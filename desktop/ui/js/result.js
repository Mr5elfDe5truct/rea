// Renders tool results: text blocks, a lazily expanded JSON tree and the raw
// response. Everything is inserted as text, never as HTML.
import { pickSavePath, invoke } from "./bridge.js";
import { h, clear } from "./dom.js";

const MAX_STRING = 400;
const MAX_CHILDREN = 500;
const MAX_RAW_CHARS = 2_000_000;

function scalar(value) {
  if (value === null) return h("span", { class: "j-null" }, "null");
  if (typeof value === "string") {
    if (value.length <= MAX_STRING)
      return h("span", { class: "j-str" }, JSON.stringify(value));
    const el = h(
      "span",
      { class: "j-str" },
      JSON.stringify(value.slice(0, MAX_STRING)).slice(0, -1) + '…" ',
    );
    el.append(
      h(
        "button",
        {
          class: "link",
          onclick: () => el.replaceChildren(JSON.stringify(value)),
        },
        `show all ${value.length.toLocaleString()} chars`,
      ),
    );
    return el;
  }
  return h(
    "span",
    { class: typeof value === "number" ? "j-num" : "j-bool" },
    String(value),
  );
}

function summary(value) {
  if (Array.isArray(value)) return `[${value.length}]`;
  const keys = Object.keys(value);
  return `{${keys.length}} ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}`;
}

function node(key, value, depth) {
  const label = key === null ? null : h("span", { class: "j-key" }, `${key}: `);
  if (value === null || typeof value !== "object")
    return h("div", { class: "j-row" }, label, scalar(value));
  const details = h(
    "details",
    { class: "j-node" },
    h("summary", {}, label, h("span", { class: "j-sum" }, summary(value))),
  );
  let rendered = false;
  const render = () => {
    if (rendered) return;
    rendered = true;
    const entries = Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.entries(value);
    const box = h("div", { class: "j-children" });
    for (const [k, v] of entries.slice(0, MAX_CHILDREN))
      box.append(node(k, v, depth + 1));
    if (entries.length > MAX_CHILDREN) {
      box.append(
        h(
          "div",
          { class: "muted" },
          `… ${entries.length - MAX_CHILDREN} more (use Save to see everything)`,
        ),
      );
    }
    details.append(box);
  };
  details.addEventListener("toggle", () => details.open && render());
  if (depth < 1) {
    details.open = true;
    render();
  }
  return details;
}

export function jsonTree(value) {
  return h("div", { class: "json-tree mono" }, node(null, value, 0));
}

function tryParse(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function contentBlock(item) {
  if (item.type === "text") {
    const parsed = tryParse(item.text ?? "");
    return parsed !== undefined
      ? jsonTree(parsed)
      : h("pre", { class: "text-block" }, item.text);
  }
  if (
    item.type === "image" &&
    /^image\/(png|jpeg|gif|webp)$/.test(item.mimeType ?? "")
  ) {
    return h("img", {
      class: "result-image",
      src: `data:${item.mimeType};base64,${item.data}`,
      alt: "Tool image result",
    });
  }
  if (item.type === "resource_link")
    return h(
      "p",
      {},
      "Resource: ",
      h("code", {}, item.uri),
      item.name ? ` (${item.name})` : "",
    );
  if (item.type === "resource")
    return h(
      "pre",
      { class: "text-block" },
      item.resource?.text ?? item.resource?.uri ?? "",
    );
  return jsonTree(item);
}

function rawText(result) {
  return JSON.stringify(result, null, 2);
}

async function saveResult(result, toolName) {
  const path = await pickSavePath(`${toolName}-result.json`);
  if (path) await invoke("save_text_file", { path, contents: rawText(result) });
}

/** Builds the tabbed view for one tools/call result. */
export function renderResult(result, toolName) {
  const tabs = [];
  const content = result.content ?? [];
  if (content.length)
    tabs.push([
      "Result",
      () => h("div", { class: "blocks" }, content.map(contentBlock)),
    ]);
  if (result.structuredContent !== undefined)
    tabs.push(["Structured", () => jsonTree(result.structuredContent)]);
  tabs.push([
    "Raw",
    () => {
      const text = rawText(result);
      return text.length > MAX_RAW_CHARS
        ? h(
            "p",
            { class: "muted" },
            `The raw response is ${(text.length / 1e6).toFixed(1)} MB. Use Save to open it in an editor.`,
          )
        : h("pre", { class: "text-block mono" }, text);
    },
  ]);

  const body = h("div", { class: "result-body" });
  const tabBar = h("div", { class: "tabs" });
  const select = (index) => {
    [...tabBar.querySelectorAll(".tab")].forEach((b, i) =>
      b.classList.toggle("active", i === index),
    );
    clear(body, tabs[index][1]());
  };
  tabs.forEach(([label], i) =>
    tabBar.append(
      h("button", { class: "tab", onclick: () => select(i) }, label),
    ),
  );
  tabBar.append(
    h("span", { class: "spacer" }),
    h(
      "button",
      { class: "btn small", onclick: (e) => copy(e.target, rawText(result)) },
      "Copy",
    ),
    h(
      "button",
      { class: "btn small", onclick: () => saveResult(result, toolName) },
      "Save…",
    ),
  );
  select(0);
  return h("div", { class: "result" }, tabBar, body);
}

async function copy(button, text) {
  await navigator.clipboard.writeText(text);
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = label), 1200);
}
