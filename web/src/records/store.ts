/**
 * Where the structure log is kept between visits.
 *
 * The browser's own database, with one exception that shapes the whole
 * interface: it is not always there. A private window, a browser with site data
 * turned off, an old version - in any of those, opening the database throws or
 * simply never answers, and the records exist only while the tab is open. That
 * is a usable state, not an error: a lecture still works if the log lasts the
 * hour. What must not happen is a class preparing an hour of records and losing
 * them without ever being told they were not being kept, so the App says so
 * (P9-5) and points at the export.
 *
 * So the log is behind an interface with two implementations: the database, and
 * a plain array. Everything above this file works the same either way, and the
 * tests use the array - IndexedDB does not exist in Node, and a fake of it
 * would be testing the fake.
 */
import type { StructureRecord } from './record';

export interface RecordStore {
  /** Every record, oldest first. */
  load(): Promise<StructureRecord[]>;
  /** Adds a record, or replaces the one with the same id (a rename). */
  put(record: StructureRecord): Promise<void>;
  /** Adds or replaces several at once, which is what reading a file does. */
  putAll(records: readonly StructureRecord[]): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** The log for this tab only. Also what the tests run against. */
export class MemoryRecordStore implements RecordStore {
  #records: StructureRecord[];

  constructor(initial: readonly StructureRecord[] = []) {
    this.#records = [...initial];
  }

  async load(): Promise<StructureRecord[]> {
    return oldestFirst(this.#records);
  }

  async put(record: StructureRecord): Promise<void> {
    const at = this.#records.findIndex((existing) => existing.id === record.id);
    if (at === -1) this.#records.push(record);
    else this.#records[at] = record;
  }

  async putAll(records: readonly StructureRecord[]): Promise<void> {
    for (const record of records) await this.put(record);
  }

  async remove(id: string): Promise<void> {
    this.#records = this.#records.filter((record) => record.id !== id);
  }

  async clear(): Promise<void> {
    this.#records = [];
  }
}

const DATABASE = 'mol-structure-log';
const STORE = 'records';
const DATABASE_VERSION = 1;

/**
 * How long to wait for the database before giving up on it.
 *
 * `indexedDB.open` in a browser that will not open it does not always fail: in
 * some private-window implementations the request simply never answers. A
 * lecture cannot start with a panel that says nothing, so waiting has an end,
 * after which the log is the one in memory.
 */
const OPEN_TIMEOUT_MS = 3000;

/** The log in the browser's database, surviving a reload. */
export class IndexedDbRecordStore implements RecordStore {
  #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  async load(): Promise<StructureRecord[]> {
    // Whatever order the keys came back in - they are random ids.
    return oldestFirst((await this.#run('readonly', (store) => store.getAll())) as StructureRecord[]);
  }

  async put(record: StructureRecord): Promise<void> {
    await this.#run('readwrite', (store) => store.put(record));
  }

  async putAll(records: readonly StructureRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.#run('readwrite', (store) => {
      let last: IDBRequest | null = null;
      for (const record of records) last = store.put(record);
      return last!;
    });
  }

  async remove(id: string): Promise<void> {
    await this.#run('readwrite', (store) => store.delete(id));
  }

  async clear(): Promise<void> {
    await this.#run('readwrite', (store) => store.clear());
  }

  /**
   * One transaction, resolved by the last request in it.
   *
   * A transaction that fails takes every request in it with it, which is what
   * makes `putAll` all-or-nothing.
   */
  #run(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const transaction = this.#db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
      transaction.oncomplete = () => resolve(request.result);
    });
  }
}

/** A store, and whether what goes in it will still be there next time. */
export interface OpenedStore {
  store: RecordStore;
  /** False when the records live only as long as this tab. */
  persistent: boolean;
}

/**
 * Opens the database, or falls back to memory.
 *
 * Never rejects: a browser that will not keep records is a state the interface
 * shows, not a failure it reports.
 */
export async function openRecordStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  timeoutMs: number = OPEN_TIMEOUT_MS,
): Promise<OpenedStore> {
  if (!factory) return { store: new MemoryRecordStore(), persistent: false };
  try {
    const db = await openDatabase(factory, timeoutMs);
    return { store: new IndexedDbRecordStore(db), persistent: true };
  } catch (error) {
    if (import.meta.env.DEV) console.debug('structure log: no database', error);
    return { store: new MemoryRecordStore(), persistent: false };
  }
}

function oldestFirst(records: readonly StructureRecord[]): StructureRecord[] {
  return [...records].sort((a, b) => (a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : 0));
}

function openDatabase(factory: IDBFactory, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, DATABASE_VERSION);
    const timer = setTimeout(() => reject(new Error('IndexedDB did not answer')), timeoutMs);
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      finish();
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => settle(() => resolve(request.result));
    request.onerror = () => settle(() => reject(request.error ?? new Error('IndexedDB refused')));
    // A database still open in another tab at an older version blocks this one.
    request.onblocked = () => settle(() => reject(new Error('IndexedDB is blocked')));
  });
}
