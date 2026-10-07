import { afterEach } from "vitest";
import type { ContentScriptContext } from "#imports";
import { detectFields } from "../src/lib/fields.ts";
import type { Page } from "../src/lib/page.ts";
import { DEFAULT_SETTINGS } from "../src/lib/settings.ts";

const contexts: AbortController[] = [];

afterEach(() => {
  for (const controller of contexts.splice(0)) controller.abort();
});

/** Enough of ContentScriptContext for the features. Window listeners are removed after each test. */
export function fakeContext(): ContentScriptContext {
  const controller = new AbortController();
  contexts.push(controller);
  return {
    addEventListener: (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) =>
      target.addEventListener(type, handler, { ...options, signal: controller.signal }),
    setTimeout: (handler: () => void, ms?: number) => window.setTimeout(handler, ms),
    setInterval: (handler: () => void, ms?: number) => {
      const id = window.setInterval(handler, ms);
      controller.signal.addEventListener("abort", () => window.clearInterval(id));
      return id;
    },
    onInvalidated: () => () => {},
  } as unknown as ContentScriptContext;
}

export function fakePage(html: string): Page {
  document.body.innerHTML = html;
  const page: Page = {
    ctx: fakeContext(),
    fields: detectFields(document, { isVisible: () => true }),
    settings: { ...DEFAULT_SETTINGS },
    onFieldsChange(listener) {
      listener(page.fields);
    },
    onSettingsChange() {},
  };
  return page;
}

export const SPLIT_CARD_FORM = `
  <form>
    <input id="CardNoPart1" maxlength="4"><input id="CardNoPart2" maxlength="4">
    <input id="CardNoPart3" maxlength="4"><input id="CardNoPart4" maxlength="4">
    <input id="Cvv2" maxlength="4">
    <input id="Month" maxlength="2" placeholder="ماه"><input id="Year" maxlength="2" placeholder="سال">
    <input id="Captcha" maxlength="5">
    <input id="Pin2" maxlength="12">
    <button type="button" id="getOTP">درخواست رمز پویا</button>
    <input id="MobileNo" maxlength="11">
    <button type="submit" id="pay">پرداخت</button>
  </form>`;
