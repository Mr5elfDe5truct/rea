# REA desktop app

A small desktop window for REA, built with [Tauri 2](https://tauri.app/). The
Rust shell in `src-tauri/` starts the bundled Node.js runtime with `rea mcp`
and pipes its JSON-RPC messages to the web UI in `ui/`. REA's logic stays in
the Node.js package, so every MCP tool appears in the app without UI changes:
forms are generated from each tool's input schema.

What it offers:

- Search and browse all MCP tools by area, with a form for each tool (file and
  folder pickers for path inputs, a JSON editor for complex inputs, and the
  tool's own examples).
- Runs with progress, cancel, a collapsible JSON view of results, copy and save.
- Drag a file onto the window to open a matching tool.
- Health & agents: `rea doctor` results, and a button that opens `rea setup`
  in a console window.
- Settings for optional engines (`GHIDRA_INSTALL_DIR`, `REA_IDA_MCP_CONFIG`,
  `REA_JADX_MCP_JAR`, `JAVA_HOME`, or any other variable), passed to REA when
  the app runs it and stored in the app's config folder.

## Layout at runtime

`REA.exe` expects the layout shared by the Windows installer and portable zip:

```
REA.exe
WebView2Loader.dll
node\node.exe
app\node_modules\rea-agents\scripts\rea.mjs
```

`REA_DESKTOP_NODE` and `REA_DESKTOP_ENTRY` override the two paths, for example
to run against a source checkout.

## Building

The Windows packages build it as part of `packaging/windows/build.sh`. To build
only the app on Linux, install Rust with the `x86_64-pc-windows-gnu` target and
MinGW-w64, then:

```sh
cd desktop/src-tauri
cargo build --release --target x86_64-pc-windows-gnu
```

The UI is plain HTML, CSS and ES modules with no build step. The window needs
the Microsoft Edge WebView2 Runtime, which Windows 11 and current Windows 10
include.
