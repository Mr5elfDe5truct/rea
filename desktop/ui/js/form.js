// Builds an input form from a tool's JSON Schema and turns it back into
// tool arguments. Anything the form cannot express falls back to a JSON box.
import { pickPath } from "./bridge.js";
import { h, humanize, firstSentence } from "./dom.js";

function lookup(root, ref) {
  if (!ref.startsWith("#/")) return {};
  return (
    ref
      .slice(2)
      .split("/")
      .reduce(
        (node, part) =>
          node?.[part.replaceAll("~1", "/").replaceAll("~0", "~")],
        root,
      ) ?? {}
  );
}

export function deref(schema, root) {
  let current = schema ?? {};
  for (let depth = 0; current.$ref && depth < 32; depth++) {
    const { $ref, ...rest } = current;
    current = { ...lookup(root, $ref), ...rest };
  }
  return current;
}

const PATH_NAME = /(^|_)(path|paths|directory|file|jar|root)$/;

function isLocalPath(name, schema) {
  if (name.startsWith("device_") || name === "cdp_endpoint") return false;
  const text = (schema.description ?? "").toLowerCase();
  return PATH_NAME.test(name) || text.includes("local filesystem path");
}

function wantsDirectory(name, schema) {
  const text = (schema.description ?? "").toLowerCase();
  return name.includes("directory") || /\bdirectory\b/.test(text);
}

