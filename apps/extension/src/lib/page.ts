import type { ContentScriptContext } from "#imports";
import { detectFields, FIELD_ORDER, type DetectOptions, type PaymentFields } from "./fields.ts";
import type { Settings } from "./settings.ts";

export type Page = {
  ctx: ContentScriptContext;
  fields: PaymentFields;
  settings: Settings;
  onFieldsChange(listener: (fields: PaymentFields) => void): void;
  onSettingsChange(listener: (settings: Settings) => void): void;
};

function signature(fields: PaymentFields): unknown[] {
  return [
    ...fields.card,
    ...FIELD_ORDER.slice(1).map((kind) => fields[kind]),
    fields.otpButton,
    fields.payButton,
    fields.email,
    fields.mobile,
  ];
}

function sameFields(a: PaymentFields, b: PaymentFields): boolean {
  const sa = signature(a);
  const sb = signature(b);
  return sa.length === sb.length && sa.every((el, i) => el === sb[i]);
}

/**
 * Tracks the payment fields. Vue/Quasar gateways (Pasargad, IranKish) render after load and swap elements, so
 * detection reruns on DOM changes.
 */
export function createPage(
  ctx: ContentScriptContext,
  settings: Settings,
  options: DetectOptions = {},
): Page & { setSettings(next: Settings): void } {
  const listeners: ((fields: PaymentFields) => void)[] = [];
  const settingsListeners: ((settings: Settings) => void)[] = [];
  const page = {
    ctx,
    fields: detectFields(document, options),
    settings,
    onFieldsChange(listener: (fields: PaymentFields) => void) {
      listeners.push(listener);
      listener(page.fields);
    },
    onSettingsChange(listener: (settings: Settings) => void) {
      settingsListeners.push(listener);
    },
    setSettings(next: Settings) {
      page.settings = next;
      for (const listener of settingsListeners) listener(next);
    },
  };

  let timer: number | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = ctx.setTimeout(() => {
      const next = detectFields(document, options);
      if (sameFields(page.fields, next)) return;
      page.fields = next;
      for (const listener of listeners) listener(next);
    }, 150);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "type", "disabled"],
  });
  ctx.onInvalidated(() => observer.disconnect());
  return page;
}
