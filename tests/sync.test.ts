import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync, emptyData, type Data, type Task } from "../src/lib/model.ts";

const today = "2026-11-05";
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, status: "todo", day: today, since: today, attachments: [], created: 0, ...over,
});
const data = (...tasks: Task[]): Data => ({ ...emptyData(), tasks });
const ids = (d: Data) => d.tasks.map((t) => t.id).sort();

test("first sync of a PC: its tasks and the account's are put together", () => {
  const p = planSync(null, { rev: 3, data: data(task("a"), task("b")) }, data(task("c")), today);
  assert.deepEqual(ids(p.merged), ["a", "b", "c"]);
  assert.ok(p.apply && p.upload);
});

test("nothing new on the server: only this PC's changes go up", () => {
  const base = data(task("a"));
  const p = planSync({ rev: 2, base }, { rev: 2, data: base }, data(task("a"), task("b")), today);
  assert.deepEqual(ids(p.merged), ["a", "b"]);
  assert.ok(!p.apply && p.upload);
  const same = planSync({ rev: 2, base }, { rev: 2, data: base }, base, today);
  assert.ok(!same.upload, "nothing changed anywhere");
});

test("a task deleted on another PC is deleted here", () => {
  const base = data(task("a"), task("b"));
  const p = planSync({ rev: 1, base }, { rev: 2, data: data(task("a")) }, data(task("a"), task("b")), today);
  assert.deepEqual(ids(p.merged), ["a"]);
  assert.ok(p.apply && !p.upload);
});

test("the server lost its copy: nothing is deleted here, and it all goes back up", () => {
  const base = data(task("a"), task("b"));
  const p = planSync({ rev: 7, base }, { rev: 0, data: null }, data(task("a"), task("b")), today);
  assert.deepEqual(ids(p.merged), ["a", "b"]);
  assert.ok(!p.apply && p.upload);
});

test("the server went back to an older copy (a backup): tasks added since stay", () => {
  const base = data(task("a"), task("b"), task("c"));
  const p = planSync({ rev: 9, base }, { rev: 4, data: data(task("a")) }, data(task("a"), task("b"), task("c")), today);
  assert.deepEqual(ids(p.merged), ["a", "b", "c"]);
  assert.ok(p.upload);
});

test("a new day between syncs doesn't undo what another PC finished", () => {
  const yesterday = "2026-11-04";
  const open = task("a", { day: yesterday, since: yesterday });
  // Another PC finished it; this PC only rolled it onto today.
  const theirs = data(task("a", { day: yesterday, since: yesterday, status: "done", doneDay: yesterday }));
  const mine = data(task("a", { day: today, since: yesterday }));
  const p = planSync({ rev: 1, base: data(open) }, { rev: 2, data: theirs }, mine, today);
  assert.equal(p.merged.tasks[0].status, "done");
});
