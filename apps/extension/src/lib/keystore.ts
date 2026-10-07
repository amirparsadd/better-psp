export type VaultKeys = { aes: CryptoKey; hmac: CryptoKey };

const DB_NAME = "better-psp";
const STORE = "keys";
const KEY_ID = "vault";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const req = factory.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return request(req);
}

/**
 * Non-extractable keys live in IndexedDB as CryptoKey objects: extension code can use them, but no API can
 * export the raw key material, and they never touch extension storage where the ciphertexts are.
 */
export async function loadOrCreateKeys(factory: IDBFactory = indexedDB): Promise<VaultKeys> {
  const db = await openDb(factory);
  try {
    const existing = await request<VaultKeys | undefined>(db.transaction(STORE).objectStore(STORE).get(KEY_ID));
    if (existing) return existing;

    const keys: VaultKeys = {
      aes: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
      hmac: await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    };
    try {
      await request(db.transaction(STORE, "readwrite").objectStore(STORE).add(keys, KEY_ID));
      return keys;
    } catch {
      // Another context created the keys first.
      return (await request<VaultKeys | undefined>(db.transaction(STORE).objectStore(STORE).get(KEY_ID)))!;
    }
  } finally {
    db.close();
  }
}
