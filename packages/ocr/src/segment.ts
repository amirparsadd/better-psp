import { findComponents, fromGray, scale, threshold, toGray, type RgbaImage } from "./image.ts";

export type SegmentOptions = {
  /** Shapes smaller than this fraction of the largest shape are treated as noise. */
  minAreaRatio?: number;
  /** Every digit is redrawn at this height, which undoes superscripts and uneven baselines. */
  digitHeight?: number;
};

type Part = { pixels: number[]; minX: number; maxX: number; minY: number; maxY: number };

const widthOf = (part: Part) => part.maxX - part.minX + 1;
const gapBetween = (left: Part, right: Part) => right.minX - left.maxX;

function boundsOf(pixels: number[], width: number): Part {
  const part: Part = { pixels, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const index of pixels) {
    const x = index % width;
    const y = (index - x) / width;
    part.minX = Math.min(part.minX, x);
    part.maxX = Math.max(part.maxX, x);
    part.minY = Math.min(part.minY, y);
    part.maxY = Math.max(part.maxY, y);
  }
  return part;
}

function merge(a: Part, b: Part): Part {
  return {
    pixels: a.pixels.concat(b.pixels),
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Pieces of one glyph (a detached bar, a broken stroke) mostly share the same columns. */
function mergeOverlapping(parts: Part[]): Part[] {
  const result: Part[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    const overlap = previous ? Math.min(previous.maxX, part.maxX) - Math.max(previous.minX, part.minX) : -1;
    if (previous && overlap > 0.5 * Math.min(widthOf(previous), widthOf(part))) result[result.length - 1] = merge(previous, part);
    else result.push(part);
  }
  return result;
}

/** Splits touching glyphs at the column with the least ink in the middle of the shape. */
function splitAtValley(part: Part, width: number): [Part, Part] | null {
  const columns = new Array<number>(widthOf(part)).fill(0);
  for (const index of part.pixels) columns[(index % width) - part.minX]++;
  const from = Math.floor(columns.length * 0.3);
  const to = Math.ceil(columns.length * 0.7);
  let cut = from;
  for (let x = from; x < to; x++) if (columns[x] < columns[cut]) cut = x;

  const left: number[] = [];
  const right: number[] = [];
  for (const index of part.pixels) ((index % width) - part.minX < cut ? left : right).push(index);
  return left.length > 0 && right.length > 0 ? [boundsOf(left, width), boundsOf(right, width)] : null;
}

function render(part: Part, sourceWidth: number, digitHeight: number): RgbaImage {
  const width = widthOf(part);
  const height = part.maxY - part.minY + 1;
  const gray = new Uint8ClampedArray(width * height).fill(255);
  for (const index of part.pixels) {
    const x = index % sourceWidth;
    const y = (index - x) / sourceWidth;
    gray[(y - part.minY) * width + (x - part.minX)] = 0;
  }
  return threshold(128)(scale(digitHeight / height)(fromGray(width, height, gray)));
}

/**
 * Cuts a binarized captcha into exactly `count` digit images, left to right. Returns null when the shapes cannot be
 * reconciled into that many digits, which is a strong signal that the read would be wrong.
 */
export function segmentDigits(image: RgbaImage, count: number, options: SegmentOptions = {}): RgbaImage[] | null {
  const { minAreaRatio = 0.1, digitHeight = 64 } = options;
  const components = findComponents(toGray(image), image.width, image.height);
  if (components.length === 0) return null;

  const largest = Math.max(...components.map((c) => c.pixels.length));
  let parts = mergeOverlapping(
    components.filter((c) => c.pixels.length >= largest * minAreaRatio).sort((a, b) => a.minX - b.minX),
  );

  for (let guard = 0; parts.length !== count && guard < count * 4; guard++) {
    if (parts.length > count) {
      const areas = parts.map((p) => p.pixels.length).sort((a, b) => a - b);
      const medianArea = areas[areas.length >> 1];
      const smallest = parts.reduce((a, b) => (b.pixels.length < a.pixels.length ? b : a));
      if (smallest.pixels.length < medianArea * 0.35) {
        parts = parts.filter((p) => p !== smallest);
      } else {
        let closest = 0;
        for (let i = 1; i < parts.length - 1; i++) {
          if (gapBetween(parts[i], parts[i + 1]) < gapBetween(parts[closest], parts[closest + 1])) closest = i;
        }
        parts.splice(closest, 2, merge(parts[closest], parts[closest + 1]));
      }
    } else {
      const widest = parts.reduce((a, b) => (widthOf(b) > widthOf(a) ? b : a));
      const halves = splitAtValley(widest, image.width);
      if (!halves) return null;
      parts.splice(parts.indexOf(widest), 1, ...halves);
    }
  }

  return parts.length === count ? parts.map((part) => render(part, image.width, digitHeight)) : null;
}

/** Lays digits out as one clean, evenly spaced line on a shared baseline; spans are each digit's x range. */
export function composeLine(digits: RgbaImage[], gap = 16, margin = 20): { image: RgbaImage; spans: [number, number][] } {
  const height = Math.max(...digits.map((d) => d.height)) + margin * 2;
  const width = digits.reduce((sum, d) => sum + d.width, 0) + gap * (digits.length - 1) + margin * 2;
  const out = new Uint8ClampedArray(width * height).fill(255);
  const spans: [number, number][] = [];
  let x = margin;
  for (const digit of digits) {
    const gray = toGray(digit);
    const top = margin + Math.floor((height - margin * 2 - digit.height) / 2);
    for (let y = 0; y < digit.height; y++) {
      out.set(gray.subarray(y * digit.width, (y + 1) * digit.width), (top + y) * width + x);
    }
    spans.push([x - gap / 2, x + digit.width + gap / 2]);
    x += digit.width + gap;
  }
  return { image: fromGray(width, height, out), spans };
}
