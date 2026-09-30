// Profiles: .propsprofile files uploaded from a folder (any folder, as it's a
// plain upload: the site never goes back to it) and kept in this browser.
// They're opened one at a time from the Match panel's Profiles tab
// (profiles-ui.js), edited, and saved back into the browser copy when the
// user saves (Save / Ctrl+S). Download gets a file out again.
//
// A profile replaces the scene while it's open; free design keeps its slot
// (matches.js) and comes back when no profile is open. Profiles and matches
// never are open at the same time.

import { S, emit, on } from './state.js';
import * as store from './store.js';
import * as M from './matches.js';
import { parseProfile, exportProfile } from './profile.js';

const DB = 'ppg-profile-files';
const FILES = 'files'; // file name -> text
const DIRTY = 'ppg.profileDirty';

export const baseName = (name) => String(name).replace(/\.propsprofile$/i, '');

function dbTx(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FILES);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(FILES, mode);
      const r = fn(tx.objectStore(FILES));
      tx.oncomplete = () => { db.close(); resolve(r?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

let dirty = false;   // the open profile has changes not saved yet
let loading = false; // opening a profile isn't an edit
try { dirty = !!S.profile && localStorage.getItem(DIRTY) === '1'; } catch { /* storage unavailable */ }

// The profiles kept here, sorted.
export async function list() {
  const names = (await dbTx('readonly', (s) => s.getAllKeys()).catch(() => [])) || [];
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

// Keep the .propsprofile files among `files` (from a folder upload). Same
// names replace what's here. Returns { added, replaced }.
export async function upload(files) {
  const have = new Set(await list());
  let added = 0, replaced = 0;
  for (const f of files) {
    if (!/\.propsprofile$/i.test(f.name)) continue;
    const text = await f.text();
    await dbTx('readwrite', (s) => s.put(text, f.name));
    if (have.has(f.name)) replaced++; else added++;
    have.add(f.name);
  }
  emit('profiles');
  return { added, replaced };
}

export const textOf = (name) => dbTx('readonly', (s) => s.get(name));

export async function remove(name) {
  if (S.profile === name) await open(null);
  await dbTx('readwrite', (s) => s.delete(name));
  emit('profiles');
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

// The open profile as it is now (what Save keeps and Download gives).
export const currentText = () => exportProfile(S.props, S.unknownLines);

// Open a profile (a name), or go back to free design (null). Unsaved changes
// are the caller's to settle first.
export async function open(name) {
  if (name === S.profile) return;
  let text = null;
  if (name) {
    text = await textOf(name);
    if (text == null) throw new Error('it isn’t in this browser any more');
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

// Keep the open profile's changes in its browser copy.
export async function save() {
  const name = S.profile;
  if (!name) throw new Error('no profile is open');
  await dbTx('readwrite', (s) => s.put(currentText(), name));
  setDirty(false);
  return name;
}
