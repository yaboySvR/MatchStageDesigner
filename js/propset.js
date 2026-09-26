// The game's prop set files (PropsSet_<Mode>.jsfb) <-> the designer's scene.
// jsfb.js reads and writes the bytes; this maps them onto prop records.
//
// The jsfb has its own axes, where height is -y (see ../jsfb's/README.md):
//   position  jsfb (x, y, z) = designer (x, -z, y)
//   rotation  jsfb (x, y, z) = designer (rx, rz, ry)
// prop_id and state are the same numbers as in a .propsprofile.
//
// Opening a file loses nothing, and saving it untouched gives back identical
// bytes:
// - each prop remembers the fields it was read with (record.jsfb.src) and
//   writes them back, changing only what was edited;
// - props that aren't in the catalog are kept as they were (S.jsfb.keep) and
//   go back in their original place in the list.
// New props are written the way the intermediary program writes them.

import { getProp, stateId } from './catalog.js';
import { catalogMatcher } from './profile.js';
import { pyFixed3 } from './rotation.js';
import { decode, encode } from './jsfb.js';

const NEW_PROP_HASH = 0x49016aee; // the intermediary puts this on every prop
const NEW_FILE_UNK1 = 1;          // and this on the file

// The game's match types with a prop set, by the names people know them by
// (matches.js). data/propsets/ has each one's vanilla file.
export const MATCHES = [
  { file: 'PropsSet_Ambulance', name: 'Ambulance' },
  { file: 'PropsSet_BloodlineRules', name: 'Bloodline Rules' },
  { file: 'PropsSet_Gameplay_Casket', name: 'Casket' },
  { file: 'PropsSet_Gameplay_Dumpster', name: 'Dumpster' },
  { file: 'PropsSet_EliminationChamber', name: 'Elimination Chamber' },
  { file: 'PropsSet_ExtremeRules', name: 'Extreme Rules' },
  { file: 'PropsSet_FallsCountAnywhere', name: 'Falls Count Anywhere' },
  { file: 'PropsSet_HIAC', name: 'Hell in a Cell' },
  { file: 'PropsSet_IQuit', name: 'I Quit' },
  { file: 'PropsSet_Inferno', name: 'Inferno' },
  { file: 'PropsSet_Gameplay_LadderMatch_0', name: 'Ladder' },
  { file: 'PropsSet_LastManStanding', name: 'Last Man Standing' },
  { file: 'PropsSet_SteelCage', name: 'Steel Cage' },
  { file: 'PropsSet_Gameplay_TableMatch_0', name: 'Tables' },
  { file: 'PropsSet_Gameplay_TLCMatch_0', name: 'TLC' },
  { file: 'PropsSet_Underground', name: 'Underground' },
  { file: 'PropsSet_Wargames', name: 'WarGames' },
];

// For naming a saved file.
export const MATCH_FILES = MATCHES.map((m) => m.file);

// The match a file name (with or without .jsfb) belongs to, or null.
export function matchOf(name) {
  const base = String(name).replace(/\.jsfb$/i, '').toLowerCase();
  return MATCHES.find((m) => m.file.toLowerCase() === base) || null;
}

// The arena that goes with a match type's file.
export function envForFile(name) {
  if (/ambulance/i.test(name)) return 'AMB';
  if (/eliminationchamber/i.test(name)) return 'EC';
  if (/hiac|hellinacell/i.test(name)) return 'HIAC';
  if (/wargames/i.test(name)) return 'WG';
  return 'NORMAL';
}

// ---------------------------------------------------------------- float32 bits

// Stored props keep their floats as float32 bit patterns: JSON (undo, autosave)
// would otherwise turn the file's many -0.0 into 0.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const toBits = (v) => { f32[0] = v; return u32[0]; };
const fromBits = (b) => { u32[0] = b; return f32[0]; };
const VECS = ['position', 'rotation', 'scale'];

function mapVecs(prop, fn) {
  const out = { ...prop };
  for (const k of VECS) {
    if (out[k]) out[k] = Object.fromEntries(Object.entries(out[k]).map(([c, v]) => [c, fn(v)]));
  }
  return out;
}
const freeze = (prop) => mapVecs(prop, toBits);
const thaw = (prop) => mapVecs(prop, fromBits);

// ---------------------------------------------------------------- reading

