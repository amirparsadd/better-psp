import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configFor, defaultClassifier, solveCaptcha, type GatewayOcrConfig, type Recognize } from "@better-psp/ocr";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const envPath = join(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = Number(process.env.PORT ?? 4321);
const MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID ?? "";
const DEFAULT_AMOUNT = Number(process.env.ZARINPAL_AMOUNT ?? 10000);
const CALLBACK_URL = process.env.ZARINPAL_CALLBACK_URL ?? `https://figfit.ir`;
const DATASET_DIR = resolve(root, process.env.DATASET_DIR ?? "datasets");
const MANIFEST = join(DATASET_DIR, "manifest.jsonl");
const ZARINPAL = "https://payment.zarinpal.com/pg";
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const KNOWN_GATEWAYS: Record<string, string> = {
  "payment.zarinpal.com": "zarinpal",
  "sep.shaparak.ir": "saman",
  "bpm.shaparak.ir": "mellat",
  "pec.shaparak.ir": "parsian",
  "pep.shaparak.ir": "pasargad",
  "ikc.shaparak.ir": "irankish",
  "sadad.shaparak.ir": "sadad",
  "asan.shaparak.ir": "asanpardakht",
  "mabna.shaparak.ir": "sepehr",
  "fcp.shaparak.ir": "fanava",
  "pna.shaparak.ir": "novin",
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".html": "text/plain; charset=utf-8",
};

type ManifestEntry = {
  file: string;
  label: string;
  gateway: string;
  host: string;
  /** Origin and path only: the query holds the gateway's session token. */
  pageUrl: string;
  mime: string;
  width: number | null;
  height: number | null;
  sha256: string;
  savedAt: string;
  /**
   * What the bundled model read. The page keeps it hidden until the label is typed, so labels never copy it and it
   * is an honest accuracy check on captchas the model never saw.
   */
  guess?: { text: string; confidence: number } | null;
  /** On a few early samples labeled by an AI agent rather than a person typing in the page. */
  labeler?: string;
};

type Body = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const entries = await loadManifest();

async function loadManifest(): Promise<ManifestEntry[]> {
  if (!existsSync(MANIFEST)) return [];
  const text = await readFile(MANIFEST, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ManifestEntry);
}

function detectGateway(rawUrl: unknown): { gateway: string; host: string; pageUrl: string } {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw new HttpError(400, "Paste the full URL of the gateway page (starting with https://)");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const fallback = host.endsWith(".shaparak.ir") ? host.slice(0, -".shaparak.ir".length) : host;
  const gateway = (KNOWN_GATEWAYS[host] ?? fallback).replace(/[^a-z0-9]+/g, "-");
  return { gateway, host, pageUrl: url.href };
}

function normalizeLabel(raw: string): string {
  return raw
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, "");
}

function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function toDatasetPath(abs: string): string {
  return relative(DATASET_DIR, abs).split(sep).join("/");
}

function resolveInDataset(rel: string): string {
  const abs = resolve(DATASET_DIR, rel);
  if (!abs.startsWith(DATASET_DIR + sep)) throw new HttpError(400, "Path escapes the dataset directory");
  return abs;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDataUrl(value: unknown): { mime: string; bytes: Buffer } {
  const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(value ?? ""));
  if (!match) throw new HttpError(400, "Image must be a base64 data URL");
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

async function createPaymentLink(body: Body) {
  if (!MERCHANT_ID) throw new HttpError(400, "ZARINPAL_MERCHANT_ID is not set in .env");
  const amount = Number(body.amount ?? DEFAULT_AMOUNT);
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, "Amount must be a positive integer (rials)");

  const response = await fetch(`${ZARINPAL}/v4/payment/request.json`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      merchant_id: MERCHANT_ID,
      amount,
      callback_url: CALLBACK_URL,
      description: "Captcha dataset collection (not meant to be paid)",
    }),
  });
  const result = (await response.json().catch(() => null)) as {
    data?: { code?: number; authority?: string };
    errors?: unknown;
  } | null;

  const authority = result?.data?.authority;
  if (result?.data?.code !== 100 || !authority) {
    throw new HttpError(502, `Zarinpal rejected the request: ${JSON.stringify(result?.errors ?? result)}`);
  }
  return { authority, url: `${ZARINPAL}/StartPay/${authority}` };
}

