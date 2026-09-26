# Prop Profile Generator: web edition

Browser version of the Blender add-on. Place props in the arena and export a
`.propsprofile`. The file format and coordinates match the add-on's export exactly.
It can also open and save the game's own prop set files (`PropsSet_*.jsfb`)
directly; see [Game prop sets](#game-prop-sets-jsfb).

It is a static site: plain HTML/JS, with three.js loaded from a CDN (and the
Rapier physics engine, the first time physics is used). There is no build step
for users.

## Run locally

Browsers block `fetch` on `file://` pages, so serve the folder over HTTP:

```
python web/tools/dev_server.py
```

(`python -m http.server 8765 --directory web` works too, but the browser may
keep old copies of edited JS files; `dev_server.py` turns caching off.)

Then open http://localhost:8765.

## Host it

Upload the `web/` folder to any static host, such as GitHub Pages, Netlify,
Cloudflare Pages, or itch.io (HTML project). The assets total about 17 MB.

## Update props / models

`web/assets` and `web/data/catalog.json` are generated from the add-on's own
data:

- `props/Prop_Models/props.json` (prop IDs, states, labels). `EXCLUDE_KEYS` in
  the build script leaves props out; AT / AT_COVER (commentary table) are excluded.
- `props/Prop_Models/*.obj` (converted to compact `.bin` meshes)
- `icons/*.png` (resized to 256px WebP)
- `ICON_MAP` / `ICON_MAP_ALT` in `tools/wheel_tool.py`

After changing any of these, rebuild (needs Python 3 + Pillow):

```
python web/tools/build_assets.py
```

Only changed files are reconverted. Output file names are lowercase, so
case-sensitive hosts work even though `props.json` mixes cases.

## Coordinates and rotation

The web app uses the add-on's convention, and it was checked against the real
add-on running in Blender:

- **Position**: `x, y, z` are Blender world coordinates (Z up), written as-is.
  The 3D scene itself runs in Blender's Z-up space (meshes get the OBJ
  importer's axis conversion when they load), so no other axis swap exists.
- **Rotation**: the add-on imports `rx, ry, rz` as a Blender Euler in `XZY`
  order with angles `(rx, ry, -rz)`, so `R = Ry(ry) · Rz(-rz) · Rx(rx)`.
  The web app builds exactly that matrix (`js/rotation.js`). It never runs the
  angles through three.js Euler orders.
- **Lossless editing**: the file's `rx, ry, rz` are stored verbatim. Moving a
  prop never touches its rotation. Turning an upright prop (no RY) around the
  vertical only changes `rz`.
- **Free rotation** (gizmo rings, trackball, turning a tilted prop): the new
  orientation is turned back into angles with a port of Blender's
  `matrix.to_euler('XZY')`, so the numbers are the ones the add-on would write
  for that orientation. Checked against Blender for 243 rotations.
- **Where the add-on writes different numbers**: the add-on re-derives angles
  with `matrix.to_euler('XZY')` on export. For some props that gives different
  numbers for the same orientation: `rz` of 270 becomes -90, 180 becomes -180,
  `(10, 20, -90)` becomes `(30, 0, -90)`, and `(170, 10, 100)` becomes
  `(-10, -170, 80)`. The web app keeps the original numbers.
- **Unrecognized lines** (unknown prop ID / state, and the excluded AT /
  AT_COVER) are kept byte-for-byte and re-exported. The add-on drops unknown
  lines.

Re-run the check after changing any of this (Blender 4+ and Node):

```
blender -b --factory-startup --python web/tools/rotation-check/blender_truth.py -- . web/tools/rotation-check
node web/tools/rotation-check/verify_rotation.mjs
```

## What maps to what

| Add-on | Web |
| --- | --- |
| Import Default Props | Loads automatically |
| Environment dropdown | Ring / EC / HIAC / WG / Amb. buttons (arena models load on first use) |
| Enable Stage | Entrance stage toggle |
| Auto Snapping / Enable Stacking | Same toggles, same rules (ring Z 106, floor 0, stage top, cell and ambulance roofs, one-level stacking) |
| Add Prop (line tool) | Click a tile, then click to place or drag for a line. Shift locks to 45°. Wheel while dragging changes spacing. With Stacking on, drag upward to stack. |
| Q prop wheel | Hold Q over the viewport, release to pick. Multi-state props show their second state further out. |
| Cardinal rotation buttons | Rotation ring around the selection, dial and ±15° / ±90° buttons in the panel, `[` `]` keys |
| Export / Import .propsprofile | Export dialog (download, copy, append to an existing file) and Import (or drag and drop a file) |
| Add Custom Prop | + Custom. The OBJ is stored in this browser only (IndexedDB). |
| Modify Prop List | List. Your choices are saved in this browser. |

## Moving and rotating

- **Handles**: toolbar *Move* (W) shows arrows for X (red), Y (green) and
  Z (blue, up) plus a small square for sliding on the ground; *Rotate* (E)
  shows a ring per axis, and dragging inside the rings tumbles the prop
  freely. Rotation snaps to 15° (hold Shift for free), moves snap to a 10
  grid with Ctrl, Esc or right-click cancels. A label next to the cursor
  shows the value while dragging. *World / Local* switches the handle axes
  between the world and the selected prop's own axes. The handles are drawn
  by `js/gizmo.js` at a fixed size on screen.
- **Move** also by dragging a prop, arrow keys (5 units; Shift 25, Alt 1;
  relative to the camera, always along X or Y), PageUp / PageDown for height,
  or the X, Y, Z fields (type, or drag the letter sideways). With auto
  snapping on, a lifted prop keeps its height above whatever surface it moves
  over.
- **Rotate** also with `[` / `]` (15° around the vertical; Shift 90°, Alt 1°),
  the facing dial, or the RX / RY / RZ fields. *Stand upright* clears the tilt.
- **Before placing**: `[` / `]` rotate the ghost; placed props keep that angle.
- **Several props**: choose *Each in place* or *Around center* in the panel.
  The X / Y fields then move the group's center.
- **Duplicate** (Ctrl+D) places the copy next to the original.
- G / R still work Blender-style (click to finish, Esc cancels).

## Walk navigation

Blender's walk mode (View ‣ Navigation ‣ Walk Navigation), with its keys and
default settings (`js/walk.js`).

- **Start**: `Shift` + `` ` `` (the key left of 1) or toolbar *Walk*. The
  cursor hides and the mouse looks around; a crosshair marks the middle.
- **Move**: `W` `A` `S` `D` or the arrows. Forward goes where you look;
  `E` / `Q` go straight up / down, `R` / `F` up / down the view. Hold `Shift`
  for 5× faster, `Alt` for 5× slower. The wheel (or `+` / `-`) changes the
  speed: 2.5 m/s (250 units a second) to start, remembered between walks.
- **Teleport**: `Space` flies to what the crosshair is on, stopping eye height
  (160) short of it.
- **Gravity**: `Tab`. The camera then stays 160 above whatever is under it
  (floor, ring, props), hops up onto things it walks into and falls off
  edges; `V` jumps (hold for the full 0.4 m, `.` / `,` change it). Finding the
  floor uses the physics engine, which downloads the first time gravity is on;
  until then the snap surfaces stand in.
- **Finish**: click or `Enter` keeps the new view (orbiting then turns around
  what the crosshair was on); `Esc` or right-click goes back to where the
  walk started. The status bar shows the eye position while walking.

## Prop sets

Save a group of placed props exactly as it is, and stamp copies of it
anywhere.

- **Save**: select the props, then press Ctrl+G (or *Save as set* in the
  panel). Name it; a 3D thumbnail is made automatically.
- **Place**: open the *Sets* tab and click a set. The whole group follows the
  cursor as a ghost; click to place a copy, stay in the mode to place more, Esc
  to stop. Each copy is one undo step, and the new props come in selected.
- **Exact**: the group is never rearranged. Every prop keeps its offset from
  the group's center, its height above the group's ground and its rotation
  numbers. Only the group as a whole moves: its center goes to the cursor and
  its ground onto the surface there (floor, ring, stage...). Physics never
  drops a set.
- **Optional**: `[` / `]` turn the whole group (Shift 90°, Alt 1°) and `M`
  mirrors it left-right (a corner setup becomes the opposite corner). Turning
  only changes `rz` for upright props; tilted props are re-derived with the
  same Blender-compatible conversion as the rotate handles. Mirroring maps
  (rx, ry, rz) to (rx, -ry, -rz).
- Sets saved before this change are converted when the page loads.
- **Library**: rename (✎) and delete (✕, with Undo) on each tile. Sets live
  in this browser; *Export* / *Import* move them between browsers or share
  them as a `prop-sets.json` file.

## Game prop sets (.jsfb)

The game keeps one prop set per match type, `PropsSet_<Mode>.jsfb`. The
designer opens and saves these directly, without the intermediary program.
The format and how it was worked out are in [`jsfb's/README.md`](jsfb's/README.md).

