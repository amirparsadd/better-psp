import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findCaptchaImage, gatewayFor, installCaptcha } from "../src/lib/captcha.ts";
import { detectFields } from "../src/lib/fields.ts";
import type { CaptchaSolution, OcrRequest } from "../src/lib/messages.ts";
import { fakePage } from "./helpers.ts";

const visible = { isVisible: () => true };
const DATASETS = resolve(import.meta.dirname, "../../../datasets");
const gateways = existsSync(DATASETS) ? readdirSync(DATASETS).filter((g) => existsSync(join(DATASETS, g, "pages"))) : [];

describe.each(gateways)("captcha image on %s", (gateway) => {
  it("is found next to the captcha field", () => {
    const dir = join(DATASETS, gateway, "pages");
    const file = readdirSync(dir).find((f) => f.endsWith(".html"));
    if (!file) return;
    const doc = new DOMParser().parseFromString(readFileSync(join(dir, file), "utf8"), "text/html");
    const meta = JSON.parse(readFileSync(join(dir, file.replace(/\.html$/, ".meta.json")), "utf8")) as { host: string };
    const img = findCaptchaImage(detectFields(doc, visible), visible);
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toMatch(/^data:image|captcha/i);
    expect(gatewayFor(meta.host)).toBe(gateway);
  });
});

const FORM = `
  <input id="CardNumber"><input id="Cvv2"><input id="Month" placeholder="ماه"><input id="Year" placeholder="سال">
  <input id="Captcha"><img id="CaptchaImage" src="data:image/png;base64,AAAA"><input id="Pin2">`;

/** happy-dom does not decode images, so the pixels are stubbed per test. */
function setup(
  images: string[],
  solutions: CaptchaSolution[],
  options: { value?: string; solve?: (request: OcrRequest) => Promise<CaptchaSolution> } = {},
) {
  const read = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
  for (const image of images) read.mockReturnValueOnce(image);
  read.mockReturnValue(images.at(-1)!);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as never);
  const img = () => document.querySelector<HTMLImageElement>("#CaptchaImage")!;
  const captcha = () => document.querySelector<HTMLInputElement>("#Captcha")!;
  const page = fakePage(FORM);
  Object.defineProperty(img(), "complete", { value: true });
  Object.defineProperty(img(), "naturalWidth", { value: 100 });
  Object.defineProperty(img(), "naturalHeight", { value: 30 });
  if (options.value) captcha().value = options.value;
  const requests: OcrRequest[] = [];
  const solve = vi.fn(async (request: OcrRequest) => {
    requests.push(request);
    return options.solve ? options.solve(request) : (solutions.shift() ?? null);
  });
  installCaptcha(page, solve);
  return { page, requests, img, captcha };
}

describe("captcha autofill", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fills the solution", async () => {
    const { captcha, requests } = setup(["data:one"], [{ text: "12345", confidence: 90 }]);
    await vi.waitFor(() => expect(captcha().value).toBe("12345"));
    expect(requests[0]).toMatchObject({ type: "ocr:solve", image: "data:one" });
  });

  it("fills every new captcha, replacing whatever answered the previous one", async () => {
    const { captcha, img } = setup(
      ["data:one", "data:two", "data:three"],
      [{ text: "12345", confidence: 90 }, { text: "67890", confidence: 90 }, { text: "11111", confidence: 90 }],
    );
    await vi.waitFor(() => expect(captcha().value).toBe("12345"));
    img().dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(captcha().value).toBe("67890"));

    captcha().value = "55555";
    img().dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(captcha().value).toBe("11111"));
  });

  it("ignores a load event that brings the same picture", async () => {
    const { captcha, img, requests } = setup(["data:one"], [{ text: "12345", confidence: 90 }]);
    await vi.waitFor(() => expect(captcha().value).toBe("12345"));
    captcha().value = "55555";
    img().dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captcha().value).toBe("55555");
    expect(requests).toHaveLength(1);
  });

  it("leaves a value typed before the first captcha was read", async () => {
    const { captcha, requests } = setup(["data:one"], [{ text: "12345", confidence: 90 }], { value: "55555" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(0);
    expect(captcha().value).toBe("55555");
  });

  it("does not overwrite what the user types while a solve is running", async () => {
    let finish: ((solution: CaptchaSolution) => void) | undefined;
    const { captcha } = setup(["data:one"], [], { solve: () => new Promise((resolve) => (finish = resolve)) });
    await vi.waitFor(() => expect(finish).toBeDefined());
    captcha().value = "55555";
    finish!({ text: "12345", confidence: 90 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captcha().value).toBe("55555");
  });

  it("leaves the field empty when unsure and clears a stale answer", async () => {
    const { captcha, img } = setup(["data:one", "data:two"], [{ text: "12345", confidence: 90 }, null]);
    await vi.waitFor(() => expect(captcha().value).toBe("12345"));
    img().dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(captcha().value).toBe(""));
  });

  it("does nothing when turned off", async () => {
    const page = fakePage(FORM);
    page.settings.captcha = false;
    const solve = vi.fn(async () => ({ text: "12345", confidence: 90 }));
    installCaptcha(page, solve);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(solve).not.toHaveBeenCalled();
  });
});
