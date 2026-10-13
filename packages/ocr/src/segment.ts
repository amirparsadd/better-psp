import { erode, findComponents, fromGray, scale, threshold, toGray, type RgbaImage } from "./image.ts";

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

/** Splits a shape in two at a column, counted from its left edge. */
function cutAt(part: Part, width: number, cut: number): [Part, Part] | null {
  const left: number[] = [];
  const right: number[] = [];
  for (const index of part.pixels) ((index % width) - part.minX < cut ? left : right).push(index);
  return left.length > 0 && right.length > 0 ? [boundsOf(left, width), boundsOf(right, width)] : null;
}

/** Splits touching glyphs at the column with the least ink in the middle of the shape. */
function splitAtValley(part: Part, width: number): [Part, Part] | null {
  const columns = new Array<number>(widthOf(part)).fill(0);
  for (const index of part.pixels) columns[(index % width) - part.minX]++;
  const from = Math.floor(columns.length * 0.3);
  const to = Math.ceil(columns.length * 0.7);
  let cut = from;
  for (let x = from; x < to; x++) if (columns[x] < columns[cut]) cut = x;
  return cutAt(part, width, cut);
}

/**
 * Ways to split touching glyphs, for a classifier to choose from: the valley cut first, other straight cuts across
 * the middle, then the pieces the shape breaks into as it is eroded, grown back over it and grouped into a left and
 * a right half. Only the eroded pieces can separate glyphs that overlap in x, like Sadad's raised digits.
 */
function candidateSplits(part: Part, width: number): [Part, Part][] {
  const candidates: [Part, Part][] = [];
  const valley = splitAtValley(part, width);
  if (valley) candidates.push(valley);
  const partWidth = widthOf(part);
  for (let cut = Math.floor(partWidth * 0.2); cut <= Math.ceil(partWidth * 0.8); cut += Math.max(1, Math.floor(partWidth / 20))) {
    const halves = cutAt(part, width, cut);
    if (halves) candidates.push(halves);
  }

  // One white pixel of margin, so the erosion also eats in from the edges of the bounding box.
  const w = partWidth + 2;
  const h = part.maxY - part.minY + 3;
  const local = (index: number) => {
    const x = index % width;
    return ((index - x) / width - part.minY + 1) * w + (x - part.minX + 1);
  };
  const mask = new Uint8ClampedArray(w * h).fill(255);
  for (const index of part.pixels) mask[local(index)] = 0;

  let previousCount = 1;
  for (let radius = 1; radius <= Math.ceil(h / 4); radius++) {
    const found = findComponents(toGray(erode(radius)(fromGray(w, h, mask))), w, h).sort((a, b) => b.pixels.length - a.pixels.length);
    if (found.length === 0) break;
    const pieces = found
      .filter((p) => p.pixels.length >= found[0].pixels.length * 0.08)
      .slice(0, 4)
      .sort((a, b) => a.minX + a.maxX - (b.minX + b.maxX));
    if (pieces.length === previousCount) continue;
    previousCount = pieces.length;
    if (pieces.length < 2) continue;

    // Grow the pieces back over the original shape one ring at a time, so each pixel joins the nearest piece.
    const owner = new Int8Array(w * h).fill(-1);
    let frontier: number[] = [];
    pieces.forEach((piece, id) => piece.pixels.forEach((i) => ((owner[i] = id), frontier.push(i))));
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const i of frontier) {
        const x = i % w;
        const y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const n = (y + dy) * w + x + dx;
            if (x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h || mask[n] !== 0 || owner[n] !== -1) continue;
            owner[n] = owner[i];
            next.push(n);
          }
        }
      }
      frontier = next;
    }

    // Bits the growth never reaches (detached strokes merged in earlier) go with the piece whose center is nearest.
    const centers = pieces.map((p) => (p.minX + p.maxX) / 2);
    const nearest = (x: number) => centers.reduce((best, c, id) => (Math.abs(x - c) < Math.abs(x - centers[best]) ? id : best), 0);
    for (let k = 1; k < pieces.length; k++) {
      const halves: number[][] = [[], []];
      for (const index of part.pixels) {
        const i = local(index);
        halves[(owner[i] !== -1 ? owner[i] : nearest(i % w)) < k ? 0 : 1].push(index);
      }
      if (halves[0].length > 0 && halves[1].length > 0) candidates.push([boundsOf(halves[0], width), boundsOf(halves[1], width)]);
    }
  }
  return candidates;
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
 *
 * Touching glyphs are split at the thinnest column. Given `score` (how sure a classifier is that an image is one
 * digit, 0 to 1), the last split, which must leave one digit on each side, goes wherever the two halves are most
 * convincing digits instead.
 */
export function segmentDigits(
  image: RgbaImage,
  count: number,
  options: SegmentOptions = {},
  score?: (digit: RgbaImage) => number,
): RgbaImage[] | null {
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
      // The classifier can only judge a split whose halves are one digit each, so it picks only the last one.
      const guided = score && parts.length === count - 1;
      let halves = guided ? null : splitAtValley(widest, image.width);
      if (guided) {
        let best = -1;
        for (const candidate of candidateSplits(widest, image.width)) {
          const value = score(render(candidate[0], image.width, digitHeight)) * score(render(candidate[1], image.width, digitHeight));
          if (value > best) [best, halves] = [value, candidate];
        }
      }
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
