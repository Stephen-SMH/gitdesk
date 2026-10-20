import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isDesktop, web } from "./api";

/**
 * Dialogs and shell actions. The desktop app uses Tauri plugins; the web app
 * uses the browser's own or asks gitdesk-web. Picking a folder in the browser
 * needs UI, so the web side of that lives in FolderPicker.
 */
export function confirmAction(message: string, options: { title: string; okLabel: string; kind?: "warning" }) {
  return isDesktop ? confirmDialog(message, options) : Promise.resolve(window.confirm(message));
}

export async function pickFolderNative(title: string) {
  const dir = await openDialog({ directory: true, title });
  return typeof dir === "string" ? dir : null;
}

export async function openExternal(url: string) {
  if (isDesktop) await openUrl(url);
  else window.open(url, "_blank", "noopener");
}

export function revealFolder(path: string) {
  return isDesktop ? revealItemInDir(path) : web.reveal(path);
}
