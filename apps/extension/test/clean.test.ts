import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findClutter, installClean } from "../src/lib/clean.ts";
import { detectFields } from "../src/lib/fields.ts";
import { fakePage } from "./helpers.ts";

const visible = { isVisible: () => true };

const PAGE = `
  <header><img alt="logo"><a href="/en">English</a><div class="timer">زمان باقی‌مانده: <b>09:42</b></div></header>
  <main>
    <section><span>پذیرنده</span><b>فیگ فیت</b><span>مبلغ</span><b>15,000 ریال</b></section>
    <form>
      <input id="CardNumber" maxlength="19"><small>شماره کارت 16 رقمی درج شده روی کارت را وارد نمایید</small>
      <input id="Cvv2"><span class="field-validation-error">CVV2 را وارد کنید</span>
      <input id="Month" placeholder="ماه"><input id="Year" placeholder="سال">
      <input id="Captcha"><input id="Pin2">
      <button type="submit" id="pay">پرداخت</button>
    </form>
    <div class="tips"><h3>راهنما و نکات امنیتی</h3><p>از صحت نام فروشنده و مبلغ اطمینان حاصل فرمایید.</p></div>
    <div class="modal"><h3>راهنمای رمز پویا</h3></div>
  </main>
  <footer>تمامی حقوق محفوظ است.</footer>`;

describe("clean mode", () => {
  it("hides chrome, guides and hints but keeps the timer, merchant, amount and errors", () => {
    document.body.innerHTML = PAGE;
    const hidden = findClutter(document, detectFields(document, visible), { ...visible, hints: true });
    const $ = (selector: string) => document.querySelector(selector)!;
    expect(hidden).toEqual(
      expect.arrayContaining([$("header img"), $("header a"), $(".tips"), $("form small"), $("footer")]),
    );
    expect(hidden).toHaveLength(5);
  });

  it("leaves field hints alone after the first pass", () => {
    document.body.innerHTML = PAGE;
    const hidden = findClutter(document, detectFields(document, visible), visible);
    expect(hidden).not.toContain(document.querySelector("form small"));
  });

  it("marks clutter and is undone by turning it off", () => {
    const page = fakePage(PAGE);
    installClean(page);
    expect(document.querySelector("footer")!.hasAttribute("data-better-psp-hidden")).toBe(true);
    const style = [...document.querySelectorAll("style")].find((s) => s.textContent?.includes("data-better-psp-hidden"))!;
    expect(style.disabled).toBe(false);
  });
});

const DATASETS = resolve(import.meta.dirname, "../../../datasets");
const gateways = existsSync(DATASETS) ? readdirSync(DATASETS).filter((g) => existsSync(join(DATASETS, g, "pages"))) : [];

describe.each(gateways)("clean mode on %s", (gateway) => {
  it("never hides a payment field, the captcha or the amount", () => {
    const dir = join(DATASETS, gateway, "pages");
    const file = readdirSync(dir).find((f) => f.endsWith(".html"));
    if (!file) return;
    const doc = new DOMParser().parseFromString(readFileSync(join(dir, file), "utf8"), "text/html");
    const fields = detectFields(doc, visible);
    const hidden = findClutter(doc, fields, { ...visible, hints: true });
    const isHidden = (el: Element) => hidden.some((h) => h.contains(el));

    const { cvv2, month, year, captcha: captchaInput, pin2, payButton, otpButton } = fields;
    const controls = [...fields.card, cvv2, month, year, captchaInput, pin2, payButton, otpButton];
    for (const el of controls) if (el) expect(isHidden(el)).toBe(false);
    const captcha = doc.querySelector("img[id*=aptcha], img[class*=aptcha]");
    if (captcha) expect(isHidden(captcha)).toBe(false);
    const amounts = [...doc.querySelectorAll("body *")].filter(
      (el) => el.children.length === 0 && /^\s*[\d,]+\s*ریال\s*$/.test(el.textContent ?? ""),
    );
    for (const el of amounts) expect(isHidden(el)).toBe(false);
    expect(hidden.length).toBeGreaterThan(0);
  });
});
