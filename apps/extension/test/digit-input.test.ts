import { beforeEach, describe, expect, it } from "vitest";
import { installDigitInput } from "../src/lib/digit-input.ts";
import type { Page } from "../src/lib/page.ts";
import { fakePage, SPLIT_CARD_FORM } from "./helpers.ts";

const $ = (selector: string) => document.querySelector<HTMLInputElement>(selector)!;

function type(el: HTMLInputElement, key: string) {
  el.focus();
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  // A real browser inserts the key unless keydown was cancelled.
  if (!event.defaultPrevented) el.value += key;
}

function paste(el: HTMLInputElement, text: string) {
  el.focus();
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

let page: Page;
let pageSawKeydown: string[];

describe("digit input", () => {
  beforeEach(() => {
    page = fakePage(SPLIT_CARD_FORM);
    pageSawKeydown = [];
    // Gateways like Sepehr reject anything but Latin digits in their own keydown handler.
    $("#Cvv2").addEventListener("keydown", (e) => {
      pageSawKeydown.push(e.key);
      if (!/^\d$/.test(e.key)) e.preventDefault();
    });
    installDigitInput(page);
  });

  it("types Persian digits as Latin before the gateway's handlers see them", () => {
    for (const key of "۱۲۳") type($("#Cvv2"), key);
    expect($("#Cvv2").value).toBe("123");
    expect(pageSawKeydown).toEqual([]);
  });

  it("leaves Latin digits to the page", () => {
    type($("#Cvv2"), "4");
    expect($("#Cvv2").value).toBe("4");
    expect(pageSawKeydown).toEqual(["4"]);
  });

  it("respects maxlength", () => {
    for (const key of "۱۲") type($("#Month"), key);
    type($("#Month"), "۳");
    expect($("#Month").value).toBe("12");
  });

  it("does nothing when turned off", () => {
    page.settings.digits = false;
    type($("#Month"), "۱");
    expect($("#Month").value).toBe("۱");
  });

  it("converts pasted Persian digits and drops separators in payment fields", () => {
    const event = paste($("#Pin2"), "۱۲۳ ۴۵۶");
    expect(event.defaultPrevented).toBe(true);
    expect($("#Pin2").value).toBe("123456");
  });

  it("keeps separators in other inputs", () => {
    paste($("#MobileNo"), "۰۹۱۲ ۳۴۵");
    expect($("#MobileNo").value).toBe("0912 345");
  });

  it("spreads a pasted card number across split boxes", () => {
    const event = paste($("#CardNoPart1"), "۶۰۳۷-۹۹۱۲-3456-7890");
    expect(event.defaultPrevented).toBe(true);
    expect(page.fields.card.map((el) => el.value)).toEqual(["6037", "9912", "3456", "7890"]);
  });

  it("lets Latin pastes through untouched", () => {
    const event = paste($("#Pin2"), "123456");
    expect(event.defaultPrevented).toBe(false);
  });
});
