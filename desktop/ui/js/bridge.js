// Thin wrappers over the Tauri globals so the rest of the UI never touches
// window.__TAURI__ directly.
const tauri = window.__TAURI__;

export const invoke = (command, args) => tauri.core.invoke(command, args);

export const listen = (event, handler) =>
  tauri.event.listen(event, (e) => handler(e.payload));

export function pickPath({ directory = false, multiple = false } = {}) {
  return tauri.dialog.open({ directory, multiple });
}

export function pickSavePath(defaultPath) {
  return tauri.dialog.save({ defaultPath });
}

export function confirm(message, title = "REA") {
  return tauri.dialog.ask(message, { title, kind: "warning" });
}

export function openUrl(url) {
  return tauri.opener.openUrl(url);
}

export function onFileDrop(handlers) {
  const webview = tauri.webview?.getCurrentWebview?.();
  if (!webview) return;
  webview.onDragDropEvent((event) => {
    const { type, paths } = event.payload;
    if (type === "enter" || type === "over") handlers.over?.();
    else if (type === "drop") handlers.drop?.(paths ?? []);
    else handlers.leave?.();
  });
}
