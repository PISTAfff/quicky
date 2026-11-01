# Quicky

A tiny, cute task manager for Windows. Add mini tasks fast, mark them **To do → Doing → Done**, and let unfinished ones roll over to the next day on their own.

## Install

1. Open the [latest release](../../releases/latest).
2. Download **`Quicky_x.y.z_x64-setup.exe`** and run it. It installs for your user only, no admin needed, and adds Quicky to the Start menu (and a desktop shortcut).
3. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed yet.

Or from a terminal, with the [GitHub CLI](https://cli.github.com) signed in:

```bash
gh release download --repo PISTAfff/quicky --pattern "*-setup.exe" --dir . && ./Quicky_*_x64-setup.exe
```

On first launch Quicky asks where to keep your data and creates a `Quicky` folder there (picking a folder that's already called `Quicky`, or one that already holds `quicky.json`, uses it as is). Everything stays on your PC.

## Using it

| | |
|---|---|
| **Ctrl+Space** | Open Quicky from anywhere and jump to the add box |
| **Enter** | Add the task |
| **Click the circle** | To do → Doing → Done |
| **Right-click the circle** | Step back |
| **Ctrl+N** | Focus the add box |
| **Esc** | Close a panel |

- **Carry-over:** anything not done moves to today, tinted peach with a "Carried · 2nd day" label.
- **Repeats:** the repeat button in the add box cycles *off / daily / weekdays*. Pick exact weekdays, pause, or stop a repeat from the task or the Repeats list. Each repeat appears once per matching day and never duplicates.
- **Done drawer:** finished tasks hide in the drawer, grouped by day. Restore any of them to today. Ticking a task off shows a quick Undo.
- **Media:** attach files with the paperclip, record a voice note with the mic (a live wave shows your voice while it records; ✕ discards, ■ saves), paste images into the add box, or drop files anywhere on the window. If a task is open, dropped files attach to it.
- **Any size:** drag the window to any shape. It becomes a mini "next up" panel when small, a list by default, and a board with To do / Doing / Done columns when wide (drag cards between columns). The pin button keeps it on top.
- **Bubble:** while the app is closed or minimized, a little Quicky waits on screen (bottom-left at first), always on top, even over the taskbar, with a badge showing how many tasks are left. Click it to open the app right next to it. Drag it anywhere; right-click to lock it in place, send it back to the corner, or hide it. Bring a hidden bubble back from Settings or the tray menu.
- **Starts with Windows:** on by default. Quicky starts quietly at sign-in (tray icon and bubble only). Turn it off, or hide the bubble, in Settings (the gear in the title bar).
- **Colours:** Settings (gear in the title bar) has five accents (Grape, Bubblegum, Mint, Tangerine, Ocean) and Light / Dark / Match Windows. The bubble follows along.
- **Tray icon:** left-click opens or hides Quicky. Right-click for *Show* and *Quit*. **Close** only hides Quicky, so Ctrl+Space and the bubble keep working.

## Your data

```
<your folder>/
├ quicky.json          tasks and repeats (plain JSON, saved atomically)
└ media/2026-11/…      copies of every attachment and voice note
```

Put the folder in OneDrive or Dropbox to sync it. Use the folder button in the title bar to open the folder or switch to another one. Switching doesn't move files.

## Develop

Needs Node 24+, pnpm, Rust (stable) and the Visual Studio C++ Build Tools.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

```bash
pnpm test
```

```bash
pnpm tauri build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`.

**Releasing:** bump `version` in `src-tauri/tauri.conf.json`, then push a tag. GitHub Actions builds the installer and publishes the release.

```bash
git tag v0.1.6 && git push origin v0.1.6
```

Stack: [Tauri 2](https://tauri.app) (Rust + WebView2) and [SolidJS](https://www.solidjs.com).
