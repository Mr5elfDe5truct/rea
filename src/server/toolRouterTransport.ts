import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type MessageExtraInfo,
  type RequestId,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";

import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

/** The three tools the router surface advertises in place of the catalog. */
export const ROUTER_TOOL_NAMES = [
  "search_tools",
  "get_tool_schema",
  "call_tool",
] as const;

type RouterToolName = (typeof ROUTER_TOOL_NAMES)[number];

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 25;
const SUMMARY_CHARACTERS = 200;

const ROUTER_TOOLS = [
  {
    name: "search_tools",
    title: "Search REA tools",
    description:
      "Find REA reverse-engineering tools by keyword, such as `decompile function`, `apk manifest`, or `pcap`. Returns matching tool names with one-line summaries. An empty query lists the tool groups. Next, call get_tool_schema for the tool you want, then call_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words describing what you want to do or inspect.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `How many matches to return (default ${DEFAULT_SEARCH_LIMIT}).`,
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_tool_schema",
    title: "Get an REA tool's inputs",
    description:
      "Show one REA tool's full description and input schema, so you can build the `arguments` for call_tool.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The tool name, as search_tools returned it.",
        },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "call_tool",
    title: "Call an REA tool",
    description:
      "Run one REA tool by name with arguments that match its input schema from get_tool_schema. Returns that tool's result unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The tool name." },
        arguments: {
          type: "object",
          description: "The tool's arguments; {} when it takes none.",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  },
] as const satisfies readonly {
  readonly name: RouterToolName;
  readonly [key: string]: unknown;
}[];

const ROUTER_INSTRUCTIONS =
  "This REA server advertises a router: use search_tools to find a tool, get_tool_schema to read its inputs, and call_tool to run it.";

interface CatalogTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: Record<string, unknown>;
}

interface PendingCatalogPage {
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRouterTool = (name: unknown): name is RouterToolName =>
  typeof name === "string" &&
  (ROUTER_TOOL_NAMES as readonly string[]).includes(name);

const parseCatalogTool = (value: unknown): CatalogTool | undefined => {
  if (!isRecord(value) || typeof value["name"] !== "string") return undefined;
  return {
    name: value["name"],
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof value["description"] === "string"
      ? { description: value["description"] }
      : {}),
    ...(value["inputSchema"] === undefined
      ? {}
      : { inputSchema: value["inputSchema"] }),
    ...(isRecord(value["annotations"])
      ? { annotations: value["annotations"] }
      : {}),
  };
};

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);

/** The first sentence, bounded, so a search answer stays a few hundred tokens. */
const summary = (description: string | undefined): string => {
  if (description === undefined) return "";
  const sentence = /^.*?[.!?](?=\s|$)/su.exec(description)?.[0] ?? description;
  return sentence.length > SUMMARY_CHARACTERS
    ? `${sentence.slice(0, SUMMARY_CHARACTERS - 1)}…`
    : sentence;
};

const group = (name: string): string => name.split("_")[0] ?? name;

/**
 * Rank by how many query words a tool matches, then by where they match:
 * name words weigh more than title words, and title more than description.
 */
const score = (tool: CatalogTool, query: readonly string[]): number => {
  const nameWords = words(tool.name);
  const titleWords = words(tool.title ?? "");
  const descriptionWords = new Set(words(tool.description ?? ""));
  let matched = 0;
  let weight = 0;
  for (const word of query) {
    let found = 0;
    if (nameWords.includes(word)) found += 4;
    else if (nameWords.some((part) => part.startsWith(word))) found += 3;
    if (titleWords.includes(word)) found += 2;
    if (descriptionWords.has(word)) found += 1;
    if (found > 0) matched++;
    weight += found;
  }
  return matched * 100 + weight;
};

const textResult = (payload: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError ? { isError: true } : {}),
});

/**
 * Present the complete tool catalog through three router tools. The catalog
 * comes from the server's own tools/list, so search and schemas match what
 * the full surface advertises; call_tool becomes an ordinary tools/call for
 * the named tool, so its result, progress, and errors are unchanged.
 */
export class ToolRouterTransport implements Transport {
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  readonly hasPerRequestStream?: boolean;
  private catalog: Promise<readonly CatalogTool[]> | undefined;
  private readonly pendingCatalogPages = new Map<
    RequestId,
    PendingCatalogPage
  >();
  private readonly pendingInitializations = new Set<RequestId>();
  private nextCatalogRequest = 0;

