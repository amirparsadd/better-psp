import { defaultIsVisible, type DetectOptions, type PaymentFields } from "./fields.ts";
import type { Page } from "./page.ts";

const HIDDEN = "data-better-psp-hidden";
const STYLE = `[${HIDDEN}] { display: none !important; }`;

const CHROME = "header, footer, nav, aside, [role=banner], [role=contentinfo], [role=navigation], [role=complementary]";
/** What the payer still needs: the merchant and amount (to check them), the timer, and every control. */
const ESSENTIAL_TEXT = /ریال|تومان|مبلغ|پذیرنده|فروشگاه|زمان باقی/;
const CONTROLS = "input:not([type=hidden]), select, textarea, [role=timer]";
const TIMER = /timer|countdown|remaining/i;
/** Keypads, OTP notices and error popups are only on screen when the gateway wants them to be. */
const PROTECTED_ROLE = "[role=dialog], [aria-modal]";
const PROTECTED_CLASS = /modal|keypad|dialog|popup|swal|toast/i;
const ERRORISH_ROLE = "[role=alert], [role=status], [aria-live]";
const ERRORISH_CLASS = /error|invalid|danger|alert|validation/i;

const GUIDE_HEADING = /راهنما|نکات\s*(?:امنیتی|ایمنی)|نکته\s*(?:امنیتی|ایمنی)/;
const FIELD_HINT = /(?:وارد|درج)\s*(?:نمایید|کنید|فرمایید|شده)/;

function classOrId(el: Element): string {
  return `${el.id} ${el.getAttribute("class") ?? ""}`;
}

function closestMatching(el: Element, roles: string, pattern: RegExp): boolean {
  if (el.closest(roles)) return true;
  for (let node: Element | null = el; node; node = node.parentElement) if (pattern.test(classOrId(node))) return true;
  return false;
}

function essentials(root: ParentNode, fields: PaymentFields): Element[] {
  const found = new Set<Element>(root.querySelectorAll(CONTROLS));
  for (const el of root.querySelectorAll("[id], [class]")) if (TIMER.test(classOrId(el))) found.add(el);
  for (const el of [fields.otpButton, fields.payButton]) if (el) found.add(el);
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Labels and values are short; security tips also say "check the merchant and the amount" in long sentences.
    const text = node.textContent?.trim() ?? "";
    if (node.parentElement && text.length <= 40 && ESSENTIAL_TEXT.test(text)) found.add(node.parentElement);
  }
  return [...found];
}

function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join(" ")
    .trim();
}

/**
 * Finds the gateway's extra UI: headers, footers and sidebars (minus whatever essential is inside them), guide
 * and security-tip sections, and hint lines under the fields. Returns the elements to hide.
 */
export function findClutter(root: ParentNode, fields: PaymentFields, options: DetectOptions & { hints?: boolean } = {}) {
  const isVisible = options.isVisible ?? defaultIsVisible;
  const keep = essentials(root, fields);
  const hasEssential = (el: Element) => keep.some((k) => el.contains(k));
  const skip = (el: Element) => closestMatching(el, PROTECTED_ROLE, PROTECTED_CLASS) || !isVisible(el);
  const clutter = new Set<Element>();

  const prune = (el: Element) => {
    if (skip(el) || keep.includes(el)) return;
    if (!hasEssential(el)) clutter.add(el);
    else for (const child of el.children) prune(child);
  };
  for (const chrome of root.querySelectorAll(CHROME)) {
    if (![...clutter].some((c) => c.contains(chrome))) prune(chrome);
  }

  for (const heading of root.querySelectorAll("body *")) {
    const text = ownText(heading);
    if (!text || text.length > 60 || !GUIDE_HEADING.test(text) || skip(heading)) continue;
    let block = heading;
    while (block.parentElement && block.parentElement.tagName !== "BODY" && !hasEssential(block.parentElement)) {
      block = block.parentElement;
    }
    if (!hasEssential(block)) clutter.add(block);
  }

  if (options.hints) {
    for (const hint of root.querySelectorAll("small, span, p, div")) {
      const text = ownText(hint);
      if (hint.children.length > 0 || text.length > 120 || !FIELD_HINT.test(text)) continue;
      if (skip(hint) || closestMatching(hint, ERRORISH_ROLE, ERRORISH_CLASS) || hasEssential(hint)) continue;
      clutter.add(hint);
    }
  }

  return [...clutter].filter((el) => ![...clutter].some((other) => other !== el && other.contains(el)));
}

export function installClean(page: Page) {
  const { ctx } = page;
  const style = document.createElement("style");
  style.textContent = STYLE;
  let hintsDone = false;

  function apply() {
    style.disabled = !page.settings.clean;
    if (!page.settings.clean) return;
    if (!style.isConnected) (document.head ?? document.documentElement).append(style);
    const { fields } = page;
    const ready = fields.card.length > 0 || fields.cvv2 !== undefined;
    if (!ready) return;
    for (const el of findClutter(document, fields, { hints: !hintsDone })) el.setAttribute(HIDDEN, "");
    hintsDone = true;
  }

  page.onFieldsChange(apply);
  page.onSettingsChange(apply);
  ctx.onInvalidated(() => {
    style.remove();
    for (const el of document.querySelectorAll(`[${HIDDEN}]`)) el.removeAttribute(HIDDEN);
  });
}
