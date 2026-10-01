"""
Texture coordinates for the add-on's prop OBJs, taken from the game's own
model (.mcd), so the game's textures land where the game puts them.

The add-on's OBJs have the game's shapes, but their UVs were moved around
(islands shifted and mirrored), so the game textures don't fit them. The
.mcd has the right ones. Its rest pose is the prop lying on the ground; the
OBJs of other states (a set-up chair or ladder) are the same parts moved.

  uvs = obj_uvs(positions, faces, mcd_path)   # (faces, 3, 2), v up (OBJ style)

How: the model is split into its separate parts (642 for the ladder). Each
OBJ part is matched to the game part with the same face count and shape,
fitted rigidly (mirrored too), and every OBJ triangle takes the UVs of the
game triangle it lands on. Parts that sit where they are in the game model
are taken as they are. In posed states, parts that look alike (left and
right rails) are told apart by the UVs the rest-pose OBJ already got.

.mcd layout (little-endian), as far as needed here:
  "MCD!" u32 | "MDL!" u32 hdr... then chunks: char[4] tag, u32 size, data
  TEXT: u32 n, u32 offsets[n], NUL-terminated strings
  MBfD: u32 meshes, 4 u32, 6 f32 bbox; per mesh: u32 verts, u32 streams;
        per stream: 12 bytes, u16 name, u16 format, u16 type, u16 pad,
        then verts * size bytes, padded to 4. POSITION float3, TEXCOORD float2.
  LODs: u32 count, u32, u16, u32 index count, u16 indices (mesh 0, LOD 0)
"""
import struct
from collections import defaultdict
from itertools import permutations

import numpy as np

FORMAT_SIZE = {
    ("R32_G32_B32", "float"): 12, ("R32_G32", "float"): 8, ("R8_G8_B8_A8", "unorm"): 4,
    ("R32", "uint"): 4, ("R8", "snorm"): 1, ("R8_G8_B8_A8", "uint"): 4,
    ("R8_G8_B8_A8", "snorm"): 4, ("R16_G16", "float"): 4, ("R32_G32_B32_A32", "float"): 16,
}


# ---------------------------------------------------------------- .mcd

def _chunks(b):
    o, out = 0x34, {}
    while o + 8 <= len(b):
        tag = b[o:o + 4]
        size = struct.unpack("<I", b[o + 4:o + 8])[0]
        if tag in (b"HPL!", b"END!"):
            break
        out.setdefault(tag, (o + 8, size))
        o += 8 + size
    return out


def _strings(b, o):
    n = struct.unpack("<I", b[o:o + 4])[0]
    offs = struct.unpack(f"<{n}I", b[o + 4:o + 4 + 4 * n])
    base = o + 4 + 4 * n
    return [b[base + x:b.index(b"\0", base + x)].decode("latin1") for x in offs]


def read_mcd(path):
    """First mesh of a .mcd: positions (N,3), UVs (N,2, v down), triangles (M,3)."""
    b = open(path, "rb").read()
    ch = _chunks(b)
    names = _strings(b, ch[b"TEXT"][0])
    o = ch[b"MBfD"][0] + 4 + 16 + 24
    n, nstreams = struct.unpack("<II", b[o:o + 8])
    o += 8
    streams = {}
    for _ in range(nstreams):
        ni, fi, ti = struct.unpack("<3H", b[o + 12:o + 18])
        size = FORMAT_SIZE[(names[fi], names[ti])]
        o += 20
        streams.setdefault(names[ni], o)
        o = (o + n * size + 3) & ~3
    pos = np.frombuffer(b, "<f4", n * 3, streams["POSITION"]).reshape(-1, 3).astype(float)
    uv = np.frombuffer(b, "<f4", n * 2, streams["TEXCOORD"]).reshape(-1, 2).astype(float)
    lo = ch[b"LODs"][0]
    count = struct.unpack("<I", b[lo + 10:lo + 14])[0]
    tris = np.frombuffer(b, "<u2", count, lo + 14).astype(int).reshape(-1, 3)
    if tris.max() >= n:
        raise ValueError(f"{path}: index buffer doesn't fit the mesh")
    return pos, uv, tris


# ---------------------------------------------------------------- matching

def _parts(nv, tris):
    parent = list(range(nv))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for t in tris:
        r = find(t[0])
        for x in t[1:]:
            parent[find(x)] = r
    label = [find(i) for i in range(nv)]
    groups = defaultdict(list)
    for k, t in enumerate(tris):
        groups[label[t[0]]].append(k)
    return list(groups.values())


def _signature(x):
    d = np.sort(np.linalg.norm(x - x.mean(0), axis=1))
    return np.interp(np.linspace(0, 1, 32), np.linspace(0, 1, len(d)), d)


def _kabsch(a, b):
    ca, cb = a.mean(0), b.mean(0)
    u, _, vt = np.linalg.svd((a - ca).T @ (b - cb))
    d = np.diag([1, 1, np.sign(np.linalg.det(vt.T @ u.T))])
    r = vt.T @ d @ u.T
    return r, cb - r @ ca


