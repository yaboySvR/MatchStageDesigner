"""
Build web assets from the Blender add-on data.

  python web/tools/build_assets.py [--game-props <folder>]

Reads  props/Prop_Models/*.obj, props/Prop_Models/props.json, icons/*.png,
       tools/wheel_tool.py (ICON_MAP / ICON_MAP_ALT)
       --game-props: the game's extracted Props folder (one "<id>_<name>"
       folder per prop, with Textures/design_color.dds); only needed to
       (re)make the textures
Writes web/assets/models/<name>.bin   compact indexed meshes (lowercase names)
       web/assets/icons/<name>.webp    256px icons
       web/assets/textures/<key>.webp  color textures of the TEXTURED props
       web/data/catalog.json           props + state ids + icon map for the web app

Mesh .bin layout (little-endian):
  char[4] "PPG1" | uint32 vertCount | uint32 indexCount | uint32 indexBytes (2|4)
  float32[vertCount*3] positions (OBJ space, Y-up) | uint16/uint32[indexCount] indices
Textured props use "PPG2": the same, with float32[vertCount*2] UVs (v up)
between the positions and the indices. For UVS_FROM_GAME props the UVs come
from the game's own model (game_uvs.py): their OBJs' UVs don't fit the game
textures.
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

ICON_SIZE = 256

# Props drawn with the game's own color texture (their OBJs carry the game UVs).
TEXTURED = {"CHAIR", "TABLE", "LADDER"}
# Of those, the ones whose OBJ UVs don't fit the game texture: their UVs are
# read from the game's model instead (game_uvs.py). The table's OBJ UVs fit.
UVS_FROM_GAME = {"CHAIR", "LADDER"}
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


def convert_obj(src: Path, dst: Path, with_uv=False, corner_uvs=None):
    """corner_uvs: one (u, v) per triangle corner, in place of the OBJ's own."""
    positions, uvs, tris = read_obj(src)
    if with_uv:
        # A vertex is a (position, uv) pair, so seams get their own copies.
        out_pos, out_uv, seen, indices = [], [], {}, []
        for t, tri in enumerate(tris):
            for c, (i, j) in enumerate(tri):
                uv = tuple(corner_uvs[t][c]) if corner_uvs is not None else (uvs[j] if j >= 0 else (0.0, 0.0))
                k = seen.get((i, uv))
                if k is None:
                    k = seen[(i, uv)] = len(out_pos)
                    out_pos.append(positions[i])
                    out_uv.append(uv)
                indices.append(k)
        positions = out_pos
    else:
        indices = [i for tri in tris for i, _ in tri]

    vcount = len(positions)
    flat = [x for p in positions for x in p]
    ibytes = 2 if vcount < 65536 else 4
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, "wb") as out:
        out.write(b"PPG2" if with_uv else b"PPG1")
        out.write(struct.pack("<III", vcount, len(indices), ibytes))
        out.write(struct.pack(f"<{len(flat)}f", *flat))
        if with_uv:
            out.write(struct.pack(f"<{len(out_uv) * 2}f", *(x for uv in out_uv for x in uv)))
        out.write(struct.pack(f"<{len(indices)}{'H' if ibytes == 2 else 'I'}", *indices))
    return vcount, len(indices) // 3


def game_folder(game_props: Path, prop_id: int):
    folders = [p for p in game_props.iterdir() if p.is_dir() and p.name.startswith(f"{prop_id:04d}_")]
    return folders[0] if folders else None


def game_corner_uvs(game_props: Path, prop_id: int, srcs):
    """{bin name: per-corner UVs from the game's model} for one prop's OBJs."""
    import numpy as np
    from game_uvs import prop_uvs

    folder = game_folder(game_props, prop_id)
    mcd = next(folder.glob("*.mcd"), None) if folder else None
    if not mcd:
        print(f"  ! no game model for prop {prop_id}")
        return {}
    objs = {}
    for bin_name, src in srcs.items():
        positions, uvs, tris = read_obj(src)
        objs[bin_name] = (
            np.array(positions),
            np.array([[i for i, _ in t] for t in tris]),
            np.array([[j for _, j in t] for t in tris]),
            np.array(uvs),
        )
    out = prop_uvs(objs, mcd)
    return {k: [[(round(float(u), 6), round(float(v), 6)) for u, v in tri] for tri in uv] for k, uv in out.items()}


