# Quicky

A tiny, cute task manager for Windows. Add mini tasks fast, mark them **To do → Doing → Done**, and let unfinished ones roll over to the next day on their own.

## Install

1. Open the [latest release](../../releases/latest).
2. Download **`Quicky_x.y.z_x64-setup.exe`** and run it. It installs for your user only, no admin needed, and adds Quicky to the Start menu (and a desktop shortcut).
3. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed yet.

Or from a terminal, with the [GitHub CLI](https://cli.github.com):

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
- **Repeats:** the repeat button in the add box opens a day picker: choose exactly which days (S M T W T F S) or Every day. Pick exact weekdays, pause, or stop a repeat from the task or the Repeats list. Each repeat appears once per matching day and never duplicates.
- **Done drawer:** finished tasks hide in the drawer, grouped by day. Restore any of them to today. Ticking a task off shows a quick Undo.
- **Media:** attach files with the paperclip, record a voice note with the mic (a live wave shows your voice while it records; ✕ discards, ■ saves), paste images into the add box, or drop files anywhere on the window. If a task is open, dropped files attach to it.
- **Any size:** drag the window to any shape. It becomes a mini "next up" panel when small, a list by default, and a board with To do / Doing / Done columns when wide (drag cards between columns). The pin button keeps it on top.
- **Bubble:** while the app is closed or minimized, a little Quicky waits on screen (bottom-left at first), always on top, even over the taskbar, with a badge showing how many tasks are left. Click it to open the app right next to it. Drag it anywhere, on any screen; right-click to lock it in place, send it back to the corner, or hide it. Locked, it won't move: tug it and it behaves like jelly: the side you pull stretches after your pointer, it gets angrier the harder you pull, and it snaps back and wobbles to a stop when you let go. Bring a hidden bubble back from Settings or the tray menu.
- **Starts with Windows:** on by default. Quicky starts quietly at sign-in (tray icon and bubble only). Turn it off, or hide the bubble, in Settings (the gear in the title bar).
- **Reminders:** in a task, *Remind me* has a switch and four ways to schedule: **Once** (a date and time, or quick picks like "In 30 min" / "Tomorrow 9 AM"), **Daily** (any number of editable times, with Morning/Noon/Afternoon/Evening presets), **Some days** (pick the weekdays), and **Repeat** (every 15 min to 3 hours between two times). It shows a plain summary and the next few times; *Not today* skips today, *Stop reminders* clears it, and "Nudge me once in 15m/30m/1h/2h" adds a one-off. The bell pill (or Settings → Reminders → *See all*) lists every reminder across all lists to pause, resume or stop. Times show as AM/PM. Only tasks still to do remind you. When it's time, Quicky pours out of the bubble and fills every screen (the task shows on the bubble's screen) until you answer: **D** I'm on it, **Enter** Done, **O** open the task, **S**/**Esc** snooze 10 min, **1/3/4** snooze 5/30/60 min.
- **Quick status:** hover a card (always shown in small windows) for one-tap **▶ Doing** / **✓ Done** (or **↺** back to To do) without opening the task.
- **Sounds:** little synthesized sound effects for adding, finishing, deleting, panels, voice notes, the bubble (tap, squash, boing, pop, divide) and reminders. Turn them off or change the volume in Settings.
- **Mini Quicky in your apps:** drop the bubble on any app's window and Quicky *divides*: one half stays as that app's own mini Quicky right there, the other heads home. Whenever that app is focused (and Quicky is closed) the mini sits at its spot, gliding along with the window; other apps get the normal bubble. A mini lives inside its app: drag it around and the window edges are walls. Push it against a wall and hold: it squashes flatter, gets angrier and squeaks higher until it pops out, and that app's mini is gone. Each mini has its own *Lock this mini in place* in its right-click menu, separate from the normal bubble's lock. You can also right-click a mini → *Hide this mini Quicky*: it puffs into droplets that fly home and join back up. Either way, drop Quicky on the app again to bring it back. (Store apps all share one host process, so they share one mini.)
- **Each app has its own tasks:** clicking an app's mini (or pressing Ctrl+Space in that app) opens that app's own list, inside the app: it covers the app with a small margin, and if you resize or move it, that's remembered for that app. It can't be dragged, resized or snapped past the app's edges (maximizing fills just the app). The title-bar pill (with the app's icon) switches between General and your apps' lists, with a count of open tasks for each.
- **Popover, not a background window:** Quicky tucks itself away as soon as you click into another app, and the bubble or mini comes back. Pin it (📌) to keep it open and on top.
- **Colours:** Settings (gear in the title bar) has five accents (Grape, Bubblegum, Mint, Tangerine, Ocean) plus a rainbow swatch to pick any colour you like, and Light / Dark / Match Windows. The bubble and the taskbar and tray icons follow along.
- **Tray icon:** left-click opens or hides Quicky, right above the tray. Right-click for *Show* and *Quit*. **Close** only hides Quicky, so Ctrl+Space and the bubble keep working.
- **Updates:** Quicky checks GitHub for a new version a little after it starts and twice a day, and shows a banner when one is ready. *Update and restart* installs it. Check by hand, or turn the automatic check off, in Settings → Updates.

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

The installer lands in `src-tauri/target/release/bundle/nsis/`. Builds also sign the update files, so set `TAURI_SIGNING_PRIVATE_KEY` to the private key (see Releasing) first.

**Releasing:** bump `version` in `src-tauri/tauri.conf.json`, then push a tag. GitHub Actions builds the installer, signs the update files with the `TAURI_SIGNING_PRIVATE_KEY` repository secret (its password secret is empty), and publishes the release with `latest.json`, which installed copies read to update themselves. Keep the private key safe: without it, existing installs can't trust new versions.

```bash
git tag v0.1.17 && git push origin v0.1.17
```

Stack: [Tauri 2](https://tauri.app) (Rust + WebView2) and [SolidJS](https://www.solidjs.com).
