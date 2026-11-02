# Quicky

A tiny, cute task manager for Windows, macOS and Linux. Add mini tasks fast, mark them **To do → Doing → Done**, and let unfinished ones roll over to the next day on their own.

## Install

Open the [latest release](../../releases/latest) and download the file for your system.

- **Windows:** **`Quicky_x.y.z_x64-setup.exe`**. Run it: it installs for your user only, no admin needed, and adds Quicky to the Start menu (and a desktop shortcut). If Windows shows *"Windows protected your PC"*, click **More info**, then **Run anyway**: the installer isn't code-signed yet.
- **macOS** (11 or newer, Apple silicon and Intel): **`Quicky_x.y.z_universal.dmg`**. Open it and drag Quicky into Applications. Quicky isn't notarized by Apple yet, so the first time you open it macOS says it can't check it for malware: open **System Settings**, **Privacy & Security**, and click **Open Anyway** next to Quicky.
- **Linux** (x86-64): the **`.AppImage`** (make it executable and run it) or the **`.deb`**.

Or on Windows, from a terminal, with the [GitHub CLI](https://cli.github.com):

```bash
gh release download --repo PISTAfff/quicky --pattern "*-setup.exe" --dir . && ./Quicky_*_x64-setup.exe
```

On first launch Quicky asks where to keep your data and creates a `Quicky` folder there (picking a folder that's already called `Quicky`, or one that already holds `quicky.json`, uses it as is). Everything stays on your computer.

## Using it

| | |
|---|---|
| **Ctrl+Space** (**⌥ Space** on macOS) | Open Quicky from anywhere and jump to the add box |
| **Enter** | Add the task |
| **Click the circle** | To do → Doing → Done |
| **Right-click the circle** | Step back |
| **Ctrl+F** (**⌘F**) | Search every list |
| **Ctrl+N** (**⌘N**) | Focus the add box |
| **Esc** | Close a panel |

- **Carry-over:** anything not done moves to today, tinted peach with a "Carried · 2nd day" label.
- **Repeats:** the repeat button in the add box opens a day picker: choose exactly which days (S M T W T F S) or Every day. Pick exact weekdays, pause, or stop a repeat from the task or the Repeats list. Each repeat appears once per matching day and never duplicates.
- **Done drawer:** finished tasks hide in the drawer, grouped by day. Restore any of them to today. Ticking a task off shows a quick Undo.
- **Media:** attach files with the paperclip, record a voice note with the mic (a live wave shows your voice while it records; ✕ discards, ■ saves), paste images into the add box, or drop files anywhere on the window. If a task is open, dropped files attach to it.
- **Any size:** drag the window to any shape. It becomes a mini "next up" panel when small, a list by default, and a board with To do / Doing / Done columns when wide (drag cards between columns). The pin button keeps it on top.
- **Bubble:** while the app is closed or minimized, a little Quicky waits on screen (bottom-left at first), always on top, even over the taskbar, with a badge showing how many tasks are left. Click it to open the app right next to it. Drag it anywhere, on any screen; right-click to lock it in place, send it back to the corner, or hide it. Locked, it won't move: tug it and it behaves like jelly: the side you pull stretches after your pointer, it gets angrier the harder you pull, and it snaps back and wobbles to a stop when you let go. Bring a hidden bubble back from Settings or the tray menu.
- **Starts at sign-in:** on by default. Quicky starts quietly at sign-in (tray icon and bubble only). Turn it off, or hide the bubble, in Settings (the gear in the title bar).
- **Reminders:** in a task, *Remind me* has a switch and four ways to schedule: **Once** (a date and time, or quick picks like "In 30 min" / "Tomorrow 9 AM"), **Daily** (any number of editable times, with Morning/Noon/Afternoon/Evening presets), **Some days** (pick the weekdays), and **Repeat** (every 15 min to 3 hours between two times). It shows a plain summary and the next few times; *Not today* skips today, *Stop reminders* clears it, and "Nudge me once in 15m/30m/1h/2h" adds a one-off. The bell pill (or Settings → Reminders → *See all*) lists every reminder across all lists to pause, resume or stop. Times show as AM/PM. Only tasks still to do remind you. When it's time, Quicky pours out of the bubble and fills every screen (the task shows on the bubble's screen) until you answer: **D** I'm on it, **Enter** Done, **O** open the task, **S**/**Esc** snooze 10 min, **1/3/4** snooze 5/30/60 min.
- **Search:** the magnifier in the title bar (or Ctrl+F) searches every list at once, done tasks too: titles, notes, steps and file names, ignoring case and accents.
- **Due dates:** give a task a day it's due (Today, Tomorrow or any date). Cards show "Due Fri", "Due today" or a red "Overdue", and lists put Doing first, then whatever is due soonest.
- **Not today:** put a task off until tomorrow or a day you pick. It hides (its reminders wait too) in the *Later* list next to the Done drawer, and comes back on its day as a fresh task. *Back to today* brings it back early.
- **Steps:** break a task into a small checklist. Cards show "2/3"; ticking the last step offers to finish the task. A repeating task gives each new copy the same steps, unticked.
- **Pin to the bubble:** pin the task you're working on (in the task, *Pin to the bubble*). A speech balloon over the bubble shows it with how long you've been at it, and when you finish it the bubble hops and cheers.
- **Peek:** rest the pointer on the bubble or a mini for a moment: the balloon shows the top three tasks of its list.
- **Drop on the bubble:** drag text, a link or files onto the bubble (or a mini) and it gulps them into a new task in its list: the first line becomes the title, links keep their address in the note, and files are attached.
- **Quiet hours:** Settings, Reminders: reminders wait during the hours you pick, and (on by default) while a full-screen app, game, video or presentation is in front. When it's over, the ones that waited show together on one screen.
- **Tour:** three quick tips on first run; Settings, Tips shows them again.
- **Quick status:** hover a card (always shown in small windows) for one-tap **▶ Doing** / **✓ Done** (or **↺** back to To do) without opening the task.
- **Sounds:** little synthesized sound effects for adding, finishing, deleting, panels, voice notes, the bubble (tap, squash, boing, pop, divide) and reminders. Turn them off or change the volume in Settings.
- **Mini Quicky in your apps:** drop the bubble on any app's window and Quicky *divides*: one half stays as that app's own mini Quicky right there, the other heads home. Whenever that app is focused (and Quicky is closed) the mini sits at its spot, gliding along with the window; other apps get the normal bubble. A mini lives inside its app: drag it around and the window edges are walls. Push it against a wall and hold: it squashes flatter, gets angrier and squeaks higher until it pops out, and that app's mini is gone. Each mini has its own *Lock this mini in place* in its right-click menu, separate from the normal bubble's lock. You can also right-click a mini → *Hide this mini Quicky*: it puffs into droplets that fly home and join back up. Either way, drop Quicky on the app again to bring it back. (Store apps all share one host process, so they share one mini.)
- **Each app has its own tasks:** clicking an app's mini (or pressing Ctrl+Space in that app) opens that app's own list, inside the app: it covers the app with a small margin, and if you resize or move it, that's remembered for that app. It can't be dragged, resized or snapped past the app's edges (maximizing fills just the app). The title-bar pill (with the app's icon) switches between General and your apps' lists, with a count of open tasks for each.
- **Popover, not a background window:** Quicky tucks itself away as soon as you click into another app, and the bubble or mini comes back. Pin it (📌) to keep it open and on top.
- **Colours:** Settings (gear in the title bar) has five accents (Grape, Bubblegum, Mint, Tangerine, Ocean) plus a rainbow swatch to pick any colour you like, and Light / Dark / Match the system. The bubble and the taskbar (Dock on macOS) and tray icons follow along.
- **Tray icon:** left-click opens or hides Quicky, right above the tray. Right-click for *Show* and *Quit*. **Close** only hides Quicky, so Ctrl+Space and the bubble keep working.
- **Updates:** Quicky checks GitHub for a new version a little after it starts and twice a day, and shows a banner when one is ready. *Update and restart* installs it. Check by hand, or turn the automatic check off, in Settings → Updates.

