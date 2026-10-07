import { describe, expect, it, vi } from "vitest";
import { advanceFrom, firstEmptyField, installFocus, isComplete, nextTarget } from "../src/lib/focus.ts";
import { fakePage, SPLIT_CARD_FORM } from "./helpers.ts";

const $ = (selector: string) => document.querySelector<HTMLInputElement>(selector)!;

describe("focus order", () => {
  it("starts at the first empty field", () => {
    const page = fakePage(SPLIT_CARD_FORM);
    expect(firstEmptyField(page.fields)).toBe($("#CardNoPart1"));
    for (const part of page.fields.card) part.value = "1234";
    expect(firstEmptyField(page.fields)).toBe($("#Cvv2"));
  });

  it("walks the card boxes, then skips filled fields", () => {
    const page = fakePage(SPLIT_CARD_FORM);
    expect(nextTarget(page.fields, $("#CardNoPart1"))).toBe($("#CardNoPart2"));
    $("#Cvv2").value = "123";
    expect(nextTarget(page.fields, $("#CardNoPart4"))).toBe($("#Month"));
  });

  it("goes to the one-time password button after the captcha", () => {
    const page = fakePage(SPLIT_CARD_FORM);
    expect(nextTarget(page.fields, $("#Captcha"))).toBe($("#getOTP"));
    $("#Pin2").value = "123456";
    expect(nextTarget(page.fields, $("#Captcha"))).toBeNull();
  });

  it("knows when fixed-length fields are complete", () => {
    const page = fakePage(SPLIT_CARD_FORM);
    $("#Month").value = "1";
    expect(isComplete(page.fields, $("#Month"))).toBe(false);
    $("#Month").value = "12";
    expect(isComplete(page.fields, $("#Month"))).toBe(true);
    $("#Cvv2").value = "123";
    expect(isComplete(page.fields, $("#Cvv2"))).toBe(false);
    $("#Cvv2").value = "1234";
    expect(isComplete(page.fields, $("#Cvv2"))).toBe(true);
  });

  it("does not advance when focus already moved or the feature is off", () => {
    const page = fakePage(SPLIT_CARD_FORM);
    $("#Year").value = "05";
    $("#Month").focus();
    advanceFrom(page, $("#Year"));
    expect(document.activeElement).toBe($("#Month"));

    $("#Year").focus();
    page.settings.focus = false;
    advanceFrom(page, $("#Year"));
    expect(document.activeElement).toBe($("#Year"));

    page.settings.focus = true;
    advanceFrom(page, $("#Year"));
    expect(document.activeElement).toBe($("#Captcha"));
  });
});

describe("CVV2 guard", () => {
  /** What Mellat, Sepehr and others do: jump to the month after the third CVV2 digit. */
  function gatewayJumpsAfterThree() {
    const page = fakePage(SPLIT_CARD_FORM);
    installFocus(page);
    $("#Cvv2").focus();
    $("#Cvv2").value = "123";
    $("#Month").focus();
    return page;
  }

  it("puts focus back when the gateway leaves a 3-digit CVV2", async () => {
    gatewayJumpsAfterThree();
    await vi.waitFor(() => expect(document.activeElement).toBe($("#Cvv2")));
  });

  it("lets the user leave with Tab or by clicking another field", async () => {
    installFocus(fakePage(SPLIT_CARD_FORM));
    $("#Cvv2").focus();
    $("#Cvv2").value = "123";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    $("#Month").focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe($("#Month"));

    $("#Cvv2").focus();
    $("#Year").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    $("#Year").focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe($("#Year"));
  });

  it("does not hold a 4-digit CVV2 or run with autofocus off", async () => {
    let page = fakePage(SPLIT_CARD_FORM);
    installFocus(page);
    $("#Cvv2").focus();
    $("#Cvv2").value = "1234";
    $("#Month").focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe($("#Month"));

    page = fakePage(SPLIT_CARD_FORM);
    page.settings.focus = false;
    installFocus(page);
    $("#Cvv2").focus();
    $("#Cvv2").value = "123";
    $("#Month").focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe($("#Month"));
  });

  it("advances by itself after the fourth digit", async () => {
    installFocus(fakePage(SPLIT_CARD_FORM));
    $("#Cvv2").focus();
    $("#Cvv2").value = "1234";
    $("#Cvv2").dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    await vi.waitFor(() => expect(document.activeElement).toBe($("#Month")));
  });
});
