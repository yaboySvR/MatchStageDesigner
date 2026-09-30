// Matches: the game's prop set for each match type (propset.js MATCHES),
// edited one at a time from the Match panel (matches-ui.js).
//
// Two setups (configure(), once, before anything else): the game one, with
// everything below; and a browser-only one, with its own database, that never
// reads or writes a folder: each match starts with the vanilla file's props
// and is remembered in the browser. The two never share a match.
//
// Where a match's file comes from:
// - a connected PropsSet folder (Chrome / Edge): that folder's file;
// - otherwise this browser's copy, once the match was edited here;
// - otherwise the vanilla file the site carries (data/propsets/).
// Edits save by themselves a moment after each change: to the browser copy
// always, and into the connected folder when the browser allows it. After a
// browser restart it has to ask again, which needs a click (switching
// matches, Reconnect, Ctrl+S); until then folder writes wait, marked pending.
//
// Connecting a folder (after the user confirmed) reads the match files
// already in it: from then on those are the matches, and only the missing
// ones get added. The user can choose to replace them instead: every match is
// then written into it, each file already there kept once as <name>.jsfb.bak.
// A folder picked only for Export's "Save to game folder" isn't connected:
// matches never write into a folder without that confirmation.
//
// Props the site doesn't have stay exactly as they were in every match
// (propset.js keeps them); nothing here removes or changes them.
//
// "Free design" is the scene as the site always had it, not tied to a match.
// It keeps its own slot while a match is open.

import { S, emit, on } from './state.js';
import * as store from './store.js';
import * as P from './physics.js';
import * as GF from './gamefolder.js';
import { MATCHES, matchOf, readPropSet, writePropSet } from './propset.js';

export { MATCHES };

let DB = 'ppg-matches';
let folderOn = true;      // may a connected PropsSet folder be used at all
const COPIES = 'copies';  // match file -> { bytes, pending }
const META = 'meta';      // 'folder' -> the connected folder, 'free' -> { scene, env }
const SAVE_DELAY = 600;   // ms after the last change

// Which database the matches live in, and whether a folder may be used.
export function configure({ db = 'ppg-matches', folder = true } = {}) {
  DB = db;
  folderOn = folder;
}