/** Reduces a property schema to one of the input kinds the form supports. */
export function classify(name, raw, root) {
  const schema = deref(raw, root);
  const options = schema.anyOf ?? schema.oneOf;
  if (options) {
    const resolved = options
      .map((o) => deref(o, root))
      .filter((o) => o.type !== "null");
    if (resolved.length === 1)
      return classify(
        name,
        { ...resolved[0], description: schema.description },
        root,
      );
    if (resolved.every((o) => o.type === "boolean"))
      return { kind: "boolean", schema };
    if (
      resolved.every(
        (o) => o.type === "string" && (o.enum || o.const !== undefined),
      )
    ) {
      const values = resolved.flatMap((o) => o.enum ?? [o.const]);
      const def =
        schema.default ??
        resolved.find((o) => o.default !== undefined)?.default;
      return { kind: "enum", values, schema: { ...schema, default: def } };
    }
    if (resolved.every((o) => o.type === "string")) {
      const suggestions = resolved.flatMap(
        (o) => o.enum ?? (o.const !== undefined ? [o.const] : []),
      );
      const path = isLocalPath(name, schema);
      return {
        kind: "string",
        path,
        directory: path && wantsDirectory(name, schema),
        suggestions,
        schema,
      };
    }
    if (resolved.every((o) => o.type === "integer" || o.type === "number")) {
      return {
        kind: "number",
        integer: resolved.every((o) => o.type === "integer"),
        schema,
      };
    }
    return { kind: "json", schema };
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  if (type === "string" && schema.enum)
    return { kind: "enum", values: schema.enum, schema };
  if (type === "string" && schema.const !== undefined)
    return { kind: "const", schema };
  if (type === "string") {
    const path = isLocalPath(name, schema);
    return {
      kind: "string",
      path,
      directory: path && wantsDirectory(name, schema),
      schema,
    };
  }
  if (type === "integer" || type === "number")
    return { kind: "number", integer: type === "integer", schema };
  if (type === "boolean") return { kind: "boolean", schema };
  if (type === "array") {
    const items = deref(schema.items, root);
    if (items.type === "string" && !items.enum) {
      return {
        kind: "lines",
        path: isLocalPath(name, schema) || isLocalPath(name, items),
        schema,
      };
    }
  }
  return { kind: "json", schema };
}

function describe(schema) {
  const text = schema.description ?? "";
  if (!text) return null;
  const short = firstSentence(text);
  if (short.length >= text.trim().length)
    return h("p", { class: "field-help" }, text);
  const help = h("p", { class: "field-help" }, short, " ");
  help.append(
    h(
      "button",
      {
        class: "link",
        type: "button",
        onclick: () => help.replaceChildren(text),
      },
      "More",
    ),
  );
  return help;
}

function defaultHint(schema) {
  if (schema.default === undefined) return "";
  return `default: ${typeof schema.default === "string" ? schema.default : JSON.stringify(schema.default)}`;
}

function browseButtons(input, field) {
  const pick = async (directory) => {
    const chosen = await pickPath({
      directory,
      multiple: field.kind === "lines",
    });
    if (!chosen) return;
    if (field.kind === "lines") {
      const existing = input.value.trim();
      input.value = [existing, ...[chosen].flat()].filter(Boolean).join("\n");
    } else {
      input.value = chosen;
    }
    input.dispatchEvent(new Event("input"));
  };
  const buttons = [];
  if (!field.directory)
    buttons.push(
      h(
        "button",
        { type: "button", class: "btn small", onclick: () => pick(false) },
        "File…",
      ),
    );
  buttons.push(
    h(
      "button",
      { type: "button", class: "btn small", onclick: () => pick(true) },
      "Folder…",
    ),
  );
  return h("div", { class: "browse" }, buttons);
}

function buildInput(name, field, required) {
  const { schema } = field;
  switch (field.kind) {
    case "enum": {
      const blank =
        required && schema.default === undefined
          ? "Choose…"
          : schema.default !== undefined
            ? `(${defaultHint(schema)})`
            : "(not set)";
      return h(
        "select",
        {},
        h("option", { value: "" }, blank),
        field.values.map((v) => h("option", { value: v }, v)),
      );
    }
    case "boolean":
      return h(
        "select",
        {},
        h(
          "option",
          { value: "" },
          schema.default !== undefined
            ? `(${defaultHint(schema)})`
            : "(not set)",
        ),
        h("option", { value: "true" }, "true"),
        h("option", { value: "false" }, "false"),
      );
    case "number":
      return h("input", {
        type: "number",
        step: field.integer ? "1" : "any",
        placeholder: defaultHint(schema),
        min: schema.minimum,
        max: schema.maximum,
      });
    case "lines":
      return h("textarea", {
        rows: 3,
        spellcheck: false,
        placeholder: "One value per line",
      });
    case "json":
      return h("textarea", {
        rows: 4,
        class: "mono",
        spellcheck: false,
        placeholder:
          schema.default !== undefined
            ? `JSON, ${defaultHint(schema)}`
            : "JSON value",
      });
    case "const":
      return h("input", { type: "text", value: schema.const, disabled: true });
    default: {
      const input = h("input", {
        type: "text",
        spellcheck: false,
        placeholder: field.path
          ? "Absolute path, or browse"
          : defaultHint(schema) ||
            (field.suggestions?.length
              ? `e.g. ${field.suggestions.join(", ")}`
              : ""),
      });
      if (!field.suggestions?.length) return input;
      const listId = `list-${name}-${Math.random().toString(36).slice(2)}`;
      input.setAttribute("list", listId);
      return h(
        "div",
        { class: "with-list" },
        input,
        h(
          "datalist",
          { id: listId },
          field.suggestions.map((v) => h("option", { value: v })),
        ),
      );
    }
  }
}

function readField(name, field, input, required) {
  const raw = input.value;
  const empty = raw.trim() === "";
  if (field.kind === "const")
    return { value: field.schema.const, set: required };
  if (empty) {
    if (required) throw new FieldError(name, "is required");
    return { set: false };
  }
  switch (field.kind) {
    case "boolean":
      return { value: raw === "true", set: true };
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n)))
        throw new FieldError(
          name,
          `needs ${field.integer ? "a whole number" : "a number"}`,
        );
      return { value: n, set: true };
    }
    case "lines":
      return {
        value: raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        set: true,
      };
    case "json":
      try {
        return { value: JSON.parse(raw), set: true };
      } catch (e) {
        throw new FieldError(name, `is not valid JSON (${e.message})`);
      }
    case "string":
      return {
        value: field.path ? raw.trim().replace(/^"(.*)"$/, "$1") : raw,
        set: true,
      };
    default:
      return { value: raw, set: true };
  }
}