def bin_magic(path: Path):
    with open(path, "rb") as f:
        return f.read(4)


def convert_texture(game_props: Path, prop_id: int, dst: Path):
    """The game's design_color.dds of prop <id> -> webp."""
    from PIL import Image

    folder = game_folder(game_props, prop_id)
    src = folder / "Textures" / "design_color.dds" if folder else None
    if not src or not src.exists():
        print(f"  ! no texture for prop {prop_id}")
        return
    img = Image.open(src).convert("RGB")
    if img.width > TEXTURE_SIZE:
        img = img.resize((TEXTURE_SIZE, TEXTURE_SIZE * img.height // img.width), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "WEBP", quality=88, method=6)
    print(f"  {src.parent.parent.name:28s} -> {dst.name}")


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

    # Collect every OBJ the web app needs
    needed = {}  # out bin name -> src path
    with_uv = set()  # bins of textured props
    game_uvs = {}  # bin name -> per-corner UVs from the game's model
    from_game = set()  # bins whose UVs come from the game's model
    for env_id, fn in ENV_MODELS.items():
        src = find_case_insensitive(MODELS_SRC, fn)
        if not src:
            print(f"  ! missing env model {fn}")
            continue
        needed[f"env_{env_id}.bin"] = src

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
            if p["key"] in TEXTURED:
                with_uv.add(bin_name)
        if not states:
            continue
        entry = {k: v for k, v in p.items() if k != "companion"}
        entry["states"] = states
        if p["key"] in TEXTURED:
            tex = TEXTURES_OUT / f"{p['key'].lower()}.webp"
            if args.game_props:
                convert_texture(args.game_props, p["prop_id"], tex)
            if p["key"] in UVS_FROM_GAME:
                from_game.update(states.values())
            if args.game_props and p["key"] in UVS_FROM_GAME:
                game_uvs.update(game_corner_uvs(args.game_props, p["prop_id"], {b: needed[b] for b in states.values()}))
            if tex.exists():
                entry["texture"] = tex.name
        icon_png = icon_map.get(p["key"]) or p.get("icon")
        entry["icon"] = convert_icon(icon_png) if icon_png else None
        if p["key"] in alt_map:
            alt = alt_map[p["key"]]
            entry["alt_icon"] = {"state": alt["state"], "icon": convert_icon(alt["icon"])}
        props_out.append(entry)

    for bin_name, src in sorted(needed.items()):
        dst = MODELS_OUT / bin_name
        uv = bin_name in with_uv
        if bin_name not in game_uvs:
            if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime and (bin_magic(dst) == b"PPG2") == uv:
                continue
            if bin_name in from_game and dst.exists() and bin_magic(dst) == b"PPG2":
                # its UVs came from the game's model; without it, keep them
                print(f"  ! {bin_name}: OBJ changed; rerun with --game-props to rebuild it")
                continue
        v, t = convert_obj(src, dst, uv, game_uvs.get(bin_name))
        print(f"  {src.name:28s} -> {bin_name:24s} {v:7d} verts {t:7d} tris{'  (game UVs)' if bin_name in game_uvs else ''}")

    catalog = {
        "state_definitions": props_json.get("state_definitions", {}),
        "props": props_out,
        "env_models": {k: f"env_{k}.bin" for k in ENV_MODELS},
    }
    DATA_OUT.mkdir(parents=True, exist_ok=True)
    (DATA_OUT / "catalog.json").write_text(json.dumps(catalog, indent=1), encoding="utf-8")
    print(f"catalog: {len(props_out)} props, {len(needed)} meshes")


if __name__ == "__main__":
    sys.exit(main())
