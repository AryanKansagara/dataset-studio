/** Tiny IndexedDB wrapper: one store for projects, one for source files kept on this device. */
const DB = 'dataset-studio'
const VERSION = 1

let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  }))
}

function tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode)
    const r = f(t.objectStore(store))
    t.oncomplete = () => res(r.result)
    t.onerror = () => rej(t.error)
    t.onabort = () => rej(t.error ?? new Error('IndexedDB transaction aborted'))
  }))
}

export const idb = {
  all: <T>(store: string) => tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  get: <T>(store: string, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  put: (store: string, value: unknown, key?: string) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store: string, key: string) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store: string) => tx(store, 'readwrite', (s) => s.clear()),
}
