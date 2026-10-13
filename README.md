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
- **Captcha**: reads the captcha image with the `packages/ocr` pipeline, and fills it only when the answer has the
  expected length and the reader's confidence is at least 60. On the nine known gateways a small digit classifier
  bundled with the code (about 120 KB) reads each digit; Tesseract (worker, WASM core and `eng` model ship inside the
  extension, about 15 MB) is only started for other hosts and for captchas that cannot be cut into digits. Every new
  picture (refresh button, or a new captcha after a failed attempt) is read again and replaces whatever answered the
  old one. Everything runs locally: in an offscreen document on Chrome (service workers can't start Web Workers) and
  in the background page on Firefox. Expect the occasional empty field, mostly on Sadad.
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

A small local web app for building the dataset by hand.

```bash
pnpm collect           # http://localhost:4321
```

Live mode (the fast way):

1. Drag **Better PSP: send captchas** from the collector to the bookmarks bar.
2. Open the card-entry page of any gateway (a shop's checkout, stopped before paying) and click the bookmark. The
   captcha on screen appears in the collector, with the gateway detected from the hostname.
3. Type the label and press Enter. The gateway tab refreshes its captcha (only with the page's own refresh control,
   never anything that pays, submits or cancels) and sends the next one.

Several gateway tabs can be connected at once; their captchas arrive in one stream. Chromium browsers ask once per
gateway to allow access to the local network. Gateways whose security policy blocks other addresses (Asan Pardakht)
send through a small relay window instead, so allow popups there. After a disconnect, click the bookmark again to
reconnect.

Without the bookmark: right-click the captcha, **Copy Image**, press Cmd+V in the collector, paste the page URL in
step 2, then type the label. Always label from the preview in the collector. "Save Image As" may re-download the
captcha and give you a different image than the one on screen. Step 1 creates a Zarinpal payment session (never
paid; set `ZARINPAL_MERCHANT_ID` in `.env`), and step 3 saves the page source, which the field-detection tests use.

The collector reads every captcha with the bundled classifier but keeps its answer hidden until you have
typed yours, so labels never copy the model. If the two differ, it shows the model's reading and the first Enter
only asks you to look again; the second saves what you typed. The reading is stored in the manifest as `guess`,
which measures the shipped model on captchas it has never seen.

Zarinpal picks the bank itself, so to collect one gateway in particular, use a shop that pays through it. Unknown
`*.shaparak.ir` hosts get their own folder, named after the subdomain.

Output:

```
datasets/
  manifest.jsonl                       one line per labeled captcha
  <gateway>/captchas/<label>_<time>.png
  <gateway>/pages/<time>.html          raw page snapshots (gitignored)
  <gateway>/pages/<time>.meta.json
```

## OCR

Per-gateway image processing, then a small convolutional digit classifier for the nine known gateways, with
Tesseract (tesseract.js, bundled English model) for anything else. All image operations are pure functions on RGBA
buffers, so the same code runs in Node and in the extension on canvas `ImageData`.

- `packages/ocr/src/image.ts`: preprocessing steps (background removal, thresholding, speck/line/thin-stroke
  removal, de-slanting).
- `packages/ocr/src/segment.ts`: cuts a captcha into exactly 5 digits. When glyphs touch, the last split goes
  wherever the classifier finds two convincing digits, which also separates Sadad's raised digits from their
  neighbours. If 5 digits are not possible, the solver falls back to Tesseract.
- `packages/ocr/src/classify.ts`: the classifier (three conv blocks, about 90k int8 weights, a few ms per digit, no
  dependencies). Its 11th class means "not one digit", so a bad split gets low confidence instead of a confident
  wrong digit. The weights are generated into `src/model/digits.ts`.
- `packages/ocr/src/gateways.ts`: the pipeline for each gateway.
- `packages/ocr/src/solve.ts`: preprocess, segment, read.

```bash
pnpm bench                     # accuracy per gateway; add --raw to compare against unprocessed images
pnpm bench -g novin,sadad      # only some gateways
pnpm bench --cv <run>          # honest accuracy: each captcha read by a model that never trained on it
pnpm inspect novin <file>      # write every intermediate image to bench-results/_inspect
pnpm tune -g saman             # grid search over generic pipelines
```

The bundled model has trained on every captcha in `datasets/`, so plain `pnpm bench` overstates it. With 5-fold
cross-validation (`train.py --cv 5`, then `pnpm bench --cv`) on the 1469 labeled captchas, against the
Tesseract pipelines this replaced (filled = 5 digits at confidence 60 or more; wrong fill = share of filled answers
that are wrong):

| Gateway       |    n | Tesseract exact | Tesseract wrong fill | Classifier exact | Filled | Wrong fill |
| ------------- | ---: | --------------: | -------------------: | ---------------: | -----: | ---------: |
| Asan Pardakht |   50 |          100.0% |                 0.0% |           100.0% | 100.0% |       0.0% |
| IranKish      |   73 |           67.1% |                 8.9% |            98.6% |  95.9% |       0.0% |
| Mellat        |  223 |           88.3% |                 3.1% |           100.0% | 100.0% |       0.0% |
| Novin         |  269 |           77.7% |                18.4% |            99.6% |  97.0% |       0.4% |
| Parsian       |  229 |            3.5% |                 0.0% |            99.6% | 100.0% |       0.4% |
| Pasargad      |   61 |           72.1% |                17.0% |            98.4% |  96.7% |       0.0% |
| Sadad         |  207 |           77.8% |                 8.1% |            91.3% |  87.4% |       2.8% |
| Saman         |  252 |           50.0% |                23.6% |            99.6% |  97.6% |       0.0% |
| Sepehr        |  105 |           45.7% |                30.3% |            96.2% |  96.2% |       2.0% |
| **All**       | 1469 |       **60.7%** |            **13.7%** |        **98.2%** | **96.7%** |   **0.6%** |

Parsian moved to a new captcha style that the Tesseract pipeline never saw. Sadad stays the hardest: its small
raised digits overlap their neighbours.

### Retraining the classifier

Training data is mostly synthetic: the look-alikes in `src/lookalikes.ts` (also the site's demo) drawn in Node,
plus the digits of the [Chars74K](https://info-ee.surrey.ac.uk/CVSSP/demos/chars74k/) font set (T. E. de Campos,
B. R. Babu and M. Varma, "Character recognition in natural images", VISAPP 2009). The real captchas are the test
set, and a share of each batch during training. Needs [uv](https://docs.astral.sh/uv/); PyTorch is the CPU build.

```bash
# Crops: every digit the solver would cut out, as 32x32 classifier inputs (a few minutes; run per gateway in
# parallel with -g). Download and unpack EnglishFnt.tgz from the Chars74K page first.
pnpm crops --out crops/real --real
pnpm crops --out crops/synth --synthetic 4000 --fonts /path/to/fonts   # Arial, Times, Verdana, Tahoma, ...
pnpm crops --out crops/chars74k --chars74k /path/to/chars74k           # the folder containing English/Fnt

cd packages/ocr/training
uv run train.py --data ../crops --out runs/cv --cv 5      # held-out accuracy, about 15 minutes on 32 cores
uv run train.py --data ../crops --out runs/cv --final     # train on everything (after --cv: reuses its temperature)
uv run export.py runs/cv/final.pt                         # writes src/model/digits.ts and the parity fixture
cd ../../.. && pnpm bench --cv packages/ocr/training/runs/cv && pnpm test
```

`pnpm crops` paths are relative to `packages/ocr`. When the segmentation changes, export the crops again with
`--guide runs/cv/final.json` so training sees the splits the solver now makes. The held-out accuracy `train.py --cv`
prints runs slightly high: where digits touch, the real crops were cut by the guide model, which has usually seen
those captchas. `pnpm bench --cv` lets each fold model make its own cuts, so quote that one.

## License

[MIT](LICENSE)
