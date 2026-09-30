// Profiles folder: a folder of .propsprofile files on this computer, opened
// one at a time from the Match panel's Profiles tab (profiles-ui.js), edited,
// and written back when the user saves (Save / Ctrl+S). The first save over a
// file keeps the original next to it once, as <name>.bak. Chrome / Edge only
// (File System Access); the folder is remembered in this browser.
//
// A profile replaces the scene while it's open; free design keeps its slot
// (matches.js) and comes back when no profile is open. Profiles and matches
// never are open at the same time.

import { S, emit, on } from './state.js';
import * as store from './store.js';
import * as M from './matches.js';
import { parseProfile, exportProfile } from './profile.js';

const DB = 'ppg-profiles';
const STORE = 'meta';
const DIRTY = 'ppg.profileDirty';

export const supported = () => typeof window.showDirectoryPicker === 'function';
export const baseName = (name) => String(name).replace(/\.propsprofile$/i, '');

function dbTx(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(r?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

let dir;             // the folder handle: undefined until read, null when none
let dirty = false;   // the open profile has changes not saved yet
let loading = false; // opening a profile isn't an edit
try { dirty = !!S.profile && localStorage.getItem(DIRTY) === '1'; } catch { /* storage unavailable */ }

export async function folder() {
  if (dir === undefined) {
    try { dir = (await dbTx('readonly', (s) => s.get('folder'))) || null; } catch { dir = null; }
  }
  return dir;
}

// 'granted', 'prompt' (needs a click to ask again) or null (no folder). Never asks.
export async function access() {
  const d = await folder();
  if (!d) return null;
  return (await d.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'granted' : 'prompt';
}

// Ask the browser for the folder again (from a click or key press).
export async function allowed() {
  const d = await folder();
  if (!d) return false;
  const opts = { mode: 'readwrite' };
  try {
    return (await d.queryPermission(opts)) === 'granted' || (await d.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

// Pick the folder (throws AbortError when the picker is closed).
export async function choose() {
  const d = await window.showDirectoryPicker({ id: 'ppg-profiles', mode: 'readwrite' });
  dir = d;
  try { await dbTx('readwrite', (s) => s.put(d, 'folder')); } catch { /* remembered for this visit */ }
  emit('profiles');
  return d;
}

// The .propsprofile files in the folder, sorted; null without leave to read it.
export async function list() {
  if ((await access()) !== 'granted') return null;
  const names = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.propsprofile$/i.test(name)) names.push(name);
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

export const isDirty = () => dirty;

function setDirty(v) {
  if (dirty === v) return;
  dirty = v;
  try { localStorage.setItem(DIRTY, v ? '1' : '0'); } catch { /* storage unavailable */ }
  emit('profile-status');
}

on('props', () => {
  if (S.profile && !loading) setDirty(true);
});

async function exists(name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;
    throw e;
  }
}

async function write(name, data) {
  const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await out.write(data);
  await out.close();
}

// Open a profile from the folder (a file name), or go back to free design
// (null). Unsaved changes are the caller's to settle first.
export async function open(name) {
  if (name === S.profile) return;
  let text = null;
  if (name) {
    if (!(await allowed())) throw new Error('the browser wasn’t allowed into the profiles folder');
    text = await (await (await dir.getFileHandle(name)).getFile()).text();
  }
  loading = true;
  try {
    if (S.match) await M.openMatch(null);
    if (name) {
      if (!S.profile) await M.stashFree();
      const { items, unknown } = parseProfile(text);
      S.props = [];
      S.unknownLines = unknown;
      S.jsfb = null;
      S.selected.clear();
      S.nextId = 1;
      for (const it of items) store.addProp(it);
      S.profile = name;
      store.resetHistory();
      store.changed();
      emit('selection');
    } else {
      S.profile = null;
      await M.restoreFree();
    }
  } finally {
    loading = false;
  }
  setDirty(false);
  emit('profile', { name });
}

// Write the open profile back. Returns { name, backedUp }.
export async function save() {
  const name = S.profile;
  if (!name) throw new Error('no profile is open');
  if (!(await allowed())) throw new Error('the browser wasn’t allowed into the profiles folder');
  const bak = `${name}.bak`;
  let backedUp = false;
  if (await exists(name) && !(await exists(bak))) {
    await write(bak, await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
    backedUp = true;
  }
  await write(name, exportProfile(S.props, S.unknownLines));
  setDirty(false);
  return { name, backedUp };
}
