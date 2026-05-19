/**
 * Browser IndexedDB adapter for the roost upload queue (wave 3.3).
 *
 * Split out from `./uploadQueue.ts` so the pure runner + backoff logic
 * can be fully unit-tested under Node, without fake-indexeddb machinery
 * that would only prove the fake matches itself. This file's correctness
 * depends on real IndexedDB semantics and is validated by wave 1.6's
 * browser integration tests (or operator smoke).
 */

import type { QueueStore, UploadTask } from './uploadQueue';

const DB_NAME = 'roost-upload-queue';
const STORE_NAME = 'tasks';
const DB_VERSION = 1;

/**
 * Open the IndexedDB-backed QueueStore. Caller may pass a site-scoped
 * name to isolate two sites open in the same browser.
 */
export function openIndexedDBStore(dbName: string = DB_NAME): QueueStore {
  const dbPromise = openDb(dbName);

  const tx = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
  ): Promise<T> => {
    const db = await dbPromise;
    return new Promise<T>((resolve, reject) => {
      const trans = db.transaction(STORE_NAME, mode);
      const store = trans.objectStore(STORE_NAME);
      const result = work(store);
      trans.onerror = () => reject(trans.error);
      if (result instanceof IDBRequest) {
        result.onsuccess = () => resolve(result.result as T);
        result.onerror = () => reject(result.error);
      } else {
        // already a promise
        result.then(resolve, reject);
      }
    });
  };

  return {
    async get(id: string) {
      return tx<UploadTask | undefined>('readonly', (s) =>
        s.get(id) as IDBRequest<UploadTask | undefined>,
      );
    },
    async put(task: UploadTask) {
      await tx('readwrite', (s) => s.put(task));
    },
    async list(filter) {
      const all = await tx<UploadTask[]>('readonly', (s) =>
        s.getAll() as IDBRequest<UploadTask[]>,
      );
      if (!filter?.state) return all;
      return all.filter((t) => t.state === filter.state);
    },
    async delete(id: string) {
      await tx('readwrite', (s) => s.delete(id));
    },
  };
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('uploadQueue: IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
