import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byUrgency, dueLabel, dueReminder, emptyData, inQuietHours, plusDays, rollover, searchTasks, shortDueLabel, stepsDone, upcoming,
  type Data, type Task,
} from "../src/lib/model.ts";

const task = (over: Partial<Task>): Task => ({
  id: Math.random().toString(36), title: "t", status: "todo", day: "2026-11-01", since: "2026-11-01", attachments: [], created: 0, ...over,
});

test("not today: hidden until its day, then back as a fresh task", () => {
  const data: Data = { ...emptyData(), tasks: [task({ id: "a", since: "2026-10-28", later: "2026-11-03" })] };
  const mid = rollover(data, "2026-11-02");
  assert.equal(mid.tasks[0].later, "2026-11-03");
  const back = rollover(mid, "2026-11-03");
  assert.equal(back.tasks[0].later, undefined);
  assert.equal(back.tasks[0].since, "2026-11-03");
  assert.equal(back.tasks[0].day, "2026-11-03");
  assert.equal(rollover(back, "2026-11-03"), back, "nothing left to change");
});

test("reminders wait while a task is put off", () => {
  const t = task({ remind: ["09:00"], later: "2026-11-02" });
  assert.equal(dueReminder(t, new Date(2026, 10, 1, 9, 30)), null);
  assert.equal(dueReminder(t, new Date(2026, 10, 2, 9, 30)), "2026-11-02 09:00");
  assert.deepEqual(upcoming(t, new Date(2026, 10, 1, 8), 1), [new Date(2026, 10, 2, 9).getTime()]);
});

test("repeats copy their checklist, unticked", () => {
  const data: Data = { ...emptyData(), repeats: [{ id: "r", title: "Pack", days: [0, 1, 2, 3, 4, 5, 6], steps: ["Keys", "Phone"] }] };
  const out = rollover(data, "2026-11-01");
  assert.deepEqual(out.tasks[0].steps?.map((s) => [s.title, s.done]), [["Keys", false], ["Phone", false]]);
  assert.deepEqual(stepsDone(out.tasks[0]), { done: 0, total: 2 });
  assert.equal(stepsDone(task({})), null);
});

test("due labels", () => {
  assert.deepEqual(dueLabel("2026-11-01", "2026-11-01"), { text: "Due today", tone: "today" });
  assert.deepEqual(dueLabel("2026-11-02", "2026-11-01"), { text: "Due tomorrow", tone: "soon" });
  assert.deepEqual(dueLabel("2026-11-06", "2026-11-01"), { text: "Due Fri", tone: "soon" });
  assert.deepEqual(dueLabel("2026-11-20", "2026-11-01"), { text: "Due 20 Nov", tone: "soon" });
  assert.deepEqual(dueLabel("2026-10-31", "2026-11-01"), { text: "Overdue · yesterday", tone: "late" });
  assert.deepEqual(dueLabel("2026-10-26", "2026-11-01"), { text: "Overdue · Mon 26", tone: "late" });
});

test("doing first, then soonest due", () => {
  const list = [task({ id: "plain" }), task({ id: "later", due: "2026-11-09" }), task({ id: "late", due: "2026-10-30" }), task({ id: "doing", status: "doing" })];
  assert.deepEqual(list.sort(byUrgency).map((t) => t.id), ["doing", "late", "later", "plain"]);
});

test("search finds words anywhere, ignoring case and accents", () => {
  const tasks = [
    task({ id: "a", title: "Buy coffee", note: "the Café on 5th" }),
    task({ id: "b", title: "Pack", steps: [{ id: "s", title: "Passport", done: false }] }),
    task({ id: "c", title: "Old coffee run", status: "done", doneDay: "2026-10-30" }),
    task({ id: "d", title: "Coffee with Sam", status: "doing" }),
  ];
  assert.deepEqual(searchTasks(tasks, "coffee").map((t) => t.id), ["d", "a", "c"]);
  assert.deepEqual(searchTasks(tasks, "cafe buy").map((t) => t.id), ["a"]);
  assert.deepEqual(searchTasks(tasks, "PASSPORT").map((t) => t.id), ["b"]);
  assert.deepEqual(searchTasks(tasks, "   "), []);
});

test("quiet hours, including past midnight", () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 1, h, m);
  assert.equal(inQuietHours(at(23), "22:00", "08:00"), true);
  assert.equal(inQuietHours(at(7, 59), "22:00", "08:00"), true);
  assert.equal(inQuietHours(at(8), "22:00", "08:00"), false);
  assert.equal(inQuietHours(at(13), "12:00", "14:00"), true);
  assert.equal(inQuietHours(at(14), "12:00", "14:00"), false);
  assert.equal(inQuietHours(at(14), "09:00", "09:00"), false);
});

test("days ahead go by the calendar, across months, years and clock changes", () => {
  assert.equal(plusDays(1, new Date(2026, 0, 31, 23, 30)), "2026-02-01");
  assert.equal(plusDays(1, new Date(2026, 11, 31)), "2027-01-01");
  assert.equal(plusDays(0, new Date(2026, 10, 2, 9)), "2026-11-02");
  // The night clocks go back (a 25-hour day in many places) still moves exactly one day.
  assert.equal(plusDays(1, new Date(2026, 9, 25, 0, 30)), "2026-10-26");
  assert.equal(plusDays(-1, new Date(2026, 2, 1)), "2026-02-28");
});

test("short due labels, for tight spots", () => {
  assert.equal(shortDueLabel("2026-11-01", "2026-11-02"), "Overdue");
  assert.equal(shortDueLabel("2026-11-02", "2026-11-02"), "Today");
  assert.equal(shortDueLabel("2026-11-03", "2026-11-02"), "Tomorrow");
  assert.equal(shortDueLabel("2026-11-06", "2026-11-02"), "Fri");
  assert.equal(shortDueLabel("2026-11-20", "2026-11-02"), "20 Nov");
});
