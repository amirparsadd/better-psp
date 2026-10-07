// Pure image operations on RGBA buffers. Same shape as canvas ImageData, so they run in Node and in the extension.
// Every step outputs grayscale-in-RGBA; text ends up dark on a white background, which is what Tesseract expects.

export type RgbaImage = { width: number; height: number; data: Uint8ClampedArray };
export type Step = (image: RgbaImage) => RgbaImage;

export function toGray({ width, height, data }: RgbaImage): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < gray.length; i++) {
    const alpha = data[i * 4 + 3] / 255;
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    gray[i] = lum * alpha + 255 * (1 - alpha);
  }
  return gray;
}

export function fromGray(width: number, height: number, gray: Uint8ClampedArray): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = gray[i];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function mapGray(fn: (gray: Uint8ClampedArray, width: number, height: number) => Uint8ClampedArray): Step {
  return (image) => fromGray(image.width, image.height, fn(toGray(image), image.width, image.height));
}

export const grayscale = (): Step => mapGray((gray) => gray);

export const invert = (): Step => mapGray((gray) => gray.map((v) => 255 - v));

/** Grayscale by color distance from the background (median of border pixels). Removes colored backgrounds and grids. */
export const backgroundDistance = (gain = 2): Step => (image) => {
  const { width, height, data } = image;
  const border: number[][] = [[], [], []];
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) for (let c = 0; c < 3; c++) border[c].push(data[(y * width + x) * 4 + c]);
  }
  for (let y = 0; y < height; y++) {
    for (const x of [0, width - 1]) for (let c = 0; c < 3; c++) border[c].push(data[(y * width + x) * 4 + c]);
  }
  const bg = border.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < gray.length; i++) {
    const dr = data[i * 4] - bg[0];
    const dg = data[i * 4 + 1] - bg[1];
    const db = data[i * 4 + 2] - bg[2];
    gray[i] = 255 - Math.sqrt(dr * dr + dg * dg + db * db) * gain;
  }
  return fromGray(width, height, gray);
};

/** Bilinear upscale; Tesseract works best with glyphs roughly 30px+ tall. */
export const scale = (factor: number): Step => (image) => {
  const width = Math.round(image.width * factor);
  const height = Math.round(image.height * factor);
  const src = image.data;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * image.width + x0) * 4 + c];
        const b = src[(y0 * image.width + x1) * 4 + c];
        const d = src[(y1 * image.width + x0) * 4 + c];
        const e = src[(y1 * image.width + x1) * 4 + c];
        data[(y * width + x) * 4 + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
    }
  }
  return { width, height, data };
};

function otsu(gray: Uint8ClampedArray): number {
  const histogram = new Array<number>(256).fill(0);
  for (const v of gray) histogram[v]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/** Binarize: pixels darker than the threshold become black text. Omit the value to use Otsu. */
export const threshold = (value?: number): Step =>
  mapGray((gray) => {
    const t = value ?? otsu(gray);
    return gray.map((v) => (v <= t ? 0 : 255));
  });

type Reducer = "min" | "max" | "mean";

/** Square-window min/max/mean, computed as a horizontal pass then a vertical pass. */
function separable(gray: Uint8ClampedArray, width: number, height: number, radius: number, reducer: Reducer) {
  const pass = (src: Uint8ClampedArray, length: number, lines: number, stride: number, step: number) => {
    const out = new Uint8ClampedArray(src.length);
    for (let line = 0; line < lines; line++) {
      const base = line * stride;
      for (let i = 0; i < length; i++) {
        let acc = reducer === "min" ? 255 : 0;
        for (let d = -radius; d <= radius; d++) {
          const v = src[base + Math.min(length - 1, Math.max(0, i + d)) * step];
          if (reducer === "min") acc = v < acc ? v : acc;
          else if (reducer === "max") acc = v > acc ? v : acc;
          else acc += v;
        }
        out[base + i * step] = reducer === "mean" ? acc / (radius * 2 + 1) : acc;
      }
    }
    return out;
  };
  return pass(pass(gray, width, height, width, 1), height, width, 1, width);
}

export const median = (radius = 1): Step =>
  mapGray((gray, width, height) => {
    const out = new Uint8ClampedArray(gray.length);
    const window = new Uint8Array((radius * 2 + 1) ** 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const row = Math.min(height - 1, Math.max(0, y + dy)) * width;
          for (let dx = -radius; dx <= radius; dx++) window[n++] = gray[row + Math.min(width - 1, Math.max(0, x + dx))];
        }
        out[y * width + x] = window.sort()[window.length >> 1];
      }
    }
    return out;
  });

export const blur = (radius = 1): Step => mapGray((gray, w, h) => separable(gray, w, h, radius, "mean"));

/** Grows dark (text) regions; fills dotted or hollow glyphs. */
export const dilate = (radius = 1): Step => mapGray((gray, w, h) => separable(gray, w, h, radius, "min"));

/** Shrinks dark (text) regions; removes lines thinner than the glyph strokes. */
export const erode = (radius = 1): Step => mapGray((gray, w, h) => separable(gray, w, h, radius, "max"));

/**
 * Removes dark connected components (8-connected) smaller than minArea pixels. Expects a binarized image.
 * A minArea below 1 is a fraction of the image area, so one value works across scales.
 */
export const removeSpecks = (minArea: number): Step =>
  mapGray((gray, width, height) => {
    const limit = minArea < 1 ? minArea * width * height : minArea;
    const out = gray.slice();
    for (const component of findComponents(gray, width, height)) {
      if (component.pixels.length < limit) for (const index of component.pixels) out[index] = 255;
    }
    return out;
  });

