// Recent files (RecentFiles.kt, RecentFileList.kt): the files the user saved from any tool, newest
// first, at most 50, to open or share again. A browser can't reopen a file it downloaded, so a copy
// of each is kept in this browser (IndexedDB), on this device only; removing a file from the list
// or clearing the list deletes the copies. When storage is unavailable (a private window, blocked
// site data) the list lives in memory for this visit; when it is full, the oldest files make room,
// and a file too large to keep isn't listed. Nothing here ever throws to its caller.

/** The most files the list keeps (RecentFileList.MAX). */
export const MAX_RECENT = 50;

const DB_NAME = 'usugami';
const DB_VERSION = 1;
const LIST = 'recent';
const BYTES = 'recentBytes';

/** @typedef {{ id: string, name: string, type: string, size: number, savedAt: number }} RecentFile */

let dbPromise = null;
/** Used when IndexedDB can't be opened: the list for this visit only. */
const memory = { list: /** @type {RecentFile[]} */ ([]), bytes: new Map() };
let useMemory = false;
const listeners = new Set();
let channel = null;

function openDb() {
  if (useMemory) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      useMemory = true;
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LIST)) db.createObjectStore(LIST, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BYTES)) db.createObjectStore(BYTES);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab with a newer version of the site wants to upgrade: let it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      useMemory = true;
      resolve(null);
    };
    request.onblocked = () => {
      // Waits for the other tab; meanwhile nothing is lost by waiting.
    };
  });
  return dbPromise;
}

/** Runs `fn(stores)` in one transaction and resolves with its result once committed. */
function transact(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([LIST, BYTES], mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Aborted', 'AbortError'));
    Promise.resolve(fn({ list: tx.objectStore(LIST), bytes: tx.objectStore(BYTES) }))
      .then((r) => { result = r; })
      .catch((e) => {
        try {
          tx.abort();
        } catch {
          // Already finished.
        }
        reject(e);
      });
  });
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function sortNewest(list) {
  return list.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1));
}

function changed() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      setTimeout(() => { throw e; });
    }
  }
  try {
    channel?.postMessage('changed');
  } catch {
    // The other tabs look again next time.
  }
}

function newId() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The file's bytes as a Uint8Array (from any typed array or ArrayBuffer), or null. */
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function isQuotaError(e) {
  return e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
}

async function readAll(db) {
  if (!db) return memory.list.slice();
  return transact(db, 'readonly', ({ list }) => req(list.getAll()));
}

/**
 * Puts `outputFile` on top of the list: a file the user saved (Save, Save as, Save to folder),
 * kept in this browser. Saved again with the same name and contents, it moves up rather than
 * showing twice. The oldest go past 50.
 * @param {{ name: string, type?: string, bytes: Uint8Array }} outputFile
 * @returns {Promise<void>}
 */
export async function addRecent(outputFile) {
  try {
    const bytes = asBytes(outputFile?.bytes);
    if (!outputFile?.name || !bytes) return;
    const name = String(outputFile.name);
    const type = outputFile.type || 'application/pdf';
    const entry = { id: newId(), name, type, size: bytes.length, savedAt: Date.now() };
    const db = await openDb();
    if (!db) {
      const same = memory.list.find((f) => f.name === name && f.size === bytes.length && sameBytes(memory.bytes.get(f.id), bytes));
      if (same) {
        same.savedAt = entry.savedAt;
      } else {
        memory.list.push(entry);
        memory.bytes.set(entry.id, bytes.slice());
      }
      sortNewest(memory.list);
      for (const old of memory.list.splice(MAX_RECENT)) memory.bytes.delete(old.id);
      changed();
      return;
    }
    // The copy is taken now: the caller may reuse its bytes.
    const copy = bytes.slice();
    for (let attempt = 0; attempt < MAX_RECENT + 1; attempt++) {
      try {
        await transact(db, 'readwrite', async ({ list, bytes: store }) => {
          const all = sortNewest(await req(list.getAll()));
          for (const f of all) {
            if (f.name === name && f.size === copy.length && sameBytes(await req(store.get(f.id)), copy)) {
              f.savedAt = entry.savedAt;
              list.put(f);
              return;
            }
          }
          list.put(entry);
          store.put(copy, entry.id);
          for (const old of all.slice(MAX_RECENT - 1)) {
            list.delete(old.id);
            store.delete(old.id);
          }
        });
        changed();
        return;
      } catch (e) {
        if (!isQuotaError(e)) return;
        // Storage is full: the oldest file makes room, then the save is tried again.
        const all = sortNewest(await readAll(db));
        const oldest = all[all.length - 1];
        if (!oldest) return;
        await transact(db, 'readwrite', ({ list, bytes: store }) => {
          list.delete(oldest.id);
          store.delete(oldest.id);
        });
        changed();
      }
    }
  } catch {
    // Recent files is a convenience: saving the file itself has already happened.
  }
}

/**
 * The files on the list, newest first.
 * @returns {Promise<RecentFile[]>}
 */
export async function listRecent() {
  try {
    const db = await openDb();
    const all = sortNewest(await readAll(db));
    return all.slice(0, MAX_RECENT).map(({ id, name, type, size, savedAt }) => ({ id, name, type, size, savedAt }));
  } catch {
    return [];
  }
}

/**
 * The bytes kept for file `id`, or null when they are gone (cleared by the browser, say).
 * @param {string} id
 * @returns {Promise<Uint8Array|null>}
 */
export async function getRecentBytes(id) {
  try {
    const db = await openDb();
    if (!db) return memory.bytes.get(id)?.slice() ?? null;
    const value = await transact(db, 'readonly', ({ bytes }) => req(bytes.get(id)));
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value && typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    return null;
  } catch {
    return null;
  }
}

/**
 * Takes file `id` off the list and deletes its copy. The saved file itself stays where it is.
 * @param {string} id
 */
export async function removeRecent(id) {
  try {
    const db = await openDb();
    if (!db) {
      memory.list = memory.list.filter((f) => f.id !== id);
      memory.bytes.delete(id);
    } else {
      await transact(db, 'readwrite', ({ list, bytes }) => {
        list.delete(id);
        bytes.delete(id);
      });
    }
    changed();
  } catch {
    // Left for next time.
  }
}

/** Empties the list and deletes the copies. The saved files themselves stay where they are. */
export async function clearRecent() {
  try {
    const db = await openDb();
    if (!db) {
      memory.list = [];
      memory.bytes.clear();
    } else {
      await transact(db, 'readwrite', ({ list, bytes }) => {
        list.clear();
        bytes.clear();
      });
    }
    changed();
  } catch {
    // Left for next time.
  }
}

/**
 * Calls `fn()` whenever the list changes, in this tab or another. Returns an unsubscribe function.
 * @param {() => void} fn
 */
export function onRecentChange(fn) {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel('usugami-recent');
      channel.onmessage = () => {
        for (const l of listeners) l();
      };
    } catch {
      channel = null;
    }
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}
