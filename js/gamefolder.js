// Saving game prop sets straight into the folder they are baked from:
// BakeMe\Environment\PropsSet. Baking the BakeMe folder only picks the file up
// from there. This needs the File System Access API, so Chrome / Edge only;
// other browsers keep Download (the export dialog shows the path either way).
//
// The folder is picked once and remembered in this browser (IndexedDB). Any
// folder on that path will do: from BakeMe or Environment the rest of the way
// is taken (and made if missing); from a folder holding BakeMe, the existing
// path inside it. The browser may ask again for permission to edit it (after
// a restart, say), which needs a click or key press; Save and Ctrl+S are both.
// The first save over an existing file keeps the original next to it as
// <name>.bak, and that copy is never overwritten.

const DB = 'ppg-files';
const STORE = 'handles';

export const PROPSET_PATH = ['BakeMe', 'Environment', 'PropsSet'];
export const PROPSET_DIR = PROPSET_PATH.join('\\');

export const supported = () => typeof window.showDirectoryPicker === 'function';

let cached; // { dir, label }: undefined until read, null when there is none

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

async function remembered() {
  if (cached === undefined) {
    try {
      const v = await dbTx('readonly', (s) => s.get('game'));
      // Saved before labels existed: just the handle.
      cached = v?.kind === 'directory' ? { dir: v, label: v.name } : v?.dir ? v : null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

// The remembered folder (a directory handle), or null.
export const folder = async () => (await remembered())?.dir ?? null;

// How to show it, e.g. "BakeMe\Environment\PropsSet", or null.
export const folderLabel = async () => (await remembered())?.label ?? null;

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// The PropsSet folder for a picked folder: { dir, label }, or null when the
// picked folder isn't on the BakeMe\Environment\PropsSet path.
async function propSetFolder(picked) {
  const at = PROPSET_PATH.findIndex((name) => same(name, picked.name));
  if (at >= 0) {
    let dir = picked;
    for (const name of PROPSET_PATH.slice(at + 1)) dir = await dir.getDirectoryHandle(name, { create: true });
    return { dir, label: PROPSET_DIR };
  }
  try {
    let dir = picked;
    for (const name of PROPSET_PATH) dir = await dir.getDirectoryHandle(name);
    return { dir, label: `${picked.name}\\${PROPSET_DIR}` };
  } catch {
    return null;
  }
}

// Ask which folder to use (throws AbortError if the picker is closed).
// Returns how it is shown and whether it is on the bake path.
export async function pickFolder() {
  const picked = await window.showDirectoryPicker({ id: 'ppg-game', mode: 'readwrite' });
  const found = await propSetFolder(picked);
  cached = found ?? { dir: picked, label: picked.name };
  try {
    await dbTx('readwrite', (s) => s.put(cached, 'game'));
  } catch { /* remembered for this visit only */ }
  return { label: cached.label, onPath: !!found };
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
  return { folder: (await folderLabel()) ?? dir.name, backedUp };
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
