// Mesh loading. Built-in meshes are .bin files produced by tools/build_assets.py;
// custom props are parsed from OBJ in the browser. Files are in OBJ space
// (Y up); on load they get the same axis conversion Blender's OBJ importer
// applies, so every geometry here is in Blender space (Z up).

import * as THREE from 'three';
import { catalog, getProp } from './catalog.js';

const cache = new Map(); // id -> { promise, geom, failed }

export function makeGeometry(positions, indices) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.rotateX(Math.PI / 2); // OBJ (x, y, z) -> Blender (x, -z, y)
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function parseBin(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'PPG1') throw new Error('Bad mesh file');
  const vc = dv.getUint32(4, true);
  const ic = dv.getUint32(8, true);
  const ib = dv.getUint32(12, true);
  const positions = new Float32Array(buf, 16, vc * 3);
  const off = 16 + vc * 12;
  const indices = ib === 2 ? new Uint16Array(buf, off, ic) : new Uint32Array(buf, off, ic);
  return makeGeometry(positions, indices);
}

export function parseObj(text) {
  const pos = [];
  const idx = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.trim().split(/\s+/);
      pos.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('f ')) {
      const n = pos.length / 3;
      const f = line.trim().split(/\s+/).slice(1).map((t) => {
        const i = parseInt(t, 10);
        return i > 0 ? i - 1 : n + i;
      });
      for (let k = 1; k < f.length - 1; k++) idx.push(f[0], f[k], f[k + 1]);
    }
  }
  if (!pos.length || !idx.length) throw new Error('OBJ has no faces');
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function load(id, url) {
  let entry = cache.get(id);
  if (entry) return entry.promise;
  entry = { geom: null, failed: false };
  entry.promise = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => (entry.geom = parseBin(buf)))
    .catch((e) => {
      entry.failed = true;
      throw e;
    });
  cache.set(id, entry);
  return entry.promise;
}

const propId = (key, state) => `${key}\u0000${state}`;

export function getGeometry(key, state) {
  const pd = getProp(key);
  if (!pd || !(state in pd.states)) return Promise.reject(new Error(`Unknown prop ${key}/${state}`));
  const id = propId(key, state);
  if (pd.custom) {
    let entry = cache.get(id);
    if (!entry) {
      const g = makeGeometry(new Float32Array(pd.custom.positions), new Uint32Array(pd.custom.indices));
      entry = { geom: g, failed: false, promise: Promise.resolve(g) };
      cache.set(id, entry);
    }
    return entry.promise;
  }
  return load(id, `assets/models/${pd.states[state]}`);
}

export function geomNow(key, state) {
  return cache.get(propId(key, state))?.geom || null;
}

export function geomFailed(key, state) {
  return !!cache.get(propId(key, state))?.failed;
}

export function loadEnvGeometry(envId) {
  return load(`env:${envId}`, `assets/models/${catalog.envModels[envId]}`);
}

// Mesh extent along a horizontal direction (dx, dy). Same idea as the
// add-on's _mesh_span: project every vertex, take max - min.
export function spanAlong(geom, dx, dy) {
  const p = geom.attributes.position.array;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const v = dx * p[i] + dy * p[i + 1];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Math.max(hi - lo, 0.1);
}

export function heightOf(geom) {
  const b = geom.boundingBox;
  return Math.max(b.max.z - b.min.z, 0.1);
}

export function footprintOf(geom) {
  const b = geom.boundingBox;
  return Math.max(b.max.x - b.min.x, b.max.y - b.min.y);
}