  constructor(private readonly transport: Transport) {
    if (transport.hasPerRequestStream !== undefined)
      this.hasPerRequestStream = transport.hasPerRequestStream;
    transport.onmessage = (message, extra) => {
      if (!isJSONRPCRequest(message)) {
        this.onmessage?.(message, extra);
        return;
      }
      if (message.method === "initialize")
        this.pendingInitializations.add(message.id);
      if (message.method === "tools/list") {
        void this.reply(message.id, { tools: ROUTER_TOOLS });
        return;
      }
      if (message.method !== "tools/call") {
        this.onmessage?.(message, extra);
        return;
      }
      const params = isRecord(message.params) ? message.params : {};
      const name = params["name"];
      const args = isRecord(params["arguments"]) ? params["arguments"] : {};
      if (name === "search_tools" || name === "get_tool_schema") {
        void this.answer(message.id, name, args);
        return;
      }
      if (name === "call_tool") {
        const target = args["name"];
        const targetArguments = args["arguments"] ?? {};
        if (typeof target !== "string" || target.length === 0) {
          void this.reply(
            message.id,
            textResult(
              { error: "call_tool needs `name`: a tool from search_tools." },
              true,
            ),
          );
          return;
        }
        if (isRouterTool(target) || !isRecord(targetArguments)) {
          void this.reply(
            message.id,
            textResult(
              {
                error: isRouterTool(target)
                  ? `${target} is a router tool; call it directly.`
                  : "call_tool `arguments` must be an object.",
              },
              true,
            ),
          );
          return;
        }
        void this.route(message, params, target, targetArguments, extra);
        return;
      }
      // Direct calls to catalog tools still work for clients that know them.
      this.onmessage?.(message, extra);
    };
    transport.onerror = (error) => this.onerror?.(error);
    transport.onclose = () => {
      this.rejectPendingCatalog(new Error("MCP transport closed"));
      this.pendingInitializations.clear();
      this.onclose?.();
    };
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }
  set sessionId(value: string | undefined) {
    this.transport.sessionId = value;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } finally {
      this.rejectPendingCatalog(new Error("MCP transport closed"));
      this.pendingInitializations.clear();
    }
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.transport.setSupportedProtocolVersions?.(versions);
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id !== undefined
    ) {
      const page = this.pendingCatalogPages.get(message.id);
      if (page !== undefined) {
        this.pendingCatalogPages.delete(message.id);
        if (isJSONRPCResultResponse(message) && isRecord(message.result))
          page.resolve(message.result);
        else page.reject(new Error("REA could not list its own tools"));
        return;
      }
      if (
        isJSONRPCResultResponse(message) &&
        this.pendingInitializations.delete(message.id) &&
        isRecord(message.result)
      ) {
        const instructions = message.result["instructions"];
        await this.transport.send(
          {
            ...message,
            result: {
              ...message.result,
              instructions:
                typeof instructions === "string" && instructions.length > 0
                  ? `${instructions} ${ROUTER_INSTRUCTIONS}`
                  : ROUTER_INSTRUCTIONS,
            },
          } as JSONRPCMessage,
          options,
        );
        return;
      }
    }
    // Availability changes alter the catalog behind the router, not the router.
    if (
      isJSONRPCNotification(message) &&
      message.method === "notifications/tools/list_changed"
    ) {
      this.catalog = undefined;
      return;
    }
    await this.transport.send(message, options);
  }

  /**
   * Forward call_tool as the named tool's own tools/call. An unknown name
   * answers with similar names, which a model can act on, instead of a
   * protocol error it cannot see.
   */
  private async route(
    message: JSONRPCRequest,
    params: Record<string, unknown>,
    target: string,
    targetArguments: Record<string, unknown>,
    extra: MessageExtraInfo | undefined,
  ): Promise<void> {
    let tools: readonly CatalogTool[] | undefined;
    try {
      tools = await this.loadCatalog();
    } catch {
      // The server reports an unknown tool itself when its catalog is unreadable.
      this.catalog = undefined;
    }
    if (tools !== undefined && !tools.some(({ name }) => name === target)) {
      await this.reply(message.id, this.schema(tools, { name: target }));
      return;
    }
    this.onmessage?.(
      {
        ...message,
        params: { ...params, name: target, arguments: targetArguments },
      },
      extra,
    );
  }

  private reply(id: RequestId, result: unknown): Promise<void> {
    return this.transport
      .send({ jsonrpc: "2.0", id, result } as JSONRPCMessage)
      .catch((error: unknown) =>
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
  }

  private async answer(
    id: RequestId,
    name: "search_tools" | "get_tool_schema",
    args: Record<string, unknown>,
  ): Promise<void> {
    let tools: readonly CatalogTool[];
    try {
      tools = await this.loadCatalog();
    } catch (cause: unknown) {
      this.catalog = undefined;
      await this.reply(
        id,
        textResult(
          {
            error: cause instanceof Error ? cause.message : String(cause),
          },
          true,
        ),
      );
      return;
    }
    await this.reply(
      id,
      name === "search_tools"
        ? this.search(tools, args)
        : this.schema(tools, args),
    );
  }

  private search(tools: readonly CatalogTool[], args: Record<string, unknown>) {
    const query = words(typeof args["query"] === "string" ? args["query"] : "");
    const requested = Number(args["limit"]);
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT;
    const groups = () => {
      const counts = new Map<string, number>();
      for (const tool of tools)
        counts.set(group(tool.name), (counts.get(group(tool.name)) ?? 0) + 1);
      return Object.fromEntries(
        [...counts].sort(([left], [right]) =>
          compareUnicodeCodePoints(left, right),
        ),
      );
    };
    if (query.length === 0)
      return textResult({
        total_tools: tools.length,
        groups: groups(),
        hint: "Search with a few words, for example `decompile function` or `android manifest`.",
      });
    const matches = tools
      .map((tool) => ({ tool, score: score(tool, query) }))
      .filter(({ score: value }) => value > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareUnicodeCodePoints(left.tool.name, right.tool.name),
      );
    return textResult({
      total_tools: tools.length,
      total_matches: matches.length,
      matches: matches.slice(0, limit).map(({ tool }) => ({
        name: tool.name,
        summary: summary(tool.description),
        read_only: tool.annotations?.["readOnlyHint"] === true,
      })),
      ...(matches.length === 0
        ? {
            groups: groups(),
            hint: "No tool matched. Try other words, or a group name above.",
          }
        : {
            hint: "Call get_tool_schema with a name, then call_tool with its arguments.",
          }),
    });
  }

  private schema(tools: readonly CatalogTool[], args: Record<string, unknown>) {
    const name = typeof args["name"] === "string" ? args["name"] : "";
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      const similar = tools
        .map((candidate) => ({
          name: candidate.name,
          score: score(candidate, words(name)),
        }))
        .filter(({ score: value }) => value > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            compareUnicodeCodePoints(left.name, right.name),
        )
        .slice(0, 5)
        .map(({ name: candidate }) => candidate);
      return textResult(
        {
          error: `No REA tool is named ${JSON.stringify(name)}.`,
          similar,
        },
        true,
      );
    }
    return textResult({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description ?? "",
      input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      ...(tool.annotations === undefined
        ? {}
        : { annotations: tool.annotations }),
    });
  }

  /** The server's complete catalog, read once until it reports a change. */
  private loadCatalog(): Promise<readonly CatalogTool[]> {
    this.catalog ??= (async () => {
      const tools: CatalogTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.requestCatalogPage(cursor);
        for (const value of Array.isArray(page["tools"]) ? page["tools"] : []) {
          const tool = parseCatalogTool(value);
          if (tool !== undefined) tools.push(tool);
        }
        cursor =
          typeof page["nextCursor"] === "string"
            ? page["nextCursor"]
            : undefined;
      } while (cursor !== undefined);
      return tools;
    })();
    return this.catalog;
  }

  private requestCatalogPage(
    cursor: string | undefined,
  ): Promise<Record<string, unknown>> {
    const id = `rea-tool-router-${this.nextCatalogRequest++}`;
    return new Promise((resolve, reject) => {
      this.pendingCatalogPages.set(id, { resolve, reject });
      this.onmessage?.({
        jsonrpc: "2.0",
        id,
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      });
    });
  }

  private rejectPendingCatalog(error: Error): void {
    for (const page of this.pendingCatalogPages.values()) page.reject(error);
    this.pendingCatalogPages.clear();
  }
}
