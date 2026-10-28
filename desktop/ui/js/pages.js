// Home, Health & agents, and Settings pages.
import { invoke, pickPath, openUrl } from "./bridge.js";
import { h, clear } from "./dom.js";
import { FEATURED } from "./catalog.js";
import { renderRun } from "./runs.js";

export function homePage(app) {
  const featured = FEATURED.filter(([name]) => app.tools.has(name));
  const recent = app.runs.runs.slice(0, 4);
  return h(
    "section",
    { class: "page" },
    h("h1", {}, "What do you want to look at?"),
    h(
      "p",
      { class: "lead" },
      "Pick a starting point, search the ",
      String(app.tools.size),
      " tools on the left, or drop a file anywhere in this window.",
    ),
    h(
      "div",
      { class: "cards" },
      featured.map(([name, title, text]) =>
        h(
          "button",
          { class: "card", onclick: () => app.showTool(name) },
          h("strong", {}, title),
          h("span", {}, text),
          h("code", {}, name),
        ),
      ),
    ),
    h(
      "div",
      { class: "card wide" },
      h("strong", {}, "Use REA from your AI agent"),
      h(
        "span",
        {},
        "Register REA with Claude Code, Codex, Cursor and other agents, then ask them to investigate an app for you.",
      ),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          { class: "btn primary", onclick: () => app.openSetup() },
          "Set up AI agents…",
        ),
        h(
          "button",
          { class: "btn", onclick: () => app.show("health") },
          "Check health",
        ),
      ),
    ),
    recent.length
      ? [
          h("h2", {}, "Recent runs"),
          recent.map((run) =>
            renderRun(run, app.runActions, { expanded: false }),
          ),
        ]
      : null,
    h(
      "p",
      { class: "muted footer-links" },
      h(
        "button",
        { class: "link", onclick: () => openUrl("https://rea.tools/guides/") },
        "Guides",
      ),
      " · ",
      h(
        "button",
        {
          class: "link",
          onclick: () => openUrl("https://github.com/morluto/rea"),
        },
        "Source",
      ),
    ),
  );
}

const CLASSIFICATION = {
  healthy: "Ready",
  missing_analysis_engine: "Not installed",
  config_drift: "Needs setup",
};

function checkRow(check) {
  const ok = check.ok;
  return h(
    "li",
    { class: `check ${ok ? "ok" : "warn"}` },
    h("span", { class: "check-icon" }, ok ? "✓" : "!"),
    h(
      "div",
      {},
      h(
        "div",
        { class: "check-title" },
        h("strong", {}, check.name),
        " ",
        h(
          "span",
          { class: "muted" },
          CLASSIFICATION[check.classification] ?? check.classification ?? "",
        ),
      ),
      check.detail ? h("div", { class: "muted" }, check.detail) : null,
      !ok && check.remediation && check.remediation !== check.detail
        ? h("div", { class: "remedy" }, check.remediation)
        : null,
    ),
  );
}

export function healthPage(app) {
  const results = h(
    "div",
    {},
    h(
      "p",
      { class: "progress" },
      h("span", { class: "spinner" }),
      "Running rea doctor…",
    ),
  );
  const info = h("div", {});
  const run = async () => {
    clear(
      results,
      h(
        "p",
        { class: "progress" },
        h("span", { class: "spinner" }),
        "Running rea doctor…",
      ),
    );
    try {
      const out = await invoke("run_cli", {
        args: ["doctor", "--format", "json"],
      });
      const report = JSON.parse(out.stdout);
      const checks = [...(report.scope_checks ?? []), ...(report.checks ?? [])];
      clear(
        results,
        h(
          "p",
          {},
          h(
            "span",
            {
              class: `chip ${(report.environment_healthy ?? report.healthy) ? "chip-ok" : "chip-error"}`,
            },
            (report.environment_healthy ?? report.healthy)
              ? "Environment ready"
              : "Some parts need attention",
          ),
          " Optional engines such as Ghidra, IDA, Hopper and JADX only matter for the analyses that use them.",
        ),
        h("ul", { class: "checks" }, checks.map(checkRow)),
      );
    } catch (error) {
      clear(
        results,
        h(
          "p",
          { class: "error-text" },
          `Could not run rea doctor: ${error?.message ?? error}`,
        ),
      );
    }
  };
  invoke("runtime_info")
    .then((rt) =>
      clear(
        info,
        h(
          "dl",
          { class: "facts" },
          h("dt", {}, "Installed in"),
          h("dd", { class: "mono" }, rt.root),
          h("dt", {}, "Node.js"),
          h("dd", { class: "mono" }, rt.node),
          h("dt", {}, "Engine"),
          h("dd", { class: "mono" }, rt.entry),
          h("dt", {}, "Edition"),
          h("dd", {}, rt.portable ? "Portable" : "Installed"),
        ),
        rt.portable
          ? h(
              "p",
              { class: "muted" },
              "Portable edition: agents are registered with this folder's location. If you move the folder, run agent setup again.",
            )
          : null,
      ),
    )
    .catch((e) => clear(info, h("p", { class: "error-text" }, String(e))));
  run();
  return h(
    "section",
    { class: "page" },
    h("h1", {}, "Health & agents"),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { class: "btn primary", onclick: () => app.openSetup() },
        "Set up AI agents…",
      ),
      h("button", { class: "btn", onclick: run }, "Check again"),
    ),
    h(
      "p",
      { class: "muted" },
      "Agent setup opens a console window, because it asks you to choose agents and approve each change.",
    ),
    results,
    h("h2", {}, "This copy of REA"),
    info,
  );
}