async function saveHtml(body: Body) {
  const { gateway, host, pageUrl } = detectGateway(body.pageUrl);
  const html = typeof body.html === "string" ? body.html : "";
  if (html.trim() === "") throw new HttpError(400, "HTML is empty");

  const savedAt = new Date().toISOString();
  const dir = join(DATASET_DIR, gateway, "pages");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${fileStamp(savedAt)}.html`);
  await writeFile(file, html);
  await writeFile(
    file.replace(/\.html$/, ".meta.json"),
    JSON.stringify({ gateway, host, pageUrl, authority: optionalString(body.authority), savedAt }, null, 2),
  );
  return { gateway, file: toDatasetPath(file) };
}

async function saveCaptcha(body: Body): Promise<ManifestEntry> {
  const { gateway, host, pageUrl: fullUrl } = detectGateway(body.pageUrl);
  const { origin, pathname } = new URL(fullUrl);
  const pageUrl = origin + pathname;
  const label = normalizeLabel(String(body.label ?? ""));
  if (!/^[0-9A-Za-z]+$/.test(label)) throw new HttpError(400, "Label must contain only digits or letters");

  const { mime, bytes } = parseDataUrl(body.image);
  const ext = IMAGE_EXTENSIONS[mime];
  if (!ext) throw new HttpError(400, `Unsupported image type ${mime}`);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const duplicate = entries.find((entry) => entry.sha256 === sha256);
  if (duplicate) throw new HttpError(409, `Already saved as ${duplicate.file} (label ${duplicate.label})`);

  const savedAt = new Date().toISOString();
  const dir = join(DATASET_DIR, gateway, "captchas");
  await mkdir(dir, { recursive: true });
  const abs = join(dir, `${label}_${fileStamp(savedAt)}.${ext}`);
  await writeFile(abs, bytes);

  const entry: ManifestEntry = {
    file: toDatasetPath(abs),
    label,
    gateway,
    host,
    pageUrl,
    mime,
    width: optionalNumber(body.width),
    height: optionalNumber(body.height),
    sha256,
    savedAt,
    guess: await guessFor(gateway, mime, bytes),
  };
  entries.push(entry);
  await appendFile(MANIFEST, JSON.stringify(entry) + "\n");
  return entry;
}

// The collector reads captchas with the digit classifier only, so it needs no Tesseract. Gateways without a tuned
// classifier pipeline still get a guess from their default steps, which helps when collecting a new gateway.
const noTesseract: Recognize = async () => ({ text: "", confidence: 0, symbols: [] });

function guessConfig(gateway: string): GatewayOcrConfig {
  const config = configFor(gateway);
  return config.read === "classifier" ? config : { ...config, segment: config.segment ?? {}, read: "classifier" };
}

// A captcha is guessed when it arrives and again when it is saved. Guessing blocks the server for a moment, so each
// answer is kept for a while.
const guesses = new Map<string, ManifestEntry["guess"]>();

async function guessFor(gateway: string, mime: string, bytes: Buffer): Promise<ManifestEntry["guess"]> {
  if (mime !== "image/png") return null;
  const key = `${gateway} ${createHash("sha256").update(bytes).digest("hex")}`;
  if (guesses.has(key)) return guesses.get(key);
  let guess: ManifestEntry["guess"] = null;
  try {
    const png = PNG.sync.read(bytes);
    const image = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
    const { text, confidence } = await solveCaptcha(image, guessConfig(gateway), noTesseract, defaultClassifier());
    if (text) guess = { text, confidence: Math.round(confidence) };
  } catch {
    // Not a readable PNG: no guess.
  }
  guesses.set(key, guess);
  if (guesses.size > 200) guesses.delete(guesses.keys().next().value!);
  return guess;
}

async function guessCaptcha(body: Body) {
  const { gateway } = detectGateway(body.pageUrl);
  const { mime, bytes } = parseDataUrl(body.image);
  return { guess: await guessFor(gateway, mime, bytes) };
}

// Live mode: a gateway tab running gateway.js (a bookmarklet, see GET /api/bookmarklet) sends its captcha here and a
// new one whenever the page asks, so captchas stream into the page with no copying. Several tabs can be connected.
type LiveCaptcha = {
  id: string;
  image: string;
  width: number | null;
  height: number | null;
  guess: ManifestEntry["guess"];
};
type LiveSession = {
  id: string;
  gateway: string;
  host: string;
  pageUrl: string;
  seen: number;
  sent: number;
  wanted: boolean;
  wake?: () => void;
  /** Sent but not yet labeled, so a page opened later still gets it. */
  latest?: LiveCaptcha;
};
const sessions = new Map<string, LiveSession>();
const listeners = new Set<ServerResponse>();
const LIVE_WAIT_MS = 20_000;
const LIVE_STALE_MS = 45_000;

function broadcast(event: string, data: unknown, to: Iterable<ServerResponse> = listeners) {
  for (const res of to) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sessionList() {
  return [...sessions.values()].map(({ id, gateway, host, sent }) => ({ id, gateway, host, sent }));
}

function liveCaptchaEvent(session: LiveSession, captcha: LiveCaptcha) {
  const { id, gateway, host, pageUrl } = session;
  return { session: id, gateway, host, pageUrl, ...captcha };
}

function liveSession(body: Body): LiveSession {
  const id = String(body.session ?? "");
  if (!/^[\w-]{8,64}$/.test(id)) throw new HttpError(400, "Bad session id");
  let session = sessions.get(id);
  if (!session) {
    const { gateway, host, pageUrl } = detectGateway(body.pageUrl);
    session = { id, gateway, host, pageUrl, seen: Date.now(), sent: 0, wanted: false };
    sessions.set(id, session);
    broadcast("sessions", sessionList());
  }
  session.seen = Date.now();
  return session;
}

async function livePush(body: Body) {
  const session = liveSession(body);
  const { mime, bytes } = parseDataUrl(body.image);
  const captcha: LiveCaptcha = {
    id: `${session.id}-${session.sent + 1}`,
    image: String(body.image),
    width: optionalNumber(body.width),
    height: optionalNumber(body.height),
    guess: await guessFor(session.gateway, mime, bytes),
  };
  session.latest = captcha;
  session.sent++;
  broadcast("captcha", liveCaptchaEvent(session, captcha));
  broadcast("sessions", sessionList());
  return { ok: true };
}

/** Long poll from the gateway tab: "next" once the page wants a new captcha from it, "wait" after a while. */
async function liveWait(body: Body) {
  const session = liveSession(body);
  if (!session.wanted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LIVE_WAIT_MS);
      session.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    session.wake = undefined;
    session.seen = Date.now();
  }
  const command = session.wanted ? "next" : "wait";
  session.wanted = false;
  return { command };
}

function liveNext(body: Body) {
  const session = sessions.get(String(body.session ?? ""));
  if (!session) throw new HttpError(404, "That gateway tab is no longer connected");
  session.latest = undefined;
  session.wanted = true;
  session.wake?.();
  return { ok: true };
}

function liveEvents(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  broadcast("sessions", sessionList(), [res]);
  for (const session of sessions.values()) {
    if (session.latest) broadcast("captcha", liveCaptchaEvent(session, session.latest), [res]);
  }
  listeners.add(res);
  req.on("close", () => listeners.delete(res));
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, session] of sessions) {
    if (now - session.seen > LIVE_STALE_MS) changed = sessions.delete(id);
  }
  if (changed) broadcast("sessions", sessionList());
  for (const res of listeners) res.write(": keep-alive\n\n");
}, 10_000).unref();

/** The gateway-side script as a bookmarklet, pointed back at this server. */
async function bookmarklet(req: IncomingMessage) {
  const source = await readFile(join(here, "gateway.js"), "utf8");
  const code = source.replace("__COLLECTOR__", `http://${req.headers.host ?? `localhost:${PORT}`}`);
  return { href: "javascript:" + encodeURIComponent(code) };
}

