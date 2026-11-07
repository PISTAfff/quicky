import { Show } from "solid-js";
import { sheet } from "./state";
import { TaskSheet } from "./sheets/TaskSheet";
import { DoneDrawer } from "./sheets/DoneDrawer";
import { LaterSheet } from "./sheets/LaterSheet";
import { SearchSheet } from "./sheets/SearchSheet";
import { RepeatsSheet } from "./sheets/RepeatsSheet";
import { RemindersSheet } from "./sheets/RemindersSheet";
import { SettingsSheet } from "./sheets/SettingsSheet";
import { AccountSheet } from "./sheets/AccountSheet";
import { ExtensionsSheet } from "./sheets/ExtensionsSheet";
import { FeedbackSheet } from "./sheets/FeedbackSheet";
import { ShortcutsSheet } from "./sheets/ShortcutsSheet";

export function Sheets() {
  return (
    <Show when={sheet()} keyed>
      {(s) =>
        s.kind === "task" ? <TaskSheet id={s.id} edit={s.edit} />
        : s.kind === "done" ? <DoneDrawer />
        : s.kind === "later" ? <LaterSheet />
        : s.kind === "search" ? <SearchSheet />
        : s.kind === "repeats" ? <RepeatsSheet />
        : s.kind === "reminders" ? <RemindersSheet />
        : s.kind === "account" ? <AccountSheet />
        : s.kind === "extensions" ? <ExtensionsSheet />
        : s.kind === "feedback" ? <FeedbackSheet />
        : s.kind === "shortcuts" ? <ShortcutsSheet />
        : <SettingsSheet />
      }
    </Show>
  );
}
