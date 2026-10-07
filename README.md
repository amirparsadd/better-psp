# Better PSP

Better UX for Iranian payment gateways (PSPs). A Chrome/Firefox extension that removes the small annoyances of
paying on Shaparak pages, and fills the numeric captcha to show that an OCR-readable number adds friction, not
security.

## Repository

pnpm workspaces + Turborepo. Requires Node 22.18+ and pnpm.

```
apps/extension     the browser extension (WXT, TypeScript, Chrome + Firefox MV3)
apps/site          landing page (Astro, Tailwind, daisyUI), deployed to GitHub Pages
apps/collector     local GUI for collecting labeled captcha samples
packages/ocr       captcha preprocessing and solving (browser-safe), plus Node benchmark scripts
datasets/          labeled captchas (page snapshots are gitignored)
```

```bash
pnpm install
pnpm build        # extension for Chrome and Firefox, in apps/extension/.output
pnpm test
pnpm typecheck
pnpm dev          # Chrome with hot reload; pnpm dev:firefox for Firefox
pnpm site         # landing page at http://localhost:4321/better-psp
```

## Releases and the site

- `.github/workflows/pages.yml` deploys `apps/site` to https://amirparsadd.github.io/better-psp on every push to
  `main` that touches the site. In the repo settings, set Pages > Source to **GitHub Actions**.
- `.github/workflows/release.yml` runs on tags. Bump `version` in `apps/extension/package.json`, then
  `git tag v<version> && git push --tags`. It attaches `better-psp-chrome.zip`, `better-psp-firefox.zip` and
  `better-psp-sources.zip` to a GitHub release; the site links to `releases/latest/download/...`.
- Release Firefox only installs Mozilla-signed add-ons. Add `AMO_API_KEY` and `AMO_API_SECRET` repo secrets
  (from https://addons.mozilla.org/developers/addon/api/key/) and the workflow also signs an unlisted
  `better-psp-firefox.xpi`, which the site's Firefox button installs.

## Extension

Runs only on `https://*.shaparak.ir/*`. Every feature can be turned off from the popup.

- **Persian digits**: digits typed with a Persian keyboard or pasted (۰-۹ and ٠-٩) become Latin digits before the
  gateway sees them. Several gateways silently drop them otherwise. Pasting a full card number into a gateway with
  four card boxes fills all four.
- **Autofocus**: focuses the first empty field on load, and moves on when the card number, a 4-digit CVV2, expiry
  month/year or captcha is complete. After the captcha it focuses the "request dynamic password" button. It never
  submits. Several gateways jump away from CVV2 after the third digit, which cuts off 4-digit CVV2s; that jump is
  undone unless you clicked another field or pressed Tab/Enter.
- **Captcha**: reads the captcha image with the `packages/ocr` pipeline and a bundled Tesseract (worker, WASM core
  and `eng` model ship inside the extension, about 15 MB), and fills it only when the answer has the expected length
  and Tesseract's confidence is at least 60. Every new picture (refresh button, or a new captcha after a failed
  attempt) is read again and replaces whatever answered the old one. Known gateways get their tuned pipeline, any other host the default one.
  Everything runs locally: in an offscreen document on Chrome (service workers can't start Web Workers) and in the
  background page on Firefox. Expect the occasional wrong answer, mostly on Pasargad and Sepehr.
- **CVV2 on this device**: a checkbox under the CVV2 field. When ticked, the CVV2 is saved when you press pay and
  filled in automatically the next time the same card is entered. Unticking it forgets the card.
- **Email and mobile**: saved in the popup and filled into the gateway's optional receipt fields when they are
  empty. Kept in plain extension storage, since gateways ask for them in the clear anyway.
- **Clean page**: hides headers, footers, guide and security-tip sections and the hint line under each field.
  The merchant, amount, timer, every control and anything that looks like an error or dialog stay visible.

Field detection is heuristic (ids, names, labels, placeholders), with a positional fallback for IranKish, whose
fields have random ids. It is tested against snapshots of all nine gateways we have data for.

### How the CVV2 is stored

- Nothing is stored unless you tick the box, and nothing ever leaves the device.
- The background script creates an AES-GCM key and an HMAC key with WebCrypto as non-extractable keys and keeps
  them in the extension's IndexedDB. No extension code can read the raw key bytes.
- Each card is identified by an HMAC of its first six and last four digits, so masked saved cards
  (`6037-99**-****-1234`) still match and the full card number is never stored.
- The CVV2 is encrypted with AES-GCM, using the record id as associated data, and kept in extension storage.
- Only content scripts on HTTPS `*.shaparak.ir` pages can ask for a CVV2. The popup can list and delete saved
  cards but cannot read a CVV2.

This protects against casual inspection of the browser profile and other websites. It does not protect against
malware running as your user, which could drive the browser itself.

## Captcha collector

A small local web app for building the dataset by hand. It creates Zarinpal payment sessions (never paid), and
lets you paste the gateway page URL, its HTML, and captcha images with labels.

```bash
cp .env.example .env   # set ZARINPAL_MERCHANT_ID
pnpm collect           # http://localhost:4321
```

Workflow:

1. Click **New payment link** and open it.
2. On the card-entry page, copy the URL from the address bar and paste it in step 2. The gateway is detected
   from the hostname.
3. Once per session, paste the page source (view-source, select all, copy) in step 3 and save it.
4. Right-click the captcha, **Copy Image**, press Cmd+V in the collector, type the label and press Enter.
   Refresh the captcha on the gateway and repeat.

Always label from the preview in the collector. "Save Image As" may re-download the captcha and give you a
different image than the one on screen.

Output:

```
datasets/
  manifest.jsonl                       one line per labeled captcha
  <gateway>/captchas/<label>_<time>.png
  <gateway>/pages/<time>.html          raw page snapshots (gitignored)
  <gateway>/pages/<time>.meta.json
```

## OCR

Tesseract (tesseract.js, bundled English model) plus per-gateway image processing. All image operations are pure
functions on RGBA buffers, so the same code will run in the extension on canvas `ImageData`.

- `packages/ocr/src/image.ts`: preprocessing steps (background removal, thresholding, speck/line/thin-stroke
  removal, de-slanting).
- `packages/ocr/src/segment.ts`: cuts a captcha into exactly 5 digits and redraws them on one clean baseline. If
  that is not possible, the solver returns nothing rather than guessing.
- `packages/ocr/src/gateways.ts`: the pipeline for each gateway.
- `packages/ocr/src/solve.ts`: preprocess, segment, read.

```bash
pnpm bench                     # accuracy per gateway; add --raw to compare against unprocessed images
pnpm bench -g novin,sadad      # only some gateways
pnpm inspect novin <file>      # write every intermediate image to bench-results/_inspect
pnpm tune -g saman             # grid search over generic pipelines
```
