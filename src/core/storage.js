// Keeping your painting between visits.
//
// A painting is two full-canvas textures -- colour plus wet-paint volume, and
// impasto height plus wetness. At 24x18in that is about 12MB packed to 8 bits,
// which is far past what localStorage will take, so it lives in IndexedDB.
// Same thing as far as you are concerned: it is on your machine, nothing is
// uploaded anywhere, and clearing site data clears it.

const DB_NAME = 'joy-of-painting';
const STORE = 'paintings';
const SLOT = 'current';
const VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req && req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

/**
 * Everything needed to carry on later: both surfaces, the canvas size, and
 * what was on the brush. Private-browsing or a blocked database just means
 * saving quietly does nothing, which is why every call swallows its errors.
 */
export async function save(state) {
  try {
    await run('readwrite', (store) => store.put({ ...state, savedAt: Date.now() }, SLOT));
    return true;
  } catch {
    return false;
  }
}

export async function load() {
  try {
    const state = await run('readonly', (store) => store.get(SLOT));
    return state && state.version === VERSION ? state : null;
  } catch {
    return null;
  }
}

export async function clear() {
  try {
    await run('readwrite', (store) => store.delete(SLOT));
    return true;
  } catch {
    return false;
  }
}

export const SAVE_VERSION = VERSION;
