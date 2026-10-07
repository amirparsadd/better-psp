import {
  backgroundDistance,
  blur,
  close,
  deslant,
  dilate,
  erode,
  grayscale,
  median,
  pad,
  removeLongLines,
  removeSpecks,
  removeThinStrokes,
  scale,
  threshold,
  type Step,
} from "./image.ts";
import type { SegmentOptions } from "./segment.ts";

/** Tesseract page segmentation: 7 single line, 8 single word, 10 single character, 13 raw line. */
export type PageSegMode = "7" | "8" | "10" | "13";

export type GatewayOcrConfig = {
  length: number;
  psm: PageSegMode;
  /** Must end in a binarized image when segmenting. */
  steps: Step[];
  /** Cut into `length` digits and redraw them evenly before reading. */
  segment?: SegmentOptions;
  /** With segmentation: read the recomposed line, or each digit on its own. */
  read?: "line" | "digits";
  /** Page mode for each digit when read is "digits". */
  digitPsm?: PageSegMode;
};

export const DEFAULT_CONFIG: GatewayOcrConfig = {
  length: 5,
  psm: "7",
  steps: [grayscale(), scale(3), threshold(), pad(20)],
};

// Tuned on only ~10 samples per gateway (grid search plus hand tuning), so these may be overfit; re-check with
// `npm run bench` as the dataset grows.
export const GATEWAY_CONFIGS: Record<string, Partial<GatewayOcrConfig>> = {
  asanpardakht: { psm: "8" },
  irankish: {
    steps: [backgroundDistance(1.5), scale(3), threshold(), erode(1), pad(20)],
    segment: {},
  },
  mellat: {
    steps: [grayscale(), scale(3), blur(2), threshold(), removeSpecks(0.004), median(2), pad(20)],
  },
  novin: {
    steps: [
      backgroundDistance(3),
      threshold(),
      removeLongLines(0.2),
      scale(3),
      threshold(128),
      close(3),
      removeThinStrokes(4),
      removeSpecks(0.004),
      pad(20),
    ],
    segment: {},
  },
  parsian: {
    psm: "8",
    steps: [backgroundDistance(1.5), median(1), scale(3), blur(2), threshold(), dilate(1), pad(20)],
  },
  pasargad: {
    steps: [backgroundDistance(1.5), median(1), scale(3), threshold(), removeSpecks(0.004), median(2), pad(20)],
    segment: {},
  },
  sadad: {
    steps: [backgroundDistance(1.5), scale(3), threshold(), erode(1), pad(20)],
    segment: {},
  },
  saman: {
    steps: [backgroundDistance(3), median(1), scale(3), threshold(), removeSpecks(0.004), median(2), pad(20)],
  },
  sepehr: {
    steps: [grayscale(), scale(3), threshold(190), close(1), removeSpecks(0.006), pad(40), deslant()],
    segment: {},
  },
};

export function configFor(gateway: string): GatewayOcrConfig {
  return { ...DEFAULT_CONFIG, ...GATEWAY_CONFIGS[gateway] };
}
