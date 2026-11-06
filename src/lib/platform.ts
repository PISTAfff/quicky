// Which system Quicky runs on, for the few words and shortcuts that differ.
import type { InvokeArgs } from "@tauri-apps/api/core";

const ua = navigator.userAgent;
export const OS: "windows" | "mac" | "linux" = /Windows/.test(ua) ? "windows" : /Mac/.test(ua) ? "mac" : "linux";
/** The Android app (`mobile.tsx`): one window, no bubble, tray, shortcut or data folder to pick. */
export const IS_MOBILE = /Android/.test(ua);

/** The global quick-add shortcut (Ctrl+Space switches input sources on macOS). */
export const QUICK_KEY = OS === "mac" ? "⌥ Space" : "Ctrl+Space";
/** Ctrl on Windows and Linux, ⌘ on macOS, as shown in tips. */
export const MOD_KEY = OS === "mac" ? "⌘" : "Ctrl+";
/** The command key pressed with a shortcut letter. */
export const modDown = (e: KeyboardEvent) => (OS === "mac" ? e.metaKey : e.ctrlKey);
export const SYSTEM_NAME = IS_MOBILE ? "the phone" : OS === "mac" ? "macOS" : OS === "linux" ? "the system" : "Windows";

/** Bytes for a raw-body command (`save_blob`, `write_media`, `extension_save`): as they are on the
 *  desktop; on Android, whose IPC only carries JSON, as one base64 string (Rust takes both). */
export function ipcBytes(bytes: Uint8Array): InvokeArgs {
  if (!IS_MOBILE) return bytes;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  // A plain string travels as a JSON string, which `body_bytes` in data.rs decodes.
  return btoa(bin) as unknown as InvokeArgs;
}
