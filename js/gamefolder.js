// Saving game prop sets straight into a folder on this computer: the one with
// the PropsSet_*.jsfb files the game (or the mod tool) uses. This needs the
// File System Access API, so Chrome / Edge only; other browsers keep Download.
// Export's "Save to game folder" and the connected match folder (matches.js)
// are the same folder.
//
// The folder is picked once and remembered in this browser (IndexedDB). The
// browser may ask again for permission to edit it (after a restart, say),
// which needs a click or key press; Save, Ctrl+S and switching matches all
// are. The first save over an existing file keeps the original next to it as
// <name>.bak, and that copy is never overwritten.

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

// Names of the PropsSet_*.jsfb files in a folder (the remembered one by default).
export async function listPropSets(dir = null) {
  dir ??= await folder();
  const names = [];
  if (!dir) return names;
  for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /^PropsSet_.*\.jsfb$/i.test(name)) names.push(name);
  return names;
}

// Ask which folder to use, without remembering it yet (throws AbortError if
// the picker is closed).
export const chooseFolder = () => window.showDirectoryPicker({ id: 'ppg-game', mode: 'readwrite' });

// Remember `dir` as the folder.
export async function useFolder(dir) {
  cached = dir;
  try {
    await dbTx('readwrite', (s) => s.put(dir, 'game'));
  } catch { /* remembered for this visit only */ }
}

// Ask which folder to use and remember it. Returns its name and how many
// PropsSet files are in it.
export async function pickFolder() {
  const dir = await chooseFolder();
  await useFolder(dir);
  return { name: dir.name, propSets: (await listPropSets(dir)).length };
}

// May the site edit the folder right now? 'granted', 'prompt' (the browser has
// to ask again, which needs a click or key press) or null (no folder).
export async function access() {
  const dir = await folder();
  if (!dir) return null;
  if (typeof dir.queryPermission !== 'function') return 'granted';
  return (await dir.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'granted' : 'prompt';
}

async function allowed(dir) {
  if (typeof dir.queryPermission !== 'function') return true;
  const opts = { mode: 'readwrite' };
  if ((await dir.queryPermission(opts)) === 'granted') return true;
  return (await dir.requestPermission(opts)) === 'granted';
}

// Ask the browser for permission again (from a click or key press). Returns
// whether the site may edit the folder now.
export async function reconnect() {
  const dir = await folder();
  if (!dir) return false;
  try {
    return await allowed(dir);
  } catch {
    return false;
  }
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

// Read `name` from the folder: its bytes, or null if it isn't there or the
// site may not read the folder right now (this never asks).
export async function readFile(name) {
  const dir = await folder();
  if (!dir || (await access()) !== 'granted') return null;
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

// Write `name` (e.g. PropsSet_HIAC.jsfb) into the folder, keeping the
// original as name.bak the first time (unless backup is false: autosave of a
// match, whose original was kept when the folder was connected). Returns
// { folder, backedUp }.
export async function saveFile(name, bytes, { backup = true } = {}) {
  const dir = await folder();
  if (!dir) throw new Error('no game folder picked yet');
  if (!(await allowed(dir))) throw new DOMException('the browser was not allowed to edit the folder', 'NotAllowedError');
  const bak = `${name}.bak`;
  let backedUp = false;
  if (backup && await exists(dir, name) && !(await exists(dir, bak))) {
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
