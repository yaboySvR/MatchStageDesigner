// Physics drops: props fall from above the cursor and settle where they land.
//
// The physics engine (Rapier, WebAssembly) downloads the first time physics is
// used. Inside it the arena and every placed prop are fixed triangle meshes,
// so a falling prop lands on exactly the surfaces you see; falling props use
// the convex hull of their model. The simulation runs in meters (the profile
// uses centimeters) in the same Z-up world space as everything else.
//
// Props dropped while earlier ones are still moving join the same "session":
// they can knock each other around, and the whole session becomes one undo
// step once everything is at rest. Any other edit settles the session first
// (the rest of the fall is simulated instantly), and undo cancels it.

import { S, on } from './state.js';
import * as V from './viewport.js';
import * as store from './store.js';
import { geomNow, footprintOf } from './geometry.js';
import { profileToMatrix, matrixToProfile, quatToMatrix, axisAngleMatrix, mul, yawToRz } from './rotation.js';
import { snapZ } from './snapping.js';

const M = 0.01;              // world units (cm) -> meters
const STEP = 1 / 60;         // simulation step, seconds
const FRICTION = 0.7;
const QUIET_LIN = 0.03;      // m/s: slower than this counts as still...
const QUIET_ANG = 0.1;       // rad/s
const QUIET_STEPS = 20;      // ...for this many steps in a row
const MAX_STEPS = 8 * 60;    // a body still moving after 8 s is left where it is
const LEVEL_TOL = 1;         // cm: a resting tilt that moves no point further than this is levelled
const SNAP_TOL = 1.5;        // cm: resting this close to a snap surface lands on it
const RAISE_STEP = 10;       // cm: spawn raised in these steps until clear...
const RAISE_MAX = 40;        // ...at most this many times
const QUERY_BUDGET = 400;    // overlap tests per planDrop call

let R = null;                // the Rapier module
let world = null;
let loading = null;
const envCols = new Map();   // env model id -> collider
const propCols = new Map();  // prop id -> { col, sig }
const meshes = new WeakMap(); // geometry -> { v, i } in meters
const hulls = new WeakMap();  // geometry -> { pts (meters), shape, reach (cm) }
let staticDirty = true;
let session = null;
let onFrame = null;

on('props', () => { staticDirty = true; });

export const ready = () => !!world;
export const busy = () => !!session;

// Called after every simulated frame and when a session ends (tools.js keeps
// the gizmo, inspector and HUD in step).
export const setFrameHook = (fn) => { onFrame = fn; };

export function load() {
  loading ||= import('@dimforge/rapier3d-compat')
    .then(async (mod) => {
      R = mod.default;
      await R.init();
      world = new R.World({ x: 0, y: 0, z: -9.81 });
      world.timestep = STEP;
      // Ground under everything: the arena floor model doesn't reach everywhere.
      world.createCollider(R.ColliderDesc.cuboid(500, 500, 1).setTranslation(0, 0, -1).setFriction(FRICTION));
    })
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

// ---------------------------------------------------------------- shapes

function meshOf(geom) {
  let m = meshes.get(geom);
  if (!m) {
    const src = geom.attributes.position.array;
    const v = new Float32Array(src.length);
    for (let k = 0; k < src.length; k++) v[k] = src[k] * M;
    const i = geom.index ? Uint32Array.from(geom.index.array) : Uint32Array.from({ length: src.length / 3 }, (_, k) => k);
    m = { v, i };
    meshes.set(geom, m);
  }
  return m;
}

const trimesh = (geom) => {
  const m = meshOf(geom);
  return R.ColliderDesc.trimesh(m.v, m.i).setFriction(FRICTION);
};

// Box corners, for models too flat or broken for a hull.
function boxPoints(geom) {
  const b = geom.boundingBox;
  const lo = [b.min.x, b.min.y, b.min.z], hi = [b.max.x, b.max.y, b.max.z];
  for (let k = 0; k < 3; k++) {
    if (hi[k] - lo[k] < 0.5) { const c = (lo[k] + hi[k]) / 2; lo[k] = c - 0.25; hi[k] = c + 0.25; }
  }
  const out = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) out.push(x * M, y * M, z * M);
  return Float32Array.from(out);
}

