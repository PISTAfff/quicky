import { createEffect, createMemo, createSignal, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  addAttachments, data, dataDir, flush, init, loadError, nameSpace, ready, setSpace, setToast, showToast, space, tick, toast, today,
} from "./lib/store";
import { importPaths } from "./lib/media";
import { startReminders } from "./lib/reminders";
import { bannerClosed, installUpdate, setBannerClosed, startUpdateChecks, updateState } from "./lib/updates";
import { TitleBar } from "./ui/TitleBar";
import { FolderSetup } from "./ui/FolderSetup";
import { BoardView, ListView, MiniView } from "./ui/Views";
import { Sheets } from "./ui/Sheets";
import { Tour } from "./ui/Tour";
import { dropping, focusQuickAdd, setDropping, setSheet, setStaged, sheet, staged } from "./ui/state";
import { Blob } from "./ui/icons";
import { modDown } from "./lib/platform";
import { isLater } from "./lib/model";

type Mode = "mini" | "list" | "board";
const modeFor = (w: number, h: number): Mode => (w < 330 || h < 340 ? "mini" : w >= 680 ? "board" : "list");

export default function App() {
  const [mode, setMode] = createSignal<Mode>(modeFor(innerWidth, innerHeight));
  const unlisten: (() => void)[] = [];
  let appEl: HTMLDivElement | undefined;

  // Keep the bubble's badge in sync: open tasks in the general list, and per app space for minis.
  const counts = createMemo(() => {
    const spaces: Record<string, number> = {};
    let open = 0;
    for (const t of data.tasks) {
      if (t.status === "done" || isLater(t, today())) continue;
      if (t.space) spaces[t.space] = (spaces[t.space] ?? 0) + 1;
      else open++;
    }
    return { open, spaces };
  });
  // The bubble shows them as its badge; the big-moment overlay (fx) needs them to draw the bubble's
  // all-clear look.
  const sendCounts = () => {
    void emitTo("bubble", "counts", counts());
    void emitTo("fx", "counts", counts());
  };
  createEffect(on(counts, sendCounts));

  onMount(async () => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setMode(modeFor(innerWidth, innerHeight)));
    };
    addEventListener("resize", onResize);
    addEventListener("focus", tick);
    const minute = setInterval(tick, 60_000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sheet()) setSheet(null);
      else if (modDown(e) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        focusQuickAdd();
      } else if (modDown(e) && e.key.toLowerCase() === "f" && dataDir()) {
        e.preventDefault();
        setSheet({ kind: "search" });
      }
    };
    addEventListener("keydown", onKey);
    // Little pop each time the window comes back from the tray or the bubble.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !appEl) return;
      appEl.classList.remove("pop-in");
      void appEl.offsetWidth;
      appEl.classList.add("pop-in");
    };
    document.addEventListener("visibilitychange", onVisible);
    unlisten.push(() => document.removeEventListener("visibilitychange", onVisible));
    unlisten.push(
      () => removeEventListener("resize", onResize),
      () => removeEventListener("focus", tick),
      () => removeEventListener("keydown", onKey),
      () => clearInterval(minute),
    );

    unlisten.push(await listen("quick-add", focusQuickAdd));
    unlisten.push(await listen("bubble-ready", sendCounts));
    // Opened from an app's mini Quicky: show that app's own tasks (null = the general list).
    unlisten.push(
      await listen<{ key: string | null; name?: string }>("open-space", ({ payload }) => {
        if (payload.key && payload.name) nameSpace(payload.key, payload.name);
        if (payload.key !== space()) setSheet(null);
        setSpace(payload.key);
      }),
    );
    unlisten.push(await listen("flush", () => void flush()));
    unlisten.push(
      await getCurrentWebview().onDragDropEvent(async (e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") setDropping(!!dataDir());
        else if (p.type === "leave") setDropping(false);
        else if (p.type === "drop") {
          setDropping(false);
          if (!dataDir() || !p.paths.length) return;
          try {
            const atts = await importPaths(p.paths);
            const s = sheet();
            // Dropped while a task is open: attach there. Otherwise stage for the next new task.
            if (s?.kind === "task") addAttachments(s.id, atts);
            else {
              setStaged([...staged(), ...atts]);
              focusQuickAdd();
            }
          } catch (err) {
            showToast(`Couldn't add files: ${err}`);
          }
        }
      }),
    );

    await init();
    await startReminders();
    startUpdateChecks();
  });
  onCleanup(() => unlisten.forEach((u) => u()));

  return (
    <div class="app pop-in" data-mode={mode()} ref={appEl}>
      <TitleBar />
      <Show when={!bannerClosed() && (updateState().kind === "ready" || updateState().kind === "installing")}>
        <div class="update-banner" role="status">
          <Show
            when={updateState().kind === "ready"}
            fallback={<span>Updating… {Math.round(((updateState() as { progress: number }).progress ?? 0) * 100)}%</span>}
          >
            <span>Quicky {(updateState() as { version: string }).version} is ready</span>
            <button class="btn small" onClick={() => void installUpdate()}>Update and restart</button>
            <button class="icon-btn" aria-label="Later" title="Later" onClick={() => setBannerClosed(true)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </Show>
        </div>
      </Show>
      <main class="content">
        <Show when={ready()}>
          <Show when={!loadError()} fallback={<p class="error pad" role="alert">{loadError()}</p>}>
            <Show when={dataDir()} fallback={<FolderSetup />}>
              <Switch>
                <Match when={mode() === "mini"}><MiniView /></Match>
                <Match when={mode() === "board"}><BoardView /></Match>
                <Match when={mode() === "list"}><ListView /></Match>
              </Switch>
              <Sheets />
              <Tour />
            </Show>
          </Show>
        </Show>
      </main>
      <Show when={toast()}>
        {(t) => (
          <div class="toast" role="status">
            <span>{t().text}</span>
            <Show when={t().action}>
              {(a) => (
                <button
                  onClick={() => {
                    setToast(null);
                    a().run();
                  }}
                >
                  {a().label}
                </button>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={dropping()}>
        <div class="drop-overlay">
          <Blob size={56} />
          <span>{sheet()?.kind === "task" ? "Drop to attach to this task" : "Drop to add to a new task"}</span>
        </div>
      </Show>
    </div>
  );
}
