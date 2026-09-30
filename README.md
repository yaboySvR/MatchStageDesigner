# PropSetEditor

Design WWE 2K26 arena prop layouts in the browser and export them as
`.propsprofile` files, the same format as the Prop Profile Generator Blender
add-on.

Live at **https://propseteditor.com**.

## Features

- **Place props** from the catalog or the prop wheel (hold Q), in lines or
  stacks, snapped to the ring, floor and stage.
- **Edit** with move/rotate handles, number fields, arrow-key nudges,
  duplicate, mirror, line up and space evenly.
- **Physics**: drop props and let them land and topple.
- **Walk mode**: Blender-style first-person navigation (Shift+`).
- **Matches**: one remembered layout per match type, starting from the
  game's defaults.
- **Prop Profiles**: upload a folder of `.propsprofile` files (any folder, it's
  only read once), flip through them, save changes in the browser, download
  them back.
- **Sets**: save a group of props, stamp copies, share it as a code.
- **Overlap warning**: props that clip into each other turn red.
- **Screenshot**: copy a clean picture of the view.
- Everything autosaves in the browser. Press **?** in the site for all
  controls.

## Run locally

Browsers block `file://` pages, so serve the folder:

```
python web/tools/dev_server.py
```

Then open http://localhost:8765.

## Host

It's a static site with no build step: upload `web/` to any static host.
three.js, Rapier and three-mesh-bvh load from a CDN.

## Update props

Prop models, icons and `data/catalog.json` are generated from the add-on's
data (`props/Prop_Models`, `icons/`):

```
python web/tools/build_assets.py
```

## Code

| File | What |
|---|---|
| `js/viewport.js` | three.js scene, camera, screenshots |
| `js/tools.js` | placing, selecting, moving, rotating, arranging |
| `js/ui.js` | sidebar, panels, import/export |
| `js/profile.js` | `.propsprofile` read/write |
| `js/sets.js`, `js/sets-ui.js` | sets and share codes |
| `js/matches.js`, `js/matches-ui.js` | match picker |
| `js/profiles.js`, `js/profiles-ui.js` | profiles folder tab |
| `js/physics.js` | Rapier drop physics |
| `js/overlaps.js` | overlap warning |
| `js/walk.js`, `js/settings.js` | walk mode and its keys |
| `js/features.js` | switched-off features |
