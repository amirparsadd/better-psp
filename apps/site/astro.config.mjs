// @ts-check
import { createReadStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

const require = createRequire(import.meta.url);
const requireFromTesseract = createRequire(require.resolve("tesseract.js"));
const engData = require("@tesseract.js-data/eng");

/** The same worker, core and model the extension bundles, so the demo reads captchas exactly like it does. */
const TESSERACT_FILES = {
  "worker.min.js": require.resolve("tesseract.js/dist/worker.min.js"),
  "tesseract-core-simd-lstm.wasm.js": requireFromTesseract.resolve("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"),
  "eng.traineddata.gz": join(engData.langPath, "eng.traineddata.gz"),
};

/** @returns {import("astro").AstroIntegration} */
function tesseractAssets() {
  return {
    name: "tesseract-assets",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use("/tesseract/", (req, res, next) => {
          const file = TESSERACT_FILES[/** @type {keyof typeof TESSERACT_FILES} */ (req.url?.slice(1).split("?")[0])];
          if (!file) return next();
          res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
          createReadStream(file).pipe(res);
        });
      },
      "astro:build:done": async ({ dir }) => {
        const target = join(fileURLToPath(dir), "tesseract");
        await mkdir(target, { recursive: true });
        await Promise.all(Object.entries(TESSERACT_FILES).map(([name, src]) => copyFile(src, join(target, name))));
      },
    },
  };
}

export default defineConfig({
  site: "https://betterpsp.amir-parsa.ir",
  integrations: [tesseractAssets()],
  vite: {
    plugins: [tailwindcss()],
  },
});
