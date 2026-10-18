// D8 keyboard rules. Pure, no browser. The Space-bar case is the one found in review: a focused button must not
// also toggle playback.
import test from "node:test";
import assert from "node:assert/strict";
import { keyToAction, shouldHandleShortcut, SHORTCUTS } from "../src/engine/access.js";

const el = (tagName, attrs = {}) => ({ tagName, isContentEditable: false, getAttribute: (k) => attrs[k] ?? null });

test("the documented keys map to replay actions", () => {
  assert.equal(keyToAction("Space"), "toggle");
  assert.equal(keyToAction("ArrowRight"), "next");
  assert.equal(keyToAction("ArrowLeft"), "previous");
  assert.equal(keyToAction("Home"), "first");
  assert.equal(keyToAction("End"), "last");
  assert.equal(keyToAction("KeyA"), null);
  assert.equal(keyToAction("ArrowUp"), null);
});

test("shortcuts with Ctrl, Cmd or Alt are left to the browser", () => {
  assert.equal(keyToAction("Space", { ctrlKey: true }), null);
  assert.equal(keyToAction("ArrowRight", { metaKey: true }), null);
  assert.equal(keyToAction("Home", { altKey: true }), null);
  assert.equal(keyToAction("End", { shiftKey: true }), "last", "Shift alone is not blocked");
});

test("a focused control keeps its own Space key (Space on Step steps, it does not start playback)", () => {
  assert.equal(shouldHandleShortcut(el("BUTTON")), false);
  assert.equal(shouldHandleShortcut(el("INPUT")), false);
  assert.equal(shouldHandleShortcut(el("SELECT")), false);
  assert.equal(shouldHandleShortcut(el("TEXTAREA")), false);
  assert.equal(shouldHandleShortcut(el("A")), false);
  assert.equal(shouldHandleShortcut(el("SUMMARY")), false);
});

test("ARIA control roles on other elements also keep their keys", () => {
  assert.equal(shouldHandleShortcut(el("DIV", { role: "button" })), false);
  assert.equal(shouldHandleShortcut(el("SPAN", { role: "slider" })), false);
  assert.equal(shouldHandleShortcut(el("DIV", { role: "switch" })), false);
});

test("the map canvas, the page and plain content still get the shortcuts", () => {
  assert.equal(shouldHandleShortcut(el("CANVAS", { role: "img" })), true);
  assert.equal(shouldHandleShortcut(el("BODY")), true);
  assert.equal(shouldHandleShortcut(el("P")), true);
  assert.equal(shouldHandleShortcut(null), true);
});

test("editable content never takes shortcuts", () => {
  assert.equal(shouldHandleShortcut({ tagName: "DIV", isContentEditable: true, getAttribute: () => null }), false);
});

test("the shortcut list shown to users matches the keys the code handles", () => {
  const keys = SHORTCUTS.map((s) => s.keys).join(" | ");
  for (const k of ["Space", "Left and Right arrows", "Home and End"]) assert.ok(keys.includes(k));
});
