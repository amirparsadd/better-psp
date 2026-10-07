// Look-alikes of each gateway's captcha, drawn on a canvas. Sizes, colors and noise follow the real samples in
// datasets/, so the solver's per-gateway pipeline gets something close to what it was tuned on.

type Ctx = CanvasRenderingContext2D;

export type CaptchaStyle = {
  gateway: string;
  name: string;
  width: number;
  height: number;
  draw(ctx: Ctx, digits: string): void;
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

const SANS = "Arial, Helvetica, 'Liberation Sans', sans-serif";
const SERIF = "'Times New Roman', Times, 'Liberation Serif', serif";

function fill(ctx: Ctx, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

type GlyphOptions = { font: string; color: string; angle?: number; skew?: number };

function glyph(ctx: Ctx, char: string, x: number, y: number, { font, color, angle = 0, skew = 0 }: GlyphOptions) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.transform(1, 0, skew, 1, 0, 0);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(char, 0, 0);
  ctx.restore();
}

/** Evenly spread centers across the width, with some jitter. */
function slots(count: number, from: number, to: number, jitter: number) {
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, i) => from + step * (i + 0.5) + rand(-jitter, jitter));
}

function line(ctx: Ctx, color: string, width: number, x0: number, y0: number, x1: number, y1: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function specks(ctx: Ctx, count: number, color: string, size: number) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.fillRect(rand(0, ctx.canvas.width), rand(0, ctx.canvas.height), rand(0.6, size), rand(0.6, size));
  }
}

