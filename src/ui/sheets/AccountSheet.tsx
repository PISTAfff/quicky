import { createSignal, Match, Show, Switch } from "solid-js";
import { forgotPassword, readAccount, refreshAccount, resendVerification, resetPassword, signIn, signOut, signUp, verifyEmail } from "../../lib/cloud";
import { showToast } from "../../lib/store";
import { setSheet } from "../state";
import { Panel } from "./Panel";
import { IS_MOBILE } from "../../lib/platform";

type Mode = "signin" | "signup" | "forgot" | "reset";

/** Signing in to Quicky's server, for online projects and extensions. Tasks stay on this PC. */
export function AccountSheet() {
  const [account, setAccount] = createSignal(readAccount());
  const [mode, setMode] = createSignal<Mode>("signin");
  const [email, setEmail] = createSignal(account()?.user.email ?? "");
  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  if (account()) void refreshAccount().then(setAccount);

  const go = (m: Mode) => {
    setMode(m);
    setError("");
    setPassword("");
  };

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await job();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    const m = mode();
    if (m === "signin") void run(async () => setAccount(await signIn(email(), password())));
    else if (m === "signup") void run(async () => setAccount(await signUp(email(), password(), name())));
    else if (m === "forgot")
      void run(async () => {
        await forgotPassword(email());
        go("reset");
      });
    else
      void run(async () => {
        setAccount(await resetPassword(email(), code(), password()));
        showToast("New password saved. Other devices were signed out");
      });
  };

  const confirmed = () => account()?.user.verified !== false;
  const confirm = (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    void run(async () => {
      await verifyEmail(code());
      setAccount(readAccount());
      setCode("");
      showToast("Email confirmed");
    });
  };

  const title = () => (account() ? (confirmed() ? "Account" : "Confirm your email") : { signin: "Sign in", signup: "Create an account", forgot: "Forgot password", reset: "Choose a new password" }[mode()]);

  return (
    <Panel title={title()} class="account-sheet">
      <Show
        when={account()}
        fallback={
          <form class="box account-form" onSubmit={submit}>
            <p class="muted">
              <Switch>
                <Match when={mode() === "signin" || mode() === "signup"}>{IS_MOBILE ? "An account keeps your tasks the same on this phone and your PCs, and is for online projects and extensions." : "An account is for online projects and extensions. Your tasks stay on this computer."}</Match>
                <Match when={mode() === "forgot"}>We'll email you a 6-digit code to choose a new password.</Match>
                <Match when={mode() === "reset"}>Type the code we emailed to {email()} and your new password. The code works for 30 minutes.</Match>
              </Switch>
            </p>
            <Show when={mode() === "signup"}>
              <label class="field">
                <span>Name</span>
                <input id="acct-name" autocomplete="name" maxLength={60} value={name()} onInput={(e) => setName(e.currentTarget.value)} required />
              </label>
            </Show>
            <Show when={mode() !== "reset"}>
              <label class="field">
                <span>Email</span>
                <input id="acct-email" type="email" autocomplete="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required />
              </label>
            </Show>
            <Show when={mode() === "reset"}>
              <label class="field">
                <span>Code</span>
                <input id="acct-code" inputmode="numeric" autocomplete="one-time-code" maxLength={6} value={code()} onInput={(e) => setCode(e.currentTarget.value)} required />
              </label>
            </Show>
            <Show when={mode() !== "forgot"}>
              <label class="field">
                <span>{mode() === "reset" ? "New password" : "Password"}</span>
                <input
                  id="acct-password"
                  type="password"
                  autocomplete={mode() === "signin" ? "current-password" : "new-password"}
                  minLength={mode() === "signin" ? undefined : 8}
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                  required
                />
                <Show when={mode() !== "signin"}>
                  <small class="muted">At least 8 characters</small>
                </Show>
              </label>
            </Show>
            <Show when={error()}>
              <p class="error" role="alert">{error()}</p>
            </Show>
            <button class="btn primary" type="submit" disabled={busy()}>
              {busy() ? "One moment…" : { signin: "Sign in", signup: "Create account", forgot: "Email me a code", reset: "Save new password" }[mode()]}
            </button>
            <div class="account-links">
              <Switch>
                <Match when={mode() === "signin"}>
                  <button type="button" class="link" onClick={() => go("signup")}>Create an account</button>
                  <button type="button" class="link" onClick={() => go("forgot")}>Forgot password?</button>
                </Match>
                <Match when={mode() === "signup"}>
                  <button type="button" class="link" onClick={() => go("signin")}>I already have an account</button>
                </Match>
                <Match when={mode() === "forgot" || mode() === "reset"}>
                  <button type="button" class="link" onClick={() => go("signin")}>Back to sign in</button>
                  <Show when={mode() === "reset"}>
                    <button type="button" class="link" onClick={() => go("forgot")}>Send a new code</button>
                  </Show>
                </Match>
              </Switch>
            </div>
          </form>
        }
      >
        {(a) => (
          <>
            <Show when={!confirmed()}>
              <form class="box account-form" onSubmit={confirm}>
                <p class="muted">We emailed a 6-digit code to {a().user.email}. Type it here to finish setting up your account.</p>
                <label class="field">
                  <span>Code</span>
                  <input id="acct-verify" inputmode="numeric" autocomplete="one-time-code" maxLength={6} value={code()} onInput={(e) => setCode(e.currentTarget.value)} required />
                </label>
                <Show when={error()}>
                  <p class="error" role="alert">{error()}</p>
                </Show>
                <button class="btn primary" type="submit" disabled={busy()}>{busy() ? "One moment…" : "Confirm email"}</button>
                <div class="account-links">
                  <button
                    type="button"
                    class="link"
                    onClick={() =>
                      void run(async () => {
                        await resendVerification();
                        showToast("A new code is on its way");
                      })
                    }
                  >
                    Send a new code
                  </button>
                  <small class="muted">Not there? Check your spam folder.</small>
                </div>
              </form>
            </Show>
            <div class="box">
              <span class="box-label">{a().user.name}</span>
              <span class="muted">{a().user.email}</span>
            </div>
            <div class="sheet-actions">
              <button class="btn ghost" disabled={!confirmed()} onClick={() => setSheet({ kind: "extensions" })}>Extensions</button>
              <button
                class="btn ghost"
                onClick={async () => {
                  await signOut();
                  setAccount(null);
                  go("signin");
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </Show>
    </Panel>
  );
}