// Convex hull of a model, computed once (Rapier computes it; the hull's own
// points are kept so later shapes are quick to build).
function hullOf(geom) {
  let h = hulls.get(geom);
  if (h) return h;
  let pts = null;
  try {
    const tmp = world.createCollider(R.ColliderDesc.convexHull(meshOf(geom).v).setEnabled(false));
    pts = Float32Array.from(tmp.vertices());
    world.removeCollider(tmp, false);
  } catch { /* degenerate model */ }
  if (!pts || pts.length < 12) pts = boxPoints(geom);
  let reach = 0;
  for (let k = 0; k < pts.length; k += 3) reach = Math.max(reach, Math.hypot(pts[k], pts[k + 1], pts[k + 2]));
  h = { pts, shape: new R.ConvexPolyhedron(pts, null), reach: reach / M };
  hulls.set(geom, h);
  return h;
}

// Lowest point (cm, relative to the origin) of a model turned by the 3x3 Rm.
function lowest(geom, Rm) {
  const [a, b, c] = Rm[2];
  let lo = Infinity;
  if (world) {
    const { pts } = hullOf(geom);
    for (let k = 0; k < pts.length; k += 3) lo = Math.min(lo, a * pts[k] + b * pts[k + 1] + c * pts[k + 2]);
    return lo / M;
  }
  const bb = geom.boundingBox;
  for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
    lo = Math.min(lo, a * x + b * y + c * z);
  }
  return lo;
}

const rotOf = (rx, ry, rz) => {
  const q = V.quatOf(rx, ry, rz);
  return { x: q.x, y: q.y, z: q.z, w: q.w };
};

// ---------------------------------------------------------------- the fixed world

// A collider, or null if Rapier rejects the shape (a broken custom model).
function tryCollider(desc, body) {
  try {
    return world.createCollider(desc, body);
  } catch (e) {
    console.warn('Physics: shape skipped', e);
    return null;
  }
}

// Bring the fixed colliders up to date: arena models that are showing, and
// every placed prop that isn't falling right now.
function syncStatic() {
  let changed = false;
  for (const { id, geom, visible } of V.envMeshList()) {
    let col = envCols.get(id);
    if (col === undefined) {
      if (!visible) continue;
      col = tryCollider(trimesh(geom));
      envCols.set(id, col);
      changed = true;
    }
    if (col && col.isEnabled() !== visible) {
      col.setEnabled(visible);
      changed = true;
    }
  }
  if (staticDirty) {
    staticDirty = false;
    const alive = new Set();
    for (const p of S.props) {
      if (session?.bodies.has(p.id)) continue;
      const geom = geomNow(p.key, p.state);
      if (!geom) { staticDirty = true; continue; } // retried once the model loads
      alive.add(p.id);
      const sig = `${p.key}|${p.state}|${p.x}|${p.y}|${p.z}|${p.rx}|${p.ry}|${p.rz}`;
      const cur = propCols.get(p.id);
      if (cur?.sig === sig) continue;
      if (cur) removeStatic(p.id);
      const col = tryCollider(trimesh(geom).setTranslation(p.x * M, p.y * M, p.z * M).setRotation(rotOf(p.rx, p.ry, p.rz)));
      propCols.set(p.id, { col, sig });
      changed = true;
    }
    for (const id of propCols.keys()) {
      if (alive.has(id)) continue;
      removeStatic(id);
      changed = true;
    }
  }
  // Scene queries only see new colliders after a step; with nothing moving
  // the step does nothing else.
  if (changed && !session) world.step();
}

function removeStatic(id) {
  const c = propCols.get(id);
  if (c?.col) world.removeCollider(c.col, false);
  propCols.delete(id);
}

// Does p (at its pose) touch anything? skip: collider handles to ignore.
function overlaps(p, skip = null) {
  let hit = false;
  world.intersectionsWithShape(
    { x: p.x * M, y: p.y * M, z: p.z * M }, rotOf(p.rx, p.ry, p.rz), hullOf(p.geom).shape,
    () => { hit = true; return false; },
    undefined, undefined, undefined, undefined, skip && ((c) => !skip.has(c.handle)),
  );
  return hit;
}

// Raise a group of poses together until none of them touches anything.
function raiseClear(group, skip = null, budget = { n: QUERY_BUDGET }) {
  for (let n = 0; n < RAISE_MAX && budget.n > 0 && group.some((p) => overlaps(p, skip)); n++) {
    budget.n -= group.length;
    for (const p of group) p.z += RAISE_STEP;
  }
}

// Height of the first thing straight below (x, y, z), or null.
function groundBelow(x, y, z) {
  const hit = world.castRay(new R.Ray({ x: x * M, y: y * M, z: z * M }, { x: 0, y: 0, z: -1 }), 1000, true);
  return hit ? z - hit.timeOfImpact / M : null;
}