export const STYLES: CaptchaStyle[] = [
  {
    gateway: "saman",
    name: "سامان",
    width: 200,
    height: 70,
    draw(ctx, digits) {
      fill(ctx, "#a9d3e3");
      const layer = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
      const inner = layer.getContext("2d")! as unknown as Ctx;
      const xs = slots(5, 8, 192, 2);
      [...digits].forEach((d, i) =>
        glyph(inner, d, xs[i]!, 37 + rand(-3, 3), { font: `bold ${rand(58, 64)}px ${SANS}`, color: "#111" }),
      );
      inner.globalCompositeOperation = "source-atop";
      inner.fillStyle = "#fff";
      for (let y = 2; y < 70; y += 6) {
        for (let x = (y / 6) % 2 ? 5 : 2; x < 200; x += 6) {
          inner.beginPath();
          inner.arc(x, y, 1.6, 0, Math.PI * 2);
          inner.fill();
        }
      }
      ctx.drawImage(layer, 0, 0);
      specks(ctx, 18, "#334", 1.6);
      for (let i = 0; i < 3; i++) {
        const x = rand(0, 200);
        const y = rand(0, 70);
        line(ctx, "#335", 0.8, x, y, x + rand(-14, 14), y + rand(-8, 8));
      }
    },
  },
  {
    gateway: "mellat",
    name: "ملت",
    width: 100,
    height: 25,
    draw(ctx, digits) {
      fill(ctx, "#ececec");
      specks(ctx, 60, "#d2d2d2", 2);
      const xs = slots(5, 10, 90, 1);
      [...digits].forEach((d, i) =>
        glyph(ctx, d, xs[i]!, 13 + rand(-1, 1), {
          font: `${rand(19, 21)}px ${SANS}`,
          color: pick(["#6f6f6f", "#7a7a7a", "#666"]),
          angle: rand(-0.08, 0.08),
        }),
      );
      specks(ctx, 12, "#999", 1.2);
    },
  },
  {
    gateway: "parsian",
    name: "پارسیان",
    width: 160,
    height: 40,
    draw(ctx, digits) {
      fill(ctx, "#c3ccd4");
      for (let x = 0; x < 160; x += 9) line(ctx, "#e6ebef", 1, x, 0, x, 40);
      for (let y = 0; y < 40; y += 9) line(ctx, "#e6ebef", 1, 0, y, 160, y);
      const xs = slots(5, 6, 154, 3);
      [...digits].forEach((d, i) =>
        glyph(ctx, d, xs[i]!, 20 + rand(-4, 4), {
          font: `italic bold ${rand(25, 29)}px ${SANS}`,
          color: "#0b1c7d",
          angle: rand(-0.15, 0.15),
        }),
      );
    },
  },
  {
    gateway: "asanpardakht",
    name: "آسان پرداخت",
    width: 150,
    height: 33,
    draw(ctx, digits) {
      fill(ctx, "#c9dcb6");
      const xs = slots(5, 2, 148, 2);
      [...digits].forEach((d, i) =>
        glyph(ctx, d, xs[i]!, 18 + rand(-1.5, 1.5), {
          font: `bold ${rand(24, 26)}px ${SANS}`,
          color: pick(["#111", "#555", "#5e1a2a", "#3b3b9a", "#b8282f"]),
        }),
      );
      for (let i = 0; i < 2; i++) line(ctx, pick(["#7a5a4a", "#666"]), 0.7, rand(0, 40), rand(8, 30), rand(90, 150), rand(4, 26));
    },
  },
  {
    gateway: "sadad",
    name: "سداد (ملی)",
    width: 160,
    height: 46,
    draw(ctx, digits) {
      fill(ctx, "#fbf5e2");
      const raised = Math.floor(rand(0, 5));
      const xs = slots(5, 10, 150, 3);
      [...digits].forEach((d, i) => {
        const small = i === raised;
        glyph(ctx, d, xs[i]!, small ? 16 : 26 + rand(-2, 2), {
          font: `bold ${small ? rand(17, 19) : rand(28, 31)}px ${SANS}`,
          color: "#7b3f12",
        });
      });
      ctx.strokeStyle = "#7b3f12";
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.arc(rand(10, 150), rand(10, 36), rand(5, 9), rand(0, 3), rand(4, 6.2));
        ctx.stroke();
      }
    },
  },
  {
    gateway: "irankish",
    name: "ایران‌کیش",
    width: 120,
    height: 45,
    draw(ctx, digits) {
      fill(ctx, "#ededed");
      const xs = slots(5, 4, 116, 3);
      [...digits].forEach((d, i) =>
        glyph(ctx, d, xs[i]!, 23 + rand(-6, 6), {
          font: `italic ${rand(22, 27)}px ${SERIF}`,
          color: "#7d0a3c",
          angle: rand(-0.12, 0.12),
        }),
      );
    },
  },
  {
    gateway: "pasargad",
    name: "پاسارگاد",
    width: 200,
    height: 40,
    draw(ctx, digits) {
      fill(ctx, "#ffffff");
      const xs = slots(5, 8, 192, 4);
      [...digits].forEach((d, i) =>
        glyph(ctx, d, xs[i]!, 22 + rand(-3, 3), {
          font: `italic ${rand(24, 28)}px ${SANS}`,
          color: "#1a1a1a",
          angle: rand(-0.1, 0.1),
        }),
      );
      for (let i = 0; i < 6; i++) {
        const x = rand(0, 200);
        const y = rand(2, 38);
        line(ctx, "#333", 1, x, y, x + rand(6, 14), y + rand(-1, 1));
      }
      ctx.fillStyle = "#222";
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(rand(0, 200), rand(2, 38), rand(1, 1.8), 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  {
    gateway: "sepehr",
    name: "سپهر",
    width: 200,
    height: 40,
    draw(ctx, digits) {
      fill(ctx, "#ffffff");
      for (let x = -40; x < 240; x += 8) {
        line(ctx, "#d4d4d4", 1, x, 0, x + 40, 40);
        line(ctx, "#d4d4d4", 1, x + 40, 0, x, 40);
      }
      const skew = rand(-0.25, 0.1);
      const xs = slots(5, 50, 150, 1.5);
      [...digits].forEach((d, i) =>
        glyph(ctx, d, xs[i]!, 21 + rand(-1, 1), { font: `${rand(28, 31)}px ${SANS}`, color: "#111", skew }),
      );
      specks(ctx, 45, "#111", 1.8);
    },
  },
  {
    gateway: "novin",
    name: "نوین",
    width: 330,
    height: 100,
    draw(ctx, digits) {
      fill(ctx, "#f4b5c9");
      const xs = slots(5, 10, 320, 10);
      [...digits].forEach((d, i) =>
        glyph(ctx, d, xs[i]!, 60 + rand(-14, 14), {
          font: `bold ${rand(52, 68)}px ${SERIF}`,
          color: pick(["#445a6e", "#5b2a6e", "#7a2346", "#7a5418", "#2c4a9a"]),
        }),
      );
      line(ctx, "#7a1830", 2, rand(30, 60), rand(55, 75), rand(280, 330), rand(5, 25));
      line(ctx, "#6a6aa0", 1.5, rand(150, 180), rand(30, 40), rand(250, 290), rand(30, 40));
      line(ctx, "#7a5418", 1.5, rand(10, 30), rand(10, 20), rand(30, 45), rand(0, 8));
    },
  },
];

export function randomDigits(count = 5): string {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 10)).join("");
}

/** Draws a fresh captcha into `canvas` (resizing it) and returns its answer. */
export function renderCaptcha(canvas: HTMLCanvasElement, style: CaptchaStyle): string {
  const digits = randomDigits();
  canvas.width = style.width;
  canvas.height = style.height;
  style.draw(canvas.getContext("2d")!, digits);
  return digits;
}
