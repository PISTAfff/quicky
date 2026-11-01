import { test } from "node:test";
import assert from "node:assert/strict";
import { rollover, emptyData, dayKey, type Data, type Task } from "../src/lib/model.ts";

const task = (over: Partial<Task>): Task => ({
  id: Math.random().toString(36),
  title: "t",
  status: "todo",
  day: "2026-10-30",
  since: "2026-10-30",
  attachments: [],
  created: 0,
  ...over,
});

test("open tasks carry across several days and keep their origin", () => {
  const data: Data = { ...emptyData(), tasks: [task({ id: "a" }), task({ id: "b", status: "doing" })] };
  const out = rollover(rollover(data, "2026-10-31"), "2026-11-01");
  assert.deepEqual(out.tasks.map((t) => [t.id, t.day, t.since, t.status]), [
    ["a", "2026-11-01", "2026-10-30", "todo"],
    ["b", "2026-11-01", "2026-10-30", "doing"],
  ]);
});

test("done tasks stay on their day", () => {
  const data: Data = { ...emptyData(), tasks: [task({ status: "done", doneDay: "2026-10-30" })] };
  assert.equal(rollover(data, "2026-11-01").tasks[0].day, "2026-10-30");
});

test("repeat spawns once per matching day, never duplicates", () => {
  let data: Data = { ...emptyData(), repeats: [{ id: "r", title: "Water", days: [0, 1, 2, 3, 4, 5, 6] }] };
  data = rollover(data, "2026-11-01");
  data = rollover(data, "2026-11-01");
  assert.equal(data.tasks.length, 1);

  // Not done yesterday: the copy carries over instead of a second copy appearing.
  data = rollover(data, "2026-11-02");
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].day, "2026-11-02");

  // Done, then next day: a fresh copy.
  data = { ...data, tasks: data.tasks.map((t) => ({ ...t, status: "done" as const, doneDay: "2026-11-02" })) };
  data = rollover(data, "2026-11-03");
  assert.equal(data.tasks.filter((t) => t.status !== "done").length, 1);
});

test("weekday-only repeat skips weekends", () => {
  // 2026-11-01 is a Sunday.
  const data: Data = { ...emptyData(), repeats: [{ id: "r", title: "Standup", days: [1, 2, 3, 4, 5] }] };
  assert.equal(rollover(data, "2026-11-01").tasks.length, 0);
  assert.equal(rollover(data, "2026-11-02").tasks.length, 1);
});

test("paused repeat spawns nothing", () => {
  const data: Data = { ...emptyData(), repeats: [{ id: "r", title: "x", days: [0], paused: true }] };
  assert.equal(rollover(data, "2026-11-01").tasks.length, 0);
});

test("unchanged data returns the same object", () => {
  const data: Data = { ...emptyData(), tasks: [task({ day: "2026-11-01" })] };
  assert.equal(rollover(data, "2026-11-01"), data);
});

test("dayKey uses the local date", () => {
  assert.equal(dayKey(new Date(2026, 10, 1, 23, 59)), "2026-11-01");
  assert.equal(dayKey(new Date(2026, 10, 2, 0, 1)), "2026-11-02");
});
