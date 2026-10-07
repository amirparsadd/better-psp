import { browser, type Browser } from "#imports";

type Sender = Browser.runtime.MessageSender;

/** A content script running in a tab on an HTTPS Shaparak gateway. */
export function isGatewayPage(sender: Sender): boolean {
  if (!sender.tab || !sender.url || sender.id !== browser.runtime.id) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "https:" && url.hostname.endsWith(".shaparak.ir");
  } catch {
    return false;
  }
}

/** One of this extension's own pages, such as the popup. */
export function isExtensionPage(sender: Sender): boolean {
  return !sender.tab && sender.id === browser.runtime.id && Boolean(sender.url?.startsWith(browser.runtime.getURL("/")));
}
