import { storage } from "#imports";
import { onlyDigits } from "./digits.ts";
import { isEditable, setInputValue } from "./input.ts";
import type { Page } from "./page.ts";

/** The optional receipt details, kept in plain extension storage: gateways ask for them in the clear anyway. */
export type Contact = { email: string; mobile: string };

const EMPTY: Contact = { email: "", mobile: "" };

export const contactItem = storage.defineItem<Contact>("local:contact", { fallback: EMPTY });

export function loadContact(): Promise<Contact> {
  return contactItem.getValue();
}

/** 09xxxxxxxxx from the usual ways of writing an Iranian mobile number (+98, 0098, without the leading 0). */
export function normalizeMobile(text: string): string | null {
  const digits = onlyDigits(text).replace(/^(?:0098|98)(?=9\d{9}$)/, "");
  const local = digits.length === 10 ? `0${digits}` : digits;
  return /^09\d{9}$/.test(local) ? local : null;
}

export function isEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text);
}

/** Fills empty email and mobile fields once each, so clearing a field keeps it empty. */
export function installContact(page: Page) {
  const { ctx } = page;
  let contact = EMPTY;
  const filled = new WeakSet<HTMLInputElement>();

  function fill() {
    if (!page.settings.contact) return;
    for (const [el, value] of [
      [page.fields.email, contact.email],
      [page.fields.mobile, contact.mobile],
    ] as const) {
      if (!el || !value || filled.has(el) || !isEditable(el) || el.value.trim() !== "") continue;
      filled.add(el);
      setInputValue(el, value);
    }
  }

  void loadContact().then((loaded) => {
    contact = loaded;
    fill();
  });
  const unwatch = contactItem.watch((next) => {
    contact = next ?? EMPTY;
    fill();
  });
  ctx.onInvalidated(unwatch);
  page.onFieldsChange(fill);
}
