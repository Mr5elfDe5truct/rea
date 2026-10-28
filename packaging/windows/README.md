# Windows installer

`build.sh` produces `build/windows-installer/REA-Setup-<version>-x64.exe`, a
per-user NSIS installer for Windows 10+ x64 that needs no administrator rights.

## What it installs

- `%LOCALAPPDATA%\Programs\REA` containing a private Node.js runtime (`node\`),
  the packed `rea-agents` package with Windows x64 production dependencies
  (`app\`), including the Windows native addon, node-pty and the Frida binding,
  and the `rea` / `rea-agents` command shims (`bin\`).
- `bin\` on the user `PATH`, Start menu shortcuts (REA Command Prompt,
  Configure AI Agents, Uninstall REA), and an Apps & Features entry.

The installer does not install or change a system Node.js, Java, Ghidra, IDA or
Hopper. Agent configuration stays an explicit `rea setup` step, offered
unchecked on the finish page.

## Uninstaller

`Uninstall REA.exe` (also reachable from Apps & Features) removes the program
files, shortcuts, `PATH` entry and registry entry. Its components page also
runs `rea uninstall` to remove REA's agent MCP entries and skills (on by
default) and optionally `rea uninstall --purge-data` to delete caches and
state. Silent mode: `"Uninstall REA.exe" /S`.

## Building

Run on Linux with Node.js (see `.nvmrc`), `curl`, `unzip`, `tar`, `makensis`
and MinGW-w64 (`apt install nsis g++-mingw-w64-x86-64`):

```sh
packaging/windows/build.sh
```

`REA_WINDOWS_NODE_VERSION` overrides the bundled Node.js release (default
`v24.22.1`); its archive is checked against the official `SHASUMS256.txt`.
