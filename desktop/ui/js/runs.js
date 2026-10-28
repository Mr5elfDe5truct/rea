// Tool runs: starting, cancelling, remembering and drawing them.
import { h, clear, formatDuration } from "./dom.js";
import { renderResult } from "./result.js";
import { toolTitle } from "./catalog.js";

const STORAGE_KEY = "rea.desktop.runs";
const KEEP = 40;

export class RunStore extends EventTarget {
  constructor(client) {
    super();
    this.client = client;
    this.runs = [];
    this.nextId = 1;
    this.#restore();
  }

  start(tool, args) {
    const run = {
      id: this.nextId++,
      tool: tool.name,
      title: toolTitle(tool),
      args,
      started: Date.now(),
      status: "running",
      progress: "",
      controller: new AbortController(),
    };
    this.runs.unshift(run);
    this.#changed(run);
    this.client
      .callTool(tool.name, args, {
        signal: run.controller.signal,
        onProgress: ({ progress, total, message }) => {
          const pct = total ? ` ${Math.round((progress / total) * 100)}%` : "";
          run.progress = `${message ?? "Working"}${pct}`;
          this.#changed(run);
        },
      })
      .then((result) => {
        run.result = result;
        run.status = result?.isError ? "error" : "ok";
      })
      .catch((error) => {
        run.status = error?.name === "AbortError" ? "cancelled" : "error";
        run.error = String(error?.message ?? error);
      })
      .finally(() => {
        run.finished = Date.now();
        this.#changed(run);
        this.#persist();
      });
    return run;
  }

  cancel(run) {
    run.controller?.abort();
  }

  forTool(name) {
    return this.runs.filter((r) => r.tool === name);
  }

  get active() {
    return this.runs.filter((r) => r.status === "running").length;
  }

  #changed(run) {
    this.dispatchEvent(new CustomEvent("change", { detail: run }));
  }

  #persist() {
    const saved = this.runs
      .filter((r) => r.status !== "running")
      .slice(0, KEEP)
      .map(({ tool, title, args, started, finished, status, lastStatus }) => ({
        tool,
        title,
        args,
        started,
        finished,
        lastStatus: status === "restored" ? lastStatus : status,
      }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // History is a convenience; ignore storage failures.
    }
  }

  #restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      this.runs = saved.map((r) => ({
        ...r,
        id: this.nextId++,
        status: "restored",
      }));
    } catch {
      this.runs = [];
    }
  }
}

const STATUS_LABEL = {
  running: "Running",
  ok: "Done",
  error: "Failed",
  cancelled: "Cancelled",
  restored: "Earlier session",
};

/** Draws one run as a card. `actions` supplies rerun/edit/cancel callbacks. */
export function renderRun(
  run,
  actions,
  { showTool = true, expanded = true } = {},
) {
  const card = h("article", {
    class: `run run-${run.status}`,
    "data-run": run.id,
  });
  drawRun(card, run, actions, { showTool, expanded });
  return card;
}

export function drawRun(
  card,
  run,
  actions,
  { showTool = true, expanded = true } = {},
) {
  card.className = `run run-${run.status}`;
  const elapsed = (run.finished ?? Date.now()) - run.started;
  const when = new Date(run.started).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const head = h(
    "header",
    { class: "run-head" },
    h(
      "span",
      { class: `chip chip-${run.status}` },
      STATUS_LABEL[run.status] ?? run.status,
    ),
    showTool
      ? h(
          "button",
          { class: "link run-tool", onclick: () => actions.edit(run) },
          run.title,
        )
      : null,
    h("span", { class: "muted" }, when),
    run.status === "running" || run.status === "restored"
      ? null
      : h("span", { class: "muted" }, formatDuration(elapsed)),
    h("span", { class: "spacer" }),
    run.status === "running"
      ? h(
          "button",
          { class: "btn small", onclick: () => actions.cancel(run) },
          "Cancel",
        )
      : [
          h(
            "button",
            { class: "btn small", onclick: () => actions.edit(run) },
            "Edit inputs",
          ),
          h(
            "button",
            { class: "btn small", onclick: () => actions.rerun(run) },
            "Run again",
          ),
        ],
  );
  const argCount = Object.keys(run.args ?? {}).length;
  const inputs = h(
    "details",
    { class: "run-args" },
    h("summary", {}, argCount ? `Inputs (${argCount})` : "No inputs"),
    h(
      "pre",
      { class: "text-block mono" },
      JSON.stringify(run.args ?? {}, null, 2),
    ),
  );
  const body = [];
  if (run.status === "running")
    body.push(
      h(
        "p",
        { class: "progress" },
        h("span", { class: "spinner" }),
        run.progress || "Working…",
      ),
    );
  if (run.error) body.push(h("p", { class: "error-text" }, run.error));
  if (run.result) {
    if (run.result.isError)
      body.push(
        h(
          "p",
          { class: "error-text" },
          "REA reported a problem with this run. Details below.",
        ),
      );
    body.push(
      expanded ? renderResult(run.result, run.tool) : collapsedResult(run),
    );
  }
  if (run.status === "restored")
    body.push(
      h(
        "p",
        { class: "muted" },
        `Results are kept only while the app is open (last status: ${STATUS_LABEL[run.lastStatus] ?? "unknown"}).`,
      ),
    );
  clear(card, head, inputs, body);
}

function collapsedResult(run) {
  const box = h("div", {});
  box.append(
    h(
      "button",
      {
        class: "btn small",
        onclick: () => clear(box, renderResult(run.result, run.tool)),
      },
      "Show result",
    ),
  );
  return box;
}