- **Open**: *Import* (or drag and drop) a `PropsSet_*.jsfb`. It replaces the
  scene (Ctrl+Z brings the old one back), and the arena follows the match type
  (Ambulance, Elimination Chamber, HIAC, WarGames; others get the normal ring).
- **Save**: *Export* → *Game prop set*. The name defaults to the file you
  opened, and the name field suggests the game's match types. Put the
  downloaded file in place of the game's file, and keep a copy of the original.
- **Nothing is lost**: each prop keeps the fields the designer doesn't show
  (hashes, scale, extra lists) and writes them back. Props the catalog doesn't
  know (the ambulance, the casket, the WarGames pedestals...) aren't drawn but
  stay in the file, in their place. Saving without edits gives an identical
  file, and the export dialog says so.
- **New props** are written the way the intermediary writes them (every field,
  hash `0x49016AEE`, scale 1), with values rounded to 3 decimals like a
  profile. Saving directly should give the same file as exporting a profile
  and running it through the intermediary; comparing the two is the planned
  confirmation of the axes below.
- **.propsprofile** import and export work as before. A profile exported from
  an opened game file also lists the props the designer can't show; a game
  file saved from an imported profile includes its unrecognized lines.
- **Axes**: jsfb position `(x, y, z)` = designer `(x, -z, y)`; rotation
  `(x, y, z)` = designer `(rx, rz, ry)`. This still needs one check against the
  intermediary's own output (see `jsfb's/README.md`).
- **Code**: `js/jsfb.js` reads and writes the FlatBuffers bytes (a port of
  `propset.py`, byte-identical on all 19 sample files); `js/propset.js`
  converts between the file and the scene.

## Physics

Drop props and let them fall into place.

- **Turn it on**: toolbar *Physics* or `P`. Placing then drops props instead of
  setting them down: the ghost hangs above the cursor with a dashed guide to
  the spot below, and a click lets it fall. It lands on whatever is really
  there (ring, ropes, steps, barricade, other props) and topples if it can't
  stand. Lines and stacks drop the same way; sets are always placed exactly as
  saved.
- **While placing**: `↑` / `↓` change the drop height (60 by default; Shift
  ×5, Alt 1). Shift + click adds a random tumble. With physics on, the cursor
  picks the surface it is over, so pointing at a table drops onto the table.
- **Existing props**: *Drop with physics* in the panel (or `End`) lets the
  selection fall from where it is. A prop that starts inside something (like a
  barrel whose center sits on the floor) is lifted clear first.
- **Undo**: everything dropped while earlier props are still falling becomes
  one undo step when all of it comes to rest. Ctrl+Z during the fall cancels
  it. Any other edit first finishes the fall instantly.
- **Clean numbers**: a prop that comes to rest within a hair of level (no
  point off by more than 1 unit) is made exactly level, and upright props get
  `rx = ry = 0` with only `rz` set. With auto snapping on, a prop resting
  within 1.5 of a snap surface (ring 106, floor 0, ...) is put exactly on it.
  Tilted results go through the same Blender-compatible conversion as the
  rotate handles.
- **How**: [Rapier](https://rapier.rs) (`@dimforge/rapier3d-compat`, about
  760 KB, loaded from the CDN on first use; `js/physics.js`). The arena models
  and placed props are fixed triangle meshes; falling props are the convex
  hulls of their models. The simulation runs in meters, gravity 9.81.

Other additions: undo/redo, box select, state switching on placed props,
X-ray arena, and autosave of the scene in the browser.