// First surface along a ray (the camera ray through the cursor) that a prop
// could rest on. Steep hits (walls, the cage mesh) are looked through.
export function surfaceOnRay({ origin: o, direction: d }) {
  if (!world) return null;
  syncStatic();
  let best = Infinity;
  const ray = new R.Ray({ x: o.x * M, y: o.y * M, z: o.z * M }, { x: d.x, y: d.y, z: d.z });
  world.intersectionsWithRay(ray, 2000, true, (hit) => {
    if (Math.abs(hit.normal.z) >= 0.5) best = Math.min(best, hit.timeOfImpact);
    return true;
  });
  if (best === Infinity) return null;
  const t = best / M;
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
}

// ---------------------------------------------------------------- planning a drop

// Where props start their fall: their lowest point `height` above the surface
// they were placed on, raised further while that spot is occupied.
//   items: [{ key, state, x, y, z, rx, ry, rz }], z as normal placing puts it
//   returns the same items with the start z, plus bottom (their lowest Z),
//   land (the Z below them) and r (landing marker radius) for the preview.
export function planDrop(items, height) {
  if (world) syncStatic();
  const plan = [];
  for (const it of items) {
    const geom = geomNow(it.key, it.state);
    if (!geom) continue;
    const rx = it.rx || 0, ry = it.ry || 0, rz = it.rz || 0;
    plan.push({ ...it, rx, ry, rz, geom, base: it.z, low: lowest(geom, profileToMatrix(rx, ry, rz)) });
  }
  for (const p of plan) p.z = p.base + height - p.low;
  if (world) {
    const budget = { n: QUERY_BUDGET };
    for (const p of plan) raiseClear([p], null, budget);
  }
  return plan.map(({ geom, base, low, ...p }) => {
    const bottom = p.z + low;
    const below = world ? groundBelow(p.x, p.y, bottom) : null;
    return { ...p, bottom, land: Math.min(below ?? base, bottom), r: Math.min(30, Math.max(5, footprintOf(geom) * 0.2)) };
  });
}

// ---------------------------------------------------------------- simulating

function begin() {
  if (session) return;
  syncStatic();
  session = { snap0: store.snapshot(), bodies: new Map(), acc: 0, last: performance.now(), raf: 0 };
  session.raf = requestAnimationFrame(frame);
}

function addBody(p, geom, spin) {
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
    .setTranslation(p.x * M, p.y * M, p.z * M)
    .setRotation(rotOf(p.rx, p.ry, p.rz))
    .setLinearDamping(0.05)
    .setAngularDamping(0.3)
    .setCcdEnabled(true));
  tryCollider(R.ColliderDesc.convexHull(hullOf(geom).pts).setDensity(300).setFriction(FRICTION).setRestitution(0.1), body);
  if (spin) {
    // random axis, 4-8 rad/s
    const u = Math.random() * 2 - 1, t = Math.random() * 2 * Math.PI, w = 4 + Math.random() * 4;
    const s = Math.sqrt(1 - u * u);
    body.setAngvel({ x: s * Math.cos(t) * w, y: s * Math.sin(t) * w, z: u * w }, true);
  }
  session.bodies.set(p.id, { body, geom, quiet: 0, age: 0 });
}

// Drop new props (from planDrop). spin: tumble them. Returns the new records.
export function drop(items, { spin = false } = {}) {
  begin();
  const added = [];
  for (const it of items) {
    const geom = geomNow(it.key, it.state);
    if (!geom) continue;
    const p = store.addProp({ key: it.key, state: it.state, x: it.x, y: it.y, z: it.z, rx: it.rx, ry: it.ry, rz: it.rz });
    addBody(p, geom, spin);
    added.push(p);
  }
  if (!session.bodies.size) finish();
  else store.changed();
  return added;
}

// Let placed props fall from where they are. One that starts inside
// something (the add-on puts a barrel's center on the floor) is lifted clear
// first, so it doesn't get shoved through the surface.
export function dropExisting(props) {
  begin();
  const list = props
    .filter((p) => !session.bodies.has(p.id))
    .map((p) => ({ p, geom: geomNow(p.key, p.state) }))
    .filter((d) => d.geom);
  const skip = new Set(list.map((d) => propCols.get(d.p.id)?.col?.handle).filter((h) => h !== undefined));
  const budget = { n: QUERY_BUDGET };
  for (const d of list) {
    const pose = { ...d.p, geom: d.geom };
    raiseClear([pose], skip, budget);
    d.p.z = pose.z;
  }
  for (const { p, geom } of list) {
    removeStatic(p.id);
    addBody(p, geom, false);
  }
  if (!session.bodies.size) finish();
}

