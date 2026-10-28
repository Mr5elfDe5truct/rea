// Minimal MCP client over the JSON-RPC pipe the Rust shell exposes.
import { invoke, listen } from "./bridge.js";

const PROTOCOL_VERSION = "2025-06-18";

export class McpClient extends EventTarget {
  constructor() {
    super();
    this.generation = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.progress = new Map();
    this.state = "stopped";
    this.serverInfo = null;
    this.ready = Promise.resolve();
  }

  async attach() {
    await listen("mcp-message", (p) => this.#onLine(p));
    await listen("engine-log", (p) => {
      if (p.generation === this.generation) this.#emit("log", p.line);
    });
    await listen("engine-exit", (p) => {
      if (p.generation === this.generation) this.#onExit(p.code);
    });
  }

  start() {
    this.ready = this.#start();
    return this.ready;
  }

  async #start() {
    this.#setState("starting");
    this.#failPending(new Error("The REA engine restarted."));
    try {
      this.generation = await invoke("engine_start");
      const init = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: "rea-desktop", version: "1" },
      });
      this.serverInfo = init.serverInfo ?? null;
      await this.notify("notifications/initialized");
      this.#setState("ready");
    } catch (error) {
      this.#setState("error", String(error?.message ?? error));
      throw error;
    }
  }

  async stop() {
    await invoke("engine_stop");
  }

  async listTools() {
    await this.ready;
    const tools = [];
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name, args, { signal, onProgress } = {}) {
    await this.ready;
    return this.request(
      "tools/call",
      { name, arguments: args },
      { signal, onProgress },
    );
  }

  request(method, params = {}, { signal, onProgress } = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    if (onProgress) {
      message.params = { ...params, _meta: { progressToken: id } };
      this.progress.set(id, onProgress);
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        this.progress.delete(id);
      };
      this.pending.set(id, {
        resolve: (v) => (cleanup(), resolve(v)),
        reject: (e) => (cleanup(), reject(e)),
      });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id)) return;
          this.notify("notifications/cancelled", {
            requestId: id,
            reason: "Cancelled in REA desktop",
          }).catch(() => {});
          this.pending
            .get(id)
            .reject(new DOMException("Cancelled", "AbortError"));
        },
        { once: true },
      );
      this.#send(message).catch((e) => this.pending.get(id)?.reject(e));
    });
  }

  notify(method, params) {
    return this.#send({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
  }

  #send(message) {
    return invoke("mcp_send", { message: JSON.stringify(message) });
  }

  #onLine({ generation, line }) {
    if (generation !== this.generation) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#emit("log", line);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.#answerServerRequest(message);
    } else if (message.method) {
      this.#onNotification(message);
    } else if (this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      if (message.error) entry.reject(new RpcError(message.error));
      else entry.resolve(message.result);
    }
  }

  #answerServerRequest({ id, method }) {
    const reply = { jsonrpc: "2.0", id };
    if (method === "ping") reply.result = {};
    else if (method === "roots/list") reply.result = { roots: [] };
    else reply.error = { code: -32601, message: `Unsupported: ${method}` };
    this.#send(reply).catch(() => {});
  }

  #onNotification({ method, params }) {
    if (method === "notifications/progress") {
      this.progress.get(params?.progressToken)?.(params);
    } else if (method === "notifications/tools/list_changed") {
      this.#emit("tools-changed");
    } else if (method === "notifications/message") {
      const data = params?.data;
      this.#emit("log", typeof data === "string" ? data : JSON.stringify(data));
    }
  }

  #onExit(code) {
    this.#failPending(
      new Error(`The REA engine stopped (exit code ${code ?? "unknown"}).`),
    );
    this.#setState("error", `Engine stopped (exit code ${code ?? "unknown"})`);
  }

  #failPending(error) {
    for (const entry of this.pending.values()) entry.reject(error);
  }

  #setState(state, detail = "") {
    this.state = state;
    this.#emit("state", { state, detail });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export class RpcError extends Error {
  constructor({ code, message, data }) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
