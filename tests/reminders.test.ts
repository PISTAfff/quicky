import { test } from "node:test";
import assert from "node:assert/strict";
import { dueReminder, nextReminder, rollover, emptyData, type Task, type Data } from "../src/lib/model.ts";

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
  assert.equal(nextReminder(t, at(10, 0)), "10:10");
});

test("next reminder shows the upcoming time", () => {
  const t = task({ remind: ["18:00", "09:00", "13:30"] });
  assert.equal(nextReminder(t, at(10)), "13:30");
  assert.equal(nextReminder(t, at(19)), null);
});

test("repeating tasks bring their reminder times along", () => {
  const data: Data = { ...emptyData(), repeats: [{ id: "r", title: "Water", days: [0], remind: ["11:00"] }] };
  const out = rollover(data, "2026-11-01");
  assert.deepEqual(out.tasks[0].remind, ["11:00"]);
});
