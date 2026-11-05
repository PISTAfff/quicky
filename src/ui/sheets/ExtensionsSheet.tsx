import { createSignal, For, Show } from "solid-js";
import { installExtension, listExtensions, openExtension, readAccount, readInstalled, removeExtension, type Extension } from "../../lib/cloud";
import { showToast } from "../../lib/store";
import { setSheet } from "../state";
import { Panel } from "./Panel";

/** Extensions from Quicky's server: install, open, update, remove. Each runs in its own window. */
export function ExtensionsSheet() {
  const account = readAccount();
  const signedIn = !!account && account.user.verified !== false;
  const [available, setAvailable] = createSignal<Extension[] | null>(null);
  const [installed, setInstalled] = createSignal(readInstalled());
  const [error, setError] = createSignal("");
  const [working, setWorking] = createSignal("");
  /** Per extension: being checked for an update right now, or found up to date. */
  const [checks, setChecks] = createSignal<Record<string, "checking" | "latest">>({});

  /** Asks Quicky's server again for one extension's latest version. */
  const check = async (id: string) => {
    setChecks({ ...checks(), [id]: "checking" });
    try {
      const list = await listExtensions();
      setAvailable(list);
      setError("");
      const ext = list.find((x) => x.id === id);
      const local = mine(id);
      const next = { ...checks() };
      if (ext && local && local.sha256 === ext.sha256) next[id] = "latest";
      else delete next[id];
      setChecks(next);
    } catch (e) {
      const next = { ...checks() };
      delete next[id];
      setChecks(next);
      showToast((e as Error).message);
    }
  };
  /** Installed extensions with a newer version on the server. */
  const outdated = () => (available() ?? []).filter((x) => {
    const l = mine(x.id);
    return l && l.sha256 !== x.sha256;
  });
  const updateAll = () =>
    act("all", async () => {
      for (const x of outdated()) await installExtension(x);
    }, "Extensions updated");

  const load = () =>
    listExtensions()
      .then(setAvailable)
      .catch((e: Error) => {
        setAvailable([]);
        setError(e.message);
      });
  if (signedIn) void load();

  const act = async (id: string, job: () => Promise<unknown>, done?: string) => {
    setWorking(id);
    try {
      await job();
      setInstalled(readInstalled());
      if (done) showToast(done);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setWorking("");
    }
  };

  const mine = (id: string) => installed().find((i) => i.id === id);
  // Installed ones the server no longer lists still show, so they can be opened or removed.
  const orphans = () => installed().filter((i) => !(available() ?? []).some((a) => a.id === i.id));

  return (
    <Panel title="Extensions" class="extensions-sheet">
      <Show
        when={signedIn}
        fallback={
          <div class="box">
            <p class="muted">
              {account ? "Confirm your email first: type the code we sent you." : "Sign in to add extensions like Projects, a shared whiteboard for planning with others."}
            </p>
            <button class="btn primary" onClick={() => setSheet({ kind: "account" })}>{account ? "Confirm email" : "Sign in"}</button>
          </div>
        }
      >
        <Show when={available()} fallback={<p class="muted">Loading extensions…</p>}>
          <Show when={outdated().length > 1}>
            <div class="box box-row">
              <span class="box-label">{outdated().length} updates ready</span>
              <button class="btn small primary" disabled={!!working()} onClick={updateAll}>
                {working() === "all" ? "Updating…" : "Update all"}
              </button>
            </div>
          </Show>
          <Show when={error()}>
            <p class="error" role="alert">{error()}</p>
          </Show>
          <Show when={!error() && !available()!.length && !installed().length}>
            <p class="muted">No extensions are available yet.</p>
          </Show>
          <For each={available()!}>
            {(ext) => {
              const local = () => mine(ext.id);
              return (
                <div class="box ext-card">
                  <span class="box-label">
                    {ext.name}
                    <small class="muted">
                      {local() && local()!.sha256 !== ext.sha256 ? `v${local()!.version} → v${ext.version}` : `v${local()?.version ?? ext.version}`}
                    </small>
                  </span>
                  <Show when={ext.description}>
                    <small class="muted">{ext.description}</small>
                  </Show>
                  <Show when={checks()[ext.id] === "latest" && local() && local()!.sha256 === ext.sha256}>
                    <small class="muted" role="status">Up to date: v{local()!.version} is the latest.</small>
                  </Show>
                  <div class="ext-actions">
                    <Show
                      when={local()}
                      fallback={
                        <button class="btn small primary" disabled={!!working()} onClick={() => act(ext.id, () => installExtension(ext), `${ext.name} is installed`)}>
                          {working() === ext.id ? "Installing…" : "Install"}
                        </button>
                      }
                    >
                      <button class="btn small primary" onClick={() => act(ext.id, () => openExtension(local()!))}>Open</button>
                      <Show
                        when={local()!.sha256 !== ext.sha256}
                        fallback={
                          <button class="btn small" disabled={!!working() || checks()[ext.id] === "checking"} onClick={() => void check(ext.id)}>
                            {checks()[ext.id] === "checking" ? "Checking…" : "Check for updates"}
                          </button>
                        }
                      >
                        <button class="btn small" disabled={!!working()} onClick={() => act(ext.id, () => installExtension(ext), `${ext.name} is updated to v${ext.version}`)}>
                          {working() === ext.id ? "Updating…" : `Update to v${ext.version}`}
                        </button>
                      </Show>
                      <button class="btn small ghost" disabled={!!working()} onClick={() => act(ext.id, () => removeExtension(ext.id), `${ext.name} was removed`)}>
                        Remove
                      </button>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
          <For each={orphans()}>
            {(i) => (
              <div class="box ext-card">
                <div class="box-row">
                  <span class="box-label">{i.name} <small class="muted">v{i.version}</small></span>
                  <span class="row-gap">
                    <button class="btn small primary" onClick={() => act(i.id, () => openExtension(i))}>Open</button>
                    <button class="btn small ghost" onClick={() => act(i.id, () => removeExtension(i.id), `${i.name} was removed`)}>Remove</button>
                  </span>
                </div>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </Panel>
  );
}
