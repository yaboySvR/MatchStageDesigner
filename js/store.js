// Placed props: add/remove, rotation edits, undo/redo, and autosave to this
// browser.

import { S, emit } from './state.js';
import { getProp } from './catalog.js';
import { yawToRz } from './rotation.js';

const SAVE_KEY = 'ppg.scene';
const undoStack = [];
const redoStack = [];

export const byId = (id) => S.props.find((p) => p.id === id);
export const selectedProps = () => S.props.filter((p) => S.selected.has(p.id));

// Record fields (see state.js): world position x, y, z and the profile's own
// rotation rx, ry, rz. jsfb: what a prop read from a game file keeps for
// saving it back (propset.js); copies and new props never carry it.
export function addProp({ key, state, x, y, z, rx = 0, ry = 0, rz = 0 }, { jsfb = null } = {}) {
  const rec = { id: S.nextId++, key, state, x, y, z, rx, ry, rz };
  if (jsfb) rec.jsfb = jsfb;
  S.props.push(rec);
  return rec;
}

export const yawOf = (p) => -p.rz;

// Change only the yaw (Blender Euler Z), like the add-on's compass buttons and
// R tool: rx / ry stay exactly as they were.
export function setYawOf(p, yaw) {
  p.rz = yawToRz(yaw);
}

export function removeProps(ids) {
  const kill = new Set(ids);
  S.props = S.props.filter((p) => !kill.has(p.id));
  for (const id of kill) S.selected.delete(id);
  return kill.size;
}

// ---------------------------------------------------------------- undo / redo

export const snapshot = () => JSON.stringify({ props: S.props, unknown: S.unknownLines, jsfb: S.jsfb });

let lastTag = null;
let lastTagTime = 0;
let beforeEdit = null;

// Runs before every checkpoint (physics.js settles falling props there, so an
// edit never starts from, or records, a half-finished fall).
export const setBeforeEdit = (fn) => { beforeEdit = fn; };

// Call BEFORE mutating. Repeated calls with the same tag in quick succession
// (holding an arrow key, clicking rotate buttons) collapse into one undo step.
export function checkpoint(snap = null, tag = null) {
  beforeEdit?.();
  snap ??= snapshot();
  const now = performance.now();
  const merge = tag && tag === lastTag && now - lastTagTime < 800;
  lastTag = tag;
  lastTagTime = now;
  if (merge) return;
  undoStack.push(snap);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function restore(json) {
  const snap = JSON.parse(json);
  S.props = snap.props;
  S.unknownLines = snap.unknown || [];
  S.jsfb = snap.jsfb || null;
  S.nextId = S.props.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  for (const id of [...S.selected]) if (!byId(id)) S.selected.delete(id);
  changed();
}

// Put back a snapshot without touching the undo stacks (cancelled drag).
export function revert(snap) {
  restore(snap);
}

export function undo() {
  if (!undoStack.length) return false;
  lastTag = null;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  lastTag = null;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

// ---------------------------------------------------------------- change + autosave

let saveTimer = null;

export function changed() {
  emit('props');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

export function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 3, env: S.env, stage: S.stage, autoSnap: S.autoSnap, stacking: S.stacking, xray: S.xray,
      pivot: S.pivot, gizmo: S.gizmo, space: S.space, physics: S.physics, dropHeight: S.dropHeight,
      props: S.props, unknown: S.unknownLines, jsfb: S.jsfb,
    }));
  } catch { /* storage full or unavailable */ }
}

export function loadSaved() {
  try {
    const d = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!d || ![1, 2, 3].includes(d.v)) return false;
    Object.assign(S, {
      env: d.env ?? S.env, stage: !!d.stage, autoSnap: d.autoSnap ?? true,
      stacking: !!d.stacking, xray: !!d.xray, pivot: d.pivot === 'group' ? 'group' : 'each',
      gizmo: d.gizmo === 'rotate' ? 'rotate' : 'move', space: d.space === 'local' ? 'local' : 'world',
      physics: !!d.physics, dropHeight: Number.isFinite(d.dropHeight) ? d.dropHeight : S.dropHeight,
    });
    S.props = (d.props || [])
      .filter((p) => getProp(p.key)?.states[p.state] !== undefined)
      .map((p) => ({
        id: p.id, key: p.key, state: p.state, x: p.x, y: p.y, z: p.z,
        rx: p.rx || 0, ry: p.ry || 0,
        rz: d.v === 1 ? yawToRz(p.yaw || 0) : p.rz, // v1 stored yaw instead of rz
        ...(p.jsfb ? { jsfb: p.jsfb } : {}),
      }));
    S.unknownLines = d.unknown || [];
    S.jsfb = d.jsfb || null;
    S.nextId = S.props.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    return true;
  } catch {
    return false;
  }
}
