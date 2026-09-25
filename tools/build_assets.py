"""
Build web assets from the Blender add-on data.

  python web/tools/build_assets.py

Reads  props/Prop_Models/*.obj, props/Prop_Models/props.json, icons/*.png,
       tools/wheel_tool.py (ICON_MAP / ICON_MAP_ALT)
Writes web/assets/models/<name>.bin   compact indexed meshes (lowercase names)
       web/assets/icons/<name>.webp    256px icons
       web/data/catalog.json           props + state ids + icon map for the web app

Mesh .bin layout (little-endian):
  char[4] "PPG1" | uint32 vertCount | uint32 indexCount | uint32 indexBytes (2|4)
  float32[vertCount*3] positions (OBJ space, Y-up) | uint16/uint32[indexCount] indices
"""
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


def convert_obj(src: Path, dst: Path):
    positions = []
    indices = []
    with open(src, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.startswith("v "):
                parts = line.split()
                positions.extend((float(parts[1]), float(parts[2]), float(parts[3])))
            elif line.startswith("f "):
                n = len(positions) // 3
                idx = []
                for tok in line.split()[1:]:
                    i = int(tok.split("/")[0])
                    idx.append(i - 1 if i > 0 else n + i)
                for k in range(1, len(idx) - 1):  # triangle fan
                    indices.extend((idx[0], idx[k], idx[k + 1]))

    vcount = len(positions) // 3
    ibytes = 2 if vcount < 65536 else 4
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, "wb") as out:
        out.write(b"PPG1")
        out.write(struct.pack("<III", vcount, len(indices), ibytes))
        out.write(struct.pack(f"<{len(positions)}f", *positions))
        out.write(struct.pack(f"<{len(indices)}{'H' if ibytes == 2 else 'I'}", *indices))
    return vcount, len(indices) // 3


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
    props_json = json.loads((MODELS_SRC / "props.json").read_text(encoding="utf-8"))
    icon_map, alt_map = parse_icon_maps()

    # Collect every OBJ the web app needs
    needed = {}  # out bin name -> src path
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
        if not states:
            continue
        entry = {k: v for k, v in p.items() if k != "companion"}
        entry["states"] = states
        icon_png = icon_map.get(p["key"]) or p.get("icon")
        entry["icon"] = convert_icon(icon_png) if icon_png else None
        if p["key"] in alt_map:
            alt = alt_map[p["key"]]
            entry["alt_icon"] = {"state": alt["state"], "icon": convert_icon(alt["icon"])}
        props_out.append(entry)

    for bin_name, src in sorted(needed.items()):
        dst = MODELS_OUT / bin_name
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        v, t = convert_obj(src, dst)
        print(f"  {src.name:28s} -> {bin_name:24s} {v:7d} verts {t:7d} tris")

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
