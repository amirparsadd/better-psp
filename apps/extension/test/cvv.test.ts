import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { installCvv } from "../src/lib/cvv.ts";
import type { VaultRequest } from "../src/lib/messages.ts";
import { fakePage, SPLIT_CARD_FORM } from "./helpers.ts";

const $ = (selector: string) => document.querySelector<HTMLInputElement>(selector)!;

let stored: Map<string, string>;
let requests: VaultRequest[];

function typeCard(number: string) {
  document.querySelectorAll<HTMLInputElement>("[id^=CardNoPart]").forEach((el, i) => {
    el.value = number.slice(i * 4, i * 4 + 4);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CVV2 store", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    stored = new Map();
    requests = [];
    fakeBrowser.runtime.onMessage.addListener((message: VaultRequest, _sender, sendResponse) => {
      requests.push(message);
      const key = "card" in message ? `${message.card.bin}:${message.card.last4}` : "";
      if (message.type === "vault:get") {
        sendResponse({ ok: true, value: stored.has(key) ? { cvv2: stored.get(key) } : null });
      } else if (message.type === "vault:save") {
        stored.set(key, message.cvv2);
        sendResponse({ ok: true, value: null });
      } else if (message.type === "vault:forget") {
        stored.delete(key);
        sendResponse({ ok: true, value: null });
      }
      return true;
    });
  });

  it("saves nothing without consent", async () => {
    const page = fakePage(SPLIT_CARD_FORM);
    installCvv(page);
    typeCard("6037991234567890");
    $("#Cvv2").value = "123";
    $("#pay").click();
    await vi.waitFor(() => expect(requests.map((r) => r.type)).toEqual(["vault:get"]));
    expect(stored.size).toBe(0);
  });

  it("saves on pay when ticked, then fills it next time", async () => {
    let page = fakePage(SPLIT_CARD_FORM);
    let { checkbox } = installCvv(page);
    typeCard("6037991234567890");
    $("#Cvv2").value = "123";
    checkbox.click();
    $("#pay").click();
    await vi.waitFor(() => expect(stored.get("603799:7890")).toBe("123"));

    page = fakePage(SPLIT_CARD_FORM);
    ({ checkbox } = installCvv(page));
    typeCard("6037991234567890");
    await vi.waitFor(() => expect($("#Cvv2").value).toBe("123"));
    expect(checkbox.checked).toBe(true);
  });

  it("forgets immediately when a saved card is unticked", async () => {
    stored.set("603799:7890", "999");
    const page = fakePage(SPLIT_CARD_FORM);
    const { checkbox } = installCvv(page);
    typeCard("6037991234567890");
    await vi.waitFor(() => expect(checkbox.checked).toBe(true));
    checkbox.click();
    await vi.waitFor(() => expect(stored.size).toBe(0));
  });

  it("matches masked saved cards by BIN and last four digits", async () => {
    stored.set("603799:7890", "456");
    document.body.innerHTML = "";
    const page = fakePage(`<input id="CardNumber" maxlength="19" value="6037-99**-****-7890"><input id="Cvv2">`);
    installCvv(page);
    await vi.waitFor(() => expect($("#Cvv2").value).toBe("456"));
  });
});
