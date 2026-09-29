// Overlap warning: props that go into each other, shown in red (viewport.js)
// and counted in the status bar (ui.js). Touching is fine: a prop stacked on
// another or standing right next to it isn't flagged, only one that goes more
// than about TOL into another.
//
// How: each prop's mesh gets a BVH (three-mesh-bvh, loaded the first time it's
// needed); pairs whose boxes overlap are tested triangle against triangle, with
// the second prop shrunk by TOL on every side so surfaces that only touch
// don't count.

import * as THREE from 'three';
import { S, emit, on } from './state.js';
import { geomNow } from './geometry.js';
import * as V from './viewport.js';

const TOL = 1.5;          // cm a prop may sink into another without a warning
const DELAY = 300;        // ms after the last change
const MAX_TESTS = 20000;  // pair tests per check, so a huge scene can't lock the page

let lib = null;           // three-mesh-bvh
let timer = null;
let running = false;
let again = false;
const prepared = new WeakMap(); // geometry -> { geom, box, shrink }

export let overlapping = new Set(); // prop ids

export function initOverlaps() {
  on('props', schedule);
  schedule();
}

export function schedule() {
  clearTimeout(timer);
  timer = setTimeout(check, DELAY);
}

function publish(ids) {
  const same = ids.size === overlapping.size && [...ids].every((id) => overlapping.has(id));
  if (same) return;
  overlapping = ids;
  V.setOverlaps(ids);
  emit('overlaps');
}

// The mesh ready for testing: a copy with its BVH, its box, and the matrix
// that shrinks it by TOL on every side (around its center).
function prep(geometry) {
  let e = prepared.get(geometry);
  if (e) return e;
  const geom = geometry.clone();
  geom.boundsTree = new lib.MeshBVH(geom);
  geom.computeBoundingBox();
  const box = geom.boundingBox.clone();
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const k = (v) => (v > 4 * TOL ? (v - 2 * TOL) / v : 0.5);
  const shrink = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
    .multiply(new THREE.Matrix4().makeScale(k(s.x), k(s.y), k(s.z)))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  e = { geom, box, shrink };
  prepared.set(geometry, e);
  return e;
}

const deep = (a, b) => a.max.x - b.min.x > TOL && b.max.x - a.min.x > TOL
  && a.max.y - b.min.y > TOL && b.max.y - a.min.y > TOL
  && a.max.z - b.min.z > TOL && b.max.z - a.min.z > TOL;

// A prop stacked on another stands with its origin on the other's top. Some
// models reach below their origin (a folded chair's is at its middle), so a
// stacked one sinks into the prop under it by design: that much isn't an
// overlap. onTop: u's origin is on l's top; sink: how far u reaches below it.
const onTop = (u, l) => Math.abs(u.z - l.box.max.z) < 0.5
  && u.x >= l.box.min.x && u.x <= l.box.max.x && u.y >= l.box.min.y && u.y <= l.box.max.y;
const sink = (u) => Math.max(0, u.z - u.box.min.z);

// Is the middle of `inner` (moved up by dz) inside outer's mesh? A prop can
// be wholly inside another without any surfaces crossing (a duplicate on the
// same spot, a folded chair sunk into a folded table). A ray from a point
// inside a closed mesh crosses it an odd number of times; two of three
// slanted rays have to agree, as models aren't always perfectly closed.
const RAYS = [[0.3, 0.2, 0.93], [-0.25, 0.35, -0.9], [0.9, -0.3, 0.3]].map((d) => new THREE.Vector3(...d).normalize());
const _c = new THREE.Vector3(), _ray = new THREE.Ray();

function inside(inner, outer, dz) {
  inner.box.getCenter(_c);
  _c.z += dz;
  if (!outer.box.containsPoint(_c)) return false;
  _c.applyMatrix4(outer.inv);
  let odd = 0;
  for (const d of RAYS) {
    _ray.set(_c, d);
    const ds = outer.e.geom.boundsTree.raycast(_ray, THREE.DoubleSide).map((h) => h.distance).sort((p, q) => p - q);
    const crossings = ds.filter((v, i) => i === 0 || v - ds[i - 1] > 1e-3).length;
    if (crossings % 2) odd++;
  }
  return odd >= 2;
}

async function check() {
  if (running) { again = true; return; }
  if (!S.overlapWarn || S.props.length < 2) { publish(new Set()); return; }
  running = true;
  try {
    lib ??= await import('three-mesh-bvh');
    let missing = false;
    const items = [];
    for (const p of S.props) {
      const g = geomNow(p.key, p.state);
      if (!g) { missing = true; continue; }
      const e = prep(g);
      const world = V.propMatrix(p);
      items.push({ id: p.id, x: p.x, y: p.y, z: p.z, e, world, inv: world.clone().invert(), box: e.box.clone().applyMatrix4(world) });
    }
    const found = new Set();
    const m = new THREE.Matrix4(), lift = new THREE.Matrix4();
    let tests = 0;
    for (let i = 0; i < items.length && tests < MAX_TESTS; i++) {
      const a = items[i];
      for (let j = i + 1; j < items.length && tests < MAX_TESTS; j++) {
        const b = items[j];
        if (!deep(a.box, b.box)) continue;
        tests++;
        // b relative to a, with a stacked one lifted by its designed sink
        const dz = (onTop(b, a) ? sink(b) : 0) - (onTop(a, b) ? sink(a) : 0);
        m.copy(a.inv).multiply(lift.makeTranslation(0, 0, dz)).multiply(b.world).multiply(b.e.shrink);
        if (a.e.geom.boundsTree.intersectsGeometry(b.e.geom, m) || inside(b, a, dz) || inside(a, b, -dz)) {
          found.add(a.id);
          found.add(b.id);
        }
      }
    }
    publish(found);
    if (missing) setTimeout(schedule, 1000); // models still loading
  } catch (e) {
    console.error(e);
  } finally {
    running = false;
    if (again) { again = false; schedule(); }
  }
}
