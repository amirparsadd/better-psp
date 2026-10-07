import type { PageSegMode } from "./gateways.ts";
import type { RgbaImage } from "./image.ts";
import type { RecognizedSymbol, Recognize } from "./solve.ts";

type TesseractSymbol = { text: string; confidence: number; bbox: { x0: number; x1: number } };
type TesseractBlock = { paragraphs: { lines: { words: { symbols: TesseractSymbol[] }[] }[] }[] };

/** The parts of a tesseract.js worker the solver uses, so this package does not depend on tesseract.js. */
export type TesseractWorker<Input> = {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(
    image: Input,
    options: object,
    output: { text: true; blocks: true },
  ): Promise<{ data: { text: string; blocks: TesseractBlock[] | null } }>;
};

/** Create the worker with OEM 1 (LSTM only) and the English model; captchas are Latin digits. */
export const TESSERACT_PARAMETERS = { tessedit_char_whitelist: "0123456789", user_defined_dpi: "300" };

/** Wraps a tesseract.js worker as a `Recognize`. `encode` turns RGBA pixels into something the worker accepts. */
export async function createRecognize<Input>(
  worker: TesseractWorker<Input>,
  encode: (image: RgbaImage) => Input,
): Promise<Recognize> {
  await worker.setParameters(TESSERACT_PARAMETERS);
  let currentPsm: PageSegMode | null = null;

  return async (image, psm) => {
    if (psm !== currentPsm) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      currentPsm = psm;
    }
    const { data } = await worker.recognize(encode(image), {}, { text: true, blocks: true });
    const symbols = (data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words.flatMap((w) => w.symbols))),
    );
    const digits = symbols.filter((s) => /\d/.test(s.text));
    return {
      text: data.text.replace(/\D/g, ""),
      // Page-level confidence is unreliable with a whitelist; the weakest digit is a better signal.
      confidence: digits.length > 0 ? Math.min(...digits.map((s) => s.confidence)) : 0,
      symbols: symbols.map((s): RecognizedSymbol => ({ text: s.text, confidence: s.confidence, x0: s.bbox.x0, x1: s.bbox.x1 })),
    };
  };
}