function stepOnce() {
  world.step();
  for (const b of session.bodies.values()) {
    b.age++;
    const v = b.body.linvel(), w = b.body.angvel();
    const quiet = b.body.isSleeping() || (Math.hypot(v.x, v.y, v.z) < QUIET_LIN && Math.hypot(w.x, w.y, w.z) < QUIET_ANG);
    b.quiet = quiet ? b.quiet + 1 : 0;
  }
}

const settled = () => [...session.bodies.values()].every((b) => b.quiet >= QUIET_STEPS || b.age >= MAX_STEPS);

function frame(now) {
  const s = session;
  if (!s) return;
  s.raf = requestAnimationFrame(frame);
  s.acc = Math.min(s.acc + Math.max(0, now - s.last) / 1000, STEP * 4); // a slow frame doesn't snowball
  s.last = now;
  while (s.acc >= STEP) {
    stepOnce();
    s.acc -= STEP;
  }
  writeBack(false);
  if (settled()) finish();
  else onFrame?.();
}

// A prop at rest within a hair of level (no point off by more than LEVEL_TOL)
// is made exactly level, then one resting within SNAP_TOL of a snap surface is
// put on it, so the exported numbers come out clean. Returns the new matrix
// and whether the prop stands upright.
function tidy(p, geom, Rm, exclude) {
  let k = 2;
  for (const j of [0, 1]) if (Math.abs(Rm[2][j]) > Math.abs(Rm[2][k])) k = j;
  const up = Rm[2][k] > 0 ? 1 : -1;
  const tilt = Math.acos(Math.min(1, Math.abs(Rm[2][k])));
  const { reach } = hullOf(geom);
  let level = false;
  if (tilt * reach <= LEVEL_TOL) {
    level = true;
    const a = [Rm[0][k], Rm[1][k], Rm[2][k]];
    const axis = [a[1] * up, -a[0] * up, 0]; // a × (0, 0, up)
    const len = Math.hypot(axis[0], axis[1]);
    if (len > 1e-12) {
      const low0 = lowest(geom, Rm);
      Rm = mul(axisAngleMatrix([axis[0] / len, axis[1] / len, 0], (tilt * 180) / Math.PI), Rm);
      p.z += low0 - lowest(geom, Rm);
    }
  }
  if (S.autoSnap) {
    const surface = snapZ(p.x, p.y, exclude);
    if (Math.abs(p.z - surface) <= SNAP_TOL) p.z = surface;
  }
  return { Rm, upright: level && k === 2 && up > 0 };
}

// Copy the bodies' poses onto their props (final: tidied, at rest).
function writeBack(final) {
  const exclude = final ? new Set(session.bodies.keys()) : null;
  for (const [id, b] of session.bodies) {
    const p = store.byId(id);
    if (!p) continue;
    const t = b.body.translation(), q = b.body.rotation();
    p.x = t.x / M;
    p.y = t.y / M;
    p.z = t.z / M;
    let Rm = quatToMatrix(q.x, q.y, q.z, q.w);
    if (final) {
      const r = tidy(p, b.geom, Rm, exclude);
      Rm = r.Rm;
      if (r.upright) {
        // an upright prop gets exact numbers: facing only
        const yaw = Math.round((Math.atan2(Rm[1][0], Rm[0][0]) * 180) / Math.PI * 1e4) / 1e4;
        [p.rx, p.ry, p.rz] = [0, 0, yawToRz(yaw)];
        continue;
      }
    }
    [p.rx, p.ry, p.rz] = matrixToProfile(Rm);
  }
  V.syncProps();
}

function endSession() {
  const s = session;
  cancelAnimationFrame(s.raf);
  for (const b of s.bodies.values()) world.removeRigidBody(b.body);
  session = null;
  staticDirty = true;
  return s;
}

function finish() {
  writeBack(true);
  const s = endSession();
  if (store.snapshot() !== s.snap0) store.checkpoint(s.snap0);
  store.changed();
  onFrame?.();
}

// Finish any fall in progress right now (before another edit).
export function settleNow() {
  if (!session) return;
  for (let n = 0; n < MAX_STEPS && !settled(); n++) stepOnce();
  finish();
}

// Undo a fall in progress: the props go back to where they were before it
// (new ones disappear). Returns false if nothing was falling.
export function cancel() {
  if (!session) return false;
  const s = endSession();
  store.revert(s.snap0);
  onFrame?.();
  return true;
}
