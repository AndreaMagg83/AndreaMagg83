// Archivio locale nel browser (IndexedDB): note e registrazioni audio.

const DB_NAME = 'agenda-vocale';
const DB_VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const getAllNotes = () => run('notes', 'readonly', (s) => s.getAll());
export const saveNote = (note) => run('notes', 'readwrite', (s) => s.put(note));
export const deleteNote = (id) => run('notes', 'readwrite', (s) => s.delete(id));
export const saveAudio = (id, blob) => run('audio', 'readwrite', (s) => s.put(blob, id));
export const getAudio = (id) => run('audio', 'readonly', (s) => s.get(id));
export const deleteAudio = (id) => run('audio', 'readwrite', (s) => s.delete(id));
