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
//
// The folder picked is the Environment folder: the one with PropsSet and
// EnvironmentSetup in it. The match files go in PropsSet; EnvironmentSetup's
// PropsPositions.jsfb says which match types load which PropsSet file, and
// saving a match's file adds its rows there when they're missing
// (positions.js), as the mod tool does. (A PropsSet folder remembered from
// before still opens and saves, but can't reach PropsPositions.jsfb.)

import * as POS from './positions.js';

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

// A subfolder of dir, or null if there's none.
async function sub(dir, name, create = false) {
  try {
    return await dir.getDirectoryHandle(name, { create });
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null;
    throw e;
  }
}

// The picked folder when it's an Environment folder (PropsSet or
// EnvironmentSetup in it, or named Environment); null otherwise.
async function environment(dir) {
  if (dir.name.toLowerCase() === 'environment') return dir;
  return (await sub(dir, 'PropsSet')) || (await sub(dir, 'EnvironmentSetup')) ? dir : null;
}

// Where the PropsSet files are, from the picked folder (create: make the
// PropsSet folder if an Environment folder has none yet).
export async function propsDir(dir, { create = false } = {}) {
  const env = await environment(dir);
  return env ? sub(env, 'PropsSet', create) : dir;
}

// The EnvironmentSetup folder next to the PropsSet one, or null if the
// picked folder can't reach it (or it isn't there and create is false).
export async function setupDir(dir, { create = false } = {}) {
  const env = await environment(dir);
  return env ? sub(env, 'EnvironmentSetup', create) : null;
}

// Names of the PropsSet_*.jsfb files in a folder (the remembered one by default).
export async function listPropSets(dir = null) {
  dir ??= await folder();
  const names = [];
  const props = dir && (await propsDir(dir));
  if (!props) return names;
  for await (const [name, h] of props.entries()) if (h.kind === 'file' && /^PropsSet_.*\.jsfb$/i.test(name)) names.push(name);
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

// Ask which folder to use and remember it, if it's an Environment folder.
// Returns its name, whether it is one (env) and how many PropsSet files are
// in it.
export async function pickFolder() {
  const dir = await chooseFolder();
  if (!(await environment(dir))) return { name: dir.name, env: false, propSets: 0 };
  await useFolder(dir);
  return { name: dir.name, env: true, propSets: (await listPropSets(dir)).length };
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

// Read `name` from `dir`: its bytes, or null if it isn't there (any other
// failure throws, so a file that can't be read never passes for a missing one).
export async function readFrom(dir, name) {
  const props = await propsDir(dir);
  if (!props) return null;
  try {
    const file = await (await props.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

// Read `name` from the folder: its bytes, or null if it isn't there or the
// site may not read the folder right now (this never asks).
export async function readFile(name) {
  const dir = await folder();
  if (!dir || (await access()) !== 'granted') return null;
  return readFrom(dir, name);
}

// Write `name` into `dir`, keeping the original as name.bak the first time
// (when backup). Returns { backedUp, replaced }.
async function put(dir, name, bytes, backup) {
  const bak = `${name}.bak`;
  let backedUp = false;
  const replaced = await exists(dir, name);
  if (backup && replaced && !(await exists(dir, bak))) {
    const original = await (await dir.getFileHandle(name)).getFile();
    await write(dir, bak, await original.arrayBuffer());
    backedUp = true;
  }
  await write(dir, name, bytes);
  return { backedUp, replaced };
}

let vanillaPositions = null;

// The game's own PropsPositions.jsfb, which the site carries.
function gamePositions() {
  vanillaPositions ??= fetch(`data/environmentsetup/${POS.FILE}`)
    .then((r) => {
      if (!r.ok) throw new Error(`${POS.FILE}: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b))
    .catch((e) => {
      vanillaPositions = null;
      throw e;
    });
  return vanillaPositions;
}

// Let the match whose file is `name` load: add its rows to EnvironmentSetup's
// PropsPositions.jsfb if they're missing (the game's own file when there's
// none yet; an original nobody added rows to kept once as .bak). Returns
// 'added', 'ok' (nothing to add), 'unreachable' (rows needed, but the
// folder isn't an Environment folder) or 'unreadable' (the file there can't
// be read: left as it is).
async function letLoad(dir, name) {
  const file = name.replace(/\.jsfb$/i, '');
  if (!POS.listed(file)) return 'ok';
  if (!(await environment(dir))) return 'unreachable';
  const setup = await setupDir(dir);
  const there = setup && (await readIn(setup, POS.FILE));
  let next;
  try {
    next = POS.withMatches(there ?? await gamePositions(), [file]);
  } catch {
    if (there) return 'unreadable';
    throw new Error(`couldn’t read the game’s ${POS.FILE}`);
  }
  if (!next) return 'ok';
  // keep the original once: only a file nobody has added rows to yet is one
  await put(setup ?? await setupDir(dir, { create: true }), POS.FILE, next, !!there && POS.untouched(there));
  return 'added';
}

async function readIn(dir, name) {
  try {
    return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

// Make sure the match whose file is `name` (already in the folder) loads:
// letLoad without writing the file itself.
export async function letMatchLoad(name) {
  const dir = await folder();
  if (!dir || !(await allowed(dir))) return 'ok';
  return letLoad(dir, name);
}

// Is the picked folder an Environment folder (so it reaches EnvironmentSetup)?
export const reachesSetup = async (dir) => !!(await environment(dir));

// Can the match whose file is `name` load from the remembered folder? false
// only when it needs PropsPositions.jsfb rows and the folder can't reach it.
export async function canLoad(name) {
  const dir = await folder();
  if (!dir || !POS.listed(name.replace(/\.jsfb$/i, ''))) return true;
  return reachesSetup(dir);
}

// Write `name` (e.g. PropsSet_HIAC.jsfb) into the folder, keeping the
// original as name.bak the first time (unless backup is false: autosave of a
// match, whose original was kept when the folder was connected). A PropsSet
// file also gets its PropsPositions.jsfb rows (letLoad). Returns { folder,
// backedUp, replaced, positions: 'added' | 'ok' | 'unreachable' | 'unreadable' }.
export async function saveFile(name, bytes, { backup = true } = {}) {
  const dir = await folder();
  if (!dir) throw new Error('no game folder picked yet');
  if (!(await allowed(dir))) throw new DOMException('the browser was not allowed to edit the folder', 'NotAllowedError');
  const propSet = /^PropsSet_.*\.jsfb$/i.test(name);
  const target = propSet ? await propsDir(dir, { create: true }) : dir;
  const res = await put(target, name, bytes, backup);
  return { folder: dir.name, ...res, positions: propSet ? await letLoad(dir, name) : 'ok' };
}
