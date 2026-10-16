// Persists the chosen target folder (a FileSystemDirectoryHandle) in IndexedDB so it survives the
// popup closing. Handles are structured-cloneable, so they can be stored directly.
const DB_NAME = 'isc-pro';
const STORE = 'handles';
const KEY = 'targetFolder';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const getFolder = () => tx('readonly', (s) => s.get(KEY)).catch(() => null);
export const setFolder = (handle) => tx('readwrite', (s) => s.put(handle, KEY));
export const clearFolder = () => tx('readwrite', (s) => s.delete(KEY));

// Returns the folder only if we may write to it, asking the user when the grant has lapsed.
// Must be called at the start of a click handler: requestPermission needs a recent user gesture.
export async function getWritableFolder() {
  const handle = await getFolder();
  if (!handle) return null;
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return handle;
    if ((await handle.requestPermission(opts)) === 'granted') return handle;
  } catch (_) {}
  return { expired: true, name: handle.name };
}
