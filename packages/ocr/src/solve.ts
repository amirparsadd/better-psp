import { pad, pipeline, type RgbaImage } from "./image.ts";
import { composeLine, segmentDigits } from "./segment.ts";
import { createDigitClassifier, type DigitClassifier } from "./classify.ts";
import { DIGIT_MODEL } from "./model/digits.ts";
import type { GatewayOcrConfig, PageSegMode } from "./gateways.ts";

export type RecognizedSymbol = { text: string; confidence: number; x0: number; x1: number };

export type Recognize = (
  image: RgbaImage,
  psm: PageSegMode,
) => Promise<{ text: string; confidence: number; symbols: RecognizedSymbol[] }>;

export type Solution = {
  text: string;
  confidence: number;
  /** The image the reader actually saw (the recomposed line when segmenting). */
  processed: RgbaImage;
};

const padDigit = pad(20);

let bundledClassifier: DigitClassifier | undefined;
/** The classifier trained in packages/ocr/training, decoded on first use. */
export function defaultClassifier(): DigitClassifier {
  return (bundledClassifier ??= createDigitClassifier(DIGIT_MODEL));
}

/** Picks the most confident symbol centered inside each digit span, so the answer has exactly one digit per span. */
function assignToSpans(symbols: RecognizedSymbol[], spans: [number, number][]): { text: string; confidence: number } {
  let text = "";
  let confidence = 100;
  for (const [from, to] of spans) {
    const inside = symbols.filter((s) => /^\d$/.test(s.text) && (s.x0 + s.x1) / 2 >= from && (s.x0 + s.x1) / 2 < to);
    if (inside.length === 0) return { text: "", confidence: 0 };
    const best = inside.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    text += best.text;
    confidence = Math.min(confidence, best.confidence);
  }
  return { text, confidence };
}

/**
 * Second half of solving, split out so tuning can preprocess once and try several read strategies. With the
 * classifier, Tesseract (`recognize`) is only called when the captcha cannot be cut into digits.
 */
export async function readProcessed(
  processed: RgbaImage,
  config: GatewayOcrConfig,
  recognize: Recognize,
  classify: DigitClassifier = defaultClassifier(),
): Promise<Solution> {
  if (!config.segment) {
    const { text, confidence } = await recognize(processed, config.psm);
    return { text, confidence, processed };
  }

  const score = config.read === "classifier" ? (digit: RgbaImage) => classify(digit)?.probability ?? 0 : undefined;
  const digits = segmentDigits(processed, config.length, config.segment, score);
  if (!digits) {
    if (config.read !== "classifier") return { text: "", confidence: 0, processed };
    const { text, confidence } = await recognize(processed, config.psm);
    return { text, confidence, processed };
  }
  const line = composeLine(digits);

  if (config.read === "classifier") {
    let text = "";
    let confidence = 100;
    for (const digit of digits) {
      const prediction = classify(digit);
      if (!prediction) return { text: "", confidence: 0, processed: line.image };
      text += prediction.digit;
      confidence = Math.min(confidence, prediction.probability * 100);
    }
    return { text, confidence, processed: line.image };
  }

  if (config.read !== "digits") {
    const { symbols } = await recognize(line.image, config.psm);
    return { ...assignToSpans(symbols, line.spans), processed: line.image };
  }

  let text = "";
  let confidence = 100;
  for (const digit of digits) {
    const result = await recognize(padDigit(digit), config.digitPsm ?? "10");
    if (result.text.length !== 1) return { text: "", confidence: 0, processed: line.image };
    text += result.text;
    confidence = Math.min(confidence, result.confidence);
  }
  return { text, confidence, processed: line.image };
}

export function solveCaptcha(
  image: RgbaImage,
  config: GatewayOcrConfig,
  recognize: Recognize,
  classify?: DigitClassifier,
): Promise<Solution> {
  return readProcessed(pipeline(config.steps)(image), config, recognize, classify);
}
