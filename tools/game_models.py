"""
The game's own prop models (.mcd + .mtls), read to texture the add-on's OBJs.

  model = prop_model(objs, folder, uvs_from_game)

For each OBJ it gives every triangle corner a UV and every triangle a
texture (group). The OBJs carry the game's UVs already, except a few (the
ladder's islands were moved around, the glass has none): for those the UVs
are read from the game's model. Props with more than one texture (apple skin
and inside, chainsaw body and blade, ...) get each triangle's texture from
the game triangle it sits on.

Where an OBJ sits on the game model: the game's model is the OBJ turned half
round x (or mirrored in z), centred; found by trying both, per mesh. Posed
states (a set-up chair or ladder) don't sit on it: there, each separate part
of the OBJ is matched to the game part with the same face count and shape,
fitted rigidly (mirrored too), and every triangle takes the UVs of the game
triangle it lands on. Look-alike parts (left and right rails) are told apart
by the UVs the resting OBJ already got.

.mcd layout (little-endian), as far as needed here:
  "MCD!" u32 | "MDL!" ... then chunks from 0x34: char[4] tag, u32 size, data
  TEXT: u32 n, u32 offsets[n], NUL-terminated strings
  MTL!: u32 n, n * (u16 string, u32 hash): the materials, "name:skinned"
  MBfD: the meshes' vertex streams. Each stream: 4 bytes, 8 bytes (the same
        in every file), u16 name, u16 format, u16 type (strings), u16 pad,
        then verts * size bytes, padded to 4; u32 verts, u32 streams just
        before a mesh's first stream (POSITION float3; TEXCOORD float2, v down)
  LODs: u32 lods, u32 meshes, then per LOD, per mesh: u16 mesh, u32 count,
        u16 indices, pad to 4, u32 n, n * (u32 material, start, count, max
        vertex), u32 0, "ENDM", u32 0
.mtls: "MTLs", u32 n, the material names, then one "MTL!" block each that
  names its textures (<name>_color, <name>_nrm, ...).
"""
import re
import struct
from collections import defaultdict
from itertools import permutations
from pathlib import Path

import numpy as np

FORMAT_SIZE = {
    ("R32_G32_B32", "float"): 12, ("R32_G32", "float"): 8, ("R8_G8_B8_A8", "unorm"): 4,
    ("R32", "uint"): 4, ("R8", "snorm"): 1, ("R8_G8_B8_A8", "uint"): 4,
    ("R8_G8_B8_A8", "snorm"): 4, ("R16_G16", "float"): 4, ("R32_G32_B32_A32", "float"): 16,
}
STREAM_TAG = bytes.fromhex("677d20255f8eb547")
# game -> OBJ: turned half round x, or mirrored in z
FLIPS = (np.array([1, -1, -1.0]), np.array([1, 1, -1.0]))


# ---------------------------------------------------------------- .mcd / .mtls

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


def _lod_blocks(b, lo, size):
    """Every index block: (mesh, indices, submeshes). Read back from its
    "ENDM", which is unambiguous (the blocks' heads vary)."""
    out, p = [], lo
    while True:
        e = b.find(b"ENDM", p, lo + size)
        if e < 0:
            return out
        p = e + 4
        if struct.unpack("<I", b[e - 4:e])[0] != 0:
            continue
        for k in range(1, 17):
            a = e - 4 - 16 * k - 4
            if struct.unpack("<I", b[a:a + 4])[0] != k:
                continue
            subs = [struct.unpack("<4I", b[a + 4 + 16 * i:a + 20 + 16 * i]) for i in range(k)]
            if subs[0][1] != 0 or any(subs[i][1] != subs[i - 1][1] + subs[i - 1][2] for i in range(1, k)):
                continue
            total = sum(s[2] for s in subs)
            for pad in (0, 2):
                s = a - pad - 2 * total
                if s - 6 >= lo and struct.unpack("<I", b[s - 4:s])[0] == total:
                    mesh = struct.unpack("<H", b[s - 6:s - 4])[0]
                    out.append((mesh, np.frombuffer(b, "<u2", total, s).astype(int), subs))
                    break
            else:
                continue
            break


