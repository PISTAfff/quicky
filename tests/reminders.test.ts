import { test } from "node:test";
import assert from "node:assert/strict";
import { dueReminder, nextReminder, upcoming, describeReminder, rollover, emptyData, type Task, type Data, type Reminder } from "../src/lib/model.ts";

const at = (h: number, m = 0) => new Date(2026, 10, 1, h, m);
const task = (over: Partial<Task>): Task => ({
  id: "t", title: "t", status: "todo", day: "2026-11-01", since: "2026-11-01", attachments: [], created: 0, ...over,
});

test("fires the latest passed time once", () => {
  const t = task({ remind: ["09:00", "15:00"] });
  assert.equal(dueReminder(t, at(8, 59)), null);
  assert.equal(dueReminder(t, at(9, 0)), "2026-11-01 09:00");
  assert.equal(dueReminder({ ...t, lastFired: "2026-11-01 09:00" }, at(12)), null);
  assert.equal(dueReminder({ ...t, lastFired: "2026-11-01 09:00" }, at(15, 1)), "2026-11-01 15:00");
});

test("a missed time catches up, but not when far too late", () => {
  const t = task({ remind: ["09:00"] });
  assert.equal(dueReminder(t, at(14, 30)), "2026-11-01 09:00");
  assert.equal(dueReminder(t, at(15, 30)), null);
});

test("fires again the next day", () => {
  const t = task({ remind: ["09:00"], lastFired: "2026-10-31 09:00" });
  assert.equal(dueReminder(t, at(9, 5)), "2026-11-01 09:00");
});

test("only to-do tasks remind", () => {
  assert.equal(dueReminder(task({ remind: ["09:00"], status: "doing" }), at(10)), null);
  assert.equal(dueReminder(task({ remind: ["09:00"], status: "done" }), at(10)), null);
});

test("snooze replaces the schedule until it goes off", () => {
  const until = at(10, 10).getTime();
  const t = task({ remind: ["10:05"], snoozeUntil: until, lastFired: "2026-11-01 09:00" });
  assert.equal(dueReminder(t, at(10, 6)), null);
  assert.equal(dueReminder(t, at(10, 10)), `snooze ${until}`);
  assert.equal(nextReminder(t, at(10, 0)), "10:10 AM");
});

test("next reminder shows the upcoming time", () => {
  const t = task({ remind: ["18:00", "09:00", "13:30"] });
  assert.equal(nextReminder(t, at(10)), "1:30 PM");
  assert.equal(nextReminder(t, at(19)), "Tomorrow 9:00 AM");
  assert.equal(nextReminder({ ...t, status: "done" }, at(10)), null);
});

test("repeating tasks bring their reminder times along", () => {
  const data: Data = { ...emptyData(), repeats: [{ id: "r", title: "Water", days: [0], remind: ["11:00"] }] };
  const out = rollover(data, "2026-11-01");
  assert.deepEqual(out.tasks[0].remind, ["11:00"]);
});

const rem = (over: Partial<Reminder>): Reminder => ({ on: true, mode: "daily", times: [], days: [], ...over });

test("some days: only on the picked weekdays", () => {
  // 2026-11-01 is a Sunday.
  const t = task({ reminder: rem({ mode: "days", days: [1, 2], times: ["09:00"] }) });
  assert.equal(dueReminder(t, at(9, 30)), null);
  assert.equal(nextReminder(t, at(9, 30)), "Tomorrow 9:00 AM");
});

test("every N minutes inside a window", () => {
  const t = task({ reminder: rem({ mode: "every", every: 30, from: "09:00", to: "11:00" }) });
  assert.equal(dueReminder(t, at(8, 59)), null);
  assert.equal(dueReminder(t, at(10, 40)), "2026-11-01 10:30");
  assert.deepEqual(upcoming(t, at(10, 40), 3).map((ms) => new Date(ms).getHours() * 60 + new Date(ms).getMinutes()), [11 * 60, 9 * 60, 9 * 60 + 30]);
});

test("once fires once, at its moment", () => {
  const when = at(14, 15).getTime();
  const t = task({ reminder: rem({ mode: "once", at: when }) });
  assert.equal(dueReminder(t, at(14, 0)), null);
  assert.equal(dueReminder(t, at(14, 16)), `once ${when}`);
  assert.equal(dueReminder({ ...t, lastFired: `once ${when}` }, at(14, 30)), null);
});

test("off and not-today stay quiet, but keep their settings", () => {
  const r = rem({ times: ["09:00"] });
  assert.equal(dueReminder(task({ reminder: { ...r, on: false } }), at(9, 5)), null);
  assert.equal(dueReminder(task({ reminder: { ...r, skip: "2026-11-01" } }), at(9, 5)), null);
  assert.equal(nextReminder(task({ reminder: { ...r, skip: "2026-11-01" } }), at(8)), "Tomorrow 9:00 AM");
});

test("summaries read naturally", () => {
  const now = at(8);
  assert.equal(describeReminder(rem({ times: ["15:30", "09:00"] }), now), "Every day at 9:00 AM, 3:30 PM");
  assert.equal(describeReminder(rem({ mode: "days", days: [5, 6], times: ["10:00"] }), now), "Fri, Sat at 10:00 AM");
  assert.equal(describeReminder(rem({ mode: "every", every: 90, from: "09:00", to: "17:00" }), now), "Every 90 min, 9:00 AM–5:00 PM");
  assert.equal(describeReminder(rem({ mode: "every", every: 120 }), now), "Every 2 h, 9:00 AM–6:00 PM");
  assert.equal(describeReminder(rem({ times: ["00:05", "12:00"] }), now), "Every day at 12:05 AM, 12:00 PM");
  assert.equal(describeReminder({ ...rem({}), on: false }, now), "Off");
});