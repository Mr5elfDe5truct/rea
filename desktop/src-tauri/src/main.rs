// REA desktop shell. The Rust side only locates the bundled Node.js runtime,
// runs `rea mcp` as a child process and pipes its JSON-RPC lines to and from
// the web UI. All REA logic stays in the Node.js package.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

#[derive(Clone, Serialize)]
struct Runtime {
    node: String,
    entry: String,
    root: String,
    portable: bool,
}

/// Finds node.exe and rea.mjs next to REA.exe, the layout shared by the
/// installer and the portable zip. REA_DESKTOP_NODE / REA_DESKTOP_ENTRY
/// override both for development from a source checkout.
fn locate_runtime() -> Result<Runtime, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    let bundled_node = root
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let node = match std::env::var_os("REA_DESKTOP_NODE") {
        Some(path) => PathBuf::from(path),
        None if bundled_node.is_file() => bundled_node,
        None => PathBuf::from("node"),
    };
    let entry = match std::env::var_os("REA_DESKTOP_ENTRY") {
        Some(path) => PathBuf::from(path),
        None => root
            .join("app")
            .join("node_modules")
            .join("rea-agents")
            .join("scripts")
            .join("rea.mjs"),
    };
    if !entry.is_file() {
        return Err(format!(
            "REA's engine was not found at {}. Reinstall REA, or keep REA.exe in the same folder as its node and app folders.",
            entry.display()
        ));
    }
    Ok(Runtime {
        node: node.display().to_string(),
        entry: entry.display().to_string(),
        portable: root.join("README-PORTABLE.txt").is_file(),
        root: root.display().to_string(),
    })
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn rea_command(app: &AppHandle, runtime: &Runtime, args: &[String]) -> Command {
    let mut command = Command::new(&runtime.node);
    command.arg(&runtime.entry).args(args);
    for (key, value) in read_settings(app).env {
        if !key.trim().is_empty() && !value.is_empty() {
            command.env(key.trim(), value);
        }
    }
    command
}

struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct Engine {
    running: Mutex<Option<Running>>,
    generation: AtomicU64,
}

impl Engine {
    fn stop(&self) {
        let Some(Running { mut child, stdin }) = self.running.lock().unwrap().take() else {
            return;
        };
        // Closing stdin lets the MCP server shut down its own child processes.
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Clone, Serialize)]
struct EngineExit {
    generation: u64,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct EngineLine {
    generation: u64,
    line: String,
}

#[tauri::command]
fn runtime_info() -> Result<Runtime, String> {
    locate_runtime()
}

/// Starts `rea mcp` (restarting it if it is already running) and returns the
/// generation number that tags its mcp-message, engine-log and engine-exit events.
#[tauri::command]
fn engine_start(app: AppHandle, engine: State<'_, Engine>) -> Result<u64, String> {
    engine.stop();
    let runtime = locate_runtime()?;
    let mut command = rea_command(&app, &runtime, &["mcp".to_string()]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", runtime.node))?;
    let generation = engine.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let stdin = child.stdin.take().ok_or("engine stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("engine stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("engine stderr unavailable")?;

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = handle.emit("engine-log", EngineLine { generation, line });
        }
    });

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = handle.emit("mcp-message", EngineLine { generation, line });
            }
        }
        let engine = handle.state::<Engine>();
        let mut code = None;
        if engine.generation.load(Ordering::SeqCst) == generation {
            if let Some(mut running) = engine.running.lock().unwrap().take() {
                code = running.child.wait().ok().and_then(|status| status.code());
            }
        }
        let _ = handle.emit("engine-exit", EngineExit { generation, code });
    });

    *engine.running.lock().unwrap() = Some(Running { child, stdin });
    Ok(generation)
}

#[tauri::command]
fn engine_stop(engine: State<'_, Engine>) {
    engine.stop();
}

/// Writes one JSON-RPC message (already serialized by the UI) to the engine.
#[tauri::command]
fn mcp_send(engine: State<'_, Engine>, message: String) -> Result<(), String> {
    let mut guard = engine.running.lock().unwrap();
    let running = guard.as_mut().ok_or("The REA engine is not running.")?;
    let line = message.replace(['\r', '\n'], " ");
    running
        .stdin
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|_| running.stdin.flush())
        .map_err(|e| format!("Could not reach the REA engine: {e}"))
}

#[derive(Serialize)]
struct CliOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs one non-interactive `rea <args>` command and captures its output.
#[tauri::command]
async fn run_cli(app: AppHandle, args: Vec<String>) -> Result<CliOutput, String> {
    let runtime = locate_runtime()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = rea_command(&app, &runtime, &args);
        command.stdin(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.output().map_err(|e| e.to_string())?;
        Ok(CliOutput {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens an interactive console running `rea <args>`, for prompts such as `rea setup`.
#[tauri::command]
fn open_console(app: AppHandle, args: Vec<String>) -> Result<(), String> {
    let runtime = locate_runtime()?;
    #[cfg(windows)]
    {
        let quote = |s: &str| format!("\"{}\"", s.replace('"', ""));
        let mut line = format!("{} {}", quote(&runtime.node), quote(&runtime.entry));
        for arg in &args {
            line.push(' ');
            line.push_str(&quote(arg));
        }
        let mut command = Command::new("cmd.exe");
        command
            .raw_arg(format!("/k \"{line}\""))
            .creation_flags(CREATE_NEW_CONSOLE);
        for (key, value) in read_settings(&app).env {
            if !key.trim().is_empty() && !value.is_empty() {
                command.env(key.trim(), value);
            }
        }
        command.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("x-terminal-emulator");
        command
            .arg("-e")
            .arg(&runtime.node)
            .arg(&runtime.entry)
            .args(&args);
        let _ = app;
        command
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Run `rea {}` in a terminal instead ({e}).", args.join(" ")))
    }
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Settings {
    read_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            engine_start,
            engine_stop,
            mcp_send,
            run_cli,
            open_console,
            load_settings,
            save_settings,
            save_text_file
        ])
        .build(tauri::generate_context!())
        .expect("failed to start REA");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Engine>().stop();
        }
    });
}
