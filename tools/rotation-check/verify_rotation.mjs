// Compare the web app's import / edit / export against the real Blender add-on.
//
// 1) Ground truth from Blender (runs the add-on headless):
//    blender -b --factory-startup --python web/tools/rotation-check/blender_truth.py -- <addon folder> web/tools/rotation-check
// 2) This script:
//    node web/tools/rotation-check/verify_rotation.mjs
//
// For every case it checks the ORIENTATION (3x3 rotation matrix) and position
// the web app produces against Blender, and reports whether the numbers are
// identical or only equivalent (Blender re-derives Euler angles on export).
// Lines for props the web app leaves out (AT / AT_COVER) must come back
// byte-for-byte as unrecognized lines.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../..');
globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(webDir, u), 'utf8')) });
globalThis.window = {}; // no IndexedDB: custom props are skipped

const { loadCatalog, getProp } = await import('../../js/catalog.js');
const warn = console.warn; console.warn = () => {};
await loadCatalog();
console.warn = warn;
const { S } = await import('../../js/state.js');
const store = await import('../../js/store.js');
const P = await import('../../js/profile.js');

const R = await import('../../js/rotation.js');
const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
const truth = JSON.parse(fs.readFileSync(path.join(here, 'blender_truth.json'), 'utf8'));

const parseLine = (l) => {
  const p = l.replace(/;\s*$/, '').split(',');
  return { pid: +p[1], x: +p[2], y: +p[3], z: +p[4], rx: +p[5], ry: +p[6], rz: +p[7], sid: +p[8], raw: l.trim() };
};
const f3 = (v) => R.pyFixed3(v).replace(/^-0\.000$/, '0.000');
const posKey = (o) => `${o.pid}|${f3(o.x)}|${f3(o.y)}|${f3(o.z)}`;
const matDiff = (A, B) => Math.max(...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => Math.abs(A[r][c] - B[r][c]))));
const TOL = 2e-4; // 3-decimal degrees + Blender float32

function importWeb() {
  S.props = []; S.unknownLines = []; S.selected = new Set(); S.nextId = 1;
  const { items, unknown } = P.parseProfile(cases.profile.join('\n'));
  for (const it of items) store.addProp(it);
  S.unknownLines = unknown;
}

const webLines = () => P.exportProfile(S.props).trim().split('\n').map(parseLine);

let failures = 0;
const rows = [];
function compare(label, webList, blenderRawLines, { skipPositions = new Set() } = {}) {
  const bl = new Map(blenderRawLines.map(parseLine).map((o) => [posKey(o), o]));
  for (const w of webList) {
    const b = bl.get(posKey(w));
    if (!b) {
      if (!skipPositions.has(posKey(w))) { rows.push([label, w.raw, '(no Blender line at this position)', 'MISSING']); failures++; }
      continue;
    }
    const d = matDiff(R.profileToMatrix(w.rx, w.ry, w.rz), R.profileToMatrix(b.rx, b.ry, b.rz));
    const same = w.raw.replace(/-0\.000/g, '0.000') === b.raw.replace(/-0\.000/g, '0.000');
    const verdict = same ? 'IDENTICAL' : d < TOL ? 'SAME ORIENTATION' : 'MISMATCH';
    if (verdict === 'MISMATCH') failures++;
    if (verdict !== 'IDENTICAL') rows.push([label, w.raw, b.raw, `${verdict} (Δ=${d.toExponential(1)})`]);
  }
}

// ---------------------------------------------------------------- 1. rendering matrix
importWeb();
let renderChecked = 0;
for (const o of truth.objects) {
  if (!getProp(o.key)) continue; // not in the web catalog (AT): kept as a raw line instead
  const m = o.matrix_world;
  const rec = S.props.find((p) => Math.abs(p.x - m[0][3]) < 1e-3 && Math.abs(p.y - m[1][3]) < 1e-3 && Math.abs(p.z - m[2][3]) < 1e-3 && p.key === o.key);
  if (!rec) { rows.push(['render', o.name, '(no web prop)', 'MISSING']); failures++; continue; }
  const d = matDiff(R.profileToMatrix(rec.rx, rec.ry, rec.rz), m.map((r) => r.slice(0, 3)));
  renderChecked++;
  if (d > 1e-5) { rows.push(['render', o.name, JSON.stringify([rec.rx, rec.ry, rec.rz]), `MISMATCH Δ=${d}`]); failures++; }
}

// ---------------------------------------------------------------- 2. untouched round trip
importWeb();
const inputLines = cases.profile.map(parseLine);
const out = P.exportProfile(S.props, S.unknownLines).trim().split('\n');
let lossless = 0;
for (const l of out) {
  const w = parseLine(l);
  const src = inputLines.find((i) => i.raw.startsWith(`PROP,${w.pid},`) && posKey(i) === posKey(w) && i.sid === w.sid);
  const eq = src && ['rx', 'ry', 'rz'].every((k) => f3(src[k]) === f3(w[k]));
  if (eq) lossless++;
  else { rows.push(['roundtrip', l, src?.raw || '?', 'NOT LOSSLESS']); failures++; }
}
compare('roundtrip vs plugin', webLines(), truth.roundtrip);

