import { configFor, createRecognize, solveCaptcha, type Recognize, type RgbaImage, type TesseractWorker } from "@better-psp/ocr";
import { createWorker, OEM } from "tesseract.js";

/** Same bar the extension uses before it fills the field. */
export const MIN_CONFIDENCE = 60;

function toCanvas({ width, height, data }: RgbaImage): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas;
}

export type Reading = { text: string; confidence: number; processed: RgbaImage; ms: number; filled: boolean };

export async function createEngine(base: string, onProgress?: (fraction: number) => void) {
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: `${base}tesseract/worker.min.js`,
    corePath: `${base}tesseract/tesseract-core-simd-lstm.wasm.js`,
    langPath: `${base}tesseract`,
    gzip: true,
    workerBlobURL: false,
    logger: ({ status, progress }) => {
      if (status === "loading language traineddata") onProgress?.(progress);
    },
  });
  const recognize: Recognize = await createRecognize(worker as unknown as TesseractWorker<OffscreenCanvas>, toCanvas);
  let queue: Promise<unknown> = Promise.resolve();

  return {
    /** One at a time: a solve switches Tesseract's page mode several times. */
    read(image: RgbaImage, gateway: string): Promise<Reading> {
      const run = async (): Promise<Reading> => {
        const config = configFor(gateway);
        const started = performance.now();
        const { text, confidence, processed } = await solveCaptcha(image, config, recognize);
        const filled = text.length === config.length && confidence >= MIN_CONFIDENCE;
        return { text, confidence, processed, ms: performance.now() - started, filled };
      };
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
  };
}
