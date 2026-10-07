import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { loadOrCreateKeys } from "../src/lib/keystore.ts";
import { createVault } from "../src/lib/vault.ts";

const CARD = { bin: "603799", last4: "1234" };
const OTHER = { bin: "610433", last4: "9876" };

let factory: IDBFactory;
const vault = createVault(() => loadOrCreateKeys(factory));

describe("vault", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    factory = new IDBFactory();
  });

  it("round-trips a CVV2", async () => {
    await vault.save(CARD, "123");
    expect(await vault.get(CARD)).toEqual({ cvv2: "123" });
    expect(await vault.get(OTHER)).toBeNull();
  });

  it("stores only ciphertext and an opaque id", async () => {
    await vault.save(CARD, "4321");
    const stored = JSON.stringify(await fakeBrowser.storage.local.get(null));
    expect(stored).not.toContain("4321");
    expect(stored).not.toContain("6037991234");
  });

  it("creates non-extractable keys once", async () => {
    const first = await loadOrCreateKeys(factory);
    const second = await loadOrCreateKeys(factory);
    expect(first.aes.extractable).toBe(false);
    expect(first.hmac.extractable).toBe(false);
    await vault.save(CARD, "555");
    expect(second.aes.algorithm).toEqual(first.aes.algorithm);
    expect(await vault.get(CARD)).toEqual({ cvv2: "555" });
  });

  it("rejects ciphertext moved to another card", async () => {
    const a = await vault.save(CARD, "111");
    const b = await vault.save(OTHER, "222");
    const local = await fakeBrowser.storage.local.get("vault");
    const records = local.vault as Record<string, unknown>;
    records[b.id] = { ...(records[a.id] as object), bin: OTHER.bin, last4: OTHER.last4 };
    await fakeBrowser.storage.local.set({ vault: records });
    expect(await vault.get(OTHER)).toBeNull();
    expect(await vault.get(CARD)).toEqual({ cvv2: "111" });
  });

  it("lists and forgets cards", async () => {
    await vault.save(CARD, "123");
    const saved = await vault.save(OTHER, "4567");
    expect((await vault.list()).map((c) => c.last4).sort()).toEqual(["1234", "9876"]);
    await vault.remove(saved.id);
    await vault.forget(CARD);
    expect(await vault.list()).toEqual([]);
  });

  it("validates input", async () => {
    await expect(vault.save(CARD, "12")).rejects.toThrow();
    await expect(vault.save(CARD, "12a")).rejects.toThrow();
    await expect(vault.save({ bin: "6037**", last4: "1234" }, "123")).rejects.toThrow();
  });
});
