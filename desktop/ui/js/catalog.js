// Sorts REA's MCP tools into sidebar groups by name. Order matters: the
// first matching group wins, so specific domains come before broad ones.
const GROUPS = [
  [
    "JavaScript & Electron",
    /javascript|electron|application_feature|application_versions|source_to_bundle/,
  ],
  [".NET & managed code", /managed/],
  ["Web & browser", /web|browser/],
  ["Android", /adb|android|apktool|jeb|flutter|dart/],
  ["Debuggers & runtime", /frida|gdb|rizin|cutter|objdump|process/],
  ["Network & signals", /packet|pcap|signal/],
  [
    "Compare & reconstruct",
    /^compare|reconstruction|changed_behavior|^project_/,
  ],
  [
    "Files & formats",
    /artifact|binary_layout|pe_resources|go_binary|rust_binary|wasm|evm|sqlite|crash|firmware/,
  ],
  [
    "Sessions & evidence",
    /^(open|close)_binary|binary_session|evidence|analysis_view|document/,
  ],
  ["Native code", /./],
];

export function groupTools(tools) {
  const groups = new Map(GROUPS.map(([label]) => [label, []]));
  for (const tool of tools) {
    const [label] = GROUPS.find(([, pattern]) => pattern.test(tool.name));
    groups.get(label).push(tool);
  }
  for (const list of groups.values())
    list.sort((a, b) => toolTitle(a).localeCompare(toolTitle(b)));
  return [...groups].filter(([, list]) => list.length);
}

export function toolTitle(tool) {
  return tool.title ?? tool.annotations?.title ?? tool.name;
}

export function matchesQuery(tool, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [tool.name, toolTitle(tool), tool.description ?? ""].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/** Starting points shown on the home page, in order. */
export const FEATURED = [
  [
    "analyze_javascript_application",
    "Analyze a JavaScript or Electron app",
    "Point at an .asar file or an extracted app folder.",
  ],
  [
    "open_binary",
    "Open a native binary",
    "EXE, DLL, ELF or Mach-O, using Ghidra, IDA or Hopper.",
  ],
  [
    "inspect_managed_artifact",
    "Inspect a .NET assembly",
    "Types, members and native boundaries of a managed DLL or EXE.",
  ],
  [
    "inspect_android_package",
    "Inspect an Android APK",
    "Manifest, classes and methods of an APK.",
  ],
  [
    "inspect_pe_resources",
    "Read Windows PE resources",
    "Version info, manifests, icons and other embedded resources.",
  ],
  [
    "inspect_artifact",
    "Identify any file",
    "Format, integrity and contents of an archive, installer or bundle.",
  ],
];

/** Guesses a starting tool for a dropped file by its extension. */
export function toolForPath(path) {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byExt = {
    asar: "analyze_javascript_application",
    apk: "inspect_android_package",
    wasm: "inspect_wasm_artifact",
    sqlite: "inspect_sqlite_database",
    db: "inspect_sqlite_database",
    pcap: "inspect_pcap_capture",
    pcapng: "inspect_pcap_capture",
    har: "inspect_web_network_capture",
    exe: "open_binary",
    dll: "open_binary",
    so: "open_binary",
    dylib: "open_binary",
    elf: "open_binary",
    bin: "inspect_firmware_regions",
  };
  return (
    byExt[ext] ?? (ext ? "inspect_artifact" : "analyze_javascript_application")
  );
}