/**
 * Straightens italic text: tries horizontal shears within ±maxShear and keeps the one whose column ink profile is
 * sharpest (sum of squared column counts), i.e. where strokes are most vertical and gaps between digits open up.
 * Expects a binarized image.
 */
export const deslant = (maxShear = 0.7, step = 0.05): Step =>
  mapGray((gray, width, height) => {
    const dark: [number, number][] = [];
    for (let i = 0; i < gray.length; i++) if (gray[i] === 0) dark.push([i % width, Math.floor(i / width)]);
    const reach = Math.ceil(maxShear * height);
    const columns = new Float64Array(width + reach * 2);
    let best = 0;
    let bestScore = -1;
    for (let shear = -maxShear; shear <= maxShear + 1e-9; shear += step) {
      columns.fill(0);
      for (const [x, y] of dark) columns[Math.round(x + shear * (y - height / 2)) + reach]++;
      let score = 0;
      for (const count of columns) score += count * count;
      if (score > bestScore) {
        bestScore = score;
        best = shear;
      }
    }
    const out = new Uint8ClampedArray(gray.length).fill(255);
    for (const [x, y] of dark) {
      const nx = Math.round(x + best * (y - height / 2));
      if (nx >= 0 && nx < width) out[y * width + nx] = 0;
    }
    return out;
  });

/** Seals gaps narrower than about 2 * radius + 1 pixels inside glyphs (slivers left by line removal, dotted strokes). */
export const close = (radius: number): Step => (image) => erode(radius)(dilate(radius)(image));

/**
 * Removes dark strokes thinner than about 2 * radius + 1 pixels (crossing lines, rings) while keeping the exact
 * outline of thicker glyphs: a morphological opening, intersected with the original. Expects a binarized image.
 */
export const removeThinStrokes = (radius: number): Step => (image) => {
  const opened = pipeline([erode(radius), dilate(radius)])(image);
  const original = toGray(image);
  const kept = toGray(opened);
  return fromGray(image.width, image.height, original.map((v, i) => Math.max(v, kept[i])));
};

/**
 * Erases straight dark lines: runs longer than `length` pixels (a fraction of the width when below 1), traced at
 * every angle within ±maxAngle degrees of horizontal. Digits never contain a straight run that long. Only pixels
 * where the stroke is at most `thickness` pixels across (measured perpendicular to the run) are erased, so a line
 * crossing a bold glyph does not cut through it. Expects a binarized image.
 */
export const removeLongLines = (length: number, thickness = 4, maxAngle = 45, angleStep = 2): Step =>
  mapGray((gray, width, height) => {
    const minRun = length < 1 ? length * width : length;
    const isDark = (x: number, y: number) => {
      const rx = Math.round(x);
      const ry = Math.round(y);
      return rx >= 0 && ry >= 0 && rx < width && ry < height && gray[ry * width + rx] === 0;
    };
    const out = gray.slice();
    const run = new Int32Array(width);
    const offsets = new Int32Array(width);

    for (let degrees = -maxAngle; degrees <= maxAngle; degrees += angleStep) {
      const radians = (degrees * Math.PI) / 180;
      const slope = Math.tan(radians);
      const nx = -Math.sin(radians);
      const ny = Math.cos(radians);
      for (let x = 0; x < width; x++) offsets[x] = Math.round(slope * x);
      const reach = Math.ceil(Math.abs(slope) * width);
      const [firstRow, lastRow] = slope >= 0 ? [-reach, height] : [0, height + reach];

      for (let y0 = firstRow; y0 < lastRow; y0++) {
        let runLength = 0;
        for (let x = 0; x <= width; x++) {
          const y = y0 + offsets[x];
          if (x < width && y >= 0 && y < height && gray[y * width + x] === 0) {
            run[runLength++] = y * width + x;
            continue;
          }
          if (runLength >= minRun) {
            for (let r = 0; r < runLength; r++) {
              const index = run[r];
              const px = index % width;
              const py = (index - px) / width;
              let across = 1;
              for (let d = 1; across <= thickness && isDark(px - d * nx, py - d * ny); d++) across++;
              for (let d = 1; across <= thickness && isDark(px + d * nx, py + d * ny); d++) across++;
              if (across <= thickness) out[index] = 255;
            }
          }
          runLength = 0;
        }
      }
    }
    return out;
  });

export type Component = { pixels: number[]; minX: number; maxX: number; minY: number; maxY: number };

/** 8-connected components of black (0) pixels. */
export function findComponents(gray: Uint8ClampedArray, width: number, height: number): Component[] {
  const seen = new Uint8Array(gray.length);
  const stack: number[] = [];
  const components: Component[] = [];
  for (let start = 0; start < gray.length; start++) {
    if (seen[start] || gray[start] !== 0) continue;
    const component: Component = { pixels: [], minX: width, maxX: 0, minY: height, maxY: 0 };
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      component.pixels.push(index);
      if (x < component.minX) component.minX = x;
      if (x > component.maxX) component.maxX = x;
      if (y < component.minY) component.minY = y;
      if (y > component.maxY) component.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!seen[next] && gray[next] === 0) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    components.push(component);
  }
  return components;
}

/** White margin around the text; Tesseract misreads glyphs touching the image edge. */
export const pad = (pixels = 10): Step => (image) => {
  const gray = toGray(image);
  const width = image.width + pixels * 2;
  const height = image.height + pixels * 2;
  const out = new Uint8ClampedArray(width * height).fill(255);
  for (let y = 0; y < image.height; y++) {
    out.set(gray.subarray(y * image.width, (y + 1) * image.width), (y + pixels) * width + pixels);
  }
  return fromGray(width, height, out);
};

export function pipeline(steps: Step[]): Step {
  return (image) => steps.reduce((current, step) => step(current), image);
}
