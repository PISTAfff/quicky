---
paths:
  - "src/lib/model.ts"
  - "src/lib/store.ts"
  - "src/lib/reminders.ts"
  - "tests/**"
---

# Data model rules
- `src/lib/model.ts` stays pure (no Tauri, no DOM beyond `Date`) so `tests/` can import it with Node's test runner; anything with side effects goes in `store.ts`.
- `quicky.json` is the user's data: only add optional fields; old shapes must keep working through a reader (e.g. `reminderOf()` turns the old `remind: string[]` into a daily `Reminder`). Rewrite to the new shape only when the user edits that item.
- Day keys are local `YYYY-MM-DD` from `dayKey()` (never `toISOString()`, which is UTC); days ahead come from `plusDays()` (calendar days, safe across clock changes), never `Date.now() + n * 86_400_000`.
- `rollover()` must stay idempotent and return the same object when nothing changed; repeats spawn at most one copy per day and copy `reminder` and `space` onto it.
- Reminders: only `status === "todo"` tasks remind; `dueReminder()` returns a key recorded in `lastFired` so each moment shows once; a snooze replaces the schedule until it fires; missed moments catch up only within `CATCH_UP_MS`.
- Every behaviour change in these files gets a test in `tests/` (`rollover.test.ts`, `reminders.test.ts`); run `pnpm test`.
- Store actions go through `mutate()` (it schedules the save); play the matching `sfx` sound in the action, not in components.
