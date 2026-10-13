// A small convolutional digit classifier that reads the digits `segmentDigits` cuts out, in place of Tesseract.
// Training lives in packages/ocr/training; it learns from crops made by `toClassifierInput`, so training and the
// extension see exactly the same pixels.

import { toGray, type RgbaImage } from "./image.ts";

/** Side of the square input. Glyphs are scaled so their longest side is `INPUT_SIZE - 2 * INPUT_MARGIN`. */
export const INPUT_SIZE = 32;
const INPUT_MARGIN = 2;

/**
 * Turns one digit image (dark ink on white) into the classifier's input: cropped to the ink, scaled with area
 * averaging so the longest side fills the box, centered, and inverted so ink is 1 and paper is 0. Returns null when
 * the image has no ink.
 */
export function toClassifierInput(digit: RgbaImage): Float32Array | null {
  const { width, height } = digit;
  const gray = toGray(digit);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] >= 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const factor = (INPUT_SIZE - 2 * INPUT_MARGIN) / Math.max(cropWidth, cropHeight);
  const outWidth = Math.max(1, Math.round(cropWidth * factor));
  const outHeight = Math.max(1, Math.round(cropHeight * factor));
  const left = Math.floor((INPUT_SIZE - outWidth) / 2);
  const top = Math.floor((INPUT_SIZE - outHeight) / 2);
  const out = new Float32Array(INPUT_SIZE * INPUT_SIZE);

  // Each output pixel averages the source area it covers, so thin strokes fade instead of vanishing.
  const sx = cropWidth / outWidth;
  const sy = cropHeight / outHeight;
  for (let oy = 0; oy < outHeight; oy++) {
    const y0 = oy * sy;
    const y1 = y0 + sy;
    for (let ox = 0; ox < outWidth; ox++) {
      const x0 = ox * sx;
      const x1 = x0 + sx;
      let ink = 0;
      for (let y = Math.floor(y0); y < Math.min(cropHeight, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(cropWidth, Math.ceil(x1)); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          ink += wx * wy * (255 - gray[(minY + y) * width + minX + x]);
        }
      }
      out[(top + oy) * INPUT_SIZE + left + ox] = ink / (sx * sy * 255);
    }
  }
  return out;
}

/** The model as stored in model/digits.ts: int8 weights with one scale per output channel, float32 biases. */
export type SerializedLayer =
  | { type: "conv"; in: number; out: number; weights: string; scales: string; bias: string }
  | { type: "dense"; in: number; out: number; relu: boolean; weights: string; scales: string; bias: string };

export type SerializedDigitModel = { size: number; temperature: number; layers: SerializedLayer[] };

type Layer =
  | { type: "conv"; in: number; out: number; weights: Float32Array; bias: Float32Array }
  | { type: "dense"; in: number; out: number; relu: boolean; weights: Float32Array; bias: Float32Array };

export type DigitPrediction = { digit: string; probability: number; probabilities: Float32Array };

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

function decodeLayer(layer: SerializedLayer): Layer {
  const quantized = new Int8Array(decodeBase64(layer.weights).buffer);
  const scales = new Float32Array(decodeBase64(layer.scales).buffer);
  const perOutput = quantized.length / layer.out;
  const weights = Float32Array.from(quantized, (q, i) => q * scales[Math.floor(i / perOutput)]);
  return { ...layer, weights, bias: new Float32Array(decodeBase64(layer.bias).buffer) };
}

/** 3x3 convolution with zero padding (weights laid out out x in x 3 x 3), then ReLU and 2x2 max pooling. */
function convBlock(input: Float32Array, size: number, layer: Layer & { type: "conv" }): Float32Array {
  const area = size * size;
  const conv = new Float32Array(layer.out * area);
  for (let o = 0; o < layer.out; o++) {
    const plane = conv.subarray(o * area, (o + 1) * area);
    plane.fill(layer.bias[o]);
    for (let i = 0; i < layer.in; i++) {
      const source = input.subarray(i * area, (i + 1) * area);
      const kernel = (o * layer.in + i) * 9;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const w = layer.weights[kernel + ky * 3 + kx];
          if (w === 0) continue;
          const dy = ky - 1;
          const dx = kx - 1;
          for (let y = Math.max(0, -dy); y < Math.min(size, size - dy); y++) {
            const row = y * size;
            const sourceRow = (y + dy) * size + dx;
            for (let x = Math.max(0, -dx); x < Math.min(size, size - dx); x++) plane[row + x] += w * source[sourceRow + x];
          }
        }
      }
    }
  }

  const half = size >> 1;
  const pooled = new Float32Array(layer.out * half * half);
  for (let o = 0; o < layer.out; o++) {
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const at = o * area + y * 2 * size + x * 2;
        // ReLU folded into the pooling: max(0, ...) of the four.
        pooled[(o * half + y) * half + x] = Math.max(0, conv[at], conv[at + 1], conv[at + size], conv[at + size + 1]);
      }
    }
  }
  return pooled;
}

function dense(input: Float32Array, layer: Layer & { type: "dense" }): Float32Array {
  const out = new Float32Array(layer.out);
  for (let o = 0; o < layer.out; o++) {
    let sum = layer.bias[o];
    const row = o * layer.in;
    for (let i = 0; i < layer.in; i++) sum += layer.weights[row + i] * input[i];
    out[o] = layer.relu && sum < 0 ? 0 : sum;
  }
  return out;
}

/** Decodes a model once and returns a function from `toClassifierInput` output to the raw class scores. */
export function createLogits(model: SerializedDigitModel): (input: Float32Array) => Float32Array {
  const layers = model.layers.map(decodeLayer);
  return (input) => {
    let current = input;
    let size = model.size;
    for (const layer of layers) {
      if (layer.type === "conv") {
        current = convBlock(current, size, layer);
        size >>= 1;
      } else {
        current = dense(current, layer);
      }
    }
    return current;
  };
}

export type DigitClassifier = (digit: RgbaImage) => DigitPrediction | null;

/**
 * Softmax over temperature-scaled scores, so the probabilities match how often the model is actually right. The
 * model's last class means "not one digit" (half a glyph, two glyphs): it is never the answer, it only takes
 * probability away from the digits, which is how a bad split loses to a good one.
 */
export function createDigitClassifier(model: SerializedDigitModel): DigitClassifier {
  const logits = createLogits(model);
  return (digit) => {
    const input = toClassifierInput(digit);
    if (!input) return null;
    const scores = logits(input).map((v) => v / model.temperature);
    const max = Math.max(...scores);
    const exp = scores.map((v) => Math.exp(v - max));
    const total = exp.reduce((a, b) => a + b, 0);
    const probabilities = exp.map((v) => v / total);
    let best = 0;
    for (let i = 1; i < 10; i++) if (probabilities[i] > probabilities[best]) best = i;
    return { digit: String(best), probability: probabilities[best], probabilities };
  };
}
