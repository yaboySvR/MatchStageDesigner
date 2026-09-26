// Viewport interaction: placing (port of line_tool.py), selecting, moving and
// rotating props, keyboard nudges, duplicate / delete, undo, and the Q wheel.
//
// Moving:   drag a prop, the move gizmo (W), arrow keys, the X / Y / Z fields,
//           or G (Blender style).
// Rotating: the rotate gizmo (E) on any axis or free, [ and ] keys, the dial,
//           the RX / RY / RZ fields, or R.
// Physics:  P makes placing drop props from above the cursor; End drops the
//           selection (physics.js runs the simulation).
// Walking:  Shift+` starts Blender-style walk navigation (walk.js), which has
//           the mouse and keyboard to itself until it ends.

import { S, emit, on, ENVIRONMENTS } from './state.js';
import * as V from './viewport.js';
import * as store from './store.js';
import * as P from './physics.js';
import * as W from './walk.js';
import { snapZ } from './snapping.js';
import { getGeometry, geomNow, spanAlong, heightOf, footprintOf } from './geometry.js';
import { getProp } from './catalog.js';
import { placeSet } from './sets.js';
import { yawToRz, rotZ, quatToMatrix, axisAngleMatrix, rotateProfile, apply } from './rotation.js';
import * as G from './gizmo.js';
import { openWheel, wheelOpen, wheelMove, wheelConfirm, wheelCancel } from './wheel.js';
import { toast } from './toast.js';

const MAX_LINE = 300;
const STACK_PX = 50;   // screen pixels of upward drag per stacked level
const NUDGE = 5;       // arrow key step (Shift ×5, Alt ×0.2)
const ROT_STEP = 15;   // rotation snap, and [ ] step (Shift 90, Alt 1)
const GRID = 10;       // Ctrl while moving snaps to this grid

const mouse = { x: 0, y: 0, over: false, shift: false, ctrl: false };
const add = { first: null, firstScreenY: 0, extra: 0, placements: [] };
let op = null;     // active drag-the-prop move, or G / R
let gdrag = null;  // active gizmo drag
let press = null;  // pointer down in select mode that is not a drag yet
let canvas, viewportEl, hudEl, marqueeEl, coordsEl;

const norm360 = (a) => ((a % 360) + 360) % 360;
const norm180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const inXY = (b, x, y) => !!b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
export const facingOf = (p) => norm360(store.yawOf(p));

// ---------------------------------------------------------------- modes

function setMode(mode) {
  S.mode = mode;
  viewportEl.classList.remove('mode-select', 'mode-add', 'mode-move', 'mode-rotate');
  viewportEl.classList.add(`mode-${mode}`);
  emit('mode');
  refreshGizmo();
  updateHud();
}

export function setGizmoMode(mode) {
  S.gizmo = mode;
  store.save();
  refreshGizmo();
  updateHud();
  emit('gizmo');
}

export function setGizmoSpace(space) {
  S.space = space;
  store.save();
  refreshGizmo();
  emit('gizmo');
}

export function enterAdd(key, state) {
  if (op) finishOp(false);
  const pd = getProp(key);
  if (!pd) return;
  if (S.addKey !== key) S.placeYaw = 0;
  S.addSet = null;
  S.addKey = key;
  S.addState = state && state in pd.states ? state : pd.defaultState;
  add.first = null;
  add.extra = 0;
  setHover(null);
  setMode('add');
  getGeometry(key, S.addState).then(
    () => { if (S.mode === 'add') refreshAdd(); },
    (e) => toast(`Could not load model: ${e.message}`, { error: true }),
  );
  refreshAdd();
}

export function exitAdd() {
  add.first = null;
  add.placements = [];
  S.addKey = null;
  S.addState = null;
  S.addSet = null;
  V.setGhosts([]);
  V.setDropGuides([]);
  setMode('select');
}

// Place copies of a prop set: the whole group follows the cursor.
export function enterSetPlacement(set) {
  if (op) finishOp(false);
  if (S.addSet?.id !== set.id) { S.placeYaw = 0; S.placeMirror = false; }
  S.addSet = set;
  S.addKey = null;
  S.addState = null;
  add.first = null;
  setHover(null);
  setMode('add');
  const refresh = () => { if (S.mode === 'add' && S.addSet === set) refreshAdd(); };
  for (const it of set.items) getGeometry(it.key, it.state).then(refresh, () => {});
  refreshAdd();
}

export function toggleMirror() {
  if (!S.addSet) return;
  S.placeMirror = !S.placeMirror;
  refreshAdd();
}

// ---------------------------------------------------------------- placing

// Mouse -> point on the snap surface. Project onto Z=0 like the add-on, then
// re-project onto the snapped height so raised surfaces (ring, roofs) land
// under the cursor instead of offset by perspective. With physics on, the
// point is whatever surface is really under the cursor (a table top, a step).
// `plane` is the height (x, y) was found at; lines are dragged on it.
function groundPoint(cx, cy) {
  if (S.physics && P.ready()) {
    const hit = P.surfaceOnRay(V.mouseRay(cx, cy));
    if (hit) return { ...hit, plane: hit.z };
  }
  const p = V.rayToPlaneZ(cx, cy, 0);
  if (!p) return null;
  if (!S.autoSnap) return { x: p.x, y: p.y, z: 0, plane: 0 };
  const z = snapZ(p.x, p.y);
  if (z !== 0) {
    const p2 = V.rayToPlaneZ(cx, cy, z);
    if (p2 && Math.abs(snapZ(p2.x, p2.y) - z) < 1e-6) return { x: p2.x, y: p2.y, z, plane: z };
  }
  return { x: p.x, y: p.y, z, plane: 0 };
}

