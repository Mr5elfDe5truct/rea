// App shell: sidebar, engine status, page routing and the tool page.
import { invoke, confirm, onFileDrop } from "./bridge.js";
import { McpClient } from "./mcp.js";
import { h, clear } from "./dom.js";
import { createToolForm } from "./form.js";
import { groupTools, matchesQuery, toolTitle, toolForPath } from "./catalog.js";
import { RunStore, renderRun, drawRun } from "./runs.js";
import { homePage, healthPage, settingsPage, runsPage } from "./pages.js";

const $ = (id) => document.getElementById(id);
const MAX_LOG_LINES = 1000;

const client = new McpClient();
const app = {
  tools: new Map(),
  runs: new RunStore(client),
  page: "home",
  toolName: null,
  form: null,
  logs: [],
  show,
  showTool,
  openSetup,
  restartEngine,
};

app.runActions = {
  cancel: (run) => app.runs.cancel(run),
  edit: (run) => showTool(run.tool, run.args),
  rerun: (run) => {
    const tool = app.tools.get(run.tool);
    if (!tool) return;
    showTool(run.tool, run.args);
    startRun(tool, run.args);
  },
};

// ---- Sidebar ---------------------------------------------------------------

function renderToolList() {
  const query = $("tool-search").value;
  const tools = [...app.tools.values()].filter((t) => matchesQuery(t, query));
  const list = $("tool-list");
  if (!app.tools.size) return;
  clear(
    list,
    groupTools(tools).map(([label, group]) =>
      h(
        "details",
        {
          class: "group",
          open: Boolean(query) || group.some((t) => t.name === app.toolName),
        },
        h(
          "summary",
          {},
          label,
          h("span", { class: "count" }, String(group.length)),
        ),
        group.map((tool) =>
          h(
            "button",
            {
              class: `tool-item${tool.name === app.toolName && app.page === "tool" ? " active" : ""}`,
              title: tool.name,
              onclick: () => showTool(tool.name),
            },
            toolTitle(tool),
          ),
        ),
      ),
    ),
  );
  if (!tools.length)
    list.append(h("p", { class: "muted pad" }, "No tools match."));
}

function renderNav() {
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", item.dataset.page === app.page);
  }
  const active = app.runs.active;
  $("runs-count").textContent = active ? String(active) : "";
}

function setEngineStatus({ state, detail }) {
  $("engine-dot").className = `dot dot-${state}`;
  $("engine-text").textContent =
    state === "ready"
      ? `Engine ready${client.serverInfo?.version ? ` · v${client.serverInfo.version}` : ""}`
      : state === "starting"
        ? "Starting engine…"
        : detail || "Engine stopped";
  if (client.serverInfo?.version)
    $("brand-version").textContent = `Version ${client.serverInfo.version}`;
}

// ---- Pages -----------------------------------------------------------------

function show(page) {
  app.page = page;
  app.toolName = page === "tool" ? app.toolName : null;
  app.form = page === "tool" ? app.form : null;
  const main = $("main");
  const builders = {
    home: homePage,
    health: healthPage,
    settings: settingsPage,
    runs: runsPage,
  };
  if (builders[page]) clear(main, builders[page](app));
  main.scrollTop = 0;
  renderNav();
  renderToolList();
}

function annotationBadges(tool) {
  const a = tool.annotations ?? {};
  const badges = [];
  if (a.readOnlyHint) badges.push(h("span", { class: "badge" }, "Read-only"));
  if (a.destructiveHint)
    badges.push(
      h(
        "span",
        {
          class: "badge warn",
          title: "This tool can change files, sessions or devices.",
        },
        "Can make changes",
      ),
    );
  if (a.openWorldHint)
    badges.push(
      h(
        "span",
        {
          class: "badge",
          title: "Uses external programs, devices or the network.",
        },
        "Uses external tools",
      ),
    );
  return badges;
}

function description(tool) {
  const paragraphs = (tool.description ?? "").split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length <= 1)
    return h("p", { class: "lead" }, paragraphs[0] ?? "");
  const box = h(
    "div",
    { class: "description" },
    h("p", { class: "lead" }, paragraphs[0]),
  );
  const more = h(
    "button",
    {
      class: "link",
      onclick: () => {
        more.remove();
        box.append(
          ...paragraphs
            .slice(1)
            .map((p) => h("p", { class: "muted pre-wrap" }, p)),
        );
      },
    },
    "Full description",
  );
  box.append(more);
  return box;
}