// .jsfb bytes -> { items: prop records (with .jsfb), file: S.jsfb without name }
export function readPropSet(bytes) {
  const { props, ...root } = decode(bytes);
  const match = catalogMatcher();
  const items = [];
  const keep = [];
  (props || []).forEach((p, i) => {
    const hit = match(p.prop_id ?? 0, p.state ?? 0);
    if (!hit) {
      keep.push({ i, prop: freeze(p) });
      return;
    }
    const P = p.position || {}, R = p.rotation || {};
    items.push({
      key: hit[0], state: hit[1],
      x: P.x || 0, y: P.z || 0, z: -(P.y || 0) || 0,
      rx: R.x || 0, ry: R.z || 0, rz: R.y || 0,
      jsfb: { i, src: freeze(p) },
    });
  });
  return { items, file: { root, hasProps: props !== undefined, keep } };
}

// ---------------------------------------------------------------- writing

// Rounded like a .propsprofile (3 decimals), so a prop saved straight to the
// game file comes out the same as the intermediary makes it from a profile.
const r3 = (v) => Number(pyFixed3(v));
const f = Math.fround;

// A prop placed in the designer, in the intermediary's format.
function fresh(p, pid, sid) {
  return {
    prop_id: pid, unk1: NEW_PROP_HASH,
    position: { x: f(r3(p.x)), y: f(-r3(p.z)), z: f(r3(p.y)) },
    rotation: { x: f(r3(p.rx)), y: f(r3(p.rz)), z: f(r3(p.ry)) },
    scale: { x: 1, y: 1, z: 1 }, state: sid, unk6: [],
  };
}

// A prop read from the file: its own fields, with the edits applied. A value
// that wasn't stored stays unstored while it is the default (0).
function edited(p, pid, sid) {
  const src = thaw(p.jsfb.src);
  const out = { ...src };
  if ('prop_id' in src || pid !== 0) out.prop_id = pid;
  if ('state' in src || sid !== 0) out.state = sid;
  setVec(out, src, 'position', { x: p.x, y: -p.z, z: p.y });
  setVec(out, src, 'rotation', { x: p.rx, y: p.rz, z: p.ry });
  return out;
}

function setVec(out, src, key, want) {
  const had = src[key];
  const vec = {};
  for (const c of ['x', 'y', 'z']) {
    const old = had?.[c];
    if (old !== undefined && old === want[c]) vec[c] = old; // unchanged: the exact stored value, -0 included
    else if (old !== undefined || want[c] !== 0) vec[c] = f(r3(want[c]));
  }
  if (had || Object.keys(vec).length) out[key] = vec;
}

// An unrecognized .propsprofile line, converted like the intermediary would.
function fromProfileLine(line) {
  const parts = line.replace(/;\s*$/, '').split(',').map((s) => s.trim());
  const [pid, x, y, z, rx, ry, rz, sid] = parts.slice(1, 9).map(Number);
  if (parts[0] !== 'PROP' || [pid, x, y, z, rx, ry, rz, sid].some(Number.isNaN)) return null;
  return {
    prop_id: pid, unk1: NEW_PROP_HASH,
    position: { x: f(x), y: f(-z), z: f(y) },
    rotation: { x: f(rx), y: f(rz), z: f(ry) },
    scale: { x: 1, y: 1, z: 1 }, state: sid, unk6: [],
  };
}

// The scene -> .jsfb bytes. file: S.jsfb (the file it was opened from), or
// null for a new file. Props read from the file keep their order; new ones
// follow, then any unrecognized .propsprofile lines.
export function writePropSet({ props, unknownLines = [], file = null }) {
  const placed = [];
  const added = [];
  for (const p of props) {
    const pd = getProp(p.key);
    const sid = stateId(p.state);
    if (!pd || sid === undefined) continue;
    if (p.jsfb) placed.push([p.jsfb.i, edited(p, pd.prop_id, sid)]);
    else added.push(fresh(p, pd.prop_id, sid));
  }
  for (const k of file?.keep || []) placed.push([k.i, thaw(k.prop)]);
  placed.sort((a, b) => a[0] - b[0]);
  for (const line of unknownLines) {
    const p = fromProfileLine(line);
    if (p) added.push(p);
  }
  const list = [...placed.map(([, p]) => p), ...added];
  const doc = file ? { ...file.root } : { unk1: NEW_FILE_UNK1 };
  if (!file || file.hasProps || list.length) doc.props = list;
  return encode(doc);
}

// Props the designer kept but doesn't know, as .propsprofile lines (so a
// profile exported from an opened game file still has them).
export function keptProfileLines(file) {
  return (file?.keep || []).map(({ prop }) => {
    const p = thaw(prop), P = p.position || {}, R = p.rotation || {};
    const v = [P.x || 0, P.z || 0, -(P.y || 0) || 0, R.x || 0, R.z || 0, R.y || 0].map(pyFixed3);
    return `PROP,${p.prop_id ?? 0},${v.join(',')},${p.state ?? 0};`;
  });
}