// ---------------------------------------------------------------- 3. compass on imported props
for (const [ang, lines] of Object.entries(truth.compass_on_imported)) {
  importWeb();
  S.selected = new Set(S.props.map((p) => p.id));
  for (const p of store.selectedProps()) store.setYawOf(p, +ang);
  compare(`compass ${ang}`, webLines(), lines);
}

// ---------------------------------------------------------------- 4. R tool on imported props
for (const [d, lines] of Object.entries(truth.rotate_delta_on_imported)) {
  importWeb();
  S.selected = new Set(S.props.map((p) => p.id));
  for (const p of store.selectedProps()) store.setYawOf(p, store.yawOf(p) + +d);
  compare(`rotate +${d}`, webLines(), lines);
}

// ---------------------------------------------------------------- 5. freshly placed prop + compass
S.props = []; S.nextId = 1;
const fresh = store.addProp({ key: 'CHAIR', state: 'Default', x: 1, y: 2, z: 106 });
for (const [ang, lines] of Object.entries(truth.fresh_compass)) {
  store.setYawOf(fresh, +ang);
  compare(`fresh compass ${ang}`, webLines(), lines);
}

// ---------------------------------------------------------------- 6. free rotation (gizmo rings) vs Blender
// Blender rotated each prop around a world axis through its origin and the
// add-on exported it. The web derives angles with the same to_euler port, so
// numbers must match (±360 wrap allowed for Blender's float32 ±180 noise).
const axisMatrix = (axis, deg) => {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  if (axis === 'X') return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === 'Y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return R.rotZ(deg);
};
const sameAngle = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d) < 0.0011; };
let freeChecked = 0, freeExact = 0;
for (const [label, lines] of Object.entries(truth.world_rotations || {})) {
  const [axis, deg] = label.split(':');
  const D = axisMatrix(axis, +deg);
  importWeb();
  const blender = new Map(lines.map(parseLine).map((o) => [posKey(o), o]));
  for (const p of S.props) {
    const zTurn = axis === 'Z' ? +deg : null;
    const [rx, ry, rz] = R.rotateProfile(p.rx, p.ry, p.rz, D, zTurn);
    const b = blender.get(posKey({ pid: getProp(p.key).prop_id, x: p.x, y: p.y, z: p.z }));
    if (!b) continue;
    freeChecked++;
    const dm = matDiff(R.profileToMatrix(rx, ry, rz), R.profileToMatrix(b.rx, b.ry, b.rz));
    if (dm > TOL) { rows.push([`free ${label}`, `${rx},${ry},${rz}`, b.raw, `MISMATCH (Δ=${dm.toExponential(1)})`]); failures++; continue; }
    if ([[rx, b.rx], [ry, b.ry], [rz, b.rz]].every(([u, v]) => sameAngle(u, v))) freeExact++;
    else rows.push([`free ${label}`, `${R.pyFixed3(rx)},${R.pyFixed3(ry)},${R.pyFixed3(rz)}`, b.raw, `SAME ORIENTATION (Δ=${dm.toExponential(1)})`]);
  }
}

// ---------------------------------------------------------------- 7. angles -> matrix -> angles, random
let worstRound = 0;
for (let n = 0; n < 20000; n++) {
  const M = R.profileToMatrix(Math.random() * 360 - 180, Math.random() * 360 - 180, Math.random() * 360 - 180);
  worstRound = Math.max(worstRound, matDiff(R.profileToMatrix(...R.matrixToProfile(M)), M));
}
if (worstRound > 1e-6) { rows.push(['random round trip', '', '', `MISMATCH ${worstRound}`]); failures++; }

// ---------------------------------------------------------------- report
console.log(`Rendering matrix = Blender matrix_world: ${renderChecked} props checked`);
console.log(`Free rotation (gizmo) vs add-on export: ${freeChecked} checked, ${freeExact} same numbers, rest same orientation`);
console.log(`Random angle→matrix→angle round trip worst error: ${worstRound.toExponential(1)}`);
console.log(`Import -> export untouched: ${lossless}/${out.length} lines lossless (incl. ${S.unknownLines.length} unrecognized kept)`);
console.log('');
const bad = rows.filter((r) => !String(r[3]).startsWith('SAME ORIENTATION'));
const equiv = rows.filter((r) => String(r[3]).startsWith('SAME ORIENTATION'));
console.log(`Same orientation, different numbers than the add-on: ${equiv.length} lines (add-on re-derives Euler angles)`);
const seen = new Set();
for (const r of equiv) {
  const k = r[1].split(',').slice(5, 8).join(',') + ' -> ' + r[2].split(',').slice(5, 8).join(',');
  if (seen.has(k) || seen.size >= 12) continue;
  seen.add(k);
  console.log(`   web ${r[1].split(',').slice(5, 8).join(',').padEnd(26)} add-on ${r[2].split(',').slice(5, 8).join(',')}   (${r[0]})`);
}
for (const r of equiv.filter((x) => String(x[0]).startsWith('free'))) console.log(`   ${r[0]}: web ${r[1]}  add-on ${r[2]}`);
for (const r of bad) console.log(r.map((c) => String(c).padEnd(8)).join(' | '));
console.log('');
console.log(failures ? `FAILURES: ${failures}` : 'ALL CHECKS PASSED (rows above are equivalent-orientation differences only)');
process.exit(failures ? 1 : 0);
