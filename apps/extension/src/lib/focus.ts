import { onlyDigits } from "./digits.ts";
import { FIELD_ORDER, kindOf, type FieldKind, type PaymentFields } from "./fields.ts";
import { isEditable } from "./input.ts";
import type { Page } from "./page.ts";

/** CVV2 has 3 or 4 digits, so it only advances on its own at 4. PIN2 (5 to 12) never does. */
function expectedLength(fields: PaymentFields, kind: FieldKind): number | null {
  switch (kind) {
    case "card":
      return fields.card.length === 4 ? 4 : 16;
    case "cvv2":
      return 4;
    case "month":
    case "year":
      return 2;
    case "captcha":
      return 5;
    default:
      return null;
  }
}

export function isComplete(fields: PaymentFields, el: HTMLInputElement): boolean {
  const kind = kindOf(fields, el);
  const length = kind && expectedLength(fields, kind);
  return Boolean(length) && onlyDigits(el.value).length >= length!;
}

function isEmptyInput(el: HTMLInputElement | undefined): el is HTMLInputElement {
  return el !== undefined && isEditable(el) && el.value.trim() === "";
}

function fieldsOf(fields: PaymentFields, kind: FieldKind): HTMLInputElement[] {
  return kind === "card" ? fields.card : fields[kind] ? [fields[kind]] : [];
}

/** First empty field from the top of the form. */
export function firstEmptyField(fields: PaymentFields): HTMLInputElement | null {
  for (const kind of FIELD_ORDER) {
    const empty = fieldsOf(fields, kind).find(isEmptyInput);
    if (empty) return empty;
  }
  return null;
}

/**
 * Where to go after `el` is complete: the next card box, then the next empty field. After the captcha the
 * one-time password usually has to be requested first, so the request button comes before PIN2.
 */
export function nextTarget(fields: PaymentFields, el: HTMLInputElement): HTMLElement | null {
  const kind = kindOf(fields, el);
  if (!kind) return null;
  if (kind === "card") {
    const next = fields.card.slice(fields.card.indexOf(el) + 1).find(isEmptyInput);
    if (next) return next;
  }
  for (const later of FIELD_ORDER.slice(FIELD_ORDER.indexOf(kind) + 1)) {
    if (later === "pin2" && fields.otpButton && isEmptyInput(fields.pin2)) return fields.otpButton;
    const empty = fieldsOf(fields, later).find(isEmptyInput);
    if (empty) return empty;
  }
  return null;
}

/** Moves on from `el` unless the user (or the gateway's own script) already moved focus elsewhere. */
export function advanceFrom(page: Page, el: HTMLInputElement) {
  if (!page.settings.focus || document.activeElement !== el || !isComplete(page.fields, el)) return;
  nextTarget(page.fields, el)?.focus();
}

/**
 * Several gateways jump to the next field after the third CVV2 digit, which cuts off 4-digit CVV2s. Focus that
 * leaves a 3-digit CVV2 for another payment field is put back unless the user clicked that field or pressed
 * Tab/Enter. Clicks elsewhere (the gateways' on-screen keypads) do not count.
 */
function guardCvv2(page: Page) {
  const { ctx } = page;
  const INTENT_MS = 1000;
  let keyAt = 0;
  let clicked: { target: EventTarget | null; at: number } = { target: null, at: 0 };

  ctx.addEventListener(
    document,
    "keydown",
    (event) => {
      if (event.key === "Tab" || event.key === "Enter") keyAt = Date.now();
    },
    { capture: true },
  );
  ctx.addEventListener(document, "pointerdown", (event) => (clicked = { target: event.target, at: Date.now() }), {
    capture: true,
  });

  const userChose = (next: HTMLElement) => {
    const now = Date.now();
    if (now - keyAt < INTENT_MS) return true;
    const { target, at } = clicked;
    if (now - at >= INTENT_MS || !(target instanceof Element)) return false;
    return next.contains(target) || target.closest("label")?.control === next;
  };

  ctx.addEventListener(
    document,
    "focusout",
    (event) => {
      const { fields } = page;
      const cvv2 = fields.cvv2;
      const next = (event as FocusEvent).relatedTarget;
      if (!page.settings.focus || !cvv2 || event.target !== cvv2 || !(next instanceof HTMLElement)) return;
      if (onlyDigits(cvv2.value).length !== 3) return;
      if (!kindOf(fields, next) && next !== fields.otpButton && next !== fields.payButton) return;
      if (userChose(next)) return;
      ctx.setTimeout(() => {
        if (document.activeElement === next) cvv2.focus();
      }, 0);
    },
    { capture: true },
  );
}

export function installFocus(page: Page) {
  const { ctx } = page;
  guardCvv2(page);
  let autofocused = false;
  let waitingForKeyUp: HTMLInputElement | null = null;

  page.onFieldsChange((fields) => {
    if (autofocused || !page.settings.focus) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    const target = firstEmptyField(fields);
    if (!target) return;
    autofocused = true;
    target.focus();
  });

  ctx.addEventListener(document, "input", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || !page.settings.focus || !isComplete(page.fields, el)) return;
    // While typing, wait for keyup: moving focus mid-keystroke sends the keyup (and the gateway's own
    // keyup handlers) to the next field.
    if ((event as InputEvent).inputType === "insertText") {
      waitingForKeyUp = el;
      ctx.setTimeout(() => {
        if (waitingForKeyUp !== el) return;
        waitingForKeyUp = null;
        advanceFrom(page, el);
      }, 300);
    } else {
      ctx.setTimeout(() => advanceFrom(page, el), 0);
    }
  });

  ctx.addEventListener(document, "keyup", (event) => {
    const el = waitingForKeyUp;
    if (!el || event.target !== el) return;
    waitingForKeyUp = null;
    ctx.setTimeout(() => advanceFrom(page, el), 0);
  });
}
