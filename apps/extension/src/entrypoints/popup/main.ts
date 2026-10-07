import { contactItem, isEmail, loadContact, normalizeMobile } from "../../lib/contact.ts";
import { sendVault, type SavedCard } from "../../lib/messages.ts";
import { loadSettings, settingsItem, type Settings } from "../../lib/settings.ts";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const toPersianDigits = (text: string) => text.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]!);
const dateFormat = new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" });

function maskedPan(card: SavedCard): string {
  return toPersianDigits(`${card.bin.slice(0, 4)} ${card.bin.slice(4)}•• •••• ${card.last4}`);
}

async function renderSettings() {
  const settings = await loadSettings();
  for (const input of document.querySelectorAll<HTMLInputElement>(".toggle input")) {
    const key = input.name as keyof Settings;
    input.checked = settings[key];
    input.addEventListener("change", async () => {
      await settingsItem.setValue({ ...(await loadSettings()), [key]: input.checked });
    });
  }
}

async function renderContact() {
  const form = document.querySelector<HTMLFormElement>("#contact")!;
  const status = document.querySelector<HTMLElement>("#contact-status")!;
  const email = form.elements.namedItem("email") as HTMLInputElement;
  const mobile = form.elements.namedItem("mobile") as HTMLInputElement;
  const saved = await loadContact();
  email.value = saved.email;
  mobile.value = saved.mobile;

  async function save() {
    const nextEmail = email.value.trim();
    const nextMobile = mobile.value.trim() === "" ? "" : normalizeMobile(mobile.value);
    const emailOk = nextEmail === "" || isEmail(nextEmail);
    email.setAttribute("aria-invalid", String(!emailOk));
    mobile.setAttribute("aria-invalid", String(nextMobile === null));
    status.classList.toggle("error", !emailOk || nextMobile === null);
    if (!emailOk || nextMobile === null) {
      status.textContent = !emailOk ? "ایمیل درست نیست." : "شماره‌ی موبایل باید ۱۱ رقم و با ۰۹ شروع شود.";
      return;
    }
    mobile.value = nextMobile;
    await contactItem.setValue({ email: nextEmail, mobile: nextMobile });
    status.textContent = "ذخیره شد.";
  }

  form.addEventListener("change", () => void save());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
}

async function renderCards() {
  const list = document.querySelector<HTMLUListElement>("#cards")!;
  const empty = document.querySelector<HTMLElement>("#empty")!;
  const cards = await sendVault({ type: "vault:list" }).catch(() => []);

  list.replaceChildren(
    ...cards.map((card) => {
      const item = document.createElement("li");
      const info = document.createElement("div");
      const pan = document.createElement("div");
      pan.className = "pan";
      pan.textContent = maskedPan(card);
      const savedAt = document.createElement("small");
      savedAt.className = "muted";
      savedAt.textContent = `ذخیره‌شده در ${dateFormat.format(card.savedAt)}`;
      info.append(pan, savedAt);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "حذف";
      remove.addEventListener("click", async () => {
        await sendVault({ type: "vault:delete", id: card.id });
        await renderCards();
      });

      item.append(info, remove);
      return item;
    }),
  );
  empty.hidden = cards.length > 0;
}

void renderSettings();
void renderContact();
void renderCards();
