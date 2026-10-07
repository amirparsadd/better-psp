import { onlyDigits } from "./digits.ts";
import { readCardFingerprint, type CardFingerprint } from "./fields.ts";
import { advanceFrom } from "./focus.ts";
import { setInputValue } from "./input.ts";
import { sendVault } from "./messages.ts";
import type { Page } from "./page.ts";

const STYLE = `
:host { all: initial; position: absolute; z-index: 2147483646; }
label {
  display: inline-flex; align-items: center; gap: 6px; direction: rtl;
  font: 12px/1.6 Vazirmatn, Tahoma, system-ui, sans-serif; color: #1f2937;
  background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 2px 8px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); cursor: pointer; user-select: none; white-space: nowrap;
}
input { margin: 0; accent-color: #0f766e; cursor: pointer; }
.state { color: #0f766e; }
.state:empty { display: none; }
`;

function sameCard(a: CardFingerprint | null, b: CardFingerprint | null) {
  return a?.bin === b?.bin && a?.last4 === b?.last4;
}

/**
 * Offers to keep the CVV2 on this device. Nothing is stored unless the box is ticked, and the CVV2 is only
 * sent to the background when the payment is submitted (the page navigates away right after).
 */
export function installCvv(page: Page) {
  const { ctx } = page;
  const enabled = () => page.settings.cvv;

  const host = document.createElement("better-psp-cvv");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const text = document.createElement("span");
  text.textContent = "ذخیره‌ی CVV2 روی این دستگاه";
  const state = document.createElement("span");
  state.className = "state";
  label.append(checkbox, text, state);
  shadow.append(style, label);

  let card: CardFingerprint | null = null;
  let saved = false;
  let lastSubmitted = "";

  function place() {
    const cvv2 = page.fields.cvv2;
    if (!enabled() || !cvv2 || !cvv2.isConnected || cvv2.getClientRects().length === 0) {
      host.remove();
      return;
    }
    if (!host.isConnected) document.documentElement.append(host);
    const rect = cvv2.getBoundingClientRect();
    host.style.top = `${rect.bottom + window.scrollY + 4}px`;
    host.style.left = `${rect.left + window.scrollX}px`;
  }

  function render() {
    checkbox.checked = saved || checkbox.checked;
    state.textContent = saved ? " (ذخیره شده)" : "";
  }

  async function syncCard() {
    const next = readCardFingerprint(page.fields);
    if (sameCard(next, card)) return;
    card = next;
    saved = false;
    checkbox.checked = false;
    render();
    if (!card || !enabled()) return;

    const requested = card;
    const entry = await sendVault({ type: "vault:get", card: requested }).catch(() => null);
    if (!entry || !sameCard(card, requested)) return;
    saved = true;
    render();
    const cvv2 = page.fields.cvv2;
    if (cvv2 && cvv2.value === "") {
      setInputValue(cvv2, entry.cvv2);
      advanceFrom(page, cvv2);
    }
  }

  function submit() {
    const cvv2 = onlyDigits(page.fields.cvv2?.value ?? "");
    if (!enabled() || !card || !checkbox.checked || !/^\d{3,4}$/.test(cvv2)) return;
    const key = `${card.bin}${card.last4}:${cvv2}`;
    if (key === lastSubmitted) return;
    lastSubmitted = key;
    void sendVault({ type: "vault:save", card, cvv2 }).catch(() => (lastSubmitted = ""));
  }

  checkbox.addEventListener("change", () => {
    if (checkbox.checked || !saved || !card) return;
    // Unticking a saved card means "do not keep it": forget right away instead of waiting for a submit.
    saved = false;
    lastSubmitted = "";
    render();
    void sendVault({ type: "vault:forget", card }).catch(() => {});
  });

  page.onFieldsChange(() => {
    place();
    void syncCard();
  });
  ctx.addEventListener(document, "input", (event) => {
    if (page.fields.card.includes(event.target as HTMLInputElement)) void syncCard();
  });
  ctx.addEventListener(window, "resize", place);
  ctx.addEventListener(window, "scroll", place, { capture: true, passive: true });
  ctx.setInterval(place, 1000);

  ctx.addEventListener(window, "submit", submit, { capture: true });
  ctx.addEventListener(
    window,
    "click",
    (event) => {
      const pay = page.fields.payButton;
      if (pay && event.target instanceof Node && pay.contains(event.target)) submit();
    },
    { capture: true },
  );
  ctx.addEventListener(
    window,
    "keydown",
    (event) => {
      if (event.key === "Enter" && event.target === page.fields.pin2) submit();
    },
    { capture: true },
  );
  ctx.onInvalidated(() => host.remove());
  return { checkbox };
}
