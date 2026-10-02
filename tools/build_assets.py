"""
Build web assets from the Blender add-on data.

  python web/tools/build_assets.py [--game-props <folder>]

Reads  props/Prop_Models/*.obj, props/Prop_Models/props.json, icons/*.png,
       tools/wheel_tool.py (ICON_MAP / ICON_MAP_ALT)
       --game-props: the game's extracted Props folder (one "<id>_<name>"
       folder per prop, with its .mcd/.mtls model and Textures/*.dds); only
       needed to (re)make the textures. Without it, textured props keep the
       meshes and textures they have.
Writes web/assets/models/<name>.bin       compact indexed meshes (lowercase names)
       web/assets/icons/<name>.webp        256px icons
       web/assets/textures/<key>[_n].webp  the props' color textures
       web/assets/models/env_<id>.bin and textures/env_<id>[_n].webp: the
       arena pieces made from game models (GAME_ENV)
       web/data/catalog.json               props + state ids + icon map for the web app

Mesh .bin layout (little-endian):
  char[4] "PPG1" | uint32 vertCount | uint32 indexCount | uint32 indexBytes (2|4)
  float32[vertCount*3] positions (OBJ space, Y-up) | uint16/uint32[indexCount] indices
Textured props use "PPG2": the same, with float32[vertCount*2] UVs (v up)
between the positions and the indices. Props with more than one texture use
"PPG3": after the header, uint32 groupCount and uint32[groupCount] index
counts (the triangles sorted by texture, catalog "textures" in that order),
then as PPG2.

Textures and which triangle gets which come from the game's own model
(game_models.py). The UVs are the OBJs' own (they are the game's), except
for UVS_FROM_GAME props, whose OBJ UVs don't fit the game textures.
"""
import argparse
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS_SRC = ROOT / "props" / "Prop_Models"
ICONS_SRC = ROOT / "icons"
WHEEL_PY = ROOT / "tools" / "wheel_tool.py"

WEB = ROOT / "web"
MODELS_OUT = WEB / "assets" / "models"
TEXTURES_OUT = WEB / "assets" / "textures"
ICONS_OUT = WEB / "assets" / "icons"
DATA_OUT = WEB / "data"

# Arena pieces: web id -> source OBJ (same names the add-on uses)
ENV_MODELS = {
    "ringmat": "ringmat.obj",
    "barricade": "barricade.obj",
    "floor": "floor.obj",
    "ramp": "ramp.obj",
    "stage": "stage.obj",
    "ec": "EC.obj",
    "hiac": "HIAC.obj",
    "wg": "Wargames_cage.obj",
    "amb": "ambulance.obj",
}

# Arena pieces made from the game's own model (with its textures), where the
# match's vanilla prop set puts them: web id -> (game prop id, game position
# x, y, z, turn round the game's y in degrees). The cages aren't in their
# prop sets (the game brings them), so they stand at the centre. Needs
# --game-props; until then the ones with an OBJ (ENV_MODELS) use it.
GAME_ENV = {
    "amb": (6454, (77.4000015258789, 0, 1180), 180),
    "cage": (2064, (0, 0, 0), 0),
    "dumpster": (9300, (0, 0, 364.01239013671875), 0),
    "casket": (9299, (0, 0, 364.01239013671875), 0),
    "hiac": (2066, (0, 0, 0), 0),  # the classic (silver) cell
    "wg": (2080, (0, 0, 0), 0),
    "ec": (6312, (0, 0, 0), 0),
}
# Their OBJs have the ring in them too (WarGames: both), which the game's
# models don't: it's split off into a piece of its own.
RING_IN_OBJ = {"hiac", "wg", "ec"}

ICON_SIZE = 256