const snapOrZero = (x, y) => (S.autoSnap ? snapZ(x, y) : 0);

// Where a set's ground goes: the surface under the cursor. One found by the
// physics ray (the ring mat's mesh is 106.7 high) is evened to the snap
// height it is at, so a set placed on the ring gets the same numbers.
function setGround(p) {
  if (!S.autoSnap) return p.z;
  const s = snapZ(p.x, p.y);
  return Math.abs(p.z - s) <= 1.5 ? s : p.z;
}

// Physics drops single props, lines and stacks; a set is always placed
// exactly as it was saved.
const dropping = () => S.physics && !S.addSet;

function computePlacements() {
  if (S.addSet) {
    if (!mouse.over) return [];
    const p = groundPoint(mouse.x, mouse.y);
    return p ? placeSet(S.addSet, p.x, p.y, setGround(p), S.placeYaw, S.placeMirror) : [];
  }
  const geom = geomNow(S.addKey, S.addState);
  if (!geom) return [];
  const f = add.first;
  if (!f) {
    if (!mouse.over) return [];
    const p = groundPoint(mouse.x, mouse.y);
    return p ? [{ x: p.x, y: p.y, z: p.z }] : [];
  }

  if (S.stacking) {
    const count = Math.min(MAX_LINE, Math.floor(Math.max(0, add.firstScreenY - mouse.y) / STACK_PX));
    const step = heightOf(geom) + add.extra;
    return Array.from({ length: count + 1 }, (_, i) => ({ x: f.x, y: f.y, z: f.z + i * step }));
  }

  const first = { x: f.x, y: f.y, z: f.z };
  const cur = V.rayToPlaneZ(mouse.x, mouse.y, f.plane);
  if (!cur) return [first];
  const dx = cur.x - f.x, dy = cur.y - f.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return [first];
  let a = Math.atan2(dy, dx);
  if (mouse.shift) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
  const ux = Math.cos(a), uy = Math.sin(a);
  // Mesh extent along the line, measured in the prop's own (rotated) frame.
  const t = (S.placeYaw * Math.PI) / 180;
  const spacing = spanAlong(geom, ux * Math.cos(t) + uy * Math.sin(t), -ux * Math.sin(t) + uy * Math.cos(t)) + add.extra;
  const count = Math.min(MAX_LINE, Math.floor(dist / spacing));
  const out = [first];
  for (let i = 1; i <= count; i++) {
    const x = f.x + ux * i * spacing, y = f.y + uy * i * spacing;
    out.push({ x, y, z: snapOrZero(x, y) });
  }
  return out;
}

// The current placements as full prop records.
function placementItems() {
  if (S.addSet) return add.placements;
  const rz = yawToRz(S.placeYaw);
  return add.placements.map((p) => ({ key: S.addKey, state: S.addState, ...p, rx: 0, ry: 0, rz }));
}

// With physics on, the ghosts hang above the cursor with a guide down to
// where they'll fall. Hidden while walking (the cursor is too).
function refreshAdd() {
  if (S.mode !== 'add' || W.walking()) return;
  add.placements = computePlacements();
  let items = placementItems();
  if (dropping()) items = P.planDrop(items, S.dropHeight);
  V.setGhosts(items.map((p) => ({ geom: geomNow(p.key, p.state), ...p })).filter((g) => g.geom));
  V.setDropGuides(dropping() ? items : []);
  updateHud();
}

function placeNow() {
  const items = placementItems();
  const tumble = mouse.shift && items.length === 1;
  add.first = null;
  if (items.length && dropping()) {
    loadPhysics().then(() => dropPlaced(items, tumble), () => putDown(items));
  } else if (items.length) {
    putDown(items);
  }
  refreshAdd();
}

// Place exactly where the ghosts are.
function putDown(items) {
  store.checkpoint();
  S.selected = new Set(items.map((p) => store.addProp(p).id));
  store.changed();
  emit('selection');
  refreshAdd();
}

// Physics: start the props above the spot and let them fall.
function dropPlaced(items, tumble) {
  const added = P.drop(P.planDrop(items, S.dropHeight), { spin: tumble });
  S.selected = new Set(added.map((p) => p.id));
  selectionChanged();
  refreshAdd();
}

export function rotatePlacement(delta) {
  S.placeYaw = norm360(S.placeYaw + delta);
  refreshAdd();
}

// ---------------------------------------------------------------- physics

let physicsLoading = null;

// The physics engine downloads on first use; say so while it does.
function loadPhysics() {
  if (P.ready()) return Promise.resolve();
  if (!physicsLoading) {
    const note = toast('Loading physics…', { ms: 60000 });
    physicsLoading = P.load().then(() => {
      note.remove();
      physicsLoading = null;
      refreshAdd();
    }, (e) => {
      note.remove();
      physicsLoading = null;
      toast(`Could not load physics: ${e.message}`, { error: true });
      if (S.physics) setPhysics(false);
      throw e;
    });
  }
  return physicsLoading;
}