def read_mcd(path):
    """The meshes (LOD 0): [{"pos" (N,3), "uv" (N,2) v down or None,
    "tris" (M,3), "mat" [material name per triangle]}]."""
    b = open(path, "rb").read()
    ch = _chunks(b)
    names = _strings(b, ch[b"TEXT"][0])
    mo = ch[b"MTL!"][0]
    nm = struct.unpack("<I", b[mo:mo + 4])[0]
    materials = [names[struct.unpack("<H", b[mo + 4 + 6 * i:mo + 6 + 6 * i])[0]].split(":")[0] for i in range(nm)]
    vo, vs = ch[b"MBfD"]
    verts = []
    for m in re.finditer(re.escape(STREAM_TAG), b[vo:vo + vs]):
        a = vo + m.start() - 4
        if names[struct.unpack("<H", b[a + 12:a + 14])[0]] != "POSITION":
            continue
        n, ns = struct.unpack("<II", b[a - 8:a])
        o, st = a, {}
        for _ in range(ns):
            ni, fi, ti = struct.unpack("<3H", b[o + 12:o + 18])
            o += 20
            st.setdefault(names[ni], o)
            o = (o + n * FORMAT_SIZE[(names[fi], names[ti])] + 3) & ~3
        pos = np.frombuffer(b, "<f4", n * 3, st["POSITION"]).reshape(-1, 3).astype(float)
        uv = np.frombuffer(b, "<f4", n * 2, st["TEXCOORD"]).reshape(-1, 2).astype(float) if "TEXCOORD" in st else None
        verts.append((pos, uv))
    lod0 = {}
    for mesh, idx, subs in _lod_blocks(b, *ch[b"LODs"]):
        lod0.setdefault(mesh, (idx, subs))  # LOD 0 comes first
    meshes = []
    for (pos, uv), mesh in zip(verts, sorted(lod0)):
        idx, subs = lod0[mesh]
        tris = idx.reshape(-1, 3)
        if len(tris) and tris.max() >= len(pos):
            raise ValueError(f"{path}: triangles don't fit mesh {mesh}")
        mat = [None] * len(tris)
        for mid, start, count, _ in subs:
            for t in range(start // 3, (start + count) // 3):
                mat[t] = materials[mid] if mid < len(materials) else None
        meshes.append({"pos": pos, "uv": uv, "tris": tris, "mat": mat})
    return meshes


def color_textures(mtls_path, texture_dir):
    """material name -> its color texture (a file in texture_dir) or None."""
    have = {p.stem.lower(): p for p in Path(texture_dir).glob("*.dds")}
    b = open(mtls_path, "rb").read()
    n = struct.unpack("<I", b[4:8])[0]
    blocks = b.split(b"MTL!")
    head = [x.decode("latin1") for x in re.findall(rb"[ -~]{2,}", blocks[0])]
    names = head[1:1 + n] if head and head[0] == "MTLs" else head[:n]
    out = {}
    for name, blk in zip(names, blocks[1:]):
        texs = [have[t.lower()] for t in (x.decode("latin1") for x in re.findall(rb"[ -~]{3,}", blk)) if t.lower() in have]
        color = [t for t in texs if "color" in t.stem.lower()] or [t for t in texs if not t.stem.lower().endswith(("_nrm", "_emissive"))]
        out[name] = color[0] if color else None
    return out


def model_files(folder):
    """The prop's main .mcd (not the *_low one, unless that's all) and .mtls."""
    folder = Path(folder)
    mcds = sorted(folder.glob("*.mcd"), key=lambda p: p.stem.lower().endswith("_low"))
    mtls = next(folder.glob("*.mtls"), None)
    return (mcds[0] if mcds else None), mtls


# ---------------------------------------------------------------- posed parts

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


# ---------------------------------------------------------------- where an OBJ sits

def _center(p):
    return (p.min(0) + p.max(0)) / 2


def _grid(p, cell=0.05):
    g = defaultdict(list)
    for j, k in enumerate(np.floor(p / cell).astype(int)):
        g[tuple(k)].append(j)
    return g


def _near(g, p, x, tol=1e-2, cell=0.05):
    k = np.floor(x / cell).astype(int)
    return [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
            for j in g.get((k[0] + dx, k[1] + dy, k[2] + dz), ()) if np.abs(p[j] - x).max() < tol]


def _joined(meshes, ids):
    pos, uv, tris, mat, n = [], [], [], [], 0
    for i in ids:
        m = meshes[i]
        pos.append(m["pos"])
        uv.append(m["uv"] if m["uv"] is not None else np.zeros((len(m["pos"]), 2)))
        tris.append(m["tris"] + n)
        mat += m["mat"]
        n += len(m["pos"])
    return np.concatenate(pos), np.concatenate(uv), np.concatenate(tris), mat


def placement(v, meshes):
    """(share of the OBJ's points found on the game model, mesh ids, the OBJ
    moved into the game's space)."""
    sets = [[i] for i in range(len(meshes))] + ([[0, 1]] if len(meshes) > 1 else [])
    best = (0.0, [0], None)
    step = max(1, len(v) // 400)
    for ids in sets:
        p = _joined(meshes, ids)[0]
        g = _grid(p)
        for flip in FLIPS:
            inside = (v - (_center(v) - _center(p * flip))) * flip
            share = float(np.mean([bool(_near(g, p, x)) for x in inside[::step]]))
            if share > best[0] + 1e-9:
                best = (share, ids, inside)
    return best


def faces_in_place(inside, f, gp, gt):
    """For each OBJ triangle, the game triangle at the same spot (-1 if none)
    and which game vertex each corner is."""
    g = _grid(gp)
    cand = [set(_near(g, gp, x)) for x in inside]
    touching = defaultdict(set)
    for t, tri in enumerate(gt):
        for j in tri:
            touching[j].add(t)
    face_tri = np.full(len(f), -1)
    corner = np.zeros((len(f), 3), int)
    for k, tri in enumerate(f):
        if any(not cand[i] for i in tri):
            continue
        common = set.intersection(*[set().union(*(touching[j] for j in cand[i])) for i in tri])
        if not common:
            continue
        t = min(common)
        face_tri[k] = t
        for c, i in enumerate(tri):
            corner[k, c] = next(j for j in gt[t] if j in cand[i])
    return face_tri, corner


# ---------------------------------------------------------------- per prop

def _key(t):
    return (round(float(t[0]), 5), round(float(t[1]), 5))


def prop_model(objs, folder, uvs_from_game):
    """objs: {name: (positions (N,3), triangles (M,3), uv index per corner
    (M,3), uvs (K,2))}. uvs_from_game: take the UVs from the game's model.
    Returns ({name: (corner UVs (M,3,2) v up, texture group per triangle (M,))},
    [texture file (Path) or None per group])."""
    mcd, mtls = model_files(folder)
    meshes = read_mcd(mcd)
    colors = color_textures(mtls, Path(folder) / "Textures") if mtls else {}
    placed = {name: placement(o[0], meshes) for name, o in objs.items()}
    # the resting OBJ (best on the model) goes first; it helps the posed ones
    order = sorted(objs, key=lambda n: -placed[n][0])
    known = defaultdict(set)  # an OBJ uv value -> the game uvs it got
    per_face = {}  # name -> (uvs, texture per triangle)
    for name in order:
        v, f, fi, vt = objs[name]
        share, ids, inside = placed[name]
        gp, guv, gt, gmat = _joined(meshes, ids)
        in_place = share >= 0.5
        face_tri = np.full(len(f), -1)
        uvs = None
        if in_place:
            face_tri, corner = faces_in_place(inside, f, gp, gt)
            uvs = np.where((face_tri >= 0)[:, None, None], guv[corner], 0.0)
        need_game_uv = uvs_from_game or not len(vt)
        if need_game_uv and (face_tri < 0).any():
            clear = {k for k, s in known.items() if len(s) == 1}

            def vote(fs, cu):
                s = 0
                for k, us in zip(fs, cu):
                    for c, u in zip(fi[k], us):
                        if len(vt) and _key(vt[c]) in clear:
                            s += _key(u) in known[_key(vt[c])]
                return s

            moved, _ = _transfer(inside if in_place else v, f, gp, guv, gt, in_place, vote if known else None)
            uvs = moved if uvs is None else np.where((face_tri >= 0)[:, None, None], uvs, moved)
        if need_game_uv:
            if len(vt):
                for k in range(len(f)):
                    for c, u in zip(fi[k], uvs[k]):
                        known[_key(vt[c])].add(_key(u))
            uvs = uvs.copy()
            uvs[..., 1] = 1 - uvs[..., 1]  # the game's v runs down
        else:
            uvs = vt[fi]
        # textures: from the game triangle under each one; elsewhere the
        # model's main one
        mats = [gmat[t] if t >= 0 else None for t in face_tri]
        texs = [colors.get(m) for m in mats]
        tally = defaultdict(int)
        for m in gmat:
            if colors.get(m):
                tally[colors[m]] += 1
        main = max(tally, key=tally.get) if tally else None
        texs = [t if (t or mats[k] is not None) else main for k, t in enumerate(texs)]
        per_face[name] = (uvs, texs)
    # groups: textures by how many triangles use them, untextured last
    count = defaultdict(int)
    for _, texs in per_face.values():
        for t in texs:
            count[t] += 1
    groups = sorted(count, key=lambda t: (t is None, -count[t]))
    index = {t: i for i, t in enumerate(groups)}
    out = {name: (uvs, np.array([index[t] for t in texs])) for name, (uvs, texs) in per_face.items()}
    return out, groups