export const matchName = (file) => MATCHES.find((m) => m.file === file)?.name ?? file;
export const fileName = (file) => `${file}.jsfb`;
const isMatch = (file) => MATCHES.some((m) => m.file === file);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------- browser storage

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(COPIES);
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbTx(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const getCopy = (file) => dbTx(COPIES, 'readonly', (s) => s.get(file)).catch(() => undefined);
const putCopy = (file, rec) => dbTx(COPIES, 'readwrite', (s) => s.put(rec, file));
const getMeta = (key) => dbTx(META, 'readonly', (s) => s.get(key)).catch(() => undefined);
const putMeta = (key, value) => dbTx(META, 'readwrite', (s) => s.put(value, key));

async function copies() {
  const [keys, values] = await Promise.all([
    dbTx(COPIES, 'readonly', (s) => s.getAllKeys()),
    dbTx(COPIES, 'readonly', (s) => s.getAll()),
  ]).catch(() => [[], []]);
  return keys.map((k, i) => [k, values[i]]);
}

// ---------------------------------------------------------------- sources

const vanillaCache = new Map();

// The vanilla file the site carries for a match.
export function vanilla(file) {
  if (!vanillaCache.has(file)) {
    vanillaCache.set(file, fetch(`data/propsets/${fileName(file)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${fileName(file)}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b))
      .catch((e) => {
        vanillaCache.delete(file);
        throw e;
      }));
  }
  return vanillaCache.get(file);
}

// The connected folder: the remembered game folder, if it was connected here.
export async function connectedFolder() {
  if (!folderOn) return null;
  const [dir, mine] = await Promise.all([GF.folder(), getMeta('folder')]);
  if (!dir || !mine) return null;
  try {
    return (await mine.isSameEntry(dir)) ? dir : null;
  } catch {
    return null;
  }
}

// A match's current file: { bytes, pending } (pending: it still has to be
// written into the connected folder). With a connected folder that can't be
// read, only a copy made here will do: the vanilla file in its place could
// later overwrite the real one.
async function storedBytes(file) {
  const copy = await getCopy(file);
  const dir = await connectedFolder();
  if (!dir) return { bytes: copy?.bytes ?? await vanilla(file), pending: false };
  // Switching matches is a click, so the browser may ask again here.
  if ((await GF.access()) !== 'granted') await GF.reconnect();
  if ((await GF.access()) !== 'granted') {
    if (copy?.bytes) return { bytes: copy.bytes, pending: !!copy.pending };
    throw new Error('the browser has to be allowed into the PropsSet folder again: use Reconnect');
  }
  if (copy?.pending) return { bytes: copy.bytes, pending: true }; // newer than the folder's
  const inFolder = await GF.readFile(fileName(file));
  if (inFolder) return { bytes: inFolder, pending: false };
  return { bytes: copy?.bytes ?? await vanilla(file), pending: true }; // missing there: put it back
}

// ---------------------------------------------------------------- saving

let status = { state: 'idle', detail: '' }; // idle | saving | saved | pending | error
let timer = null;
let chain = Promise.resolve(); // writes happen one at a time, in order
let last = null;               // { file, bytes, pending }: what the open match last saved (or opened) as
let quiet = false;             // loading a match isn't an edit

function setStatus(state, detail = '') {
  status = { state, detail };
  emit('match-status');
}

export const saveStatus = () => status;

const sceneBytes = () => writePropSet({ props: S.props, unknownLines: S.unknownLines, file: S.jsfb });

on('props', () => {
  if (S.match && !quiet) scheduleSave();
});

function scheduleSave() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saveNow();
  }, SAVE_DELAY);
  setStatus('saving');
}

// Save the open match now. A drop that is still falling is waited for (its
// end is a change of its own), unless settle: then it finishes at once.
export function saveNow({ settle = false } = {}) {
  clearTimeout(timer);
  timer = null;
  if (!S.match) return chain;
  if (P.busy()) {
    if (!settle) return chain;
    P.settleNow();
  }
  const file = S.match;
  let bytes;
  try {
    bytes = sceneBytes();
  } catch (e) {
    setStatus('error', e.message);
    return chain;
  }
  chain = chain.then(() => write(file, bytes)).catch((e) => setStatus('error', e.message));
  return chain;
}

async function write(file, bytes) {
  if (last?.file === file && !last.pending && same(last.bytes, bytes)) {
    setStatus('saved');
    return;
  }
  const dir = await connectedFolder();
  let pending = !!dir;
  if (dir && (await GF.access()) === 'granted') {
    await GF.saveFile(fileName(file), bytes, { backup: false });
    pending = false;
  }
  await putCopy(file, { bytes, pending });
  if (S.match === file) last = { file, bytes, pending };
  setStatus(pending ? 'pending' : 'saved');
  emit('match-edited');
}

// ---------------------------------------------------------------- switching

function fill(file, bytes) {
  const { items, file: meta } = readPropSet(bytes);
  S.props = [];
  S.unknownLines = [];
  S.selected.clear();
  S.nextId = 1;
  for (const it of items) store.addProp(it, { jsfb: it.jsfb });
  S.jsfb = { name: fileName(file), ...meta };
}

function load(file, bytes, pending) {
  quiet = true;
  try {
    S.match = file;
    fill(file, bytes);
    store.resetHistory();
    store.changed();
  } finally {
    quiet = false;
  }
  last = { file, bytes, pending };
  setStatus(pending ? 'pending' : 'saved');
  emit('selection');
  emit('match', { file, bytes });
  if (pending) saveNow();
}

// Keep the free-design scene in its slot (a profile is about to replace it).
export const stashFree = () => putMeta('free', { scene: store.snapshot(), env: S.env });

export async function restoreFree() {
  const free = await getMeta('free');
  quiet = true;
  try {
    S.match = null;
    if (free?.scene) {
      store.revert(free.scene);
    } else {
      S.props = [];
      S.unknownLines = [];
      S.jsfb = null;
      S.selected.clear();
      store.changed();
    }
    store.resetHistory();
  } finally {
    quiet = false;
  }
  last = null;
  setStatus('idle');
  emit('selection');
  emit('match', { file: null, env: free?.env });
}

// Open a match (a MATCHES file) or free design (null). The open match is
// saved first; leaving free design keeps its scene in its slot.
export async function openMatch(file) {
  if (file !== null && !isMatch(file)) throw new Error(`unknown match ${file}`);
  if (file === S.match) return;
  P.settleNow();
  if (S.match) await saveNow({ settle: true });
  else await putMeta('free', { scene: store.snapshot(), env: S.env });
  if (!file) {
    await restoreFree();
    return;
  }
  const { bytes, pending } = await storedBytes(file);
  load(file, bytes, pending);
}

// A game file named like a match opens in that match, as its new version
// (Ctrl+Z goes back). Returns false for other files.
export async function importIntoMatch(bytes, name) {
  const m = matchOf(name);
  if (!m) return false;
  readPropSet(bytes); // a damaged file fails here, before anything changes
  await openMatch(m.file);
  store.checkpoint();
  fill(m.file, bytes);
  store.changed();
  emit('selection');
  emit('match', { file: m.file, bytes });
  return true;
}

// ---------------------------------------------------------------- the folder

// Which match files are in `dir` already.
export async function filesIn(dir) {
  const names = new Set((await GF.listPropSets(dir)).map((n) => n.toLowerCase()));
  return MATCHES.map((m) => fileName(m.file)).filter((n) => names.has(n.toLowerCase()));
}

// Connect `dir` (picked, and confirmed by the user). The match files already
// in it are read, not changed: from now on they are those matches (the open
// one reloads from its file). Only the missing ones get written, as edited
// here or vanilla. A file the site can't read stays exactly as it is, and
// nothing writes over it by itself; if it's the open match's, free design
// opens instead. With replace, every match is written into the folder: the
// open one as it is now, the others as edited here or vanilla, each file
// already there kept once as <name>.jsfb.bak.
// Returns { read, added, backedUp, unreadable: [file names] }.
export async function connect(dir, { replace = false } = {}) {
  P.settleNow();
  clearTimeout(timer);
  timer = null;
  await chain;
  await GF.useFolder(dir);
  await putMeta('folder', dir);
  const res = { read: 0, added: 0, backedUp: 0, unreadable: [] };
  let reopen = null;      // the open match as the folder has it
  let openBroken = false; // the open match's file can't be read
  for (const m of MATCHES) {
    const name = fileName(m.file);
    const open = m.file === S.match;
    const copy = await getCopy(m.file);
    const there = replace ? null : await GF.readFrom(dir, name);
    if (there) {
      try {
        readPropSet(there);
      } catch {
        res.unreadable.push(name);
        if (copy?.pending) await putCopy(m.file, { ...copy, pending: false });
        if (open) openBroken = true;
        continue;
      }
      await putCopy(m.file, { bytes: there, pending: false });
      if (open) reopen = there;
      res.read++;
      continue;
    }
    const bytes = open ? sceneBytes() : copy?.bytes ?? await vanilla(m.file);
    if ((await GF.saveFile(name, bytes)).backedUp) res.backedUp++;
    if (copy || open) await putCopy(m.file, { bytes, pending: false });
    if (open) last = { file: m.file, bytes, pending: false };
    res.added++;
  }
  if (reopen) load(S.match, reopen, false);
  else if (openBroken) await restoreFree();
  else setStatus(S.match ? 'saved' : 'idle');
  emit('match-edited');
  return res;
}

// Ask the browser again (from a click or key press) and write what waited.
// Returns how many matches were written, or false if it wasn't allowed.
export async function reconnectFolder() {
  if (!(await connectedFolder()) || !(await GF.reconnect())) return false;
  let n = 0;
  for (const [file, rec] of await copies()) {
    if (!rec?.pending || !rec.bytes || !isMatch(file)) continue;
    await GF.saveFile(fileName(file), rec.bytes, { backup: false });
    await putCopy(file, { bytes: rec.bytes, pending: false });
    n++;
  }
  if (last) last.pending = false;
  if (S.match) await saveNow({ settle: true });
  setStatus(S.match ? 'saved' : 'idle');
  return n;
}

// Matches edited here: their copy differs from the vanilla file.
export async function editedMatches() {
  const out = new Set();
  for (const [file, rec] of await copies()) {
    if (!rec?.bytes || !isMatch(file)) continue;
    try {
      if (!same(rec.bytes, await vanilla(file))) out.add(file);
    } catch {
      out.add(file);
    }
  }
  return out;
}

// ---------------------------------------------------------------- start

// After the page loads: the restored scene is the latest version of the open
// match; if it didn't get saved before the page went away, save it now.
export async function initMatches() {
  if (S.match && !isMatch(S.match)) S.match = null;
  if (!S.match) return;
  const file = S.match;
  if (!S.jsfb) {
    const { bytes, pending } = await storedBytes(file);
    load(file, bytes, pending);
    return;
  }
  const copy = await getCopy(file);
  let stored = copy?.bytes;
  if (!stored && (await connectedFolder())) {
    // Without leave to read the folder there's nothing to compare with; the
    // next change saves everything anyway.
    if ((await GF.access()) !== 'granted') {
      setStatus('saved');
      return;
    }
    stored = await GF.readFile(fileName(file));
  }
  stored ??= await vanilla(file);
  last = { file, bytes: stored, pending: !!copy?.pending };
  let now;
  try {
    now = sceneBytes();
  } catch {
    return;
  }
  if (copy?.pending || !same(stored, now)) saveNow();
  else setStatus('saved');
}
