// Which system Quicky runs on, for the few words and shortcuts that differ.

const ua = navigator.userAgent;
export const OS: "windows" | "mac" | "linux" = /Windows/.test(ua) ? "windows" : /Mac/.test(ua) ? "mac" : "linux";

/** The global quick-add shortcut (Ctrl+Space switches input sources on macOS). */
export const QUICK_KEY = OS === "mac" ? "⌥ Space" : "Ctrl+Space";
/** Ctrl on Windows and Linux, ⌘ on macOS, as shown in tips. */
export const MOD_KEY = OS === "mac" ? "⌘" : "Ctrl+";
/** The command key pressed with a shortcut letter. */
export const modDown = (e: KeyboardEvent) => (OS === "mac" ? e.metaKey : e.ctrlKey);
export const SYSTEM_NAME = OS === "mac" ? "macOS" : OS === "linux" ? "the system" : "Windows";
