// Grid search over preprocessing pipelines per gateway. Prints the best candidates so they can be copied into
// gateways.ts. With ~10 samples per gateway this overfits easily; prefer the simplest candidate among ties.

import { parseArgs } from "node:util";
import {
  backgroundDistance,
  blur,
  dilate,
  erode,
  grayscale,
  median,
  pad,
  pipeline,
  removeSpecks,
  scale,
  threshold,
  type Step,
} from "../src/image.ts";
import type { PageSegMode } from "../src/gateways.ts";
import { createRecognizer, loadSamples } from "./node.ts";

const { values: args } = parseArgs({
  options: {
    gateway: { type: "string", short: "g" },
    top: { type: "string", default: "5" },
    concurrency: { type: "string", default: "4" },
  },
});

type Option = [name: string, steps: Step[]];
type Candidate = { name: string; steps: Step[]; complexity: number };

const colorOptions: Option[] = [
  ["grayscale()", [grayscale()]],
  ["backgroundDistance(1.5)", [backgroundDistance(1.5)]],
  ["backgroundDistance(3)", [backgroundDistance(3)]],
];
const denoiseOptions: Option[] = [
  ["", []],
  ["median(1)", [median(1)]],
];
const smoothOptions: Option[] = [
  ["", []],
  ["blur(2)", [blur(2)]],
];
const cleanupOptions: Option[] = [
  ["", []],
  ["removeSpecks(0.004)", [removeSpecks(0.004)]],
  ["removeSpecks(0.004), median(2)", [removeSpecks(0.004), median(2)]],
  ["dilate(1)", [dilate(1)]],
  ["erode(1)", [erode(1)]],
];
const psmOptions: PageSegMode[] = ["7", "8", "13"];

function buildCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  for (const color of colorOptions)
    for (const denoise of denoiseOptions)
      for (const smooth of smoothOptions)
        for (const cleanup of cleanupOptions) {
          const parts: Option[] = [color, denoise, ["scale(3)", [scale(3)]], smooth, ["threshold()", [threshold()]], cleanup, ["pad(20)", [pad(20)]]];
          const used = parts.filter(([name]) => name !== "");
          candidates.push({
            name: `[${used.map(([name]) => name).join(", ")}]`,
            steps: used.flatMap(([, steps]) => steps),
            complexity: used.length + (color[0] === "grayscale()" ? 0 : 1),
          });
        }
  return candidates;
}

const allSamples = await loadSamples(args.gateway?.split(",").map((g) => g.trim()));
const gateways = [...new Set(allSamples.map((s) => s.gateway))].sort();
const candidates = buildCandidates();
console.log(`Tuning ${gateways.length} gateways x ${candidates.length} pipelines x ${psmOptions.length} page modes`);

async function tuneGateway(gateway: string) {
  const samples = allSamples.filter((s) => s.gateway === gateway);
  const recognizer = await createRecognizer();
  const started = performance.now();
  const scored = [];
  for (const candidate of candidates) {
    const run = pipeline(candidate.steps);
    const processed = samples.map((sample) => run(sample.image));
    for (const psm of psmOptions) {
      let exact = 0;
      let digits = 0;
      let ms = 0;
      for (const [i, sample] of samples.entries()) {
        const result = await recognizer.recognize(processed[i], psm);
        if (result.text === sample.label) exact++;
        for (let d = 0; d < sample.label.length; d++) if (result.text[d] === sample.label[d]) digits++;
        digits -= Math.max(0, result.text.length - sample.label.length);
        ms += result.ms;
      }
      scored.push({ candidate, psm, exact, digits, ms: ms / samples.length });
    }
  }
  await recognizer.terminate();

  scored.sort((a, b) => b.exact - a.exact || b.digits - a.digits || a.candidate.complexity - b.candidate.complexity || a.ms - b.ms);
  const lines = scored
    .slice(0, Number(args.top))
    .map((s) => `  ${s.exact}/${samples.length} exact  ${s.digits}/${samples.length * 5} digits  ${s.ms.toFixed(0)}ms  psm ${s.psm}  ${s.candidate.name}`);
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  console.log(`\n${gateway} (${samples.length} samples, ${seconds}s)\n${lines.join("\n")}`);
}

const queue = [...gateways];
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    for (let gateway = queue.shift(); gateway; gateway = queue.shift()) await tuneGateway(gateway);
  }),
);
