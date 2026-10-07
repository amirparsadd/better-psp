import { hasNonLatinDigits, onlyDigits, toLatinDigits } from "./digits.ts";
import { kindOf } from "./fields.ts";
import { insertText, setInputValue } from "./input.ts";
import type { Page } from "./page.ts";

const TEXT_TYPES = new Set(["", "text", "tel", "number", "password", "phonenumber", "search"]);

function textInput(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement)) return null;
  return TEXT_TYPES.has((target.getAttribute("type") ?? "").toLowerCase()) ? target : null;
}

/**
 * Converts Persian/Arabic digits to Latin as they are typed or pasted. Several gateways reject non-Latin digits
 * in their own keydown handlers (Mellat, Sepehr), so typing is intercepted in the capture phase before them.
 */
export function installDigitInput(page: Page) {
  const { ctx } = page;
  const enabled = () => page.settings.digits;

  /** Payment fields only accept digits; other inputs (mobile, email) just get their digits converted. */
  const normalize = (el: HTMLInputElement, text: string) =>
    kindOf(page.fields, el) ? onlyDigits(text) : toLatinDigits(text);

  ctx.addEventListener(
    window,
    "keydown",
    (event) => {
      if (!enabled() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const el = textInput(event.target);
      if (!el || event.key.length !== 1 || !hasNonLatinDigits(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      insertText(el, toLatinDigits(event.key));
    },
    { capture: true },
  );

  // Virtual keyboards and IMEs do not always send a usable keydown.
  ctx.addEventListener(
    window,
    "beforeinput",
    (event) => {
      if (!enabled() || !event.cancelable || !event.data || !hasNonLatinDigits(event.data)) return;
      if (event.inputType === "insertFromPaste") return;
      const el = textInput(event.target);
      if (!el) return;
      event.preventDefault();
      insertText(el, normalize(el, event.data));
    },
    { capture: true },
  );

  ctx.addEventListener(
    window,
    "paste",
    (event) => {
      const el = textInput(event.target);
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!el || text === "") return;
      const { fields } = page;

      if (fields.card.length === 4 && fields.card.includes(el)) {
        const digits = onlyDigits(text);
        if (digits.length === 16) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const last = fields.card[3]!;
          last.focus();
          fields.card.forEach((part, i) => setInputValue(part, digits.slice(i * 4, i * 4 + 4)));
          return;
        }
      }

      if (!enabled() || !hasNonLatinDigits(text)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      insertText(el, normalize(el, text));
    },
    { capture: true },
  );
}
