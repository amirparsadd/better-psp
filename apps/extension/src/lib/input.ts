const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

/**
 * Sets a value the way a user would, so React/Vue/jQuery bindings see it. React tracks the last value it set
 * through the element's own setter, so the prototype setter has to be used.
 */
export function setInputValue(el: HTMLInputElement, value: string) {
  nativeValueSetter.call(el, value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Inserts text at the caret, replacing the selection, respecting maxlength. */
export function insertText(el: HTMLInputElement, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const room = el.maxLength >= 0 ? el.maxLength - (el.value.length - (end - start)) : text.length;
  const inserted = text.slice(0, Math.max(0, room));
  if (inserted === "") return;

  // execCommand keeps the undo stack and fires real beforeinput/input events, but only works on the focused element.
  if (el.ownerDocument.activeElement === el && el.ownerDocument.execCommand?.("insertText", false, inserted)) return;

  setInputValue(el, el.value.slice(0, start) + inserted + el.value.slice(end));
  try {
    el.setSelectionRange(start + inserted.length, start + inserted.length);
  } catch {
    // type=number and friends do not support selection.
  }
}

export function isEditable(el: HTMLInputElement): boolean {
  return !el.disabled && !el.readOnly;
}
