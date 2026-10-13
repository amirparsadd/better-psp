import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDigitClassifier, type DigitClassifier, type SerializedDigitModel } from "../src/classify.ts";
import { configFor } from "../src/gateways.ts";
import { solveCaptcha } from "../src/solve.ts";
import { ROOT, createRecognizer, encodePng, loadSamples, type Sample } from "./node.ts";

const RESULTS_DIR = join(ROOT, "bench-results");

const { values: args } = parseArgs({
  options: {
    gateway: { type: "string", short: "g" },
    "min-confidence": { type: "string", default: "60" },
    raw: { type: "boolean", default: false },
    /** A classifier JSON (train.py's final.json or fold-k.json) to use instead of the bundled one. */
    model: { type: "string" },
    /**
     * A train.py --cv run: each captcha is read by the fold model that never saw it. The bundled model was trained on
     * every captcha here, so only this gives an honest accuracy for the classifier.
     */
    cv: { type: "string" },
  },
});
const minConfidence = Number(args["min-confidence"]);

const loadClassifier = async (file: string) =>
  createDigitClassifier(JSON.parse(await readFile(file, "utf8")) as SerializedDigitModel);
const modelClassifier = args.model ? await loadClassifier(args.model) : undefined;
const folds: Record<string, number> = args.cv ? JSON.parse(await readFile(join(args.cv, "folds.json"), "utf8")) : {};
const foldClassifiers = new Map<number, DigitClassifier>();
async function classifierFor(file: string): Promise<DigitClassifier | undefined> {
  if (!args.cv) return modelClassifier;
  // Captchas labeled after the run are in no fold, and no fold model has seen them.
  const fold = folds[file] ?? 0;
  if (!foldClassifiers.has(fold)) foldClassifiers.set(fold, await loadClassifier(join(args.cv, `fold-${fold}.json`)));
  return foldClassifiers.get(fold);
}

type Variant = "raw" | "tuned";
type Result = Sample & { variant: Variant; text: string; confidence: number; ms: number; filled: boolean; correct: boolean };

function digitAccuracy(label: string, text: string): number {
  let matches = 0;
  for (let i = 0; i < label.length; i++) if (text[i] === label[i]) matches++;
  return matches / Math.max(label.length, text.length);
}

const percent = (part: number, total: number) => (total === 0 ? "-" : `${((part / total) * 100).toFixed(1)}%`);

const samples = await loadSamples(args.gateway?.split(",").map((g) => g.trim()));
if (samples.length === 0) throw new Error("No samples found in datasets/manifest.jsonl");

const recognizer = await createRecognizer();
await rm(RESULTS_DIR, { recursive: true, force: true });
const variants: Variant[] = args.raw ? ["raw", "tuned"] : ["tuned"];
const results: Result[] = [];

for (const { image, ...sample } of samples) {
  const config = configFor(sample.gateway);

  for (const variant of variants) {
    const started = performance.now();
    const { text, confidence, processed } =
      variant === "raw"
        ? { ...(await recognizer.recognize(image, config.psm)), processed: image }
        : await solveCaptcha(image, config, recognizer.recognize, await classifierFor(sample.file));
    const ms = performance.now() - started;
    const correct = text === sample.label;
    const filled = text.length === config.length && confidence >= minConfidence;
    results.push({ ...sample, variant, text, confidence, ms, filled, correct });

    if (variant === "tuned") {
      const status = correct ? "ok" : "fail";
      const name = `${status}__${sample.label}__got-${text || "none"}__c${Math.round(confidence)}.png`;
      const dir = join(RESULTS_DIR, sample.gateway);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), encodePng(processed));
    }
  }
}
await recognizer.terminate();

type Row = { name: string; n: number; exact: string; digits: string; filled: string; wrongFill: string; ms: string };

function summarize(name: string, rows: Result[]): Row {
  const filled = rows.filter((r) => r.filled);
  const digits = rows.reduce((sum, r) => sum + digitAccuracy(r.label, r.text), 0);
  return {
    name,
    n: rows.length,
    exact: percent(rows.filter((r) => r.correct).length, rows.length),
    digits: percent(digits, rows.length),
    filled: percent(filled.length, rows.length),
    wrongFill: percent(filled.filter((r) => !r.correct).length, filled.length),
    ms: (rows.reduce((sum, r) => sum + r.ms, 0) / rows.length).toFixed(0),
  };
}

function printTable(variant: Variant) {
  const rows = results.filter((r) => r.variant === variant);
  const gateways = [...new Set(rows.map((r) => r.gateway))].sort();
  const table = [...gateways.map((g) => summarize(g, rows.filter((r) => r.gateway === g))), summarize("ALL", rows)];
  const header = ["gateway", "n", "exact", "digits", "filled", "wrong fill", "ms"];
  const lines = table.map((r) => [r.name, String(r.n), r.exact, r.digits, r.filled, r.wrongFill, r.ms]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const format = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");

  const title = variant === "raw" ? "Raw images (no preprocessing)" : args.cv ? `Tuned pipelines, held-out folds of ${args.cv}` : "Tuned pipelines";
  console.log(`\n${title} | fill when 5 digits and confidence >= ${minConfidence}`);
  console.log(format(header));
  for (const line of lines) console.log(format(line));
}

for (const variant of variants) printTable(variant);

await mkdir(RESULTS_DIR, { recursive: true });
await writeFile(join(RESULTS_DIR, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nPreprocessed images and results.json written to ${RESULTS_DIR}`);
