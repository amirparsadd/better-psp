import { storage } from "#imports";
import type { CardFingerprint } from "./fields.ts";
import type { VaultKeys } from "./keystore.ts";
import type { SavedCard } from "./messages.ts";

type VaultRecord = { bin: string; last4: string; savedAt: number; iv: string; data: string };

const recordsItem = storage.defineItem<Record<string, VaultRecord>>("local:vault", { fallback: {} });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

function isValidCvv2(cvv2: string) {
  return /^\d{3,4}$/.test(cvv2);
}

function isValidCard(card: CardFingerprint) {
  return /^\d{6}$/.test(card.bin) && /^\d{4}$/.test(card.last4);
}

/**
 * CVV2 store. Records are keyed by an HMAC of BIN + last four digits, so the index reveals nothing on its own
 * and masked saved cards (6037-99**-****-1234) still match. Each CVV2 is AES-GCM encrypted with the record id
 * as associated data, so ciphertexts cannot be swapped between cards.
 */
export function createVault(getKeys: () => Promise<VaultKeys>) {
  async function idFor(card: CardFingerprint): Promise<string> {
    if (!isValidCard(card)) throw new Error("Invalid card");
    const { hmac } = await getKeys();
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(`${card.bin}:${card.last4}`)));
    return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function toSavedCard(id: string, record: VaultRecord): SavedCard {
    return { id, bin: record.bin, last4: record.last4, savedAt: record.savedAt };
  }

  async function remove(id: string) {
    const records = await recordsItem.getValue();
    if (!(id in records)) return;
    delete records[id];
    await recordsItem.setValue(records);
  }

  return {
    async save(card: CardFingerprint, cvv2: string): Promise<SavedCard> {
      if (!isValidCvv2(cvv2)) throw new Error("Invalid CVV2");
      const id = await idFor(card);
      const { aes } = await getKeys();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id) }, aes, encoder.encode(cvv2)),
      );
      const record: VaultRecord = { bin: card.bin, last4: card.last4, savedAt: Date.now(), iv: toBase64(iv), data: toBase64(data) };
      await recordsItem.setValue({ ...(await recordsItem.getValue()), [id]: record });
      return toSavedCard(id, record);
    },

    async get(card: CardFingerprint): Promise<{ cvv2: string } | null> {
      const id = await idFor(card);
      const record = (await recordsItem.getValue())[id];
      if (!record) return null;
      const { aes } = await getKeys();
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64(record.iv), additionalData: encoder.encode(id) },
          aes,
          fromBase64(record.data),
        );
        return { cvv2: decoder.decode(plain) };
      } catch {
        // Keys were lost (e.g. IndexedDB cleared); the record can never be read again.
        await remove(id);
        return null;
      }
    },

    async forget(card: CardFingerprint) {
      await remove(await idFor(card));
    },

    async list(): Promise<SavedCard[]> {
      const records = await recordsItem.getValue();
      return Object.entries(records)
        .map(([id, record]) => toSavedCard(id, record))
        .sort((a, b) => b.savedAt - a.savedAt);
    },

    remove,
  };
}

export type Vault = ReturnType<typeof createVault>;