export function setPhysics(on) {
  S.physics = on;
  store.save();
  emit('physics');
  if (on) loadPhysics().catch(() => {});
  refreshAdd();
  updateHud();
}

// Download the engine ahead of time if physics was left on last session.
export function preloadPhysics() {
  if (S.physics) P.load().then(refreshAdd, () => {});
}

// Let the selection fall from where it is until it comes to rest (End).
export function dropSelected() {
  if (!S.selected.size || op || gdrag) return;
  loadPhysics().then(() => {
    if (op || gdrag) return;
    P.dropExisting(store.selectedProps());
    updateHud();
  }, () => {});
}

function changeDropHeight(delta) {
  S.dropHeight = Math.min(1000, Math.max(0, Math.round(S.dropHeight + delta)));
  store.save();
  refreshAdd();
}

// ---------------------------------------------------------------- shared transform helpers

// Items remember where each prop started. With auto snapping, a prop resting
// on a surface re-snaps as it moves, a prop stacked on another moving prop
// rides along with it, and anything else keeps its height above the surface.
function makeItems(props) {
  const exclude = new Set(props.map((p) => p.id));
  const items = props.map((p) => ({
    p, sx: p.x, sy: p.y, sz: p.z, srx: p.rx, sry: p.ry, srz: p.rz, syaw: store.yawOf(p), box: V.propBox(p.id),
  }));
  for (const it of items) {
    const surface = S.autoSnap ? snapZ(it.sx, it.sy, exclude) : 0;
    it.resting = Math.abs(surface - it.sz) < 0.05;
    it.lift = it.resting ? 0 : it.sz - surface;
  }
  for (const it of items) {
    if (!it.resting) it.support = items.find((o) => o !== it && o.resting && inXY(o.box, it.sx, it.sy)) || null;
  }
  return { items, exclude };
}

// fn moves one item (sets p.x / p.y, may set it.nz for a new base height);
// then Z is resolved. dz lifts everything (gizmo Z arrow, Z field).
function placeItems({ items, exclude }, fn, dz = 0) {
  for (const it of items) {
    it.nz = undefined;
    fn(it);
  }
  for (const it of items) {
    const base = it.nz ?? it.sz;
    if (!S.autoSnap) it.p.z = base + dz;
    else if (!it.support) it.p.z = snapZ(it.p.x, it.p.y, exclude) + it.lift + (base - it.sz) + dz;
  }
  if (!S.autoSnap) return;
  for (const it of items) {
    if (it.support) it.p.z = it.sz + (it.support.p.z - it.support.sz);
  }
}

function pivotOf(props) {
  const n = props.length;
  return {
    x: props.reduce((s, p) => s + p.x, 0) / n,
    y: props.reduce((s, p) => s + p.y, 0) / n,
    z: n === 1 ? props[0].z : Math.min(...props.map((p) => p.z)),
  };
}

const groupPivot = (n) => n > 1 && S.pivot === 'group';

// Rotate every item by D (world-space 3x3), each around its own origin or,
// with "Around center", around the pivot. zTurn: D is a turn of that many
// degrees around world Z (lets yaw-only props keep exact numbers).
function applyRotation(set, D, pivot, zTurn = null) {
  const orbit = groupPivot(set.items.length);
  placeItems(set, (it) => {
    [it.p.rx, it.p.ry, it.p.rz] = rotateProfile(it.srx, it.sry, it.srz, D, zTurn);
    if (orbit) {
      const [vx, vy, vz] = apply(D, [it.sx - pivot.x, it.sy - pivot.y, it.sz - pivot.z]);
      it.p.x = pivot.x + vx;
      it.p.y = pivot.y + vy;
      it.nz = pivot.z + vz;
    }
  });
}

function applyMove(set, dx, dy, dz = 0) {
  placeItems(set, (it) => { it.p.x = it.sx + dx; it.p.y = it.sy + dy; }, dz);
}

function transformed() {
  V.syncProps();
  refreshGizmo();
  emit('transform');
  updateHud();
}

// ---------------------------------------------------------------- one-shot edits (buttons, keys, fields)

// Turn the selection around world Z by delta degrees (CCW seen from above).
export function rotateBy(delta) {
  const props = store.selectedProps();
  if (!props.length || op || gdrag) return;
  store.checkpoint(undefined, 'rotate');
  applyRotation(makeItems(props), rotZ(delta), pivotOf(props), delta);
  store.changed();
  transformed();
}

// Set every selected prop's facing (the add-on's Euler Z) to the same angle.
export function setFacing(yaw, { record = true } = {}) {
  const props = store.selectedProps();
  if (!props.length) return;
  if (record) store.checkpoint(undefined, 'facing');
  for (const p of props) store.setYawOf(p, yaw);
  store.changed();
  transformed();
}

// Clear RX / RY so the selection stands upright again (facing kept).
export function levelSelection() {
  const props = store.selectedProps();
  if (!props.length) return;
  store.checkpoint();
  for (const p of props) { p.rx = 0; p.ry = 0; }
  store.changed();
  transformed();
}

