// Writes training crops for the digit classifier (packages/ocr/training): every digit `segmentDigits` cuts out of the
// labeled dataset, of canvas look-alikes of each gateway, and of the Chars74K font digits, each passed through
// `toClassifierInput` exactly as the solver does. Output in --out: crops.u8 (32x32 bytes per crop, ink = 255) and
// crops.jsonl (one {label, gateway, source, sample} per crop, same order), plus preview.png.
//
// Look-alikes also yield the cases a bad split produces, so the classifier learns them: a digit with a sliver of its
// neighbour (source "sliver", labeled with the digit) and pieces that are not one digit, half a digit or two digits
// side by side (source "reject", label "x").
//
// Usage: pnpm crops --out <dir> [--real] [--synthetic <per gateway>] [--chars74k <dir>] [--fonts <dir>] [-g a,b]
//        [--guide <model.json>]   classifier that picks splits, as in the solver (default: the bundled one)
// Chars74K: download EnglishFnt.tgz from https://info-ee.surrey.ac.uk/CVSSP/demos/chars74k/ and pass the folder
// that contains English/Fnt.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { INPUT_SIZE, createDigitClassifier, toClassifierInput, type SerializedDigitModel } from "../src/classify.ts";
import { GATEWAY_CONFIGS, configFor } from "../src/gateways.ts";
import { fromGray, pipeline, threshold, toGray, type RgbaImage } from "../src/image.ts";
import { segmentDigits } from "../src/segment.ts";
import { defaultClassifier } from "../src/solve.ts";
import { decodePng, encodePng, loadSamples } from "./node.ts";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    gateway: { type: "string", short: "g" },
    real: { type: "boolean", default: false },
    synthetic: { type: "string", default: "0" },
    chars74k: { type: "string" },
    fonts: { type: "string" },
    seed: { type: "string", default: "1" },
    guide: { type: "string" },
  },
});
if (!args.out) throw new Error("Usage: pnpm crops --out <dir> [--real] [--synthetic <n>] [--chars74k <dir>]");

/** mulberry32, so a seed reproduces the same look-alikes (they draw with Math.random). */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = seeded(Number(args.seed));

type Meta = { label: string; gateway: string; source: "real" | "synthetic" | "chars74k" | "sliver" | "reject"; sample: string };
const pixels: Uint8Array[] = [];
const metas: Meta[] = [];
const stats = new Map<string, { tried: number; segmented: number }>();

function add(input: Float32Array, meta: Meta) {
  pixels.push(Uint8Array.from(input, (v) => Math.round(v * 255)));
  metas.push(meta);
}

const guide = args.guide
  ? createDigitClassifier(JSON.parse(await readFile(args.guide, "utf8")) as SerializedDigitModel)
  : defaultClassifier();
const score = (digit: RgbaImage) => guide(digit)?.probability ?? 0;

/** Draws `b` over `a` with its top left corner at (dx, dy) of `a`; the result is just big enough for both. */
function overlay(a: RgbaImage, b: RgbaImage, dx: number, dy: number): RgbaImage {
  const left = Math.min(0, dx);
  const top = Math.min(0, dy);
  const width = Math.max(a.width, dx + b.width) - left;
  const height = Math.max(a.height, dy + b.height) - top;
  const out = new Uint8ClampedArray(width * height).fill(255);
  for (const [image, ox, oy] of [[a, -left, -top], [b, dx - left, dy - top]] as const) {
    const gray = toGray(image);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (gray[y * image.width + x] < 128) out[(y + oy) * width + x + ox] = 0;
      }
    }
  }
  return fromGray(width, height, out);
}

function columns(image: RgbaImage, from: number, to: number): RgbaImage {
  const gray = toGray(image);
  const width = to - from;
  const out = new Uint8ClampedArray(width * image.height);
  for (let y = 0; y < image.height; y++) out.set(gray.subarray(y * image.width + from, y * image.width + to), y * width);
  return fromGray(width, image.height, out);
}

const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/** One digit with a sliver of a neighbour, and one piece that is not a single digit. */
function addSplitMistakes(digits: RgbaImage[], label: string, gateway: string, sample: string) {
  const i = randInt(0, digits.length - 1);
  const digit = digits[i];
  const j = i === 0 ? 1 : i === digits.length - 1 ? i - 1 : Math.random() < 0.5 ? i - 1 : i + 1;
  const neighbour = digits[j];
  const take = Math.max(2, Math.round(neighbour.width * (0.08 + Math.random() * 0.27)));
  const gap = randInt(-3, 4);
  const sliver = j < i
    ? overlay(digit, columns(neighbour, neighbour.width - take, neighbour.width), -take - gap, randInt(-10, 10))
    : overlay(digit, columns(neighbour, 0, take), digit.width + gap, randInt(-10, 10));
  const withSliver = toClassifierInput(sliver);
  if (withSliver) add(withSliver, { label: label[i], gateway, source: "sliver", sample });

  let piece: RgbaImage | null = null;
  if (Math.random() < 0.5 && i < digits.length - 1) {
    piece = overlay(digit, digits[i + 1], digit.width + randInt(-6, 3), randInt(-6, 6));
  } else if (digit.width >= digit.height * 0.45) {
    const cut = Math.round(digit.width * (0.3 + Math.random() * 0.4));
    piece = Math.random() < 0.5 ? columns(digit, 0, cut) : columns(digit, cut, digit.width);
  }
  const rejected = piece && toClassifierInput(piece);
  if (rejected) add(rejected, { label: "x", gateway, source: "reject", sample });
}

