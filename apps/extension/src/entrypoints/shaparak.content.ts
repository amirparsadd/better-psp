import { defineContentScript } from "#imports";
import { installCaptcha } from "../lib/captcha.ts";
import { installClean } from "../lib/clean.ts";
import { installContact } from "../lib/contact.ts";
import { installCvv } from "../lib/cvv.ts";
import { installDigitInput } from "../lib/digit-input.ts";
import { installFocus } from "../lib/focus.ts";
import { createPage } from "../lib/page.ts";
import { DEFAULT_SETTINGS, loadSettings, settingsItem } from "../lib/settings.ts";

export default defineContentScript({
  matches: ["https://*.shaparak.ir/*"],
  runAt: "document_idle",
  async main(ctx) {
    const page = createPage(ctx, await loadSettings());
    const unwatch = settingsItem.watch((next) => page.setSettings({ ...DEFAULT_SETTINGS, ...next }));
    ctx.onInvalidated(unwatch);

    installDigitInput(page);
    installFocus(page);
    installCvv(page);
    installContact(page);
    installClean(page);
    installCaptcha(page);
  },
});