const KNOWN_SETTINGS = [
  [
    "GHIDRA_INSTALL_DIR",
    "Ghidra folder",
    "An extracted Ghidra 12.1.x release.",
    true,
  ],
  [
    "REA_IDA_MCP_CONFIG",
    "IDA MCP registration",
    "Your upstream IDA MCP registration JSON file.",
    false,
  ],
  [
    "REA_JADX_MCP_JAR",
    "JADX headless MCP jar",
    "jadx-headless-mcp 0.7.1 JAR, for Android decompilation.",
    false,
  ],
  [
    "JAVA_HOME",
    "Java",
    "A JDK folder, if Ghidra or JADX cannot find Java.",
    true,
  ],
];

export function settingsPage(app) {
  const status = h("span", { class: "muted" });
  const known = new Map();
  const customBox = h("div", { class: "fields" });
  const addCustom = (key = "", value = "") => {
    const keyInput = h("input", {
      type: "text",
      value: key,
      placeholder: "NAME",
      class: "mono",
      spellcheck: false,
    });
    const valueInput = h("input", {
      type: "text",
      value,
      placeholder: "value",
      spellcheck: false,
    });
    const row = h(
      "div",
      { class: "env-row" },
      keyInput,
      valueInput,
      h(
        "button",
        { class: "btn small", type: "button", onclick: () => row.remove() },
        "Remove",
      ),
    );
    row.read = () => [keyInput.value.trim(), valueInput.value];
    customBox.append(row);
  };
  const knownFields = KNOWN_SETTINGS.map(([key, label, help, directory]) => {
    const input = h("input", {
      type: "text",
      spellcheck: false,
      placeholder: "Not set",
    });
    known.set(key, input);
    return h(
      "div",
      { class: "field" },
      h("label", {}, label, h("code", { class: "field-name" }, key)),
      h(
        "div",
        { class: "field-input" },
        input,
        h(
          "div",
          { class: "browse" },
          h(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: async () => {
                const chosen = await pickPath({ directory });
                if (chosen) input.value = chosen;
              },
            },
            directory ? "Folder…" : "File…",
          ),
        ),
      ),
      h("p", { class: "field-help" }, help),
    );
  });
  invoke("load_settings").then(({ env = {} }) => {
    for (const [key, value] of Object.entries(env)) {
      if (known.has(key)) known.get(key).value = value;
      else addCustom(key, value);
    }
  });
  const save = async () => {
    const env = {};
    for (const [key, input] of known)
      if (input.value.trim()) env[key] = input.value.trim();
    for (const row of customBox.children) {
      const [key, value] = row.read();
      if (key) env[key] = value;
    }
    try {
      await invoke("save_settings", { settings: { env } });
      status.textContent = "Saved. Restarting the engine…";
      await app.restartEngine();
      status.textContent = "Saved and applied.";
    } catch (error) {
      status.textContent = `Could not save: ${error?.message ?? error}`;
    }
  };
  return h(
    "section",
    { class: "page narrow" },
    h("h1", {}, "Settings"),
    h(
      "p",
      { class: "lead" },
      "Tell REA where your optional analysis engines are. These values are passed to REA when this app runs it. Agents you set up use their own environment, so set the same variables in Windows if your agents need them too.",
    ),
    h("div", { class: "fields" }, knownFields),
    h("h2", {}, "Other environment variables"),
    customBox,
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { class: "btn", type: "button", onclick: () => addCustom() },
        "Add variable",
      ),
      h("span", { class: "spacer" }),
      status,
      h(
        "button",
        { class: "btn primary", type: "button", onclick: save },
        "Save",
      ),
    ),
  );
}

export function runsPage(app) {
  const runs = app.runs.runs;
  return h(
    "section",
    { class: "page" },
    h("h1", {}, "Runs"),
    runs.length ? null : h("p", { class: "muted" }, "Nothing has run yet."),
    runs.map((run) =>
      renderRun(run, app.runActions, {
        expanded: run.status !== "restored" && run === runs[0],
      }),
    ),
  );
}
