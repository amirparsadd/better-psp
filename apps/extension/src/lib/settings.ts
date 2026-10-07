import { storage } from "#imports";

export type Settings = {
  /** Convert Persian/Arabic digits to Latin while typing and pasting. */
  digits: boolean;
  /** Focus the first empty field on load and move on when a field is complete. */
  focus: boolean;
  /** Offer to keep CVV2 on this device and fill it next time. */
  cvv: boolean;
  /** Fill the optional email and mobile fields with the details saved in the popup. */
  contact: boolean;
  /** Hide the gateway's headers, footers, guides and field hints, keeping the merchant, amount and timer. */
  clean: boolean;
  /** Read the numeric captcha with the bundled OCR and fill it in. */
  captcha: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  digits: true,
  focus: true,
  cvv: true,
  contact: true,
  clean: true,
  captcha: true,
};

export const settingsItem = storage.defineItem<Settings>("local:settings", { fallback: DEFAULT_SETTINGS });

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) };
}