# Props whose OBJ UVs don't fit the game texture (the ladder's islands were
# moved around; the glass has none): their UVs are read from the game's model.
UVS_FROM_GAME = {"LADDER", "GLASS"}
# Props left in their plain color.
NO_TEXTURE = set()
# Props whose game color texture is one flat color, the look being in the
# rest of the material: the bump (normal) map gets used too, and its alpha
# (the seams) darkens the color (the steel steps' diamond plate).
NORMAL_MAPS = {"STEEL"}
# See-through props: as see-through as their game texture's alpha says.
SEE_THROUGH = {"GLASS"}
TEXTURE_SIZE = 1024

# Props in props.json that the web app leaves out (commentary table + cover).
# Profiles that contain them still round-trip: their lines are kept verbatim.
EXCLUDE_KEYS = {"AT", "AT_COVER"}


def find_case_insensitive(folder: Path, name: str):
    exact = folder / name
    if exact.exists():
        return exact
    low = name.lower()
    for p in folder.iterdir():
        if p.name.lower() == low:
            return p
    return None


def read_obj(src: Path):
    """Positions [(x, y, z)], uvs [(u, v)], triangles [((v, vt), (v, vt), (v, vt))]
    (0-based; vt -1 when a corner has none). Polygons are fanned."""
    positions, uvs, tris = [], [], []
    with open(src, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.startswith("v "):
                parts = line.split()
                positions.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif line.startswith("vt "):
                parts = line.split()
                uvs.append((float(parts[1]), float(parts[2])))
            elif line.startswith("f "):
                n, nt = len(positions), len(uvs)
                corners = []
                for tok in line.split()[1:]:
                    t = tok.split("/")
                    i = int(t[0])
                    j = int(t[1]) if len(t) > 1 and t[1] else 0
                    corners.append((i - 1 if i > 0 else n + i, j - 1 if j > 0 else (nt + j if j < 0 else -1)))
                for k in range(1, len(corners) - 1):  # triangle fan
                    tris.append((corners[0], corners[k], corners[k + 1]))
    return positions, uvs, tris


def convert_obj(src: Path, dst: Path, textured=None):
    """textured: (one (u, v) per triangle corner, texture group per triangle)."""
    positions, _, tris = read_obj(src)
    groups = []
    if textured is not None:
        corner_uvs, group = textured
        order = sorted(range(len(tris)), key=lambda t: group[t])
        ngroups = max(group) + 1 if len(group) else 1
        groups = [0] * ngroups
        # A vertex is a (position, uv) pair, so seams get their own copies.
        out_pos, out_uv, seen, indices = [], [], {}, []
        for t in order:
            groups[group[t]] += 3
            for c, (i, _) in enumerate(tris[t]):
                uv = (round(float(corner_uvs[t][c][0]), 6), round(float(corner_uvs[t][c][1]), 6))
                k = seen.get((i, uv))
                if k is None:
                    k = seen[(i, uv)] = len(out_pos)
                    out_pos.append(positions[i])
                    out_uv.append(uv)
                indices.append(k)
        positions = out_pos
    else:
        indices = [i for tri in tris for i, _ in tri]
    return write_bin(dst, positions, indices, out_uv if textured is not None else None, groups)


def write_bin(dst: Path, positions, indices, uvs=None, groups=()):
    """positions [(x, y, z)], indices, uvs [(u, v)] or None, index count per
    texture group (more than one: PPG3)."""
    vcount = len(positions)
    flat = [x for p in positions for x in p]
    ibytes = 2 if vcount < 65536 else 4
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, "wb") as out:
        out.write(b"PPG1" if uvs is None else b"PPG3" if len(groups) > 1 else b"PPG2")
        out.write(struct.pack("<III", vcount, len(indices), ibytes))
        if len(groups) > 1:
            out.write(struct.pack(f"<I{len(groups)}I", len(groups), *groups))
        out.write(struct.pack(f"<{len(flat)}f", *flat))
        if uvs is not None:
            out.write(struct.pack(f"<{len(uvs) * 2}f", *(x for uv in uvs for x in uv)))
        out.write(struct.pack(f"<{len(indices)}{'H' if ibytes == 2 else 'I'}", *indices))
    return vcount, len(indices) // 3


def bin_magic(path: Path):
    with open(path, "rb") as f:
        return f.read(4)


