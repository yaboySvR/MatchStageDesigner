# Run the real add-on headless and record its import/export behaviour.
#   blender -b --factory-startup --python blender_truth.py -- <addon_dir> <work_dir>
import sys, json, math, importlib.util
from pathlib import Path
import bpy

addon_dir = Path(sys.argv[sys.argv.index("--") + 1])
work = Path(sys.argv[sys.argv.index("--") + 2])
cases = json.loads((work / "cases.json").read_text())

spec = importlib.util.spec_from_file_location(
    "ppg_addon", addon_dir / "__init__.py", submodule_search_locations=[str(addon_dir)])
mod = importlib.util.module_from_spec(spec)
sys.modules["ppg_addon"] = mod
spec.loader.exec_module(mod)
mod.register()

from ppg_addon.tools import export as exp
from ppg_addon.props import loader

ctx = bpy.context
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

msgs = []
report = lambda level, msg: msgs.append(msg)


def export_all(name, selected_only=False):
    path = work / name
    exp._write_props_to_file(str(path), 'OVERWRITE', selected_only, ctx, report)
    return path.read_text().splitlines()


def props():
    return [o for o in bpy.data.objects if o.get("prop_key")]


def mat_rows(o):
    m = o.matrix_world
    return [[m[r][c] for c in range(4)] for r in range(3)]


def world_aabb(o):
    pts = [o.matrix_world @ v.co for v in o.data.vertices]
    return [[min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)]]


out = {}

# 1) import the profile through the real operator, export untouched
src = work / "in.propsprofile"
src.write_text("\n".join(cases["profile"]) + "\n")
bpy.ops.import_test.import_props(filepath=str(src))
out["import_msgs"] = list(msgs)
objs = props()
out["objects"] = [{
    "name": o.name, "key": o["prop_key"], "state": o["prop_state"],
    "parent": o.parent.name if o.parent else None,
    "rotation_mode": o.rotation_mode,
    "euler": [math.degrees(v) for v in o.rotation_euler],
    "loc": list(o.location),
    "matrix_world": mat_rows(o),
    "world_aabb": world_aabb(o),
} for o in objs]
out["roundtrip"] = export_all("roundtrip.propsprofile")

# 2) compass buttons on every imported object (rotate_selected operator)
out["compass_on_imported"] = {}
for ang in cases["compass"]:
    for o in objs:
        o.select_set(True)
    ctx.view_layer.objects.active = objs[0]
    bpy.ops.import_test.rotate_selected(angle=ang)
    out["compass_on_imported"][str(ang)] = export_all(f"compass_{ang}.propsprofile")
    for o in objs:
        o.select_set(False)

# 3) R-modal equivalent: rotation_euler.z += delta (what PROP_OT_rotate_snap does)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_test.import_props(filepath=str(src))
objs = props()
out["rotate_delta_on_imported"] = {}
base = {o.name: o.rotation_euler.z for o in objs}
for d in cases["rotate_deltas"]:
    for o in objs:
        o.rotation_euler.z = base[o.name] + math.radians(d)
    ctx.view_layer.update()  # the modal gets this from the viewport redraw
    out["rotate_delta_on_imported"][str(d)] = export_all(f"rot_{d}.propsprofile")
    for o in objs:
        o.rotation_euler.z = base[o.name]

# 3b) free rotation around a world axis through each prop's origin
#     (what the web gizmo rings do), exported by the add-on
from mathutils import Matrix
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_test.import_props(filepath=str(src))
ctx.view_layer.update()
objs = props()
orig = {o.name: o.matrix_world.copy() for o in objs}
out["world_rotations"] = {}
for axis in ("X", "Y", "Z"):
    for deg in (30, -75, 135):
        for o in objs:
            m = orig[o.name]
            new = (Matrix.Rotation(math.radians(deg), 3, axis) @ m.to_3x3()).to_4x4()
            new.translation = m.translation
            o.matrix_world = new
        ctx.view_layer.update()
        out["world_rotations"][f"{axis}:{deg}"] = export_all(f"world_{axis}_{deg}.propsprofile")
for o in objs:
    o.matrix_world = orig[o.name]

# 4) freshly placed props (spawn_props, default rotation) + compass
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
from mathutils import Vector
fresh = loader.spawn_props("CHAIR", Vector((1.0, 2.0, 106.0)), "Default")
out["fresh_default"] = export_all("fresh.propsprofile")
out["fresh_compass"] = {}
for ang in cases["compass"]:
    fresh.select_set(True)
    bpy.ops.import_test.rotate_selected(angle=ang)
    out["fresh_compass"][str(ang)] = export_all(f"fresh_{ang}.propsprofile")

(work / "blender_truth.json").write_text(json.dumps(out, indent=1))
print("DONE", len(out["roundtrip"]))
