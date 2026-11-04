import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeData, sameData, emptyData, rollover, type Data, type Task } from "../src/lib/model.ts";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, status: "todo", day: "2026-11-04", since: "2026-11-04", attachments: [], created: 1, ...extra,
});
const data = (tasks: Task[], extra: Partial<Data> = {}): Data => ({ ...emptyData(), tasks, ...extra });

test("each PC's new tasks are kept", () => {
  const base = data([task("a")]);
  const mine = data([task("a"), task("mine")]);
  const theirs = data([task("a"), task("theirs")]);
  assert.deepEqual(mergeData(base, mine, theirs).tasks.map((t) => t.id), ["a", "mine", "theirs"]);
});

test("whichever side changed a task wins; both changed, this PC wins", () => {
  const base = data([task("a"), task("b")]);
  const mine = data([task("a", { status: "done" }), task("b", { title: "mine" })]);
  const theirs = data([task("a"), task("b", { title: "theirs" })]);
  const out = mergeData(base, mine, theirs).tasks;
  assert.equal(out[0].status, "done");
  assert.equal(out[1].title, "mine");
  // Changed only on the other PC: theirs comes through.
  assert.equal(mergeData(base, base, data([task("a", { note: "x" }), task("b")])).tasks[0].note, "x");
});

test("a deletion goes through unless the other side edited the task since", () => {
  const base = data([task("a"), task("b")]);
  // Deleted there, untouched here: gone.
  assert.deepEqual(mergeData(base, base, data([task("b")])).tasks.map((t) => t.id), ["b"]);
  // Deleted here, untouched there: gone.
  assert.deepEqual(mergeData(base, data([task("a")]), base).tasks.map((t) => t.id), ["a"]);
  // Deleted there but edited here: kept.
  const kept = mergeData(base, data([task("a", { title: "edited" }), task("b")]), data([task("b")]));
  assert.deepEqual(kept.tasks.map((t) => t.id), ["a", "b"]);
});

test("key order doesn't count as a change", () => {
  const a = { id: "a", title: "x", status: "todo" };
  const b = { status: "todo", title: "x", id: "a" };
  assert.ok(sameData(a, b));
});

test("both PCs' copies of a repeat for the same day collapse to one", () => {
  const base = data([]);
  const mine = data([task("m1", { repeatId: "r" })]);
  const theirs = data([task("t1", { repeatId: "r" })]);
  assert.deepEqual(mergeData(base, mine, theirs).tasks.map((t) => t.id), ["m1"]);
  assert.deepEqual(mergeData(base, theirs, mine).tasks.map((t) => t.id), ["m1"]);
  // One was already started: that one stays.
  const started = mergeData(base, mine, data([task("t1", { repeatId: "r", status: "doing" })]));
  assert.deepEqual(started.tasks.map((t) => t.id), ["t1"]);
  // Different days are different copies.
  const days = mergeData(base, mine, data([task("t1", { repeatId: "r", since: "2026-11-03" })]));
  assert.equal(days.tasks.length, 2);
});

test("the pin follows whichever side changed it, and only to a task that exists", () => {
  const base = data([task("a"), task("b")]);
  const theirs = data([task("a"), task("b")], { focus: { id: "b", since: 5 } });
  assert.deepEqual(mergeData(base, base, theirs).focus, { id: "b", since: 5 });
  const gone = mergeData(base, data([task("a")]), theirs);
  assert.equal(gone.focus, undefined);
});

test("fields from a newer Quicky survive, and nothing passed in is changed", () => {
  const base = data([task("a")]);
  const theirs = { ...data([task("a")]), future: 1 } as Data;
  const before = JSON.stringify(theirs);
  const out = mergeData(base, base, theirs) as Data & { future?: number };
  assert.equal(out.future, 1);
  assert.equal(JSON.stringify(theirs), before);
});

test("after a laptop wakes on a new day, the other PC's finished and deleted tasks stay that way", () => {
  // Read yesterday; overnight the desktop finished A and deleted B; the laptop wakes and rolls over.
  const yesterday = "2026-11-03", today = "2026-11-04";
  const base = data([task("a", { day: yesterday, since: yesterday }), task("b", { day: yesterday, since: yesterday })]);
  const mine = rollover(base, today);
  const rolledTheirs = rollover(base, today);
  const theirs = { ...rolledTheirs, tasks: [{ ...rolledTheirs.tasks[0], status: "done" as const, doneDay: today }] };
  // The store merges against the base rolled the same way as its own data.
  const out = mergeData(rollover(base, today), mine, theirs);
  assert.deepEqual(out.tasks.map((t) => [t.id, t.status]), [["a", "done"]]);
});
