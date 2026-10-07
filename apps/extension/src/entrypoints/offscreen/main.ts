import { browser } from "#imports";
import { isOcrRun, replyWith } from "../../lib/messages.ts";
import { createSolver, tesseractBase } from "../../lib/ocr-engine.ts";
import { isExtensionPage } from "../../lib/senders.ts";

// Chrome only: the background service worker forwards captchas here because it cannot start Web Workers.
const solver = createSolver(tesseractBase());

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOcrRun(message)) return;
  if (!isExtensionPage(sender)) return replyWith(Promise.reject(new Error("Forbidden")), sendResponse);
  return replyWith(solver.solve(message.gateway, message.image), sendResponse);
});