def game_folder(game_props: Path, prop_id):
    if not isinstance(prop_id, int):
        return None
    folders = [p for p in game_props.iterdir() if p.is_dir() and p.name.startswith(f"{prop_id:04d}_")]
    return folders[0] if folders else None


def convert_texture(src: Path, dst: Path, cutout=False):
    """cutout: keep the alpha when it has see-through parts. Returns None, or
    "cut" when it did, "fence" when it's mostly see-through (chain-link)."""
    from PIL import Image, ImageStat

    img = Image.open(src).convert("RGBA")
    alpha = img.getchannel("A")
    cutout = cutout and alpha.getextrema()[0] == 0 and ("fence" if ImageStat.Stat(alpha).mean[0] < 128 else "cut")
    img = img if cutout else img.convert("RGB")
    if img.width > TEXTURE_SIZE or img.height > TEXTURE_SIZE:
        img.thumbnail((TEXTURE_SIZE, TEXTURE_SIZE), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "WEBP", quality=85, method=6)
    return cutout or None


def build_env(env_id, folder: Path, position, turn, obj: Path = None):
    """An arena piece from the game's model: writes env_<id>.bin and its
    textures; returns its catalog "env_textures" list, one per group:
    {"file", "alpha": "cut" (see-through parts) | "fence" (mostly
    see-through) | "glass" | None} or None
    (left plain).
    obj: the add-on's OBJ of it, which also has the ring(s) in it (the game's
    model doesn't): what of the OBJ isn't the game's model goes to
    env_<id>_ring.bin, untouched."""
    import numpy as np
    from game_models import env_model

    pos, uv, tris, group, mats = env_model(folder, position, turn)
    if obj:
        opos, _, otris = read_obj(obj)
        cell = set(map(tuple, pos.round(1).tolist()))
        inside = [tuple(v) in cell for v in np.round(opos, 1).tolist()]
        ring = [i for tri in otris if not all(inside[i] for i, _ in tri) for i, _ in tri]
        used = sorted(set(ring))
        at = {i: k for k, i in enumerate(used)}
        v, t = write_bin(MODELS_OUT / f"env_{env_id}_ring.bin", [opos[i] for i in used], [at[i] for i in ring])
        print(f"  {obj.name:34s} -> env_{env_id}_ring.bin {v:7d} verts {t:7d} tris (its ring)")
    order = np.argsort(group, kind="stable")
    counts = [int((group == i).sum()) * 3 for i in range(len(mats))]
    v, t = write_bin(MODELS_OUT / f"env_{env_id}.bin", pos.tolist(), tris[order].ravel().tolist(), uv.tolist(), counts)
    files, out = {}, []
    for name, src in mats:
        if src is None:
            out.append(None)
            continue
        if src not in files:
            file = f"env_{env_id}.webp" if not files else f"env_{env_id}_{len(files)}.webp"
            files[src] = (file, convert_texture(src, TEXTURES_OUT / file, cutout=True))
        file, cut = files[src]
        out.append({"file": file, "alpha": "glass" if "glass" in name.lower() else cut})
    print(f"  {folder.name:34s} -> env_{env_id}.bin {v:7d} verts {t:7d} tris, {len(files)} textures")
    return out


def convert_normal(src: Path, dst: Path, color: Path):
    """The game's normal map (x, y in red, green; DirectX's y down) as an
    OpenGL one with z made up; its alpha (dark seams) darkens the color."""
    import numpy as np
    from PIL import Image

    img = Image.open(src).convert("RGBA")
    if img.width > TEXTURE_SIZE or img.height > TEXTURE_SIZE:
        img.thumbnail((TEXTURE_SIZE, TEXTURE_SIZE), Image.LANCZOS)
    a = np.asarray(img).astype(float) / 255
    x, y = a[..., 0] * 2 - 1, -(a[..., 1] * 2 - 1)
    z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
    n = np.stack([x, y, z], -1) * 0.5 + 0.5
    Image.fromarray((n * 255).round().astype(np.uint8)).save(dst, "WEBP", quality=90, method=6)
    c = Image.open(color).convert("RGB").resize(img.size, Image.LANCZOS)
    shade = 0.45 + 0.55 * a[..., 3:4]
    Image.fromarray((np.asarray(c) * shade).round().astype(np.uint8)).save(color, "WEBP", quality=85, method=6)


