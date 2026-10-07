import { describe, expect, it } from "vitest";
import { hasNonLatinDigits, onlyDigits, toLatinDigits } from "../src/lib/digits.ts";

describe("toLatinDigits", () => {
  it("converts Persian and Arabic-Indic digits", () => {
    expect(toLatinDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("leaves other characters alone", () => {
    expect(toLatinDigits("کارت ۶۰۳۷-99")).toBe("کارت 6037-99");
  });
});

it("onlyDigits strips separators after converting", () => {
  expect(onlyDigits("۶۰۳۷ ۹۹۱۲-3456_7890")).toBe("6037991234567890");
});

it("hasNonLatinDigits", () => {
  expect(hasNonLatinDigits("123")).toBe(false);
  expect(hasNonLatinDigits("12۳")).toBe(true);
  expect(hasNonLatinDigits("١")).toBe(true);
});
