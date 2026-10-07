import { toLatinDigits } from "./digits.ts";

export type FieldKind = "card" | "cvv2" | "month" | "year" | "captcha" | "pin2";

export type PaymentFields = {
  /** One input for the whole number, or the four 4-digit boxes in order. */
  card: HTMLInputElement[];
  cvv2?: HTMLInputElement;
  month?: HTMLInputElement;
  year?: HTMLInputElement;
  captcha?: HTMLInputElement;
  pin2?: HTMLInputElement;
  otpButton?: HTMLElement;
  payButton?: HTMLElement;
  form?: HTMLFormElement;
  /** Optional receipt fields. They are not payment fields: focus never moves to them. */
  email?: HTMLInputElement;
  mobile?: HTMLInputElement;
};

export type DetectOptions = { isVisible?: (el: Element) => boolean };

/** Order the user fills the form in. */
export const FIELD_ORDER = ["card", "cvv2", "month", "year", "captcha", "pin2"] as const satisfies FieldKind[];

const TEXT_TYPES = new Set(["", "text", "tel", "number", "password", "phonenumber", "search", "email"]);

type ContactKind = "email" | "mobile";
const CONTACT: [ContactKind, RegExp][] = [
  ["email", /e-?mail|ایمیل/],
  ["mobile", /mobile|cellnumber|phone|موبایل|همراه/],
];
const RULES: [Exclude<FieldKind, "card">, RegExp][] = [
  ["cvv2", /cvv|cvc|cc-csc|شناسایی دوم/],
  ["month", /month|expm|ماه/],
  ["year", /year|expy|سال/],
  ["captcha", /captcha|کد امنیتی|security.?code/],
  ["pin2", /pin|second-?pass|one-time-code|رمز/],
];
const CARD = /card|(?:^|[^a-z])pan|شماره کارت/;

const BUTTON_SELECTOR = "button, input[type=button], input[type=submit], [role=button], a:not([href])";
const BUTTON_EXCLUDED = /cancel|انصراف|لغو|بازگشت|close|بستن|dialog|keypad|صفحه کلید/;
const OTP_BUTTON = /otp|رمز\s*(?:پویا|یک\s*بار|یک‌بار)|dynamic-second-pass|countdown/;
const PAY_BUTTON = /پرداخت|pay|purchase|confirm/;

function describeInput(el: HTMLInputElement): string {
  return ["id", "name", "data-name", "aria-label", "placeholder", "autocomplete"]
    .map((attr) => el.getAttribute(attr) ?? "")
    .join(" ")
    .toLowerCase();
}

function describeButton(el: HTMLElement): string {
  const value = el instanceof HTMLInputElement ? el.value : el.textContent;
  return [el.id, el.getAttribute("name"), el.getAttribute("aria-label"), el.title, value]
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function classify(el: HTMLInputElement): FieldKind | ContactKind | null {
  if (el.type === "email") return "email";
  const text = describeInput(el);
  for (const [kind, pattern] of CONTACT) if (pattern.test(text)) return kind;
  for (const [kind, pattern] of RULES) if (pattern.test(text)) return kind;
  return CARD.test(text) ? "card" : null;
}

export function defaultIsVisible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

function isAfter(el: Element, anchor: Element): boolean {
  return Boolean(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
}

export function detectFields(root: ParentNode = document, options: DetectOptions = {}): PaymentFields {
  const isVisible = options.isVisible ?? defaultIsVisible;
  const inputs = [...root.querySelectorAll("input")].filter(
    (el) => TEXT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase()) && isVisible(el),
  );

  const fields: PaymentFields = { card: [] };
  const kinds = new Map<HTMLInputElement, ReturnType<typeof classify>>();
  for (const el of inputs) {
    const kind = classify(el);
    kinds.set(el, kind);
    if (kind === "card") fields.card.push(el);
    else if (kind) fields[kind] ??= el;
  }

  const splitCard = fields.card.length >= 4 && fields.card.slice(0, 4).every((el) => el.maxLength === 4);
  fields.card = fields.card.slice(0, splitCard ? 4 : 1);

  applyPositionalFallback(fields, inputs, kinds);

  // Only look below the form's first field, which skips header controls like language switchers.
  const firstField = fields.card[0] ?? fields.cvv2 ?? fields.captcha ?? fields.pin2;
  // IranKish (Quasar) renders its buttons as <a> without href.
  const buttons = [...root.querySelectorAll<HTMLElement>(BUTTON_SELECTOR)].filter(
    (el) => isVisible(el) && (!firstField || isAfter(el, firstField)),
  );
  const labeled = buttons.map((el) => ({ el, text: describeButton(el) })).filter(({ text }) => !BUTTON_EXCLUDED.test(text));
  fields.otpButton = labeled.find(({ text }) => OTP_BUTTON.test(text))?.el;
  fields.payButton = labeled.find(({ el, text }) => el !== fields.otpButton && PAY_BUTTON.test(text))?.el;

  fields.form = (fields.cvv2 ?? fields.card[0])?.form ?? undefined;
  return fields;
}

/**
 * Some gateways (IranKish's Quasar form) give inputs random ids and no names. The expiry fields still have
 * ماه/سال placeholders, and every gateway uses the same order, so the neighbours can be inferred. The mobile
 * number, when there is one, is the phone input right after PIN2.
 */
function applyPositionalFallback(
  fields: PaymentFields,
  inputs: HTMLInputElement[],
  kinds: Map<HTMLInputElement, ReturnType<typeof classify>>,
) {
  const unclassified = (el: HTMLInputElement | undefined) => (el && kinds.get(el) === null ? el : undefined);

  if (fields.month) {
    const i = inputs.indexOf(fields.month);
    fields.cvv2 ??= unclassified(inputs[i - 1]);
    if (fields.card.length === 0 && fields.cvv2 === inputs[i - 1]) {
      const card = unclassified(inputs[i - 2]);
      if (card) fields.card = [card];
    }
    fields.year ??= unclassified(inputs[i + 1]);
  }
  if (fields.year) {
    const i = inputs.indexOf(fields.year);
    fields.captcha ??= unclassified(inputs[i + 1]);
    if (fields.captcha === inputs[i + 1]) fields.pin2 ??= unclassified(inputs[i + 2]);
  }
  if (fields.pin2 && !fields.mobile) {
    const next = unclassified(inputs[inputs.indexOf(fields.pin2) + 1]);
    if (next?.type === "tel") fields.mobile = next;
  }
}

export function kindOf(fields: PaymentFields, el: EventTarget | null): FieldKind | null {
  if (!(el instanceof HTMLInputElement)) return null;
  if (fields.card.includes(el)) return "card";
  for (const kind of FIELD_ORDER) if (kind !== "card" && fields[kind] === el) return kind;
  return null;
}

export type CardFingerprint = { bin: string; last4: string };

/** BIN and last four digits; also readable from masked saved cards like 6037-99**-****-1234. */
export function readCardFingerprint(fields: PaymentFields): CardFingerprint | null {
  const raw = toLatinDigits(fields.card.map((el) => el.value).join(""));
  const compact = raw.replace(/[\s\-_]/g, "");
  if (compact.length !== 16 || !/^\d{6}[\d*•xX]{6}\d{4}$/.test(compact)) return null;
  return { bin: compact.slice(0, 6), last4: compact.slice(12) };
}
