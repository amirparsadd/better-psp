import { browser } from "#imports";
import { configFor, createRecognize, solveCaptcha, type Recognize, type RgbaImage, type TesseractWorker } from "@better-psp/ocr";
import { createWorker, OEM, type Worker } from "tesseract.js";
import type { CaptchaSolution } from "./messages.ts";

/** Same bar as the "filled" column of `pnpm bench`: below it a wrong guess is more likely than a right one. */
export const MIN_CONFIDENCE = 60;
/** Tesseract holds tens of megabytes; let it go once nobody is paying. */
const IDLE_MS = 2 * 60_000;

function toCanvas({ width, height, data }: RgbaImage): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas;
}

export async function decodePng(dataUrl: string): Promise<RgbaImage> {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (ch) => ch.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

/** Where the build hook in wxt.config.ts puts Tesseract's worker, core and model. */
export function tesseractBase(): string {
  return (browser.runtime.getURL as (path: string) => string)("/tesseract");
}

/**
 * Runs Tesseract from the files under `base`. Needs a context that can start Web Workers: the offscreen page
 * on Chrome, the background page on Firefox.
 */
export function createSolver(base: string) {
  let engine: Promise<{ worker: Worker; recognize: Recognize }> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;

  function start() {
    engine ??= (async () => {
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: `${base}/worker.min.js`,
        corePath: `${base}/tesseract-core-simd-lstm.wasm.js`,
        langPath: base,
        gzip: true,
        cacheMethod: "none",
        workerBlobURL: false,
      });
      return { worker, recognize: await createRecognize(worker as unknown as TesseractWorker<OffscreenCanvas>, toCanvas) };
    })();
    engine.catch(() => (engine = undefined));
    return engine;
  }

  function stopWhenIdle() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      const current = engine;
      engine = undefined;
      void current?.then(({ worker }) => worker.terminate());
    }, IDLE_MS);
  }

  async function run(gateway: string, png: string): Promise<CaptchaSolution> {
    clearTimeout(idle);
    try {
      const { recognize } = await start();
      const config = configFor(gateway);
      const { text, confidence } = await solveCaptcha(await decodePng(png), config, recognize);
      return text.length === config.length && confidence >= MIN_CONFIDENCE ? { text, confidence } : null;
    } finally {
      stopWhenIdle();
    }
  }

  return {
    /** Solves one captcha at a time: a solve switches Tesseract's page mode several times. */
    solve(gateway: string, png: string): Promise<CaptchaSolution> {
      const result = queue.then(() => run(gateway, png));
      queue = result.catch(() => {});
      return result;
    },
  };
}