/** The solver's own path up to the classifier: gateway pipeline, then cut into digits. */
function addCaptcha(image: RgbaImage, label: string, gateway: string, source: Meta["source"], sample: string) {
  const config = configFor(gateway);
  const key = `${gateway} ${source}`;
  const stat = stats.get(key) ?? { tried: 0, segmented: 0 };
  stats.set(key, stat);
  stat.tried++;
  const guided = config.read === "classifier" ? score : undefined;
  const digits = segmentDigits(pipeline(config.steps)(image), config.length, config.segment ?? {}, guided);
  if (!digits) return;
  const inputs = digits.map(toClassifierInput);
  if (inputs.some((input) => !input)) return;
  stat.segmented++;
  inputs.forEach((input, i) => add(input!, { label: label[i], gateway, source, sample }));
  if (source === "synthetic") addSplitMistakes(digits, label, gateway, sample);
}

const gateways = args.gateway?.split(",").map((g) => g.trim()) ?? Object.keys(GATEWAY_CONFIGS);

if (args.real) {
  for (const { image, label, gateway, file } of await loadSamples(gateways)) addCaptcha(image, label, gateway, "real", file);
}

const perGateway = Number(args.synthetic);
if (perGateway > 0) {
  if (args.fonts) GlobalFonts.loadFontsFromDir(args.fonts);
  // The saman look-alike draws into an offscreen layer first.
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = function (width: number, height: number) {
    return createCanvas(width, height);
  };
  const { STYLES, randomDigits } = await import("../src/lookalikes.ts");
  for (const style of STYLES.filter((s) => gateways.includes(s.gateway))) {
    for (let n = 0; n < perGateway; n++) {
      const canvas = createCanvas(style.width, style.height);
      const ctx = canvas.getContext("2d");
      const digits = randomDigits();
      style.draw(ctx as unknown as CanvasRenderingContext2D, digits);
      const { data } = ctx.getImageData(0, 0, style.width, style.height);
      const image = { width: style.width, height: style.height, data: new Uint8ClampedArray(data) };
      addCaptcha(image, digits, style.gateway, "synthetic", `${style.gateway}-${n}`);
    }
  }
}

if (args.chars74k) {
  const binarize = threshold(128);
  for (let digit = 0; digit <= 9; digit++) {
    const dir = join(args.chars74k, "English", "Fnt", `Sample${String(digit + 1).padStart(3, "0")}`);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".png")).sort()) {
      const input = toClassifierInput(binarize(decodePng(await readFile(join(dir, file)))));
      if (input) add(input, { label: String(digit), gateway: "chars74k", source: "chars74k", sample: file });
    }
  }
}

/** A grid of up to 40 x 25 crops, sampled evenly, to eyeball what the classifier learns from. */
function preview(): RgbaImage {
  const columns = 40;
  const count = Math.min(pixels.length, columns * 25);
  const rows = Math.ceil(count / columns);
  const cell = INPUT_SIZE + 2;
  const gray = new Uint8ClampedArray(columns * cell * rows * cell).fill(128);
  for (let n = 0; n < count; n++) {
    const crop = pixels[Math.floor((n * pixels.length) / count)];
    const ox = (n % columns) * cell + 1;
    const oy = Math.floor(n / columns) * cell + 1;
    for (let y = 0; y < INPUT_SIZE; y++) {
      for (let x = 0; x < INPUT_SIZE; x++) gray[(oy + y) * columns * cell + ox + x] = 255 - crop[y * INPUT_SIZE + x];
    }
  }
  return fromGray(columns * cell, rows * cell, gray);
}

await mkdir(args.out, { recursive: true });
await writeFile(join(args.out, "crops.u8"), Buffer.concat(pixels));
await writeFile(join(args.out, "crops.jsonl"), metas.map((m) => JSON.stringify(m)).join("\n") + "\n");
if (pixels.length > 0) await writeFile(join(args.out, "preview.png"), encodePng(preview()));

for (const [key, { tried, segmented }] of [...stats].sort()) {
  console.log(`${key.padEnd(24)} segmented ${String(segmented).padStart(5)}/${tried} (${((segmented / tried) * 100).toFixed(1)}%)`);
}
console.log(`${pixels.length} crops written to ${args.out}`);
