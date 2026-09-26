// Prop sets: a group of placed props saved exactly as it is, to place again
// anywhere. The group stays intact: each prop keeps its offset from the
// group's center, its height above the group's ground, and its rotation. Only
// the whole group moves: its center follows the cursor and its ground goes on
// the surface there. Turning and mirroring it are optional.

import { getProp } from './catalog.js';
import { snapZ } from './snapping.js';
import { rotateProfile, rotZ, mirrorX } from './rotation.js';

const STORE_KEY = 'ppg.sets';
const D2R = Math.PI / 180;
const TOL = 1.5; // a prop this close to a surface stands on it

export let sets = [];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const validItem = (it) => it && typeof it.key === 'string' && typeof it.state === 'string'
  && ['dx', 'dy', 'dz', 'rx', 'ry', 'rz'].every((k) => finite(it[k]));
const validSet = (s) => s && typeof s.id === 'string' && typeof s.name === 'string'
  && Array.isArray(s.items) && s.items.length > 0 && s.items.every(validItem);

// Sets saved before v2 measured dz from their lowest prop and noted how each
// prop rested ('s' on a surface, 'f' lifted `lift` above it, or the index of
// the prop it stood on). Their ground is the lowest surface that implies.
function upgrade(set) {
  if (set.v === 2) return set;
  const grounds = set.items.flatMap((it) => {
    if (it.rest === 's') return [it.dz];
    if (it.rest === 'f') return [it.dz - Math.max(0, it.lift || 0)];
    return [];
  });
  const g = grounds.length ? Math.min(...grounds) : 0;
  return { ...set, v: 2, items: set.items.map(({ rest, lift, ...it }) => ({ ...it, dz: it.dz - g })) };
}

export function loadSets() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    const valid = Array.isArray(d) ? d.filter(validSet) : [];
    sets = valid.map(upgrade);
    if (sets.some((s, i) => s !== valid[i])) persist();
  } catch {
    sets = [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sets));
    return true;
  } catch {
    return false;
  }
}

