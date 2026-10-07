import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectFields, type PaymentFields } from "../src/lib/fields.ts";

// Raw gateway snapshots are gitignored (they can hold session tokens), so this suite only runs locally.
const DATASETS = resolve(import.meta.dirname, "../../../datasets");

function loadSnapshot(gateway: string): Document | null {
  const dir = join(DATASETS, gateway, "pages");
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith(".html"));
  if (!file) return null;
  return new DOMParser().parseFromString(readFileSync(join(dir, file), "utf8"), "text/html");
}

function describeEl(el: Element | undefined): string | undefined {
  if (!el) return undefined;
  if (el.id && !el.id.startsWith("f_")) return `#${el.id}`;
  const name = el.getAttribute("name");
  if (name) return `[name=${name}]`;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return `[placeholder=${placeholder}]`;
  return `${el.tagName.toLowerCase()}:${(el.textContent || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " ")}`;
}

function summarize(fields: PaymentFields) {
  return {
    card: fields.card.map(describeEl),
    cvv2: describeEl(fields.cvv2),
    month: describeEl(fields.month),
    year: describeEl(fields.year),
    captcha: describeEl(fields.captcha),
    pin2: describeEl(fields.pin2),
    otpButton: describeEl(fields.otpButton),
    payButton: describeEl(fields.payButton),
    email: describeEl(fields.email),
    mobile: describeEl(fields.mobile),
  };
}

const EXPECTED: Record<string, Partial<ReturnType<typeof summarize>>> = {
  asanpardakht: {
    card: ["#pan1-4", "#pan2-4", "#pan3-4", "#pan4-4"],
    cvv2: "#cvv2",
    month: "#expiry-month",
    year: "#expiry-year",
    captcha: "#captcha",
    pin2: "#second-pass",
    otpButton: "#send-dynamic-second-pass-btn",
    payButton: "#confirm-btn",
    email: "#mail-address",
    mobile: "#phone-number",
  },
  mellat: {
    card: ["#cardnumber"],
    cvv2: "#inputcvv2",
    month: "#inputmonth",
    year: "#inputyear",
    captcha: "#inputcaptcha",
    pin2: "#inputpin",
    otpButton: "#otp-button",
    payButton: "#payButton",
    email: "#inputemail",
    mobile: "#inputmobile",
  },
  novin: {
    card: ["#CardNumber"],
    cvv2: "#Cvv2",
    month: "#ExpireMonth",
    year: "#ExpireYear",
    captcha: "#Captcha",
    pin2: "#Pin2",
    otpButton: "#harim-otp",
    payButton: "#payment-button",
    email: "#Email",
    mobile: "#MobileNo",
  },
  parsian: {
    card: ["#pan"],
    cvv2: "#cvv2",
    month: "#txtExpM",
    year: "#txtExpY",
    captcha: "#Captcha",
    pin2: "#pin2",
    otpButton: "button:درخواست رمز پویا",
    payButton: "#btnPayment",
    email: "#Email",
    mobile: "#MobileNo",
  },
  pasargad: {
    card: ["#field-0"],
    cvv2: "#field-1",
    month: "#field-2",
    year: "#field-3",
    captcha: "#field-4",
    pin2: "#field-5",
    otpButton: "button:درخواست رمز پویا00:00",
    payButton: "button:پرداخت 1,000,000 ریال",
    email: "#field-7",
    mobile: "#field-6",
  },
  sadad: {
    card: ["#CardNoPart1", "#CardNoPart2", "#CardNoPart3", "#CardNoPart4"],
    cvv2: "#Cvv2",
    month: "#Month",
    year: "#Year",
    captcha: "#Captcha",
    pin2: "#Pin",
    otpButton: "#getOTP",
    payButton: "#doPayment",
    email: "#EmailAddress",
    mobile: "#MobileNo",
  },
  saman: {
    card: ["#CardNumber_PanString"],
    cvv2: "#Cvv2",
    month: "#Month",
    year: "#Year",
    captcha: "#CaptchaInputText",
    pin2: "#Pin2",
    otpButton: "#Otp",
    payButton: "#Purchase",
    email: "#Email",
    mobile: "#CellNumber",
  },
  sepehr: {
    card: ["#card1", "#card2", "#card3", "#card4"],
    cvv2: "#cvv2Input",
    month: "#monthInput",
    year: "#yearInput",
    captcha: "#captchaInput",
    pin2: "#pin2-keypad",
    otpButton: "#password-countdown",
    payButton: "button:پرداخت",
    email: "[name=email]",
    mobile: undefined,
  },
  irankish: {
    month: "[placeholder=ماه]",
    year: "[placeholder=سال]",
    otpButton: "a:دریافت رمز پویا",
    payButton: "a:پرداخت",
  },
};

describe.each(Object.keys(EXPECTED))("detectFields on %s", (gateway) => {
  const doc = loadSnapshot(gateway);

  it.skipIf(!doc)("finds every payment field", () => {
    const fields = detectFields(doc!, { isVisible: () => true });
    const summary = summarize(fields);
    expect(summary).toMatchObject(EXPECTED[gateway]!);
    for (const kind of ["cvv2", "month", "year", "captcha", "pin2"] as const) expect(fields[kind]).toBeDefined();
    expect(fields.card.length === 1 || fields.card.length === 4).toBe(true);
    expect(fields.payButton).toBeDefined();
  });
});

it.skipIf(!loadSnapshot("irankish"))("places IranKish's unlabeled inputs by position", () => {
  const fields = detectFields(loadSnapshot("irankish")!, { isVisible: () => true });
  const inputs = [...loadSnapshot("irankish")!.querySelectorAll("input[type=tel]")].map((el) => el.id);
  expect(
    [fields.card[0], fields.cvv2, fields.month, fields.year, fields.captcha, fields.pin2, fields.mobile].map((el) => el?.id),
  ).toEqual(inputs.slice(0, 7));
  expect(fields.email?.type).toBe("email");
});
