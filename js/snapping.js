// Port of snapping/logic.py. All values are Blender world coordinates.

import { S } from './state.js';
import { envBoxes, envMeshList, propBox } from './viewport.js';

export const RING_Z = 106.0;
const STACK_BASE_ZS = [0.0, RING_Z];
const STACK_BASE_TOL = 12.0;

const inXY = (b, x, y) => !!b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

// ---------------------------------------------------------------- ring shape
// The ring's bounding box is much bigger than the ring: the steps stick out
// at two corners, so a box test lifted props on the floor beside the ring up
// to mat height. Instead each arena model gets a height map of the surfaces
// you can stand on up to just above the mat (the mat, the steps, a chamber
// floor): every cell keeps the highest upward-facing surface over it, and an
// empty cell means there's nothing there but the floor.

const CELL = 4;              // cm
const REACH = 130;           // surfaces above this (ropes, posts, cages, roofs) don't count
const MIN_SURFACE = 5;       // nor do faces at floor level
const heightMaps = new WeakMap(); // geometry -> { x0, y0, nx, ny, h }

function buildHeightMap(geom) {
  if (!geom.boundingBox) geom.computeBoundingBox();
  const pos = geom.attributes.position, idx = geom.index;
  const bb = geom.boundingBox;
  const x0 = bb.min.x, y0 = bb.min.y;
  const nx = Math.ceil((bb.max.x - x0) / CELL) + 1, ny = Math.ceil((bb.max.y - y0) / CELL) + 1;
  const h = new Float32Array(nx * ny).fill(-Infinity);
  const count = idx ? idx.count : pos.count;
  for (let t = 0; t < count; t += 3) {
    const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    const zTop = Math.max(az, bz, cz);
    if (zTop > REACH || zTop < MIN_SURFACE) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const d = ux * vy - uy * vx; // 2D area x2 = normal Z (unnormalised)
    const len = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, d);
    if (!len || Math.abs(d) / len < 0.25) continue; // walls (anything steeper than ~75°)
    // corners too: thin parts (grating wires) can miss every cell center
    for (const [vx_, vy_, vz_] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
      const k = Math.floor((vy_ - y0) / CELL) * nx + Math.floor((vx_ - x0) / CELL);
      if (vz_ > h[k]) h[k] = vz_;
    }
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / CELL));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / CELL));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / CELL));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * CELL - ay;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * CELL - ax;
        const w1 = (px * vy - py * vx) / d, w2 = (ux * py - uy * px) / d;
        if (w1 < -1e-4 || w2 < -1e-4 || w1 + w2 > 1 + 1e-4) continue;
        const z = az + w1 * uz + w2 * vz, k = j * nx + i;
        if (z > h[k]) h[k] = z;
      }
    }
  }
  closeGaps(h, nx, ny);
  return { x0, y0, nx, ny, h };
}

// Fill holes narrower than ~2 * GAP cells (slatted floors like the Elimination
// Chamber pods) with the highest surface next to them, without growing the
// outer edges: a morphological closing (dilate, then erode the dilation).
const GAP = 3;
function closeGaps(h, nx, ny) {
  const near = slide(slide(h, nx, ny, 1, Math.max, -Infinity), nx, ny, nx, Math.max, -Infinity);
  const filled = new Float32Array(nx * ny);
  for (let k = 0; k < filled.length; k++) filled[k] = near[k] === -Infinity ? 0 : 1;
  const inside = slide(slide(filled, nx, ny, 1, Math.min, 0), nx, ny, nx, Math.min, 0);
  for (let k = 0; k < h.length; k++) if (h[k] === -Infinity && inside[k] === 1) h[k] = near[k];
}

// Max / min over a window of 2 * GAP + 1 cells along one axis (stride 1 = rows,
// nx = columns); cells past the edge count as `edge`.
function slide(src, nx, ny, stride, pick, edge) {
  const out = new Float32Array(src.length);
  const len = stride === 1 ? nx : ny, lines = stride === 1 ? ny : nx, step = stride === 1 ? nx : 1;
  for (let l = 0; l < lines; l++) {
    const base = l * step;
    for (let i = 0; i < len; i++) {
      let v = pick === Math.max ? -Infinity : Infinity;
      for (let d = -GAP; d <= GAP; d++) {
        const j = i + d;
        v = pick(v, j < 0 || j >= len ? edge : src[base + j * stride]);
      }
      out[base + i * stride] = v;
    }
  }
  return out;
}

// Height of the model's surface under (x, y): a number, null when there's
// none (the floor), or undefined while the model isn't loaded yet.
function surfaceAt(id, x, y) {
  const m = envMeshList().find((e) => e.id === id);
  if (!m) return undefined;
  let hm = heightMaps.get(m.geom);
  if (!hm) heightMaps.set(m.geom, (hm = buildHeightMap(m.geom)));
  const i = Math.floor((x - hm.x0) / CELL), j = Math.floor((y - hm.y0) / CELL);
  if (i < 0 || j < 0 || i >= hm.nx || j >= hm.ny) return null;
  const z = hm.h[j * hm.nx + i];
  if (z === -Infinity) return null;
  // the mat, its rounded edge and a chamber floor just below it all count as ring level
  return z > RING_Z - 8 && z < RING_Z + 2 ? RING_Z : Math.round(z * 100) / 100;
}

// The ring-level surface of a model under (x, y), or null for the floor.
// Until the model has loaded, its bounding box stands in.
function ringTop(id, x, y) {
  const z = surfaceAt(id, x, y);
  if (z !== undefined) return z;
  return inXY(envBoxes[id], x, y) ? RING_Z : null;
}

// ---------------------------------------------------------------- snapping

function stageTop(x, y) {
  const b = envBoxes.stage;
  return S.stage && inXY(b, x, y) ? b.maxZ : null;
}

// Top of a placed prop resting on a base surface (floor / ring) whose footprint
// covers (x, y). One level only: stacked props are never platforms.
function placedTop(x, y, exclude) {
  let best = null;
  for (const p of S.props) {
    if (exclude?.has(p.id)) continue;
    if (!STACK_BASE_ZS.some((bz) => Math.abs(p.z - bz) <= STACK_BASE_TOL)) continue;
    const b = propBox(p.id);
    if (inXY(b, x, y) && (best === null || b.maxZ > best)) best = b.maxZ;
  }
  return best;
}

// Hell in a Cell's roof, while it shows solid (X-ray off): { z, contains(x, y) }.
// A click that lands on it places the prop there (tools.js groundPoint).
export function cellRoof() {
  const b = envBoxes.hiac;
  if (S.env !== 'HIAC' || S.xray || !b) return null;
  return { z: b.maxZ, contains: (x, y) => inXY(b, x, y) };
}

export function snapZ(x, y, exclude = null) {
  if (S.stacking) {
    const top = placedTop(x, y, exclude);
    if (top !== null) return top;
  }
  const fallback = () => stageTop(x, y) ?? 0.0;
  switch (S.env) {
    case 'EC':
      return ringTop('ec', x, y) ?? fallback();
    case 'WG':
      return ringTop('wg', x, y) ?? fallback();
    case 'HIAC':
      // Inside the cell is the floor; the roof is only for clicks on it (cellRoof).
      return ringTop('ringmat', x, y) ?? fallback();
    case 'AMB':
      return ringTop('ringmat', x, y)
        ?? (inXY(envBoxes.amb, x, y) ? envBoxes.amb.maxZ : null)   // ambulance roof
        ?? fallback();
    default:
      return ringTop('ringmat', x, y) ?? fallback();
  }
}
