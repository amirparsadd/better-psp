// Runs on a gateway's card page, from the bookmarklet on the collector page. Sends the captcha on screen to the
// collector, then a fresh one each time the collector asks for it, until the page closes. It never touches the form.
(() => {
  const COLLECTOR = "__COLLECTOR__";
  // A bookmarklet that evaluates to a value replaces the page with it, so every path returns nothing.
  if (window.__betterPspCollector) {
    window.__betterPspCollector("already connected");
    return;
  }

  const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const pageUrl = location.origin + location.pathname;
  const describe = (el) =>
    [el.id, String(el.className?.baseVal ?? el.className ?? ""), el.getAttribute("alt"), el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("src"), el.getAttribute("onclick")].join(" ");
  const named = () =>
    [...document.querySelectorAll("img")].find(
      (img) => img.offsetWidth > 0 && /captcha/i.test(describe(img)) && !/refresh|reload|audio|sound|speak/i.test(describe(img)),
    );
  // IranKish's captcha has no telling name: take the first real image around the security-code field instead.
  const besideInput = () => {
    const input = [...document.querySelectorAll("input")].find(
      (el) =>
        el.offsetWidth > 0 &&
        /captcha|security|کد امنیتی/i.test([el.id, el.name, el.placeholder, el.getAttribute("aria-label"), el.closest("label")?.textContent].join(" ")),
    );
    for (let node = input?.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      const img = [...node.querySelectorAll("img")].find((el) => el.offsetWidth > 0 && el.naturalWidth > 40 && !/\.svg(\?|$)/i.test(el.getAttribute("src") ?? ""));
      if (img) return img;
    }
    return undefined;
  };
  const captcha = () => named() ?? besideInput();

  // A badge left by an earlier run that disconnected.
  document.getElementById("better-psp-collector")?.remove();
  const badge = document.createElement("div");
  badge.id = "better-psp-collector";
  badge.style.cssText =
    "position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:#1d2129;color:#e6e8ee;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)";
  document.body.append(badge);
  let sent = 0;
  const status = (text) => (badge.textContent = `Better PSP collector: ${text}`);
  window.__betterPspCollector = status;

  // Pages whose security policy forbids other addresses (Asan Pardakht) talk to the collector through a small window
  // it serves (relay.html), over postMessage. Opening it needs the bookmarklet click, so this runs first.
  let relay = null;
  let lastId = 0;
  const replies = new Map();
  window.addEventListener("message", (event) => {
    if (event.origin !== COLLECTOR || event.data?.betterPsp !== "response") return;
    replies.get(event.data.id)?.(event.data);
    replies.delete(event.data.id);
  });

  async function connect() {
    try {
      await fetch(COLLECTOR + "/api/bookmarklet");
      return;
    } catch {
      // Blocked: fall back to the relay window.
    }
    const ready = new Promise((resolve, reject) => {
      const onReady = (event) => {
        if (event.origin !== COLLECTOR || event.data?.betterPsp !== "ready") return;
        window.removeEventListener("message", onReady);
        resolve();
      };
      window.addEventListener("message", onReady);
      setTimeout(() => reject(new Error("the relay window did not answer")), 10000);
    });
    relay = window.open(`${COLLECTOR}/relay`, `better-psp-relay-${session}`, "width=420,height=240");
    if (!relay) throw new Error("popup blocked; allow popups for this site");
    await ready;
  }

  async function post(path, body) {
    const payload = { session, pageUrl, ...body };
    if (relay) {
      if (relay.closed) throw new Error("the relay window was closed");
      const id = ++lastId;
      // A closed or reloaded relay window never answers; waits come back within 20 s otherwise.
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          replies.delete(id);
          reject(new Error(relay.closed ? "the relay window was closed" : "the relay window stopped answering"));
        }, 30000);
        replies.set(id, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
        relay.postMessage({ betterPsp: "request", id, path, body: payload }, COLLECTOR);
      });
      if (!reply.ok) throw new Error(reply.body?.error ?? "relay request failed");
      return reply.body;
    }
    const res = await fetch(COLLECTOR + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.json();
  }

  // Background tabs get their timers slowed to about once a minute, so waiting is driven by image load events, with
  // a timer only as the fallback.
  const imageLoad = (ms) =>
    new Promise((resolve) => {
      const done = () => {
        document.removeEventListener("load", done, true);
        resolve();
      };
      document.addEventListener("load", done, true);
      setTimeout(done, ms);
    });

  /** The captcha's own pixels as a PNG, once it has loaded and differs from `previous`. */
  async function snapshot(previous) {
    for (let tries = 0; tries < 6; tries++) {
      const img = captcha();
      if (img?.complete && img.naturalWidth > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(img, 0, 0);
        let sum = 0;
        for (const value of context.getImageData(0, 0, canvas.width, canvas.height).data) sum = (sum * 31 + value) >>> 0;
        if (sum !== previous) return { sum, image: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
      }
      await imageLoad(2000);
    }
    return null;
  }

  /** Clicks the gateway's own refresh control next to the captcha, or the captcha itself if that is how it works. */
  function refresh() {
    const img = captcha();
    // Never anything that could pay, submit, confirm or cancel: a refresh control is a small icon, and says nothing of
    // the sort. Sepehr's wide pay button once matched by its styling alone.
    const harmless = (el) => {
      const box = el.getBoundingClientRect();
      const words = [el.textContent, el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("value")].join(" ");
      return (
        box.width <= 72 &&
        box.height <= 72 &&
        !el.closest('[type="submit"]') &&
        !/pay|submit|confirm|cancel|پرداخت|ارسال|تایید|تأیید|انصراف|لغو/i.test(words)
      );
    };
    for (let node = img?.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const button = [...node.querySelectorAll("a,button,i,span,svg,img,input")].find(
        // Icons name themselves in their text ("refresh", "autorenew") or their SVG sprite ("#arrows-rotate" on IranKish);
        // Pasargad only says it in Persian ("درخواست عبارت امنیتی جدید", request a new security phrase).
        (el) =>
          el !== img &&
          harmless(el) &&
          /refresh|reload|renew|rotate|redo|sync|جدید|تازه|بازخوانی/i.test(
            [describe(el), el.textContent.length < 20 ? el.textContent : "", ...[...el.querySelectorAll("use")].map((u) => u.getAttribute("href") ?? u.getAttribute("xlink:href"))].join(" "),
          ),
      );
      if (button) return button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    img?.click();
  }

  let last = null;
  async function send() {
    let shot = await snapshot(last);
    if (!shot && last !== null) {
      refresh();
      shot = await snapshot(last);
    }
    // Keep watching: a captcha refreshed by hand is sent as soon as it shows up.
    while (!shot) {
      status("could not get a new captcha; refresh it by hand");
      shot = await snapshot(last);
    }
    last = shot.sum;
    await post("/api/live/push", { image: shot.image, width: shot.width, height: shot.height });
    status(`connected, ${++sent} sent`);
  }

  (async () => {
    status("connecting…");
    await connect();
    await send();
    for (;;) {
      const { command } = await post("/api/live/wait", {});
      if (command === "next") {
        refresh();
        await send();
      }
    }
  })().catch((err) => {
    status(`disconnected (${err.message}); click the bookmarklet again`);
    delete window.__betterPspCollector;
  });
})();
