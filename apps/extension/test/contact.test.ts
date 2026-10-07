import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { contactItem, installContact, isEmail, normalizeMobile } from "../src/lib/contact.ts";
import { fakePage, SPLIT_CARD_FORM } from "./helpers.ts";

const $ = (selector: string) => document.querySelector<HTMLInputElement>(selector)!;
const FORM = SPLIT_CARD_FORM.replace("</form>", `<input id="Email" type="email"></form>`);

describe("mobile and email parsing", () => {
  it("normalizes the usual ways of writing a mobile number", () => {
    for (const text of ["09123456789", "+989123456789", "00989123456789", "9123456789", "۰۹۱۲ ۳۴۵ ۶۷۸۹"]) {
      expect(normalizeMobile(text)).toBe("09123456789");
    }
    expect(normalizeMobile("0912345678")).toBeNull();
    expect(normalizeMobile("02112345678")).toBeNull();
  });

  it("accepts plain email addresses", () => {
    expect(isEmail("someone@example.com")).toBe(true);
    expect(isEmail("someone@example")).toBe(false);
    expect(isEmail("some one@example.com")).toBe(false);
  });
});

describe("contact autofill", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await contactItem.setValue({ email: "me@example.com", mobile: "09123456789" });
  });

  it("fills empty email and mobile fields", async () => {
    installContact(fakePage(FORM));
    await vi.waitFor(() => expect($("#Email").value).toBe("me@example.com"));
    expect($("#MobileNo").value).toBe("09123456789");
  });

  it("keeps what the gateway or the user already entered", async () => {
    const page = fakePage(FORM);
    $("#MobileNo").value = "09350000000";
    installContact(page);
    await vi.waitFor(() => expect($("#Email").value).toBe("me@example.com"));
    expect($("#MobileNo").value).toBe("09350000000");
  });

  it("does nothing when turned off", async () => {
    const page = fakePage(FORM);
    page.settings.contact = false;
    installContact(page);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect($("#Email").value).toBe("");
    expect($("#MobileNo").value).toBe("");
  });
});