function writeField(field, input, value) {
  if (value === undefined)
    input.value = field.kind === "const" ? field.schema.const : "";
  else if (field.kind === "lines" && Array.isArray(value))
    input.value = value.join("\n");
  else if (field.kind === "json") input.value = JSON.stringify(value, null, 2);
  else if (field.kind === "boolean") input.value = value ? "true" : "false";
  else input.value = String(value);
}

export class FieldError extends Error {
  constructor(name, problem) {
    super(`${humanize(name)} ${problem}.`);
    this.field = name;
  }
}

/** Renders a form for one tool. Returns { element, read(), write(args), focusPath(path) }. */
export function createToolForm(tool) {
  const root = tool.inputSchema ?? {};
  const required = new Set(root.required ?? []);
  const fields = Object.entries(root.properties ?? {}).map(([name, raw]) => {
    const field = classify(name, raw, root);
    const isRequired = required.has(name);
    const control = buildInput(name, field, isRequired);
    const input = control.matches("input, select, textarea")
      ? control
      : control.querySelector("input");
    const error = h("div", { class: "field-error" });
    const wrapper = h(
      "div",
      { class: `field kind-${field.kind}${isRequired ? " required" : ""}` },
      h(
        "label",
        {},
        humanize(name),
        isRequired
          ? h("span", { class: "req", title: "Required" }, " *")
          : null,
        h("code", { class: "field-name" }, name),
      ),
      h(
        "div",
        { class: "field-input" },
        control,
        field.path ? browseButtons(input, field) : null,
      ),
      describe(deref(raw, root)),
      error,
    );
    input.addEventListener("input", () => wrapper.classList.remove("invalid"));
    return { name, field, input, wrapper, error, required: isRequired };
  });

  const ordered = [
    ...fields.filter((f) => f.required),
    ...fields.filter((f) => !f.required),
  ];
  const requiredBox = h(
    "div",
    { class: "fields" },
    ordered.filter((f) => f.required).map((f) => f.wrapper),
  );
  const optional = ordered.filter((f) => !f.required);
  const optionalBox = optional.length
    ? h(
        "details",
        { class: "optional", open: ordered.every((f) => !f.required) },
        h("summary", {}, `Options (${optional.length})`),
        h(
          "div",
          { class: "fields" },
          optional.map((f) => f.wrapper),
        ),
      )
    : null;
  const element = h(
    "div",
    { class: "tool-form" },
    fields.length
      ? null
      : h("p", { class: "muted" }, "This tool takes no inputs."),
    requiredBox,
    optionalBox,
  );

  return {
    element,
    hasFields: fields.length > 0,
    read() {
      const args = {};
      let firstError = null;
      for (const f of fields) {
        f.wrapper.classList.remove("invalid");
        try {
          const { value, set } = readField(
            f.name,
            f.field,
            f.input,
            f.required,
          );
          if (set) args[f.name] = value;
        } catch (e) {
          f.wrapper.classList.add("invalid");
          f.error.textContent = e.message;
          if (f.wrapper.closest("details"))
            f.wrapper.closest("details").open = true;
          firstError ??= e;
        }
      }
      if (firstError) throw firstError;
      return args;
    },
    write(args = {}) {
      const unknown = Object.keys(args).filter(
        (k) => !fields.some((f) => f.name === k),
      );
      for (const f of fields) writeField(f.field, f.input, args[f.name]);
      if (optionalBox && optional.some((f) => args[f.name] !== undefined))
        optionalBox.open = true;
      return unknown;
    },
    /** Puts a dropped path into the first empty path field (or the first path field). */
    acceptPath(path) {
      const pathFields = fields.filter(
        (f) => f.field.path && !f.input.disabled,
      );
      const target =
        pathFields.find((f) => !f.input.value.trim()) ?? pathFields[0];
      if (!target) return false;
      if (target.field.kind === "lines")
        target.input.value = [target.input.value.trim(), path]
          .filter(Boolean)
          .join("\n");
      else target.input.value = path;
      target.input.focus();
      return true;
    },
  };
}
