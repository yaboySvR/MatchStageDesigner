// The game's prop set files (PropsSet_*.jsfb): FlatBuffers binaries with the
// file identifier "Prop". A port of propset.py (the reference implementation,
// see ../jsfb's/README.md): the same schema, worked out from the game's files,
// and a writer that lays bytes out like the C++ FlatBufferBuilder, so a file
// that wasn't edited encodes to exactly the bytes it came from.
//
//   PropSet  props: [Prop] (id 0), unk1: uint (id 1)
//   Prop     prop_id: uint, unk1: uint, position: Vec3, rotation: Vec3,
//            scale: Vec3, state: ushort, unk6: [uint], unk7: ubyte,
//            (id 8 unknown), unk9: uint, (id 10 unknown), unk11: uint,
//            unk12: ubyte
//   Vec3     x, y, z: float   (a table, not a struct)
//
// Every field is optional. decode() returns only the fields a file stores (a
// missing one means its default: 0, or an empty list), and encode() writes
// exactly the fields it is given. Floats keep their float32 value, -0 included.

const IDENT = 'Prop';
const VEC3 = [['x', 'f'], ['y', 'f'], ['z', 'f']];
const PROP = [
  ['prop_id', 'I'], ['unk1', 'I'], ['position', VEC3], ['rotation', VEC3], ['scale', VEC3],
  ['state', 'H'], ['unk6', { vec: 'I' }], ['unk7', 'B'], null, ['unk9', 'I'], null, ['unk11', 'I'], ['unk12', 'B'],
];
const ROOT = [['props', { vec: PROP }], ['unk1', 'I']];

// Types: 'B' u8, 'H' u16, 'I' u32, 'f' float32; an array is a table (fields
// by id, null for ids never seen); { vec } is a vector.
const SIZE = { B: 1, H: 2, I: 4, f: 4 };
const MAX = { B: 0xff, H: 0xffff, I: 0xffffffff };
const size = (t) => (typeof t === 'string' ? SIZE[t] : 4); // tables and vectors are 4-byte offsets

// ---------------------------------------------------------------- decoding

function readScalar(dv, pos, t) {
  switch (t) {
    case 'B': return dv.getUint8(pos);
    case 'H': return dv.getUint16(pos, true);
    case 'I': return dv.getUint32(pos, true);
    default: return dv.getFloat32(pos, true);
  }
}

// The field stored at pos: an inline scalar, or an offset to a table / vector.
function readValue(dv, pos, t) {
  if (typeof t === 'string') return readScalar(dv, pos, t);
  pos += dv.getUint32(pos, true);
  if (t.vec) {
    const n = dv.getUint32(pos, true);
    return Array.from({ length: n }, (_, i) => readValue(dv, pos + 4 + i * size(t.vec), t.vec));
  }
  const vt = pos - dv.getInt32(pos, true);
  const fields = (dv.getUint16(vt, true) - 4) / 2;
  const table = {};
  for (let fid = 0; fid < fields; fid++) {
    const off = dv.getUint16(vt + 4 + 2 * fid, true);
    if (!off) continue;
    if (!t[fid]) throw new Error(`table at 0x${pos.toString(16).toUpperCase()} has field id ${fid}, which the schema does not know`);
    const [name, ft] = t[fid];
    table[name] = readValue(dv, pos + off, ft);
  }
  return table;
}

// .jsfb bytes -> { props: [...], unk1 }
export function decode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ident = bytes.byteLength >= 8 ? String.fromCharCode(...bytes.subarray(4, 8)) : '';
  if (ident !== IDENT) throw new Error('not a prop set file');
  try {
    return readValue(dv, 0, ROOT);
  } catch (e) {
    if (e instanceof RangeError) throw new Error('the file is damaged (data runs past its end)');
    throw e;
  }
}

// ---------------------------------------------------------------- encoding

