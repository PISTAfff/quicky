import { test } from "node:test";
import assert from "node:assert/strict";
import { fromEvent, keyName, label, matches, normalize, problem } from "../src/lib/keys.ts";

const press = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
});

test("keys are written one way, like Rust's canonical form", () => {
  assert.equal(normalize("Ctrl+Shift+D"), "Ctrl+Shift+D");
  assert.equal(normalize("shift+control+KeyD"), "Ctrl+Shift+D");
  assert.equal(normalize("Option+Space"), "Alt+Space");
  assert.equal(normalize("Command+Digit1"), "Super+1");
  assert.equal(normalize("ctrl+f5"), "Ctrl+F5");
  assert.equal(normalize("Ctrl+arrowup"), "Ctrl+ArrowUp");
  assert.equal(normalize(""), "");
  assert.equal(normalize("Ctrl+Shift"), null);
  assert.equal(normalize("Ctrl+D+E"), null);
  assert.equal(normalize("Ctrl+Banana"), null);
});

test("key codes become names", () => {
  assert.equal(keyName("KeyQ"), "Q");
  assert.equal(keyName("Digit0"), "0");
  assert.equal(keyName("F12"), "F12");
  assert.equal(keyName("F25"), null);
  assert.equal(keyName("Numpad7"), "Numpad7");
  assert.equal(keyName("ShiftLeft"), null);
  assert.equal(keyName("Space"), "Space");
});

test("a key press gives its keys, and modifiers alone give nothing", () => {
  assert.equal(fromEvent(press("KeyD", { ctrl: true, shift: true })), "Ctrl+Shift+D");
  assert.equal(fromEvent(press("Space", { alt: true })), "Alt+Space");
  assert.equal(fromEvent(press("KeyN", { meta: true })), "Super+N");
  assert.equal(fromEvent(press("ControlLeft", { ctrl: true })), null);
  assert.ok(matches(press("KeyF", { ctrl: true }), "Ctrl+F"));
  assert.ok(!matches(press("KeyF", { ctrl: true, shift: true }), "Ctrl+F"));
  assert.ok(!matches(press("KeyF", { ctrl: true }), ""));
});

test("labels follow the system", () => {
  assert.equal(label("Ctrl+Shift+D", "windows"), "Ctrl+Shift+D");
  assert.equal(label("Alt+Shift+D", "mac"), "⌥⇧ D");
  assert.equal(label("Alt+Space", "mac"), "⌥ Space");
  assert.equal(label("Super+F", "mac"), "⌘ F");
  assert.equal(label("Super+F", "windows"), "Win+F");
  assert.equal(label("Super+F", "linux"), "Super+F");
  assert.equal(label("Ctrl+ArrowUp", "linux"), "Ctrl+↑");
  assert.equal(label("", "windows"), "None");
});

test("shortcuts need Ctrl, Alt or the system key, and never Esc or Backspace", () => {
  assert.equal(problem("Ctrl+Shift+D", "windows"), null);
  assert.equal(problem("Super+N", "mac"), null);
  assert.equal(problem("", "windows"), null);
  assert.match(problem("D", "windows")!, /Hold Ctrl, Alt or Win/);
  assert.match(problem("Shift+D", "mac")!, /Hold ⌘/);
  assert.match(problem("Ctrl+Escape", "linux")!, /Esc/);
  assert.match(problem("Alt+Backspace", "windows")!, /Backspace/);
  assert.match(problem("Ctrl+Nope", "windows")!, /doesn't know/);
});
