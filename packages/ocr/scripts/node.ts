import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Tesseract from "tesseract.js";
import engData from "@tesseract.js-data/eng";
import { PNG } from "pngjs";
import type { RgbaImage } from "../src/image.ts";
import type { PageSegMode } from "../src/gateways.ts";
import type { RecognizedSymbol } from "../src/solve.ts";
import { createRecognize, type TesseractWorker } from "../src/tesseract.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DATASET_DIR = join(ROOT, "datasets");

export type Sample = { file: string; label: string; gateway: string };

export function decodePng(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

export async function loadSamples(gateways?: string[]): Promise<(Sample & { image: RgbaImage })[]> {
  const manifest = await readFile(join(DATASET_DIR, "manifest.jsonl"), "utf8");
  const samples = manifest
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Sample)
    .filter((sample) => !gateways || gateways.includes(sample.gateway));
  return Promise.all(
    samples.map(async (sample) => ({ ...sample, image: decodePng(await readFile(join(DATASET_DIR, sample.file))) })),
  );
}

export type Recognition = { text: string; confidence: number; symbols: RecognizedSymbol[]; ms: number };

export async function createRecognizer() {
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
    langPath: engData.langPath,
    gzip: engData.gzip,
    cacheMethod: "none",
  });
  const recognize = await createRecognize(worker as unknown as TesseractWorker<Buffer>, encodePng);

  return {
    async recognize(image: RgbaImage, psm: PageSegMode): Promise<Recognition> {
      const started = performance.now();
      return { ...(await recognize(image, psm)), ms: performance.now() - started };
    },
    terminate: () => worker.terminate(),
  };
}
