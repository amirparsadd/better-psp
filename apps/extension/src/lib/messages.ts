import { browser } from "#imports";
import type { CardFingerprint } from "./fields.ts";

export type SavedCard = { id: string; bin: string; last4: string; savedAt: number };

export type VaultRequest =
  | { type: "vault:get"; card: CardFingerprint }
  | { type: "vault:save"; card: CardFingerprint; cvv2: string }
  | { type: "vault:forget"; card: CardFingerprint }
  | { type: "vault:list" }
  | { type: "vault:delete"; id: string };

export type VaultResponses = {
  "vault:get": { cvv2: string } | null;
  "vault:save": SavedCard;
  "vault:forget": null;
  "vault:list": SavedCard[];
  "vault:delete": null;
};

/** Requests the background accepts only from content scripts on gateway pages. */
export const PAGE_REQUESTS = new Set<VaultRequest["type"]>(["vault:get", "vault:save", "vault:forget"]);
/** Requests the background accepts only from extension pages (the popup). */
export const EXTENSION_REQUESTS = new Set<VaultRequest["type"]>(["vault:list", "vault:delete"]);

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export function isVaultRequest(message: unknown): message is VaultRequest {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === "string" && (PAGE_REQUESTS.has(type as never) || EXTENSION_REQUESTS.has(type as never));
}

export async function sendVault<T extends VaultRequest>(request: T): Promise<VaultResponses[T["type"]]> {
  return unwrap((await browser.runtime.sendMessage(request)) as Reply<VaultResponses[T["type"]]> | undefined);
}

export type CaptchaSolution = { text: string; confidence: number } | null;

/**
 * `ocr:solve` goes from a gateway page to the background. On Chrome the background passes it on to the
 * offscreen page as `ocr:run`. The image is a PNG data URL: messages are JSON, which pixel arrays bloat.
 */
export type OcrRequest = { type: "ocr:solve"; gateway: string; image: string };
export type OcrRun = { type: "ocr:run"; gateway: string; image: string };

export function isOcrRequest(message: unknown): message is OcrRequest {
  const m = message as Partial<OcrRequest> | null;
  return m?.type === "ocr:solve" && typeof m.gateway === "string" && typeof m.image === "string";
}

export function isOcrRun(message: unknown): message is OcrRun {
  const m = message as Partial<OcrRun> | null;
  return m?.type === "ocr:run" && typeof m.gateway === "string" && typeof m.image === "string";
}

export async function sendOcr(request: OcrRequest): Promise<CaptchaSolution> {
  return unwrap((await browser.runtime.sendMessage(request)) as Reply<CaptchaSolution> | undefined);
}

function unwrap<T>(reply: Reply<T> | undefined): T {
  if (!reply) throw new Error("No response from background");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export function replyWith<T>(promise: Promise<T>, sendResponse: (reply: Reply<T>) => void): true {
  promise.then(
    (value) => sendResponse({ ok: true, value }),
    (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}
