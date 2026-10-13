import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { INPUT_SIZE, createLogits, toClassifierInput } from "../src/classify.ts";
import { configFor } from "../src/gateways.ts";
import { fromGray } from "../src/image.ts";
import { DIGIT_MODEL } from "../src/model/digits.ts";
import { solveCaptcha, type Recognize } from "../src/solve.ts";
import { DATASET_DIR, decodePng, loadSamples } from "../scripts/node.ts";

/** A white image with black rectangles at [x, y, width, height]. */
function drawRects(width: number, height: number, rects: [number, number, number, number][]) {
  const gray = new Uint8ClampedArray(width * height).fill(255);
  for (const [x0, y0, w, h] of rects) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) gray[y * width + x] = 0;
  }
  return fromGray(width, height, gray);
}

test("the bundled model computes what PyTorch computed for the same int8 weights", async () => {
  const fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "digits-parity.json"), "utf8")) as {
    inputs: string[];
    logits: number[][];
  };
  const logits = createLogits(DIGIT_MODEL);
  fixture.inputs.forEach((encoded, i) => {
    const input = new Float32Array(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)).buffer);
    const got = logits(input);
    fixture.logits[i].forEach((want, c) => assert.ok(Math.abs(got[c] - want) < 1e-3, `input ${i} class ${c}: ${got[c]} vs ${want}`));
  });
});

test("toClassifierInput centers the ink and scales its longest side to the box", () => {
  // Odd sizes make the area-averaging bounds land between pixels, which once read past the crop and produced NaN.
  const input = toClassifierInput(drawRects(50, 70, [[11, 9, 13, 37]]))!;
  assert.equal(input.length, INPUT_SIZE * INPUT_SIZE);
  assert.ok(input.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  let rows = 0;
  let mass = 0;
  let centerX = 0;
  for (let y = 0; y < INPUT_SIZE; y++) {
    let ink = 0;
    for (let x = 0; x < INPUT_SIZE; x++) {
      ink += input[y * INPUT_SIZE + x];
      centerX += x * input[y * INPUT_SIZE + x];
    }
    if (ink > 0) rows++;
    mass += ink;
  }
  assert.equal(rows, 28);
  assert.ok(Math.abs(centerX / mass - (INPUT_SIZE - 1) / 2) < 1);
});

test("toClassifierInput returns null for an image without ink", () => {
  assert.equal(toClassifierInput(drawRects(10, 10, [])), null);
});

test("classifier gateways never call Tesseract when the captcha segments", async () => {
  const neverCalled: Recognize = async () => assert.fail("Tesseract was called");
  for (const { gateway, file } of await loadSamples()) {
    const config = configFor(gateway);
    if (config.read !== "classifier") continue;
    const image = decodePng(await readFile(join(DATASET_DIR, file)));
    const { text } = await solveCaptcha(image, config, neverCalled);
    assert.match(text, /^\d{5}$/, file);
  }
});