def _fit(a, b, iters=15):
    """Rigid fit of points a onto points b (no correspondence): (max error, (R, t))."""
    ca, cb = a.mean(0), b.mean(0)
    ua = np.linalg.svd(a - ca, full_matrices=False)[2]
    ub = np.linalg.svd(b - cb, full_matrices=False)[2]
    best = (np.inf, None)
    for sx in (1, -1):
        for sy in (1, -1):
            r = ub.T @ np.diag([sx, sy, sx * sy]) @ ua
            if np.linalg.det(r) < 0:
                r = ub.T @ np.diag([sx, sy, -sx * sy]) @ ua
            t = cb - r @ ca
            for _ in range(iters):
                nn = np.argmin((((a @ r.T + t)[:, None] - b[None]) ** 2).sum(-1), 1)
                r, t = _kabsch(a, b[nn])
            err = np.sqrt((((a @ r.T + t)[:, None] - b[None]) ** 2).sum(-1).min(1)).max()
            if err < best[0]:
                best = (err, (r, t))
    return best


def _take_uvs(v, f, fs, gp, guv, gt, gfs, r, t, m):
    corners = gp[gt[gfs]]
    out = np.zeros((len(fs), 3, 2))
    err = np.zeros(len(fs))
    for i, k in enumerate(fs):
        x = (v[f[k]] * m) @ r.T + t
        best = (np.inf, None)
        for perm in permutations(range(3)):
            d = np.linalg.norm(corners[:, list(perm)] - x[None], axis=2).max(1)
            j = int(np.argmin(d))
            if d[j] < best[0]:
                best = (d[j], (gfs[j], perm))
        e, (j, perm) = best
        out[i] = guv[gt[j][list(perm)]]
        err[i] = e
    return out, err


def _transfer(v, f, gp, guv, gt, in_place, vote=None):
    gparts = _parts(len(gp), gt)
    gsig = [(_signature(gp[np.unique(gt[fs])]), len(fs), gp[np.unique(gt[fs])]) for fs in gparts]
    out = np.zeros((len(f), 3, 2))
    err = np.full(len(f), np.inf)
    eye = (np.eye(3), np.zeros(3))
    for fs in _parts(len(v), f):
        pv = v[np.unique(f[fs])]
        sig = _signature(pv)
        scored = sorted((np.abs(s - sig).max(), g) for g, (s, n, _) in enumerate(gsig) if n == len(fs))
        if not scored:
            continue
        cands = [g for d, g in scored if d <= scored[0][0] + 0.05][:12]
        if in_place:
            c0 = pv.mean(0)
            here = [g for _, g in scored if np.linalg.norm(gsig[g][2].mean(0) - c0) < 2]
            cands = here + [g for g in cands if g not in here]
        options = []
        for g in cands:
            gv = gsig[g][2]
            if in_place:
                e = np.sqrt(((pv[:, None] - gv[None]) ** 2).sum(-1).min(1)).max()
                if e < 1e-2:
                    options.append((e, g, eye, np.ones(3)))
                    continue
            for m in (np.ones(3), np.array([1, 1, -1.0])):  # mirrored twins too
                e, rt = _fit(pv * m, gv)
                options.append((e, g, rt, m))
        emin = min(o[0] for o in options)
        best = None
        for e, g, (r, t), m in (o for o in options if o[0] <= emin + 0.05):
            uvs, errs = _take_uvs(v, f, fs, gp, guv, gt, gparts[g], r, t, m)
            score = (vote(fs, uvs) if vote else 0, -e)
            if best is None or score > best[0]:
                best = (score, uvs, errs)
        out[fs], err[fs] = best[1], best[2]
    return out, err


# ---------------------------------------------------------------- per prop

def _key(t):
    return (round(float(t[0]), 5), round(float(t[1]), 5))


def prop_uvs(objs, mcd_path):
    """objs: {name: (positions (N,3), faces (M,3), obj_uv_index (M,3), obj_vt (K,2))}.
    Returns {name: (M,3,2) UVs, v up}. The OBJ that lies like the game's model
    (the ground state) goes first and helps tell look-alike parts apart in
    the others."""
    gp, guv, gt = read_mcd(mcd_path)
    # OBJ space: the game's z is flipped, and the model sits on the floor
    gm = gp * [1, 1, -1]
    known = defaultdict(set)  # an OBJ uv value -> the game uvs it got
    order = []
    for name, (v, f, fi, vt) in objs.items():
        off = (v.min(0) + v.max(0)) / 2 - (gm.min(0) + gm.max(0)) / 2
        inside = (v - off) * [1, 1, -1]
        near = np.sqrt(((inside[::7, None] - gp[None]) ** 2).sum(-1).min(1))
        order.append((-(near < 1e-2).mean(), name, inside))
    out = {}
    for score, name, inside in sorted(order, key=lambda o: o[0]):
        v, f, fi, vt = objs[name]
        in_place = score < -0.5
        clear = {k for k, s in known.items() if len(s) == 1}

        def vote(fs, uvs):
            s = 0
            for k, cu in zip(fs, uvs):
                for c, u in zip(fi[k], cu):
                    kk = _key(vt[c])
                    if kk in clear:
                        s += _key(u) in known[kk]
            return s

        uvs, _ = _transfer(inside if in_place else v, f, gp, guv, gt, in_place, vote if known else None)
        for k in range(len(f)):
            for c, u in zip(fi[k], uvs[k]):
                known[_key(vt[c])].add(_key(u))
        uvs[..., 1] = 1 - uvs[..., 1]  # the game's v runs down
        out[name] = uvs
    return out
