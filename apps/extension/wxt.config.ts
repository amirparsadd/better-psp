import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "wxt";

const require = createRequire(import.meta.url);
const requireFromTesseract = createRequire(require.resolve("tesseract.js"));
const engData = require("@tesseract.js-data/eng") as { langPath: string };

/**
 * Tesseract ships as a worker script, a WebAssembly core and a model. They are bundled so nothing is fetched at
 * runtime. Only the SIMD + LSTM core is needed: every supported browser has SIMD and the solver uses LSTM only.
 * The model is the one the pipelines were tuned on (`pnpm bench`).
 */
const TESSERACT_FILES = [
  { absoluteSrc: require.resolve("tesseract.js/dist/worker.min.js"), relativeDest: "tesseract/worker.min.js" },
  {
    absoluteSrc: requireFromTesseract.resolve("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"),
    relativeDest: "tesseract/tesseract-core-simd-lstm.wasm.js",
  },
  { absoluteSrc: join(engData.langPath, "eng.traineddata.gz"), relativeDest: "tesseract/eng.traineddata.gz" },
];

export default defineConfig({
  srcDir: "src",
  imports: false,
  // Fixed names so the site can link to releases/latest/download/<file>.
  zip: {
    artifactTemplate: "better-psp-{{browser}}.zip",
    sourcesTemplate: "better-psp-sources.zip",
    // AMO reviewers rebuild from this zip, and the extension imports @better-psp/ocr from the workspace.
    sourcesRoot: "../..",
    includeSources: [
      "apps/extension/**",
      "packages/ocr/**",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "tsconfig.base.json",
      "README.md",
      "LICENSE",
    ],
  },
  hooks: {
    "build:publicAssets": (_wxt, files) => {
      files.push(...TESSERACT_FILES);
    },
  },
  manifest: ({ browser }) => ({
    name: "Better PSP",
    description:
      "تجربه‌ی بهتر پرداخت در درگاه‌های شاپرک: پر کردن خودکار کد امنیتی، تبدیل خودکار اعداد، پرش بین فیلدها و ذخیره‌ی امن CVV2.",
    // Chrome's background is a service worker, which cannot run Tesseract's worker; an offscreen page does.
    permissions: browser === "firefox" ? ["storage"] : ["storage", "offscreen"],
    host_permissions: ["https://*.shaparak.ir/*"],
    // MV3's default CSP forbids compiling WebAssembly, which Tesseract's core needs.
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "better-psp@better-psp.github.io",
          strict_min_version: "140.0",
          // Nothing leaves the device: the CVV2 store is local, OCR runs locally and there is no telemetry.
          data_collection_permissions: { required: ["none"] },
        },
      },
    }),
  }),
});
