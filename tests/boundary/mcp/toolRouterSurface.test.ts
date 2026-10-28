import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { ROUTER_TOOL_NAMES } from "../../../src/server/toolRouterTransport.js";

// Target-free calls never start a deep provider.
const noProvider = () => {
  throw new Error("No deep provider may start for router discovery");
};

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const [first] = result.content as { type: string; text?: string }[];
  return JSON.parse(first?.text ?? "null");
};

const connectRouter = async () => {
  const session = createTestBinarySession(noProvider);
  const server = createServer(
    { kind: "session", session },
    { environment: { REA_MCP_TOOL_SURFACE: "router" } },
  );
  const client = new Client({ name: "router-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: () =>
      Promise.allSettled([client.close(), server.close(), session.close()]),
  };
};

describe("router tool surface over MCP", () => {
  it("advertises three tools and reaches the catalog through them", async () => {
    const { client, close } = await connectRouter();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual([
        ...ROUTER_TOOL_NAMES,
      ]);
      expect(client.getInstructions()).toMatch(/search_tools/u);

      const search = text(
        await client.callTool({
          name: "search_tools",
          arguments: { query: "binary session", limit: 3 },
        }),
      );
      expect(search.total_tools).toBeGreaterThan(0);
      expect(search.matches[0].name).toBe("binary_session");
      expect(search.matches.length).toBeLessThanOrEqual(3);

      const groups = text(
        await client.callTool({ name: "search_tools", arguments: {} }),
      );
      expect(Object.keys(groups.groups).length).toBeGreaterThan(1);

      const schema = text(
        await client.callTool({
          name: "get_tool_schema",
          arguments: { name: "binary_session" },
        }),
      );
      expect(schema).toMatchObject({
        name: "binary_session",
        input_schema: { type: "object" },
      });

      const routed = await client.callTool({
        name: "call_tool",
        arguments: { name: "binary_session", arguments: {} },
      });
      const direct = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(routed.isError).not.toBe(true);
      expect(Object.keys(routed.structuredContent ?? {})).toEqual(
        Object.keys(direct.structuredContent ?? {}),
      );
    } finally {
      await close();
    }
  }, 30_000);

  it("answers an unknown or malformed call with something a model can act on", async () => {
    const { client, close } = await connectRouter();
    try {
      const unknown = await client.callTool({
        name: "call_tool",
        arguments: { name: "binary_sesion", arguments: {} },
      });
      expect(unknown.isError).toBe(true);
      expect(text(unknown).similar).toContain("binary_session");

      for (const args of [
        {},
        { name: "search_tools" },
        { name: "binary_session", arguments: [] },
      ]) {
        const result = await client.callTool({
          name: "call_tool",
          arguments: args,
        });
        expect(result.isError).toBe(true);
      }

      const missing = await client.callTool({
        name: "get_tool_schema",
        arguments: { name: "no_such_tool" },
      });
      expect(missing.isError).toBe(true);
    } finally {
      await close();
    }
  }, 30_000);

  it("leaves the full catalog unchanged by default", async () => {
    const session = createTestBinarySession(noProvider);
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "full-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.length).toBeGreaterThan(ROUTER_TOOL_NAMES.length);
      expect(listed.tools.length).toBeLessThanOrEqual(TOOL_CONTRACTS.length);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  }, 30_000);
});