export function moveBy(dx, dy, dz = 0, { record = true, tag = 'nudge' } = {}) {
  const props = store.selectedProps();
  if (!props.length || op || gdrag) return;
  if (record) store.checkpoint(undefined, tag);
  applyMove(makeItems(props), dx, dy, dz);
  store.changed();
  transformed();
}

// Raw profile rotation value. Only for a single prop.
export function setRawRotation(p, field, value, { record = true } = {}) {
  if (record) store.checkpoint(undefined, `raw-${field}`);
  p[field] = value;
  store.changed();
  transformed();
}

function nudge(key, e) {
  const step = NUDGE * (e.shiftKey ? 5 : e.altKey ? 0.2 : 1);
  const { forward, right } = V.viewAxes();
  const dir = { ArrowUp: forward, ArrowDown: [-forward[0], -forward[1]], ArrowRight: right, ArrowLeft: [-right[0], -right[1]] }[key];
  if (dir) moveBy(dir[0] * step, dir[1] * step);
  else moveBy(0, 0, key === 'PageUp' ? step : -step);
}

// ---------------------------------------------------------------- gizmo drags

const readout = () => document.getElementById('gizmo-readout');

function startGizmoDrag(h, e) {
  P.settleNow();
  const props = store.selectedProps();
  if (!props.length || !G.begin(h, e.clientX, e.clientY)) return false;
  gdrag = { name: h.name, snap0: store.snapshot(), set: makeItems(props), pivot: pivotOf(props), result: null, angle: null };
  V.controls.enabled = false;
  setHover(null);
  canvas.style.cursor = 'grabbing';
  try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  updateHud();
  V.requestRender();
  return true;
}

function updateGizmoDrag() {
  const r = G.dragTo(mouse.x, mouse.y, { ctrl: mouse.ctrl, grid: GRID });
  if (!r) return;
  gdrag.result = r;
  if (r.kind === 'move') {
    applyMove(gdrag.set, ...r.delta);
  } else if (r.axis) {
    let angle = r.angle;
    if (!mouse.shift) {
      // One upright prop turning around Z lands on round facing angles;
      // anything else turns in round steps.
      const lead = gdrag.set.items[0];
      angle = r.worldZ && gdrag.set.items.length === 1 && Math.abs(lead.sry) < 1e-9
        ? Math.round((lead.syaw + angle) / ROT_STEP) * ROT_STEP - lead.syaw
        : Math.round(angle / ROT_STEP) * ROT_STEP;
    }
    gdrag.angle = angle;
    G.setSweep(angle);
    applyRotation(gdrag.set, axisAngleMatrix(r.axis, angle), gdrag.pivot, r.worldZ ? angle : null);
  } else {
    applyRotation(gdrag.set, quatToMatrix(...r.quaternion), gdrag.pivot, null);
  }
  V.syncProps();
  emit('transform');
  updateHud();
  showReadout();
}

function showReadout() {
  const el = readout();
  const r = gdrag?.result;
  if (!el || !r) return;
  const axis = gdrag.name.slice(-1).toUpperCase();
  let text;
  if (r.kind === 'move') {
    text = r.along === 'xy'
      ? `X ${signed(r.delta[0])}  Y ${signed(r.delta[1])}`
      : `${axis} ${signed(r.amount)}`;
  } else if (r.axis) {
    const one = gdrag.set.items.length === 1 && r.worldZ ? `  →  ${facingOf(gdrag.set.items[0].p).toFixed(0)}°` : '';
    text = `${axis}  ${signed(gdrag.angle, 0)}°${one}`;
  } else {
    text = 'Free rotate';
  }
  const host = viewportEl.getBoundingClientRect();
  el.textContent = text;
  el.className = /^[tr][xyz]$/.test(gdrag.name) ? `readout axis-${gdrag.name[1]}` : 'readout';
  el.style.left = `${mouse.x - host.left + 16}px`;
  el.style.top = `${mouse.y - host.top - 34}px`;
  el.hidden = false;
}

function endGizmoDrag(commit) {
  const g = gdrag;
  if (!g) return;
  gdrag = null;
  G.end();
  V.controls.enabled = true;
  if (readout()) readout().hidden = true;
  if (commit) {
    if (store.snapshot() !== g.snap0) {
      store.checkpoint(g.snap0);
      store.changed();
    }
  } else {
    store.revert(g.snap0);
    V.syncProps();
  }
  refreshGizmo();
  emit('transform');
  updateHud();
  updateHover();
  V.requestRender();
}

// ---------------------------------------------------------------- drag-the-prop / G / R

function beginOp(o) {
  o.prevMode = S.mode === 'add' ? 'add' : 'select';
  o.snap0 = store.snapshot();
  op = o;
  press = null;
  V.setGhosts([]);
  V.controls.enabled = false;
  setHover(null);
  setMode(o.type);
}

// via: 'drag' (confirm on release) or 'key' (G; confirm on click / Enter)
function startMove(via, refId = null) {
  P.settleNow();
  const props = store.selectedProps();
  if (!props.length || op) return;
  const ref = (refId != null && store.byId(refId)) || props[0];
  const start = V.rayToPlaneZ(mouse.x, mouse.y, ref.z);
  if (!start) return;
  beginOp({ type: 'move', via, ref, rsx: ref.x, rsy: ref.y, refZ: ref.z, start, set: makeItems(props), axisKey: null, dx: 0, dy: 0 });
}

