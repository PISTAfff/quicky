# Quicky

A tiny, cute task manager for Windows. Add mini tasks fast, mark them **To do → Doing → Done**, and let unfinished ones roll over to the next day on their own.

## Install

1. Open the [latest release](../../releases/latest).
2. Download **`Quicky_x.y.z_x64-setup.exe`** and run it. It installs for your user only, no admin needed.
3. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed yet.

Or from a terminal, with the [GitHub CLI](https://cli.github.com) signed in:

```bash
gh release download --repo PISTAfff/quicky --pattern "*-setup.exe" --dir . && ./Quicky_*_x64-setup.exe
```

On first launch Quicky asks for a folder to keep your data in. Everything stays on your PC.

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
- **Media:** attach files with the paperclip, record a voice note with the mic, paste images into the add box, or drop files anywhere on the window. If a task is open, dropped files attach to it.
- **Any size:** drag the window to any shape. It becomes a mini "next up" panel when small, a list by default, and a board with To do / Doing / Done columns when wide (drag cards between columns). The pin button keeps it on top.
- **Close** hides Quicky to the tray so Ctrl+Space keeps working. Quit from the tray icon.

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
git tag v0.1.1 && git push origin v0.1.1
```

Stack: [Tauri 2](https://tauri.app) (Rust + WebView2) and [SolidJS](https://www.solidjs.com).
