// D8 keyboard rules (pure, testable without a browser).
// Shortcuts work only when the focus is on the map or the page, never on a control. In D1-D7 the page-wide Space
// handler ran even when a button had focus: Space on Step started playback instead of stepping (found in D8).
export const SHORTCUTS = Object.freeze([
  Object.freeze({ keys: "Space", action: "Play or pause the replay" }),
  Object.freeze({ keys: "Left and Right arrows", action: "Previous or next step" }),
  Object.freeze({ keys: "Home and End", action: "First step or last step" }),
]);

const NATIVE_CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "SUMMARY"]);
const CONTROL_ROLES = new Set(["button", "checkbox", "radio", "slider", "switch", "combobox", "listbox", "textbox", "link", "option", "menuitem", "tab"]);

/** True when a shortcut may act for this keydown target. Controls keep their own keys. */
export function shouldHandleShortcut(target) {
  if (!target || typeof target !== "object") return true;
  if (target.isContentEditable) return false;
  if (NATIVE_CONTROLS.has(String(target.tagName ?? "").toUpperCase())) return false;
  const role = typeof target.getAttribute === "function" ? target.getAttribute("role") : null;
  return !(role && CONTROL_ROLES.has(role));
}

/** Maps a KeyboardEvent.code to a replay action, or null. Modifier keys make it not a shortcut. */
export function keyToAction(code, modifiers = {}) {
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return null;
  switch (code) {
    case "Space": return "toggle";
    case "ArrowRight": return "next";
    case "ArrowLeft": return "previous";
    case "Home": return "first";
    case "End": return "last";
    default: return null;
  }
}