function updateMove() {
  const cur = V.rayToPlaneZ(mouse.x, mouse.y, op.refZ);
  if (!cur) return;
  let dx = cur.x - op.start.x, dy = cur.y - op.start.y;
  const axis = op.axisKey || (mouse.shift ? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y') : null);
  if (axis === 'x') dy = 0;
  if (axis === 'y') dx = 0;
  if (mouse.ctrl) {
    if (axis !== 'y') dx = Math.round((op.rsx + dx) / GRID) * GRID - op.rsx;
    if (axis !== 'x') dy = Math.round((op.rsy + dy) / GRID) * GRID - op.rsy;
  }
  op.axis = axis;
  op.dx = dx; op.dy = dy;
  applyMove(op.set, dx, dy);
  transformed();
}

// R: turn around world Z by the pointer's angle around the selection on screen.
function startRotate() {
  P.settleNow();
  const props = store.selectedProps();
  if (!props.length || op) return;
  const pivot = pivotOf(props);
  const center = V.projectToScreen(pivot.x, pivot.y, pivot.z);
  if (!center) return;
  const o = { type: 'rotate', via: 'key', pivot, center, set: makeItems(props), delta: 0, raw: 0 };
  o.last = screenAngle(o);
  beginOp(o);
}

const screenAngle = (o) => (Math.atan2(-(mouse.y - o.center.y), mouse.x - o.center.x) * 180) / Math.PI;

function updateRotate() {
  const a = screenAngle(op);
  op.raw += norm180(a - op.last); // unwrapped: can go past 180
  op.last = a;
  let delta = op.raw;
  if (!mouse.shift) {
    const lead = op.set.items[0];
    // One prop / each in place: land on round facing angles. Group: round steps.
    delta = groupPivot(op.set.items.length)
      ? Math.round(delta / ROT_STEP) * ROT_STEP
      : Math.round((lead.syaw + delta) / ROT_STEP) * ROT_STEP - lead.syaw;
  }
  op.delta = delta;
  applyRotation(op.set, rotZ(delta), op.pivot, delta);
  transformed();
}

function finishOp(commit) {
  const o = op;
  if (!o) return;
  op = null;
  V.controls.enabled = true;
  if (commit) {
    if (store.snapshot() !== o.snap0) {
      store.checkpoint(o.snap0);
      store.changed();
    }
  } else {
    store.revert(o.snap0);
    V.syncProps();
  }
  setMode(o.prevMode);
  emit('transform');
  if (S.mode === 'add') refreshAdd();
}

// ---------------------------------------------------------------- selection + edit ops

function selectionChanged() {
  V.syncProps();
  refreshGizmo();
  emit('selection');
  updateHud();
}

export function selectOnly(ids) {
  S.selected = new Set(ids);
  selectionChanged();
}

export function deleteSelected() {
  if (!S.selected.size || op || gdrag) return;
  store.checkpoint();
  const n = store.removeProps([...S.selected]);
  store.changed();
  selectionChanged();
  toast(`Deleted ${n} prop${n === 1 ? '' : 's'} · Ctrl+Z to undo`);
}

// Copies land next to the originals (to the right on screen), selected.
export function duplicateSelected() {
  P.settleNow();
  const props = store.selectedProps();
  if (!props.length || op || gdrag) return;
  const boxes = props.map((p) => V.propBox(p.id)).filter(Boolean);
  const { right } = V.viewAxes();
  const width = boxes.length
    ? (right[0] ? Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX))
      : Math.max(...boxes.map((b) => b.maxY)) - Math.min(...boxes.map((b) => b.minY)))
    : 40;
  const gap = 10;
  store.checkpoint();
  const copies = props.map((p) => store.addProp({ ...p }));
  S.selected = new Set(copies.map((c) => c.id));
  store.changed();
  V.syncProps();
  applyMove(makeItems(copies), right[0] * (width + gap), right[1] * (width + gap));
  store.changed();
  selectionChanged();
}

// Undo during a physics fall cancels the fall.
export function doUndo() {
  if (op || gdrag) return;
  if (P.cancel()) toast('Drop undone');
  else if (!store.undo()) toast('Nothing to undo');
  selectionChanged();
}

export function doRedo() {
  if (op || gdrag) return;
  P.cancel();
  if (!store.redo()) toast('Nothing to redo');
  selectionChanged();
}

export function frameSelectionOrAll(all = false) {
  V.frameProps(all || !S.selected.size ? S.props.map((p) => p.id) : [...S.selected]);
}

// Walk navigation (Shift+` or the toolbar), unless something else has the
// mouse right now.
export function beginWalk() {
  if (op || gdrag || press || add.first || wheelOpen() || W.walking()) return;
  W.startWalk();
}

function walkChanged() {
  if (W.walking()) {
    V.setGhosts([]);
    V.setDropGuides([]);
    setHover(null);
    if (G.setHovered(null)) V.requestRender();
  } else {
    coordsEl.textContent = 'X — Y — Z —';
    updateCoords();
    refreshAdd();
  }
  updateHud();
}

