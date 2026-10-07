import extension from "../../extension/package.json";

export const REPO = "https://github.com/amirparsadd/better-psp";
export const RELEASES = `${REPO}/releases`;
export const VERSION = extension.version;

const latest = `${RELEASES}/latest/download`;
export const DOWNLOADS = {
  chrome: `${latest}/better-psp-chrome.zip`,
  firefox: `${latest}/better-psp-firefox.xpi`,
};
