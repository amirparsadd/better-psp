// Runs one captcha through its gateway's pipeline and writes every intermediate image, with per-step timing.
// Usage: npm run inspect -- <gateway> <file in datasets/<gateway>/captchas>

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configFor } from "../src/gateways.ts";
import { DATASET_DIR, ROOT, createRecognizer, decodePng, encodePng } from "./node.ts";
import { readProcessed } from "../src/solve.ts";

const [gateway, file] = process.argv.slice(2);
if (!gateway || !file) throw new Error("Usage: npm run inspect -- <gateway> <captcha file name>");

const config = configFor(gateway);
const outDir = join(ROOT, "bench-results", "_inspect");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let image = decodePng(await readFile(join(DATASET_DIR, gateway, "captchas", file)));
await writeFile(join(outDir, "0-original.png"), encodePng(image));
for (const [i, step] of config.steps.entries()) {
  const started = performance.now();
  image = step(image);
  const ms = performance.now() - started;
  await writeFile(join(outDir, `${i + 1}.png`), encodePng(image));
  console.log(`step ${i + 1}: ${image.width}x${image.height} ${ms.toFixed(1)}ms`);
}

const recognizer = await createRecognizer();
const solution = await readProcessed(image, config, recognizer.recognize);
await recognizer.terminate();
await writeFile(join(outDir, "final.png"), encodePng(solution.processed));
console.log(`read "${solution.text}" (confidence ${solution.confidence.toFixed(0)}), images in ${outDir}`);
