import { describe, expect, it } from "vitest";
import { browser } from "#imports";
import { isExtensionPage, isGatewayPage } from "../src/lib/senders.ts";

const id = browser.runtime.id;
const tab = { id: 1 } as never;

describe("sender checks", () => {
  it("accepts content scripts on HTTPS Shaparak pages only", () => {
    expect(isGatewayPage({ id, tab, url: "https://sep.shaparak.ir/OnlinePG/OnlinePG" })).toBe(true);
    expect(isGatewayPage({ id, tab, url: "http://sep.shaparak.ir/" })).toBe(false);
    expect(isGatewayPage({ id, tab, url: "https://shaparak.ir.evil.com/" })).toBe(false);
    expect(isGatewayPage({ id, tab, url: "https://evilshaparak.ir/" })).toBe(false);
    expect(isGatewayPage({ id, url: "https://sep.shaparak.ir/" })).toBe(false);
    expect(isGatewayPage({ id: "other", tab, url: "https://sep.shaparak.ir/" })).toBe(false);
  });

  it("accepts only this extension's own pages for listing and deleting", () => {
    expect(isExtensionPage({ id, url: browser.runtime.getURL("/popup.html") })).toBe(true);
    expect(isExtensionPage({ id, tab, url: browser.runtime.getURL("/popup.html") })).toBe(false);
    expect(isExtensionPage({ id, url: "https://sep.shaparak.ir/" })).toBe(false);
  });
});
