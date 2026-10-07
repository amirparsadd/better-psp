import { defaultIsVisible, type DetectOptions, type PaymentFields } from "./fields.ts";
import { advanceFrom } from "./focus.ts";
import { isEditable, setInputValue } from "./input.ts";
import { sendOcr } from "./messages.ts";
import type { Page } from "./page.ts";

/** Hostnames of the gateways `@better-psp/ocr` has a tuned pipeline for. Others get the default pipeline. */
const GATEWAY_HOSTS: Record<string, string> = {
  "asan.shaparak.ir": "asanpardakht",
  "ikc.shaparak.ir": "irankish",
  "bpm.shaparak.ir": "mellat",
  "pna.shaparak.ir": "novin",
  "pec.shaparak.ir": "parsian",
  "pep.shaparak.ir": "pasargad",
  "sadad.shaparak.ir": "sadad",
  "sep.shaparak.ir": "saman",
  "sepehr.shaparak.ir": "sepehr",
};

export function gatewayFor(hostname: string): string {
  return GATEWAY_HOSTS[hostname] ?? "default";
}

const CAPTCHA = /captcha/i;
const NOT_CAPTCHA = /refresh|reload|audio|sound|logo/i;

function describeImage(img: HTMLImageElement): string {
  const src = img.getAttribute("src") ?? "";
  return [img.id, img.getAttribute("class"), img.alt, src.startsWith("data:") ? "" : src].join(" ");
}

/**
 * The captcha picture: an image named after it (every gateway but IranKish), otherwise the first image in the
 * captcha input's surroundings (IranKish puts it inside the input's field box).
 */
export function findCaptchaImage(fields: PaymentFields, options: DetectOptions = {}): HTMLImageElement | null {
  const isVisible = options.isVisible ?? defaultIsVisible;
  const usable = (img: HTMLImageElement) =>
    isVisible(img) && !NOT_CAPTCHA.test(describeImage(img)) && !/\.svg(?:$|\?)/i.test(img.getAttribute("src") ?? "");

  const root = fields.captcha?.ownerDocument ?? document;
  const named = [...root.querySelectorAll("img")].find((img) => usable(img) && CAPTCHA.test(describeImage(img)));
  if (named) return named;

  let node = fields.captcha?.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const img = [...node.querySelectorAll("img")].find(usable);
    if (img) return img;
  }
  return null;
}

/** The picture as a PNG data URL, at its own resolution. Null until it has loaded, or if the canvas is tainted. */
export function readImage(img: HTMLImageElement): string | null {
  if (!img.complete || img.naturalWidth === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  try {
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Reads the captcha and fills it in, again every time the picture changes. Whatever is in the field when a new
 * picture arrives answers the old one, so it is replaced even if the user typed it. A value already present on the
 * first picture is left alone, and so is anything typed while a solve is running.
 */
export function installCaptcha(page: Page, solve = sendOcr) {
  const { ctx } = page;
  const gateway = gatewayFor(location.hostname);
  let lastImage = "";

  async function run() {
    const input = page.fields.captcha;
    const img = input && findCaptchaImage(page.fields);
    if (!page.settings.captcha || !input || !img) return;
    const image = readImage(img);
    if (!image || image === lastImage) return;
    const refreshed = lastImage !== "";
    lastImage = image;

    if (!isEditable(input) || (input.value !== "" && !refreshed)) return;
    if (input.value !== "") setInputValue(input, "");

    const solution = await solve({ type: "ocr:solve", gateway, image }).catch(() => null);
    if (!solution || image !== lastImage || page.fields.captcha !== input || input.value !== "") return;
    setInputValue(input, solution.text);
    advanceFrom(page, input);
  }

  page.onFieldsChange(() => void run());
  page.onSettingsChange(() => void run());
  // A new captcha (refresh button, or a new one after a failed attempt) arrives as a load event on the image.
  ctx.addEventListener(
    document,
    "load",
    (event) => {
      if (event.target instanceof HTMLImageElement) void run();
    },
    { capture: true },
  );
}
