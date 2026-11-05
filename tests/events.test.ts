import { test } from "node:test";
import assert from "node:assert/strict";
import { eventAlarms, eventStarts, type CalEvent } from "../src/lib/model.ts";

const ev = (over: Partial<CalEvent>): CalEvent => ({
  id: "e", title: "e", note: "", start: "2026-11-10", end: "2026-11-10", allDay: true, time: null, repeat: "none", until: null, remind: null, ...over,
});

test("a one-off event shows on its days only", () => {
  assert.deepEqual(eventStarts(ev({}), "2026-11-01", "2026-11-30"), ["2026-11-10"]);
  assert.deepEqual(eventStarts(ev({}), "2026-11-11", "2026-11-30"), []);
  // A multi-day event touches a range that starts in its middle.
  assert.deepEqual(eventStarts(ev({ end: "2026-11-13" }), "2026-11-12", "2026-11-30"), ["2026-11-10"]);
});

test("daily and weekly repeats, with an end day", () => {
  assert.deepEqual(eventStarts(ev({ repeat: "daily", until: "2026-11-12" }), "2026-11-01", "2026-11-30"), ["2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.deepEqual(eventStarts(ev({ repeat: "weekly" }), "2026-11-15", "2026-12-01"), ["2026-11-17", "2026-11-24", "2026-12-01"]);
  // Far in the future: jumps ahead rather than walking every week.
  assert.deepEqual(eventStarts(ev({ repeat: "weekly" }), "2036-11-04", "2036-11-10"), ["2036-11-04"]);
  // A two-day weekly event started the day before the range.
  assert.deepEqual(eventStarts(ev({ repeat: "weekly", end: "2026-11-11" }), "2026-11-18", "2026-11-18"), ["2026-11-17"]);
});

test("monthly skips months without the day, yearly skips Feb 29 off leap years", () => {
  assert.deepEqual(eventStarts(ev({ start: "2026-01-31", end: "2026-01-31", repeat: "monthly" }), "2026-01-01", "2026-05-31"), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  assert.deepEqual(eventStarts(ev({ start: "2028-02-29", end: "2028-02-29", repeat: "yearly" }), "2028-01-01", "2033-01-01"), ["2028-02-29", "2032-02-29"]);
});

test("reminders: minutes before the time, all-day ones before 9 AM", () => {
  const now = new Date(2026, 10, 10, 8, 0);
  const timed = eventAlarms(ev({ allDay: false, time: "15:30", remind: 30 }), now);
  assert.deepEqual(timed.map((a) => [a.key, new Date(a.at).getHours(), new Date(a.at).getMinutes()]), [["e@2026-11-10", 15, 0]]);
  const allDay = eventAlarms(ev({ remind: 1440 }), now);
  assert.equal(new Date(allDay[0].at).getDate(), 9, "a day before 9 AM");
  assert.deepEqual(eventAlarms(ev({}), now), [], "no reminder set");
});
