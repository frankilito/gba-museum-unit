/**
 * IndexedDB persistence. Stores are keyed by ROM content hash so saves,
 * states and imported ROMs never cross-contaminate between games.
 */

const DB_NAME = 'gba-museum';
const DB_VERSION = 1;

export interface StoredRom {
  hash: string;
  name: string;
  title: string;
  accent: number; // label accent color (hex)
  bytes: Uint8Array;
  addedAt: number;
}

export interface StoredSram {
  hash: string;
  bytes: Uint8Array;
  updatedAt: number;
}

export class SaveStore {
  private constructor(private db: IDBDatabase) {}

  static open(): Promise<SaveStore> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sram')) db.createObjectStore('sram', { keyPath: 'hash' });
        if (!db.objectStoreNames.contains('states')) db.createObjectStore('states', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('roms')) db.createObjectStore('roms', { keyPath: 'hash' });
        if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(new SaveStore(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  private tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- SRAM (in-game saves) ----
  async putSram(hash: string, bytes: Uint8Array): Promise<void> {
    await this.tx('sram', 'readwrite', (s) => s.put({ hash, bytes, updatedAt: Date.now() } satisfies StoredSram));
  }

  async getSram(hash: string): Promise<Uint8Array | null> {
    const row = await this.tx<StoredSram | undefined>('sram', 'readonly', (s) => s.get(hash) as IDBRequest<StoredSram | undefined>);
    return row?.bytes ?? null;
  }

  // ---- Save states (one per ROM, slot 0) ----
  async putState(hash: string, bytes: Uint8Array): Promise<void> {
    await this.tx('states', 'readwrite', (s) => s.put({ id: `${hash}:0`, hash, bytes, updatedAt: Date.now() }));
  }

  async getState(hash: string): Promise<Uint8Array | null> {
    const row = await this.tx<{ bytes: Uint8Array } | undefined>('states', 'readonly', (s) => s.get(`${hash}:0`) as IDBRequest<{ bytes: Uint8Array } | undefined>);
    return row?.bytes ?? null;
  }

  // ---- Imported ROMs (user-local only; never uploaded anywhere) ----
  async putRom(rom: StoredRom): Promise<void> {
    await this.tx('roms', 'readwrite', (s) => s.put(rom));
  }

  async listRoms(): Promise<StoredRom[]> {
    return this.tx<StoredRom[]>('roms', 'readonly', (s) => s.getAll() as IDBRequest<StoredRom[]>);
  }

  async deleteRom(hash: string): Promise<void> {
    await this.tx('roms', 'readwrite', (s) => s.delete(hash));
  }

  // ---- Config (keymap etc.) ----
  async putConfig(key: string, value: unknown): Promise<void> {
    await this.tx('config', 'readwrite', (s) => s.put({ key, value }));
  }

  async getConfig<T>(key: string): Promise<T | null> {
    const row = await this.tx<{ value: T } | undefined>('config', 'readonly', (s) => s.get(key) as IDBRequest<{ value: T } | undefined>);
    return row?.value ?? null;
  }
}
