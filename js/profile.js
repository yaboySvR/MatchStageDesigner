// .propsprofile read/write. Same line format as the Blender add-on
// (tools/export.py):
//   PROP,{prop_id},{x},{y},{z},{rx},{ry},{rz},{state_id};
// Position is Blender world space. Rotation values are carried through
// verbatim; see rotation.js for how they map to an orientation.

import { catalog, getProp, stateId } from './catalog.js';
import { pyFixed3 } from './rotation.js';

export function profileLine(p) {
  const pd = getProp(p.key);
  const sid = stateId(p.state);
  if (!pd || sid === undefined) return null;
  const f = pyFixed3;
  return `PROP,${pd.prop_id},${f(p.x)},${f(p.y)},${f(p.z)},${f(p.rx)},${f(p.ry)},${f(p.rz)},${sid};\n`;
}

export function exportProfile(props, unknownLines = []) {
  return props.map(profileLine).filter(Boolean).join('') + unknownLines.map((l) => `${l}\n`).join('');
}

// (prop_id, state id) -> [key, state] of the catalog prop, or null.
export function catalogMatcher() {
  const map = new Map(); // "pid:sid" -> [key, state]
  const reverseStates = new Map(Object.entries(catalog.stateDefs).map(([k, v]) => [v, k]));
  for (const pd of catalog.props.values()) {
    for (const st of pd.stateOrder) {
      const sid = stateId(st);
      if (sid !== undefined && !map.has(`${pd.prop_id}:${sid}`)) map.set(`${pd.prop_id}:${sid}`, [pd.key, st]);
    }
  }
  return (pid, sid) => {
    const hit = map.get(`${pid}:${sid}`);
    if (hit) return hit;
    const st = reverseStates.get(sid);
    const pd = st && [...catalog.props.values()].find((p) => p.prop_id === pid && st in p.states);
    return pd ? [pd.key, st] : null;
  };
}

// Returns known props plus the raw text of entries that match no prop
// (the add-on drops those; we keep them so editing a profile loses nothing).
export function parseProfile(text) {
  const match = catalogMatcher();
  const items = [];
  const unknown = [];
  let invalid = 0;
  for (let entry of text.split(';')) {
    entry = entry.trim();
    if (!entry) continue;
    const parts = entry.split(',').map((s) => s.trim());
    if (parts.length < 9 || parts[0] !== 'PROP') { invalid++; continue; }
    const pid = parseInt(parts[1], 10);
    const [x, y, z, rx, ry, rz] = parts.slice(2, 8).map(Number);
    const sid = parseInt(parts[8], 10);
    if ([pid, x, y, z, rx, ry, rz, sid].some(Number.isNaN)) { invalid++; continue; }

    const hit = match(pid, sid);
    if (!hit) { unknown.push(`${entry};`); continue; }
    items.push({ key: hit[0], state: hit[1], x, y, z, rx, ry, rz });
  }
  return { items, unknown, invalid };
}

// data: text, or bytes (Uint8Array) for a binary file.
export function download(filename, data) {
  const type = typeof data === 'string' ? 'text/plain' : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