const newId = () => `set-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function defaultName(props) {
  const counts = new Map();
  for (const p of props) counts.set(p.key, (counts.get(p.key) || 0) + 1);
  return [...counts].map(([k, n]) => `${n > 1 ? `${n} × ` : ''}${getProp(k)?.name || k}`).join(' + ');
}

// The height the group stands on: the lowest surface under its props (the
// group itself ignored). A surface above a prop's origin isn't under it (the
// ring's box reaches over the floor by the steps), so that prop counts as
// standing on the floor.
function groundOf(props) {
  const exclude = new Set(props.map((p) => p.id));
  return Math.min(...props.map((p) => {
    const s = snapZ(p.x, p.y, exclude);
    return p.z >= s - TOL ? s : 0;
  }));
}

// Turn the selection into a set (not stored yet), exactly as it is.
export function captureSet(props, name) {
  const n = props.length;
  const ax = props.reduce((s, p) => s + p.x, 0) / n;
  const ay = props.reduce((s, p) => s + p.y, 0) / n;
  const ground = groundOf(props);
  const items = props.map((p) => ({
    key: p.key, state: p.state, dx: p.x - ax, dy: p.y - ay, dz: p.z - ground, rx: p.rx, ry: p.ry, rz: p.rz,
  }));
  return { id: newId(), v: 2, name: name || defaultName(props), created: Date.now(), items, thumb: null };
}

// World placements for `set` with its center at (x, y) and its ground at
// groundZ, turned by yaw degrees (counter-clockwise from above) and optionally
// mirrored. Unturned and unmirrored, every prop keeps its exact rotation
// numbers. Props whose type no longer exists are left out.
export function placeSet(set, x, y, groundZ, yaw = 0, mirror = false) {
  const c = Math.cos(yaw * D2R), s = Math.sin(yaw * D2R);
  const D = rotZ(yaw);
  const turned = yaw % 360 !== 0;
  return set.items
    .filter((it) => getProp(it.key)?.states[it.state] !== undefined)
    .map((it) => {
      const dx = mirror ? -it.dx : it.dx;
      let rot = [it.rx, it.ry, it.rz];
      if (mirror) rot = mirrorX(...rot); // left-right in the set's own frame
      if (turned) rot = rotateProfile(...rot, D, yaw);
      return {
        key: it.key, state: it.state,
        x: x + dx * c - it.dy * s, y: y + dx * s + it.dy * c, z: groundZ + it.dz,
        rx: rot[0], ry: rot[1], rz: rot[2],
      };
    });
}

// ---------------------------------------------------------------- library

export function addSet(set) {
  sets.unshift(set);
  if (persist()) return true;
  sets.shift();
  return false;
}

export function renameSet(id, name) {
  const s = sets.find((x) => x.id === id);
  if (!s || !name.trim()) return;
  s.name = name.trim();
  persist();
}

// Returns a function that puts the set back (for undo).
export function removeSet(id) {
  const i = sets.findIndex((x) => x.id === id);
  if (i < 0) return () => {};
  const [removed] = sets.splice(i, 1);
  persist();
  return () => {
    sets.splice(Math.min(i, sets.length), 0, removed);
    persist();
  };
}

export const getSet = (id) => sets.find((x) => x.id === id);

export function exportSets() {
  return JSON.stringify({ type: 'ppg-sets', v: 1, sets }, null, 1);
}

// Merge sets from an exported file. Returns { added, skipped }.
export function importSets(text) {
  const d = JSON.parse(text);
  const list = d?.type === 'ppg-sets' && Array.isArray(d.sets) ? d.sets : null;
  if (!list) throw new Error('Not a prop sets file');
  let added = 0, skipped = 0;
  for (const s of list) {
    if (!validSet(s) || sets.some((x) => x.id === s.id)) { skipped++; continue; }
    sets.push(upgrade({ id: s.id, v: s.v, name: s.name, created: s.created || Date.now(), items: s.items, thumb: typeof s.thumb === 'string' ? s.thumb : null }));
    added++;
  }
  if (added && !persist()) throw new Error('Browser storage is full');
  return { added, skipped };
}

// ---------------------------------------------------------------- share codes

// A set as one line of text to paste somewhere else: only its name and props
// (no id, dates or picture), packed with deflate into URL-safe base64 after a
// tag. Numbers keep 3 decimals, like a profile.
export const CODE_TAG = 'PSD-SET1:';
const CODE_RE = /PSD-SET1:([A-Za-z0-9_-]+)/;
const MAX_ITEMS = 1000;
const MAX_JSON = 4 << 20; // a code never unpacks to more than this

const r3 = (v) => Math.round(v * 1000) / 1000 || 0; // (|| 0: no -0)
const packItems = (items) => items.map((it) => [it.key, it.state, r3(it.dx), r3(it.dy), r3(it.dz), r3(it.rx), r3(it.ry), r3(it.rz)]);

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fromBase64Url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function deflate(text) {
  const out = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON) {
      reader.cancel();
      throw new Error('too big');
    }
    parts.push(value);
  }
  return new Blob(parts).text();
}

export async function setToCode(set) {
  if (typeof CompressionStream !== 'function') throw new Error('this browser can’t make share codes');
  return CODE_TAG + toBase64Url(await deflate(JSON.stringify({ n: set.name, i: packItems(set.items) })));
}

// The set in a pasted text (the code alone, or a message with one in it): not
// stored yet, and without a picture. Throws when there is none, or it's damaged.
export async function setFromCode(text) {
  const m = CODE_RE.exec(String(text));
  if (!m) throw new Error('That isn’t a set code (they start with PSD-SET1:)');
  let d;
  try {
    d = JSON.parse(await inflate(fromBase64Url(m[1])));
  } catch {
    throw new Error('This set code is incomplete or damaged');
  }
  const rows = Array.isArray(d?.i) ? d.i.slice(0, MAX_ITEMS) : [];
  const items = rows
    .filter((row) => Array.isArray(row) && row.length === 8)
    .map(([key, state, dx, dy, dz, rx, ry, rz]) => ({ key, state, dx, dy, dz, rx, ry, rz }))
    .filter(validItem);
  if (!items.length) throw new Error('This set code has no props in it');
  const name = typeof d.n === 'string' && d.n.trim() ? d.n.trim().slice(0, 60) : defaultName(items);
  return { id: newId(), v: 2, name, created: Date.now(), items, thumb: null };
}

// A set in the library with the same props (to 3 decimals), if there is one.
export function sameSet(set) {
  const key = JSON.stringify(packItems(set.items));
  return sets.find((s) => JSON.stringify(packItems(s.items)) === key) || null;
}
