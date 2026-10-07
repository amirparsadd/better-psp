const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

const NON_LATIN_DIGIT = /[\u06f0-\u06f9\u0660-\u0669]/;

export function hasNonLatinDigits(text: string): boolean {
  return NON_LATIN_DIGIT.test(text);
}

/** Converts Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII, leaving everything else untouched. */
export function toLatinDigits(text: string): string {
  return text.replace(/[\u06f0-\u06f9\u0660-\u0669]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= PERSIAN_ZERO ? code - PERSIAN_ZERO : code - ARABIC_ZERO);
  });
}

export function onlyDigits(text: string): string {
  return toLatinDigits(text).replace(/\D/g, "");
}
