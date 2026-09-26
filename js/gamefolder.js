// Saving game prop sets straight into a folder on this computer: the one with
// the PropsSet_*.jsfb files the game (or the mod tool) uses. This needs the
// File System Access API, so Chrome / Edge only; other browsers keep Download.
//
// The folder is picked once and remembered in this browser (IndexedDB). The
// browser may ask again for permission to edit it (after a restart, say),
// which needs a click or key press; Save and Ctrl+S are both. The first save
// over an existing file keeps the original next to it as <name>.bak, and that
// copy is never overwritten.

const DB = 'ppg-files';
const STORE = 'handles';

export const supported = () => typeof window.showDirectoryPicker === 'function';

let cached; // the folder handle: undefined until read, null when there is none

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// The remembered folder, or null.
export async function folder() {
  if (cached === undefined) {
    try {
      cached = (await dbTx('readonly', (s) => s.get('game'))) || null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

async function countPropSets(dir) {
  let n = 0;
  for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /^PropsSet_.*\.jsfb$/i.test(name)) n++;
  return n;
}

// Ask which folder to use (throws AbortError if the picker is closed).
// Returns its name and how many PropsSet files are in it.
export async function pickFolder() {
  const dir = await window.showDirectoryPicker({ id: 'ppg-game', mode: 'readwrite' });
  cached = dir;
  try {
    await dbTx('readwrite', (s) => s.put(dir, 'game'));
  } catch { /* remembered for this visit only */ }
  return { name: dir.name, propSets: await countPropSets(dir) };
}

async function allowed(dir) {
  if (typeof dir.queryPermission !== 'function') return true;
  const opts = { mode: 'readwrite' };
  if ((await dir.queryPermission(opts)) === 'granted') return true;
  return (await dir.requestPermission(opts)) === 'granted';
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;
    throw e;
  }
}

async function write(dir, name, data) {
  const file = await dir.getFileHandle(name, { create: true });
  const out = await file.createWritable();
  await out.write(data);
  await out.close();
}

// Write `name` (e.g. PropsSet_HIAC.jsfb) into the folder, keeping the
// original as name.bak the first time. Returns { folder, backedUp }.
export async function saveFile(name, bytes) {
  const dir = await folder();
  if (!dir) throw new Error('no game folder picked yet');
  if (!(await allowed(dir))) throw new DOMException('the browser was not allowed to edit the folder', 'NotAllowedError');
  const bak = `${name}.bak`;
  let backedUp = false;
  if (await exists(dir, name) && !(await exists(dir, bak))) {
    const original = await (await dir.getFileHandle(name)).getFile();
    await write(dir, bak, await original.arrayBuffer());
    backedUp = true;
  }
  await write(dir, name, bytes);
  return { folder: dir.name, backedUp };
}

// The system's Open dialog, starting in the game folder. Resolves to the File
// picked, or null when the dialog is closed.
export async function openFromFolder() {
  const dir = await folder();
  try {
    const [file] = await window.showOpenFilePicker({
      ...(dir ? { startIn: dir } : {}),
      types: [{
        description: 'Game prop sets and profiles',
        accept: { 'application/octet-stream': ['.jsfb'], 'text/plain': ['.propsprofile', '.txt'] },
      }],
    });
    return await file.getFile();
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

export const canOpenFromFolder = () => typeof window.showOpenFilePicker === 'function';