function openWheelHere() {
  const r = viewportEl.getBoundingClientRect();
  const x = mouse.over ? mouse.x : r.left + r.width / 2;
  const y = mouse.over ? mouse.y : r.top + r.height / 2;
  if (openWheel(x, y, (key, state) => enterAdd(key, state))) {
    wheelMove(x, y);
    V.setGhosts([]);
  }
}

// ---------------------------------------------------------------- gizmo placement + hover

export function refreshGizmo() {
  if (gdrag) return;
  const props = store.selectedProps();
  if (!props.length || S.mode === 'add' || op) {
    G.setTarget(null);
    V.requestRender();
    return;
  }
  const pivot = pivotOf(props);
  const local = S.space === 'local' && props.length === 1;
  G.setTarget(
    { ...pivot, quaternion: local ? V.quatOf(props[0].rx, props[0].ry, props[0].rz) : null },
    { mode: S.gizmo === 'rotate' ? 'rotate' : 'move' },
  );
  V.requestRender();
}

let hoverId = null;
function setHover(id) {
  hoverId = id;
  V.setHover(id);
}

function updateHover() {
  if (S.mode !== 'select' || press || op || gdrag) return;
  const h = G.hit(mouse.x, mouse.y);
  if (G.setHovered(h ? h.name : null)) V.requestRender();
  if (h) {
    setHover(null);
    canvas.style.cursor = 'grab';
    return;
  }
  const id = V.pickProp(mouse.x, mouse.y);
  setHover(id);
  canvas.style.cursor = id == null ? '' : S.selected.has(id) ? 'move' : 'pointer';
}

// ---------------------------------------------------------------- HUD / status

