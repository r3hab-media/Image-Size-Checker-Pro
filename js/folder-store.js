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

const RW = { mode: 'readwrite' };
const SIMULATED_KEY = 'simulatedPermission';

// Test hook: real folder permissions can only be granted through Chrome's own prompt, which
// automated tests cannot click. When this IndexedDB key is set ('prompt' | 'granted' | 'denied'),
// permission checks and requests use it instead of the handle.
export const setSimulatedPermission = (state) =>
  tx('readwrite', (s) => (state ? s.put(state, SIMULATED_KEY) : s.delete(SIMULATED_KEY)));
const simulated = () => tx('readonly', (s) => s.get(SIMULATED_KEY)).catch(() => undefined);

export async function folderPermission(handle) {
  const sim = await simulated();
  if (sim) return sim;
  try {
    return await handle.queryPermission(RW);
  } catch (_) {
    return 'denied';
  }
}

// Shows Chrome's permission prompt; needs a user gesture in a page that stays open.
export async function requestFolderPermission(handle) {
  const sim = await simulated();
  if (sim) {
    const next = sim === 'denied' ? 'denied' : 'granted';
    await setSimulatedPermission(next);
    return next;
  }
  try {
    return await handle.requestPermission(RW);
  } catch (_) {
    return 'denied';
  }
}
