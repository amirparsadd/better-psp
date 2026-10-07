import { browser, defineBackground, type Browser } from "#imports";
import { loadOrCreateKeys, type VaultKeys } from "../lib/keystore.ts";
import {
  EXTENSION_REQUESTS,
  isOcrRequest,
  isVaultRequest,
  PAGE_REQUESTS,
  replyWith,
  type CaptchaSolution,
  type OcrRequest,
  type OcrRun,
  type Reply,
  type VaultRequest,
} from "../lib/messages.ts";
import { isExtensionPage, isGatewayPage } from "../lib/senders.ts";
import { createVault } from "../lib/vault.ts";

type Sender = Browser.runtime.MessageSender;

const OFFSCREEN_URL = "/offscreen.html";

export default defineBackground(() => {
  let keys: Promise<VaultKeys> | undefined;
  const vault = createVault(() => {
    keys ??= loadOrCreateKeys().catch((error: unknown) => {
      keys = undefined;
      throw error;
    });
    return keys;
  });

  async function handle(request: VaultRequest, sender: Sender): Promise<unknown> {
    if (PAGE_REQUESTS.has(request.type) && !isGatewayPage(sender)) throw new Error("Forbidden");
    if (EXTENSION_REQUESTS.has(request.type) && !isExtensionPage(sender)) throw new Error("Forbidden");

    switch (request.type) {
      case "vault:get":
        return vault.get(request.card);
      case "vault:save":
        return vault.save(request.card, request.cvv2);
      case "vault:forget":
        return vault.forget(request.card).then(() => null);
      case "vault:list":
        return vault.list();
      case "vault:delete":
        return vault.remove(request.id).then(() => null);
    }
  }

  // Firefox's background is a page and can start Tesseract's worker itself; Chrome's is a service worker, and
  // its build drops this branch so tesseract.js stays out of it.
  const localSolver = import.meta.env.FIREFOX
    ? import("../lib/ocr-engine.ts").then(({ createSolver, tesseractBase }) => createSolver(tesseractBase()))
    : null;
  let offscreen: Promise<void> | undefined;

  async function ensureOffscreen() {
    const contexts = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length > 0) return;
    offscreen ??= browser.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Reads the payment gateway's numeric captcha with Tesseract, locally.",
      })
      .finally(() => (offscreen = undefined));
    await offscreen;
  }

  async function solve(request: OcrRequest, sender: Sender): Promise<CaptchaSolution> {
    if (!isGatewayPage(sender)) throw new Error("Forbidden");
    if (localSolver) return (await localSolver).solve(request.gateway, request.image);
    await ensureOffscreen();
    const run: OcrRun = { type: "ocr:run", gateway: request.gateway, image: request.image };
    const reply = (await browser.runtime.sendMessage(run)) as Reply<CaptchaSolution> | undefined;
    if (!reply) throw new Error("No response from the offscreen page");
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (isVaultRequest(message)) return replyWith(handle(message, sender), sendResponse);
    if (isOcrRequest(message)) return replyWith(solve(message, sender), sendResponse);
  });
});