function showTool(name, args) {
  const tool = app.tools.get(name);
  if (!tool) return;
  app.page = "tool";
  app.toolName = name;
  const form = createToolForm(tool);
  app.form = form;
  const examples = tool.inputSchema?.examples ?? [];
  const json = h("textarea", {
    class: "mono json-editor hidden",
    rows: 14,
    spellcheck: false,
  });
  const message = h("p", { class: "error-text" });
  let jsonMode = false;

  const readArgs = () =>
    jsonMode ? JSON.parse(json.value || "{}") : form.read();
  const toggleJson = () => {
    try {
      if (jsonMode) form.write(JSON.parse(json.value || "{}"));
      else json.value = JSON.stringify(form.read(), null, 2);
    } catch (error) {
      if (!jsonMode) json.value = "{}";
      else
        return (message.textContent = `Fix the JSON first: ${error.message}`);
    }
    jsonMode = !jsonMode;
    message.textContent = "";
    json.classList.toggle("hidden", !jsonMode);
    form.element.classList.toggle("hidden", jsonMode);
    jsonButton.textContent = jsonMode ? "Edit as form" : "Edit as JSON";
  };
  const jsonButton = h(
    "button",
    { class: "btn", type: "button", onclick: toggleJson },
    "Edit as JSON",
  );
  const run = () => {
    message.textContent = "";
    try {
      startRun(tool, readArgs());
    } catch (error) {
      message.textContent = error.message;
    }
  };

  const runsBox = h("div", { class: "tool-runs" });
  app.runs.forTool(name).forEach((r, i) =>
    runsBox.append(
      renderRun(r, app.runActions, {
        showTool: false,
        expanded: i === 0 && r.status !== "restored",
      }),
    ),
  );

  const page = h(
    "section",
    { class: "page tool-page" },
    h(
      "header",
      { class: "tool-head" },
      h("h1", {}, toolTitle(tool)),
      h(
        "div",
        { class: "row" },
        h("code", {}, tool.name),
        annotationBadges(tool),
      ),
    ),
    description(tool),
    h(
      "form",
      { class: "tool-run", onsubmit: (e) => (e.preventDefault(), run()) },
      form.element,
      json,
      message,
      h(
        "div",
        { class: "row actions" },
        h("button", { class: "btn primary", type: "submit" }, "Run"),
        h("span", { class: "muted kbd" }, "Ctrl+Enter"),
        h("span", { class: "spacer" }),
        examples.length
          ? h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => {
                  if (jsonMode)
                    json.value = JSON.stringify(examples[0], null, 2);
                  else form.write(examples[0]);
                },
              },
              "Fill example",
            )
          : null,
        form.hasFields ? jsonButton : null,
        form.hasFields
          ? h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => (form.write({}), (json.value = "{}")),
              },
              "Clear",
            )
          : null,
      ),
    ),
    h("h2", {}, "Runs"),
    runsBox,
  );
  page.runsBox = runsBox;
  if (args) {
    const unknown = form.write(args);
    if (unknown.length) {
      // Inputs the form has no field for stay intact in JSON mode.
      toggleJson();
      json.value = JSON.stringify(args, null, 2);
    }
  }
  clear($("main"), page);
  $("main").scrollTop = 0;
  renderNav();
  renderToolList();
  page.querySelector("input:not([disabled]), select, textarea")?.focus();
}

async function startRun(tool, args) {
  const a = tool.annotations ?? {};
  if (a.destructiveHint && !a.idempotentHint) {
    const ok = await confirm(
      `${toolTitle(tool)} can change files, sessions or connected devices. Run it?`,
    );
    if (!ok) return;
  }
  const run = app.runs.start(tool, args);
  const box = $("main").querySelector(".tool-runs");
  if (app.page === "tool" && app.toolName === tool.name && box) {
    box.prepend(renderRun(run, app.runActions, { showTool: false }));
    box.previousElementSibling?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }
}

app.runs.addEventListener("change", ({ detail: run }) => {
  for (const card of document.querySelectorAll(`[data-run="${run.id}"]`)) {
    drawRun(card, run, app.runActions, {
      showTool: !card.closest(".tool-runs"),
    });
  }
  renderNav();
});

// ---- Engine ----------------------------------------------------------------

async function loadTools() {
  const tools = await client.listTools();
  app.tools = new Map(tools.map((t) => [t.name, t]));
  $("tool-search").placeholder = `Search ${tools.length} tools  (Ctrl+K)`;
  renderToolList();
  if (app.page === "home") show("home");
}

async function restartEngine() {
  try {
    await client.start();
    await loadTools();
  } catch (error) {
    clear(
      $("tool-list"),
      h(
        "p",
        { class: "error-text pad" },
        `REA's engine did not start: ${error?.message ?? error}`,
      ),
      h(
        "button",
        { class: "btn small pad", onclick: () => toggleLogs(true) },
        "Show engine log",
      ),
    );
  }
}

async function openSetup() {
  try {
    await invoke("open_console", { args: ["setup"] });
  } catch (error) {
    alert(String(error));
  }
}

function toggleLogs(open = $("logs-drawer").classList.contains("hidden")) {
  $("logs-drawer").classList.toggle("hidden", !open);
  if (open) {
    $("logs-body").textContent = app.logs.join("\n") || "Nothing logged yet.";
    $("logs-body").scrollTop = $("logs-body").scrollHeight;
  }
}

client.addEventListener("state", (e) => setEngineStatus(e.detail));
client.addEventListener("tools-changed", () => loadTools().catch(() => {}));
client.addEventListener("log", (e) => {
  app.logs.push(e.detail);
  if (app.logs.length > MAX_LOG_LINES)
    app.logs.splice(0, app.logs.length - MAX_LOG_LINES);
  if (!$("logs-drawer").classList.contains("hidden")) toggleLogs(true);
});

// ---- Wiring ----------------------------------------------------------------

for (const item of document.querySelectorAll(".nav-item")) {
  item.addEventListener("click", () => show(item.dataset.page));
}
$("tool-search").addEventListener("input", renderToolList);
$("engine-restart").addEventListener("click", restartEngine);
$("engine-logs").addEventListener("click", () => toggleLogs());
$("logs-close").addEventListener("click", () => toggleLogs(false));

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("tool-search").focus();
    $("tool-search").select();
  } else if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "Enter" &&
    app.page === "tool"
  ) {
    e.preventDefault();
    $("main").querySelector("form.tool-run")?.requestSubmit();
  } else if (e.key === "Escape") {
    toggleLogs(false);
  }
});

onFileDrop({
  over: () => $("drop-overlay").classList.remove("hidden"),
  leave: () => $("drop-overlay").classList.add("hidden"),
  drop: (paths) => {
    $("drop-overlay").classList.add("hidden");
    const [path] = paths;
    if (!path) return;
    if (app.page === "tool" && app.form?.acceptPath(path)) return;
    const name = toolForPath(path);
    showTool(name);
    app.form?.acceptPath(path);
  },
});

show("home");
await client.attach();
await restartEngine();
