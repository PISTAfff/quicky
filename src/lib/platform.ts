// Which system Quicky runs on, for the few words and shortcuts that differ.

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