## On macOS and Linux

Everything works the same, with a few differences:

- **macOS:** the quick-add shortcut is **⌥ Space** (Ctrl+Space switches keyboard input sources there). Quicky lives in the menu bar and the Dock; clicking the Dock icon opens it. Minis work with any app.
- **Linux:** Quicky runs on X11 (through XWayland in a Wayland session), because Wayland doesn't let an app place its own windows. Minis work with apps that run on X11 too; apps running natively on Wayland get the normal bubble. The tray icon opens a menu (*Show Quicky*, *Show bubble*, *Quit*) rather than toggling Quicky with a click.

## Your data

```
<your folder>/
├ quicky.json          tasks and repeats (plain JSON, saved atomically)
└ media/2026-11/…      copies of every attachment and voice note
```

Put the folder in OneDrive or Dropbox to sync it. Use the folder button in the title bar to open the folder or switch to another one. Switching doesn't move files.

## Develop

Needs Node 24+, pnpm and Rust (stable), plus the Visual Studio C++ Build Tools on Windows, Xcode's command line tools on macOS, or `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` on Linux (Debian and Ubuntu names).

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

The installer lands in `src-tauri/target/release/bundle/` (`nsis/` on Windows, `dmg/` on macOS, `appimage/` and `deb/` on Linux). Builds also sign the update files, so set `TAURI_SIGNING_PRIVATE_KEY` to the private key (see Releasing) first. Every push to a branch builds all three on GitHub Actions (the *Build* workflow keeps the installers for a week).

**Releasing:** bump `version` in `src-tauri/tauri.conf.json`, then push a tag. GitHub Actions builds Windows, macOS and Linux into one release, signs the update files with the `TAURI_SIGNING_PRIVATE_KEY` repository secret (its password secret is empty), and publishes the release with `latest.json`, which installed copies read to update themselves. Keep the private key safe: without it, existing installs can't trust new versions.

```bash
git tag v0.1.22 && git push origin v0.1.22
```

Stack: [Tauri 2](https://tauri.app) (Rust + the system web view: WebView2, WebKit or WebKitGTK) and [SolidJS](https://www.solidjs.com).