def texture_prop(key, folder: Path, srcs):
    """Textures one prop from the game's model. Returns ({bin name: (corner
    uvs, group per triangle)}, [texture file name or None per group], extra
    catalog fields ("normal", "opacity"))."""
    import numpy as np
    from game_models import prop_model

    objs = {}
    for bin_name, src in srcs.items():
        positions, uvs, tris = read_obj(src)
        objs[bin_name] = (
            np.array(positions),
            np.array([[i for i, _ in t] for t in tris]),
            np.array([[j for _, j in t] for t in tris]),
            np.array(uvs).reshape(-1, 2),
        )
    per_bin, groups = prop_model(objs, folder, key in UVS_FROM_GAME)
    if not any(groups):
        return {}, [], {}
    names = []
    for i, src in enumerate(groups):
        if src is None:
            names.append(None)
            continue
        name = f"{key.lower()}.webp" if i == 0 else f"{key.lower()}_{i}.webp"
        convert_texture(src, TEXTURES_OUT / name)
        names.append(name)
    extra = {}
    if key in NORMAL_MAPS and groups[0]:
        nrm = groups[0].with_name(groups[0].stem.replace("_color", "_nrm") + groups[0].suffix)
        if nrm.exists():
            extra["normal"] = f"{key.lower()}_nrm.webp"
            convert_normal(nrm, TEXTURES_OUT / extra["normal"], TEXTURES_OUT / names[0])
    if key in SEE_THROUGH and groups[0]:
        from PIL import Image, ImageStat

        extra["opacity"] = round(ImageStat.Stat(Image.open(groups[0]).convert("RGBA").getchannel("A")).mean[0] / 255, 2)
    print(f"  {folder.name:34s} -> {', '.join(n or '(plain)' for n in [*names, extra.get('normal')] if n)}"
          + (f" (opacity {extra['opacity']})" if "opacity" in extra else ""))
    return per_bin, names, extra


def parse_icon_maps():
    text = WHEEL_PY.read_text(encoding="utf-8")
    main_block = re.search(r"ICON_MAP\s*=\s*\{(.*?)\n\}", text, re.S).group(1)
    alt_block = re.search(r"ICON_MAP_ALT\s*=\s*\{(.*?)\n\}", text, re.S).group(1)
    icon_map = dict(re.findall(r"'([A-Z0-9_]+)'\s*:\s*'([^']+)'", main_block))
    alt_map = {
        k: {"state": s, "icon": f}
        for k, s, f in re.findall(r"'([A-Z0-9_]+)'\s*:\s*\('([^']+)',\s*'([^']+)'\)", alt_block)
    }
    return icon_map, alt_map