async function deleteCaptcha(body: Body) {
  const index = entries.findIndex((entry) => entry.file === body.file);
  if (index === -1) throw new HttpError(404, "No such sample");
  const [entry] = entries.splice(index, 1);
  await unlink(resolveInDataset(entry.file)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await writeFile(MANIFEST, entries.map((e) => JSON.stringify(e) + "\n").join(""));
  return { deleted: entry.file };
}

function stats() {
  const byGateway: Record<string, number> = {};
  for (const entry of entries) byGateway[entry.gateway] = (byGateway[entry.gateway] ?? 0) + 1;
  return { total: entries.length, byGateway };
}

async function readJson(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Body) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function sendFile(res: ServerResponse, path: string, contentType: string) {
  const data = await readFile(path).catch(() => {
    throw new HttpError(404, "Not found");
  });
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  res.end(data);
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Session closed</title>
<body style="font:16px system-ui;padding:3rem;background:#0f1115;color:#e6e8ee">
<h1>Payment session closed</h1><p>Nothing was charged. You can close this tab and go back to the collector.</p></body>`;

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  switch (`${req.method} ${url.pathname}`) {
    case "GET /":
      return sendFile(res, join(here, "index.html"), "text/html; charset=utf-8");
    case "GET /relay":
      return sendFile(res, join(here, "relay.html"), "text/html; charset=utf-8");
    case "GET /callback":
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(CALLBACK_PAGE);
    case "GET /api/config":
      return sendJson(res, 200, {
        defaultAmount: DEFAULT_AMOUNT,
        merchantConfigured: MERCHANT_ID !== "",
        datasetDir: relative(root, DATASET_DIR) || ".",
      });
    case "GET /api/stats":
      return sendJson(res, 200, stats());
    case "GET /api/recent":
      return sendJson(res, 200, entries.slice(-20).reverse());
    case "POST /api/link":
      return sendJson(res, 200, await createPaymentLink(await readJson(req)));
    case "POST /api/detect": {
      const { gateway, host } = detectGateway((await readJson(req)).pageUrl);
      return sendJson(res, 200, { gateway, host });
    }
    case "POST /api/html":
      return sendJson(res, 200, await saveHtml(await readJson(req)));
    case "POST /api/captcha":
      return sendJson(res, 200, await saveCaptcha(await readJson(req)));
    case "POST /api/guess":
      return sendJson(res, 200, await guessCaptcha(await readJson(req)));
    case "POST /api/captcha/delete":
      return sendJson(res, 200, await deleteCaptcha(await readJson(req)));
    case "GET /api/bookmarklet":
      return sendJson(res, 200, await bookmarklet(req));
    case "GET /api/live":
      return liveEvents(req, res);
    case "POST /api/live/next":
      return sendJson(res, 200, liveNext(await readJson(req)));
    case "POST /api/live/push":
      return sendJson(res, 200, await livePush(await readJson(req)));
    case "POST /api/live/wait":
      return sendJson(res, 200, await liveWait(await readJson(req)));
  }

  if (req.method === "GET" && url.pathname.startsWith("/datasets/")) {
    const abs = resolveInDataset(decodeURIComponent(url.pathname.slice("/datasets/".length)));
    return sendFile(res, abs, CONTENT_TYPES[extname(abs)] ?? "application/octet-stream");
  }

  throw new HttpError(404, "Not found");
}

/** Gateway pages running gateway.js may only send captchas and wait for requests (live mode). */
const GATEWAY_ORIGIN = /^https:\/\/[a-z0-9-]+\.shaparak\.ir(:\d+)?$/;
const GATEWAY_PATHS = new Set(["/api/live/push", "/api/live/wait", "/api/bookmarklet"]);

function allowGateway(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin ?? "";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!GATEWAY_ORIGIN.test(origin) || !GATEWAY_PATHS.has(path)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  if (req.method !== "OPTIONS") return false;
  res.writeHead(204, {
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
  });
  res.end();
  return true;
}

createServer(async (req, res) => {
  try {
    if (allowGateway(req, res)) return;
    await route(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Captcha collector running at http://localhost:${PORT}`);
  if (!MERCHANT_ID) console.warn("ZARINPAL_MERCHANT_ID is not set; link generation is disabled (see .env.example).");
});