const kbd = (k) => `<kbd>${k}</kbd>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const signed = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

function updateHud() {
  hudEl.classList.toggle('walk', W.walking());
  if (W.walking()) {
    hudEl.hidden = false;
    hudEl.innerHTML = W.hudHtml();
    return;
  }
  let html = '';
  const verb = dropping() ? 'drop' : 'place';
  const height = dropping() ? ` · ${kbd('↑')} ${kbd('↓')} drop height <b>${S.dropHeight}</b>` : '';
  if (S.mode === 'add' && S.addSet) {
    const mirror = S.placeMirror ? ' · <b>mirrored</b>' : '';
    html = `<b>${esc(S.addSet.name.toUpperCase())}</b> (${S.addSet.items.length} props) · Click to ${verb} a copy${height} · ${kbd('[')} ${kbd(']')} rotate <b>${S.placeYaw.toFixed(0)}°</b> · ${kbd('M')} mirror${mirror} · ${kbd('Esc')} done`;
  } else if (S.mode === 'add' && S.addKey) {
    const pd = getProp(S.addKey);
    let name = `<b>${esc(pd.name.toUpperCase())}</b>`;
    if (S.addState !== 'Default' && pd.stateOrder.length > 1) name += ` (${esc(S.addState)})`;
    const count = add.first ? ` × ${add.placements.length}` : '';
    const drag = S.stacking ? 'drag ↑ to stack' : `drag for a line (${kbd('Shift')} 45°)`;
    const spacing = add.first ? ` · wheel: spacing${add.extra > 0 ? ` +${add.extra.toFixed(0)}` : ''}` : '';
    const tumble = S.physics && !add.first ? ` · ${kbd('Shift')}+click tumble` : '';
    html = `${name}${count} · Click to ${verb}, ${drag}${spacing}${height}${tumble} · ${kbd('[')} ${kbd(']')} rotate <b>${S.placeYaw.toFixed(0)}°</b> · ${kbd('Esc')} done`;
  } else if (gdrag && gdrag.name.startsWith('t') || gdrag?.name === 'xy') {
    html = `<b>MOVE</b> · ${kbd('Ctrl')} snap to a ${GRID} grid · release to drop · ${kbd('Esc')} cancel`;
  } else if (gdrag) {
    html = gdrag.name === 'free'
      ? `<b>FREE ROTATE</b> · drag in any direction to tumble the prop · ${kbd('Esc')} cancel`
      : `<b>ROTATE</b> · ${ROT_STEP}° steps, ${kbd('Shift')} for free · release to finish · ${kbd('Esc')} cancel`;
  } else if (op?.type === 'move') {
    const lock = op.axis ? `locked to ${op.axis.toUpperCase()}` : `${kbd('Shift')} lock axis`;
    const finish = op.via === 'drag' ? 'release to drop' : 'click to drop';
    html = `<b>MOVE</b> ${signed(op.dx)}, ${signed(op.dy)} · ${lock} · ${kbd('Ctrl')} grid ${GRID} · ${finish} · ${kbd('Esc')} cancel`;
  } else if (op?.type === 'rotate') {
    const one = op.set.items.length === 1 ? ` → <b>${facingOf(op.set.items[0].p).toFixed(0)}°</b>` : '';
    html = `<b>ROTATE</b> ${signed(op.delta, 0)}°${one} · ${kbd('Shift')} free (no ${ROT_STEP}° snap) · click to finish · ${kbd('Esc')} cancel`;
  } else if (P.busy()) {
    html = `<b>FALLING</b> · ${kbd('Ctrl')} ${kbd('Z')} cancels the drop`;
  } else if (S.selected.size) {
    html = S.gizmo === 'rotate'
      ? `Drag a coloured ring to rotate on that axis · drag inside the rings to tumble freely · ${kbd('Shift')} no snap · ${kbd('W')} move`
      : `Drag an arrow or square to move · drag the prop to slide it · arrows nudge · ${kbd('[')} ${kbd(']')} turn ${ROT_STEP}° · ${kbd('End')} drop · ${kbd('E')} rotate`;
  } else if (!S.props.length) {
    html = `Pick a prop on the left, or hold ${kbd('Q')} over the arena`;
  }
  hudEl.hidden = !html;
  hudEl.innerHTML = html;
}

function updateCoords() {
  if (!mouse.over) return;
  const p = groundPoint(mouse.x, mouse.y);
  coordsEl.textContent = p ? `X ${p.x.toFixed(1)}   Y ${p.y.toFixed(1)}   Z ${p.z.toFixed(1)}` : 'X — Y — Z —';
}

export const refreshHud = updateHud;

export function envLabel() {
  return ENVIRONMENTS.find((e) => e.key === S.env)?.name || S.env;
}

// ---------------------------------------------------------------- marquee

function drawMarquee(e) {
  const r = viewportEl.getBoundingClientRect();
  const x0 = Math.min(press.x, e.clientX), y0 = Math.min(press.y, e.clientY);
  Object.assign(marqueeEl.style, {
    left: `${x0 - r.left}px`, top: `${y0 - r.top}px`,
    width: `${Math.abs(e.clientX - press.x)}px`, height: `${Math.abs(e.clientY - press.y)}px`,
  });
  marqueeEl.hidden = false;
}

function finishMarquee(e) {
  marqueeEl.hidden = true;
  const x0 = Math.min(press.x, e.clientX), x1 = Math.max(press.x, e.clientX);
  const y0 = Math.min(press.y, e.clientY), y1 = Math.max(press.y, e.clientY);
  if (!press.shift) S.selected.clear();
  for (const p of S.props) {
    const s = V.projectToScreen(p.x, p.y, p.z);
    if (s && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) S.selected.add(p.id);
  }
  selectionChanged();
}

function clickSelect(hit, shift) {
  if (hit != null) {
    if (shift) S.selected.has(hit) ? S.selected.delete(hit) : S.selected.add(hit);
    else S.selected = new Set([hit]);
  } else if (!shift) {
    S.selected.clear();
  }
  selectionChanged();
}

// ---------------------------------------------------------------- events

function isTyping(t) {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function trackMouse(e) {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.over = true;
  mouse.shift = e.shiftKey;
  mouse.ctrl = e.ctrlKey || e.metaKey;
}

export function initTools() {
  viewportEl = document.getElementById('viewport');
  hudEl = document.getElementById('hud');
  marqueeEl = document.getElementById('marquee');
  coordsEl = document.getElementById('status-coords');
  canvas = V.renderer.domElement;
  setMode('select');
  on('props', () => { refreshGizmo(); updateHud(); });
  on('walk', walkChanged);
  V.onCamera(() => emit('camera'));
  store.setBeforeEdit(P.settleNow);
  P.setFrameHook(() => {
    refreshGizmo();
    emit('transform');
    updateHud();
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    trackMouse(e);
    if (wheelOpen()) {
      e.button === 0 ? wheelConfirm() : wheelCancel();
      return;
    }
    if (gdrag) {
      if (e.button === 2) endGizmoDrag(false);
      return;
    }
    if (op) {
      if (e.button === 0 && op.via === 'key') finishOp(true);
      else if (e.button === 2) finishOp(false);
      return;
    }
    if (e.button !== 0) return;
    if (S.mode === 'select') {
      const h = G.hit(e.clientX, e.clientY);
      if (h && startGizmoDrag(h, e)) return;
    }
    canvas.focus({ preventScroll: true });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (S.mode === 'add') {
      const p = groundPoint(e.clientX, e.clientY);
      if (!p) return;
      add.first = p;
      add.firstScreenY = e.clientY;
      V.controls.enableZoom = false;
      refreshAdd();
      return;
    }
    press = { x: e.clientX, y: e.clientY, hit: V.pickProp(e.clientX, e.clientY), shift: e.shiftKey, moved: false, marquee: false };
  });

  canvas.addEventListener('pointermove', (e) => {
    trackMouse(e);
    if (wheelOpen()) return wheelMove(e.clientX, e.clientY);
    if (gdrag) return updateGizmoDrag();
    updateCoords();
    if (op) return op.type === 'move' ? updateMove() : updateRotate();
    if (S.mode === 'add') return refreshAdd();
    if (!press) return updateHover();
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) {
      press.moved = true;
      if (press.hit != null) {
        if (!S.selected.has(press.hit)) {
          if (!press.shift) S.selected.clear();
          S.selected.add(press.hit);
          selectionChanged();
        }
        const hit = press.hit;
        mouse.x = press.x; mouse.y = press.y;
        startMove('drag', hit);
        trackMouse(e);
        if (op) updateMove();
        return;
      }
      press.marquee = true;
    }
    if (press.marquee) drawMarquee(e);
  });

  canvas.addEventListener('pointerup', (e) => {
    trackMouse(e);
    if (e.button !== 0) return;
    if (gdrag) return endGizmoDrag(true);
    if (op && op.via !== 'key') return finishOp(true);
    if (S.mode === 'add' && add.first) {
      V.controls.enableZoom = true;
      return placeNow();
    }
    if (press) {
      if (press.marquee) finishMarquee(e);
      else if (!press.moved) clickSelect(press.hit, press.shift);
      press = null;
      updateHover();
    }
  });

  canvas.addEventListener('pointerleave', () => {
    mouse.over = false;
    if (!op) setHover(null);
    if (S.mode === 'add' && !add.first) refreshAdd();
  });

  // Wheel adjusts line spacing while dragging a line (or with Alt).
  viewportEl.addEventListener('wheel', (e) => {
    if (S.mode !== 'add' || !(add.first || e.altKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const geom = geomNow(S.addKey, S.addState);
    const step = geom ? footprintOf(geom) * 0.08 : 5;
    add.extra = e.ctrlKey ? 0 : Math.max(0, add.extra + (e.deltaY < 0 ? step : -step));
    refreshAdd();
  }, { capture: true, passive: false });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
      mouse.shift = e.shiftKey;
      mouse.ctrl = e.ctrlKey || e.metaKey;
      refreshLive();
    }
    if ((e.key === 'q' || e.key === 'Q') && wheelOpen()) wheelConfirm();
  });
  window.addEventListener('blur', () => {
    mouse.shift = mouse.ctrl = false;
    if (gdrag) endGizmoDrag(false);
    wheelCancel();
  });
}

// Modifier keys change the result of an ongoing drag without moving the mouse.
function refreshLive() {
  if (gdrag) updateGizmoDrag();
  else if (op) op.type === 'move' ? updateMove() : updateRotate();
  else if (S.mode === 'add' && add.first) refreshAdd();
}

function onKeyDown(e) {
  if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.altKey && e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();

  if (k === 'shift' || k === 'control' || k === 'meta') {
    mouse.shift = e.shiftKey;
    mouse.ctrl = e.ctrlKey || e.metaKey;
    refreshLive();
    return;
  }
  if (gdrag) {
    if (k === 'escape') endGizmoDrag(false);
    e.preventDefault();
    return;
  }
  if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if (ctrl && k === 'y') { e.preventDefault(); doRedo(); return; }
  if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (ctrl && k === 'a') { e.preventDefault(); selectOnly(S.props.map((p) => p.id)); return; }
  if (ctrl && k === 'g') { e.preventDefault(); if (S.selected.size && S.mode === 'select') emit('save-set'); return; }
  if (ctrl) return;

  if (wheelOpen()) {
    if (k === 'escape') wheelCancel();
    e.preventDefault();
    return;
  }
  if (op) {
    if (k === 'escape') finishOp(false);
    else if (k === 'enter') finishOp(true);
    else if (op.type === 'move' && (k === 'x' || k === 'y')) {
      op.axisKey = op.axisKey === k ? null : k;
      updateMove();
    }
    e.preventDefault();
    return;
  }

  // Shift+` walks, like Blender (by physical key: the one left of 1).
  if (W.codeOf(e) === 'Backquote' && e.shiftKey) {
    if (!e.repeat) beginWalk();
    e.preventDefault();
    return;
  }

  // [ and ] rotate (by physical key, so Shift / Alt still work)
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const step = e.shiftKey ? 90 : e.altKey ? 1 : ROT_STEP;
    const delta = e.code === 'BracketLeft' ? step : -step;
    if (S.mode === 'add') rotatePlacement(delta);
    else rotateBy(delta);
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': case 'PageUp': case 'PageDown':
      if (S.mode === 'add' && dropping() && /Up|Down/.test(e.key)) {
        const step = e.shiftKey ? 50 : e.altKey ? 1 : 10;
        changeDropHeight(/Up/.test(e.key) ? step : -step);
        e.preventDefault();
        return;
      }
      if (S.mode !== 'select' || !S.selected.size) return;
      nudge(e.key, e);
      e.preventDefault();
      return;
    default:
  }

  switch (k) {
    case 'escape':
      if (S.mode === 'add') {
        if (add.first) { add.first = null; V.controls.enableZoom = true; refreshAdd(); }
        else exitAdd();
      } else if (S.selected.size) {
        selectOnly([]);
      }
      break;
    case 'q': if (!e.repeat) openWheelHere(); break;
    case 'm': if (S.mode === 'add' && S.addSet) toggleMirror(); else return; break;
    case 'w': setGizmoMode('move'); break;
    case 'e': setGizmoMode('rotate'); break;
    case 'p': setPhysics(!S.physics); break;
    case 'end': dropSelected(); break;
    case 'g': startMove('key'); break;
    case 'r': startRotate(); break;
    case 'x': case 'delete': case 'backspace': deleteSelected(); break;
    case 'd': if (e.shiftKey) duplicateSelected(); else return; break;
    case 'a': selectOnly(e.altKey ? [] : S.props.map((p) => p.id)); break;
    case 'f': frameSelectionOrAll(); break;
    case 'home': frameSelectionOrAll(true); break;
    case 't': V.viewTop(); break;
    default: return;
  }
  e.preventDefault();
}