def convert_icon(png_name: str):
    from PIL import Image

    src = find_case_insensitive(ICONS_SRC, png_name)
    if not src:
        print(f"  ! missing icon {png_name}")
        return None
    out_name = Path(png_name).stem.lower() + ".webp"
    dst = ICONS_OUT / out_name
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        img = Image.open(src).convert("RGBA")
        img.thumbnail((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        img.save(dst, "WEBP", quality=85, method=6)
    return out_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-props", type=Path, help="the game's extracted Props folder (for textures)")
    args = ap.parse_args()

    props_json = json.loads((MODELS_SRC / "props.json").read_text(encoding="utf-8"))
    icon_map, alt_map = parse_icon_maps()
    old_catalog = DATA_OUT / "catalog.json"
    old_data = json.loads(old_catalog.read_text(encoding="utf-8")) if old_catalog.exists() else {}
    old = {p["key"]: p for p in old_data.get("props", [])}

    # Collect every OBJ the web app needs
    needed = {}  # out bin name -> src path
    textured = {}  # bin name -> (corner uvs, group per triangle), made this run
    kept = set()  # bins of textured props that keep what they have
    for env_id, fn in ENV_MODELS.items():
        src = find_case_insensitive(MODELS_SRC, fn)
        if not src:
            print(f"  ! missing env model {fn}")
            continue
        needed[f"env_{env_id}.bin"] = src
    env_textures = {}
    env_rings = []  # the rings split off the cages' OBJs (build_env)
    for env_id, (prop_id, position, turn) in GAME_ENV.items():
        folder = game_folder(args.game_props, prop_id) if args.game_props else None
        obj = needed.get(f"env_{env_id}.bin") if env_id in RING_IN_OBJ else None
        if folder:
            env_textures[env_id] = build_env(env_id, folder, position, turn, obj)
        elif env_id in old_data.get("env_textures", {}) and (MODELS_OUT / f"env_{env_id}.bin").exists():
            env_textures[env_id] = old_data["env_textures"][env_id]
        else:
            continue
        needed.pop(f"env_{env_id}.bin", None)
        if obj:
            env_rings.append(f"{env_id}_ring")

    props_out = []
    for p in props_json.get("props", []):
        if p.get("key") in EXCLUDE_KEYS:
            continue
        states = {}
        for state_name, fn in p.get("states", {}).items():
            src = find_case_insensitive(MODELS_SRC, fn)
            if not src:
                print(f"  ! {p['key']}/{state_name}: missing {fn}")
                continue
            bin_name = Path(fn).stem.lower() + ".bin"
            needed[bin_name] = src
            states[state_name] = bin_name
        if not states:
            continue
        entry = {k: v for k, v in p.items() if k != "companion"}
        entry["states"] = states
        folder = game_folder(args.game_props, p.get("prop_id")) if args.game_props else None
        if folder and p["key"] not in NO_TEXTURE:
            per_bin, names, extra = texture_prop(p["key"], folder, {b: needed[b] for b in states.values()})
            textured.update(per_bin)
            entry.update(extra)
            if len(names) == 1:
                entry["texture"] = names[0]
            elif names:
                entry["textures"] = names
        elif not args.game_props and p["key"] in old:
            for k in ("texture", "textures"):
                if k in old[p["key"]]:
                    entry[k] = old[p["key"]][k]
                    kept.update(states.values())
            for k in ("normal", "opacity"):
                if k in old[p["key"]]:
                    entry[k] = old[p["key"]][k]
        icon_png = icon_map.get(p["key"]) or p.get("icon")
        entry["icon"] = convert_icon(icon_png) if icon_png else None
        if p["key"] in alt_map:
            alt = alt_map[p["key"]]
            entry["alt_icon"] = {"state": alt["state"], "icon": convert_icon(alt["icon"])}
        props_out.append(entry)

    for bin_name, src in sorted(needed.items()):
        dst = MODELS_OUT / bin_name
        if bin_name in kept:
            if dst.exists() and dst.stat().st_mtime < src.stat().st_mtime:
                print(f"  ! {bin_name}: OBJ changed; rerun with --game-props to rebuild it")
            continue
        if bin_name not in textured and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime and bin_magic(dst) == b"PPG1":
            continue
        v, t = convert_obj(src, dst, textured.get(bin_name))
        print(f"  {src.name:28s} -> {bin_name:24s} {v:7d} verts {t:7d} tris")

    catalog = {
        "state_definitions": props_json.get("state_definitions", {}),
        "props": props_out,
        "env_models": {k: f"env_{k}.bin" for k in [*ENV_MODELS, *(k for k in env_textures if k not in ENV_MODELS), *env_rings]},
        "env_textures": env_textures,
    }
    DATA_OUT.mkdir(parents=True, exist_ok=True)
    (DATA_OUT / "catalog.json").write_text(json.dumps(catalog, indent=1), encoding="utf-8")
    print(f"catalog: {len(props_out)} props, {len(needed)} meshes")


if __name__ == "__main__":
    sys.exit(main())