// Back-to-front builder, laid out like the C++ FlatBufferBuilder. Positions
// are measured from the end of the buffer, which is where building starts.
class Builder {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.head = this.buf.length; // data lives in buf[head..]
    this.minalign = 1;
    this.vtables = [];           // positions of written vtables
  }

  get size() { return this.buf.length - this.head; }

  reserve(n) {
    if (this.head >= n) return;
    let cap = this.buf.length * 2;
    while (cap - this.size < n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(this.head), cap - this.size);
    this.head = cap - this.size;
    this.buf = next;
  }

  put(bytes) {
    this.reserve(bytes.length);
    this.head -= bytes.length;
    this.buf.set(bytes, this.head);
  }

  // Pad so that data aligned to `align` can follow once `extra` more bytes are written.
  prep(align, extra = 0) {
    this.minalign = Math.max(this.minalign, align);
    this.put(new Uint8Array((((-(this.size + extra)) % align) + align) % align));
  }

  // Packed scalar bytes, or (given a position) an offset pointing at it.
  push(item) {
    if (typeof item === 'number') {
      this.prep(4);
      item = u32(this.size + 4 - item);
    }
    this.prep(item.length);
    this.put(item);
    return this.size;
  }

  vector(items, elemSize) {
    this.prep(4, elemSize * items.length);
    this.prep(elemSize, elemSize * items.length);
    for (let i = items.length - 1; i >= 0; i--) this.push(items[i]);
    return this.push(u32(items.length));
  }

  // fields: [[field id, packed scalar or position]] in the order they get added.
  table(fields) {
    const start = this.size;
    const locs = fields.map(([fid, item]) => [fid, this.push(item)]);
    const obj = this.push(new Uint8Array(4)); // offset to the vtable, patched below
    const vt = new Uint8Array(4 + 2 * (Math.max(-1, ...locs.map(([fid]) => fid)) + 1));
    const vdv = new DataView(vt.buffer);
    vdv.setUint16(0, vt.length, true);
    vdv.setUint16(2, obj - start, true);
    for (const [fid, loc] of locs) vdv.setUint16(4 + 2 * fid, obj - loc, true);
    // Share an identical earlier vtable instead of writing another.
    let vtPos = this.vtables.find((p) => sameBytes(this.buf.subarray(this.buf.length - p, this.buf.length - p + vt.length), vt));
    if (vtPos === undefined) {
      this.put(vt);
      vtPos = this.size;
      this.vtables.push(vtPos);
    }
    new DataView(this.buf.buffer).setInt32(this.buf.length - obj, vtPos - obj, true);
    return obj;
  }

  finish(root) {
    this.prep(this.minalign, 4 + IDENT.length);
    this.put(Uint8Array.from(IDENT, (c) => c.charCodeAt(0)));
    this.push(root);
    return this.buf.slice(this.head);
  }
}

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function pack(v, t, path) {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`${path}: expected a number`);
  if (t !== 'f' && !(Number.isInteger(v) && v >= 0 && v <= MAX[t])) throw new Error(`${path}: ${v} is out of range`);
  const b = new Uint8Array(SIZE[t]);
  const dv = new DataView(b.buffer);
  if (t === 'B') dv.setUint8(0, v);
  else if (t === 'H') dv.setUint16(0, v, true);
  else if (t === 'I') dv.setUint32(0, v, true);
  else dv.setFloat32(0, v, true);
  return b;
}

// Serialize a table or vector (children first) and return its position.
function build(b, value, t, path) {
  if (t.vec) {
    if (!Array.isArray(value)) throw new Error(`${path}: expected a list`);
    const items = value.map((v, i) => (typeof t.vec === 'string'
      ? pack(v, t.vec, `${path}[${i}]`)
      : build(b, v, t.vec, `${path}[${i}]`)));
    return b.vector(items, size(t.vec));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path || 'top level'}: expected an object`);
  const known = new Set(t.filter(Boolean).map(([name]) => name));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`${path || 'top level'}: unknown field "${key}"`);
  }
  const fields = [];
  t.forEach((f, fid) => {
    if (!f || !(f[0] in value)) return;
    const [name, ft] = f;
    const sub = path ? `${path}.${name}` : name;
    fields.push([fid, typeof ft === 'string' ? pack(value[name], ft, sub) : build(b, value[name], ft, sub)]);
  });
  // Same order flatc uses: biggest fields first, equal sizes from the last field id to the first.
  const width = (item) => (typeof item === 'number' ? 4 : item.length);
  fields.sort((a, c) => width(c[1]) - width(a[1]) || c[0] - a[0]);
  return b.table(fields);
}

// { props: [...], unk1 } -> .jsfb bytes
export function encode(doc) {
  const b = new Builder();
  return b.finish(build(b, doc, ROOT, ''));
}
