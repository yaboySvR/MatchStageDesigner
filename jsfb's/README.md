# Game prop sets (.jsfb): editing them directly

This folder documents the work on reading and writing the game's prop set
files (`PropsSet_*.jsfb`), so the designer can edit them itself.

## Goal

WWE 2K26 has one fixed prop set per match type, `PropsSet_<Mode>.jsfb` (for
example `PropsSet_HIAC.jsfb`). The game loads it every time you enter that
match type. It lists which props appear, where they are, and what state they
are in (a table set up or folded, for example).

Today the designer never touches those files:

```
designer  ->  .propsprofile  ->  intermediary program  ->  PropsSet_<Mode>.jsfb
```

The goal is to remove the intermediary program:

```
designer  <->  PropsSet_<Mode>.jsfb
```

You would open a match type's prop set in the designer, edit it, and save it
back over the file the game reads.

## Status

| Step | State |
|---|---|
| Work out the .jsfb format | Done, from 19 sample files (845 props) |
| Reader and writer | Done in Python: `propset.py` (the reference implementation) |
| Rewrite without changing a byte | Done: all 19 files re-encode to identical bytes |
| Designer ↔ jsfb coordinates and rotation | Worked out and cross-checked (more evidence below); not yet confirmed against the intermediary's output |
| Reader and writer in the designer (JavaScript) | Done: `../js/jsfb.js` (the port) and `../js/propset.js` (file ↔ scene). All 19 files decode like propset.py and re-encode to identical bytes; edited files match propset.py's output byte for byte |
| Opening and saving game files from the page | Done through Import / Export: Import opens a `.jsfb`, Export → *Game prop set* downloads it. Not yet: picking the game folder and saving over the file in place |

The .propsprofile import and export are unchanged.

## The reference implementation: propset.py

`C:\Users\thesv\OneDrive\Documentos\PropSetReader\propset.py` needs only plain
Python 3, no packages. The sample files are in `PropSetReader\Files`.

```
python propset.py read     # Files/*.jsfb -> json/*.json
python propset.py write    # json/*.json -> Files/*.jsfb (originals copied to backup/ first)
```

What was checked:

- All 19 files decode. Going .jsfb → JSON → .jsfb gives back the exact same
  bytes, so nothing is lost or misread.
- Edited files also decode back correctly and pass a structure check (bounds
  and alignment of every table, list and field). The edits tested were moved
  props, values added that weren't stored before, and props added and removed.
- Bad input fails with the exact location, e.g.
  `props[0]: unknown field "positon"`.

It also serves as the test for a JavaScript port: the port is right when it
produces the same bytes for all 19 files.

## The sample files

| File | Props | Style |
|---|---|---|
| PropsSet_Ambulance | 102 | intermediary |
| PropsSet_BloodlineRules | 84 | intermediary |
| PropsSet_EliminationChamber | 96 | intermediary |
| PropsSet_ExtremeRules | 85 | intermediary |
| PropsSet_Gameplay_TLCMatch_0 | 83 | intermediary |
| PropsSet_HIAC | 106 | intermediary |
| PropsSet_Inferno | 74 | intermediary |
| PropsSet_SteelCage | 86 | intermediary |
| PropsSet_Underground | 74 | intermediary |
| PropsSet_Gameplay_Casket | 1 | compact |
| PropsSet_Gameplay_Dumpster | 1 | compact |
| PropsSet_Gameplay_LadderMatch_0 | 2 | compact |
| PropsSet_Gameplay_TableMatch_0 | 2 | compact |
| PropsSet_KingOfHell | 7 | compact |
| PropsSet_Lights_Out | 35 | compact |
| PropsSet_Wargames | 7 | compact |
| PropsSet_FallsCountAnywhere | 0 | empty |
| PropsSet_IQuit | 0 | empty |
| PropsSet_LastManStanding | 0 | empty |

- **intermediary:** every field is stored, zeros included (often as `-0.0`),
  and every prop has the hash `0x49016AEE`. These are the files your
  intermediary program writes.
- **compact:** fields equal to their default are left out, and props have
  their own hashes.

## The format

The file is a FlatBuffers binary (little-endian), with the file identifier
`Prop` at byte 4. No schema is public, so this one was worked out from the files:

```
table PropSet {            // root
  props: [Prop];           // id 0
  unk1: uint;              // id 1   1 in most files; 3, 8, 12, 33 or 94 in the others
}

table Prop {
  prop_id: uint;           // id 0   which object (the catalog's prop_id)
  unk1: uint;              // id 1   32-bit hash, meaning unknown
  position: Vec3;          // id 2
  rotation: Vec3;          // id 3   degrees
  scale: Vec3;             // id 4   1, 1, 1 on all 845 props
  state: ushort;           // id 5   state id, see below
  unk6: [uint];            // id 6   list of 32-bit hashes (tags?); only Wargames uses it
  unk7: ubyte;             // id 7   Lights_Out: 28, on 2 props
  // id 8: never appears, type unknown
  unk9: uint;              // id 9   Wargames: 108, on 3 props
  // id 10: never appears, type unknown
  unk11: uint;             // id 11  Gameplay_Casket: 340
  unk12: ubyte;            // id 12  KingOfHell: 1, on 1 prop
}

table Vec3 {               // a table, not a struct
  x: float;
  y: float;
  z: float;
}

root_type PropSet;
file_identifier "Prop";
```

Every field is optional. A field that isn't stored takes its default (0, or an
empty list), so an unrotated prop may have a `rotation` with no x, y or z at
all. Keep track of which fields a file stores, because rewriting a file
exactly depends on it.

### States

The names come from the designer's `data/catalog.json`, and the files agree
with them. Stacked tables sit 70.5 apart when set up and 7.3 apart when folded,
which are exactly the heights of `table.bin` and `ground_table.bin`. Folded
ladders sit 21 apart, the height of `ground_ladder.bin`.

| id | Name |
|---|---|
| 15010 | Default (folded, on the ground) |
| 15001 | Set Up |
| 15009 | Set Up CHAIR |
| 15000 | Static |
| 15002 | Corner (not used in the sample files) |
| 0 or not stored | Gameplay props such as the ambulance, casket and dumpster |

## Writing files exactly like the originals

The game would probably load any valid FlatBuffer. Matching the original
layout byte for byte has a bonus, though: saving without edits reproduces the
identical file, which is a free correctness check.

The layout matches what the standard FlatBuffers C++ builder produces. These
rules reproduce all 19 files exactly (see `Builder` in propset.py):

1. **Direction:** build the buffer back to front.
2. **Each prop, in list order:** create its position, rotation and scale
   (only the ones stored), then its unk6 list, then the prop table itself.
3. **Top level:** create the props list (offsets to each prop), then the root
   table.
4. **Field order:** inside any table, add the biggest fields first (4 bytes,
   then 2, then 1). Among fields of the same size, add the highest field id
   first. Offsets count as 4 bytes.
5. **Alignment:** align every value to its own size, and offsets and list
   lengths to 4. A table's size is measured from where the buffer was when
   the table started, so padding added before its first field counts toward
   it.
6. **Shared vtables:** when a table's vtable matches an earlier one byte for
   byte (vtable size, table size and field offsets), point at the earlier one
   instead of writing a new one.
7. **Finish:** pad so the 8-byte header ends on a 4-byte boundary, write
   `Prop`, then write the offset to the root table.

Floats are float32. Keep `-0.0` as `-0.0`, because the intermediary's files
contain many.

## Designer coordinates ↔ jsfb

The designer and .propsprofile use Blender world space, with Z up. The jsfb
uses its own axes, where height is -y.

| | Designer / .propsprofile | jsfb |
|---|---|---|
| Position | x, y, z | x, **-z**, **y** |
| Rotation | rx, ry, rz | rx, **rz**, **ry** |
| prop_id, state | the same numbers | the same numbers |

Going back: designer `x = jsfb.x`, `y = jsfb.z`, `z = -jsfb.y`, and
`rx = jsfb.x`, `ry = jsfb.z`, `rz = jsfb.y`. The conversion only swaps axes and
flips signs, so values never drift over repeated saves.

Why this mapping is believed right (the intermediary's code was not
available):

- **Position:**
  - The Ambulance file's ambulance (prop 6454) sits at jsfb x = 77. The
    designer's ambulance model (`env_amb.bin`) is centered at x = 77.4.
  - That prop's jsfb z of 1180 lies inside the model's Blender y range
    (566 to 1344).
  - A shelf in EliminationChamber sits at jsfb y = -106, which is the
    designer's ring height (`RING_Z = 106`).
  - Stacked props go toward -y, and their spacing matches the model heights
    listed under [States](#states).
- **Rotation, from the math:** the add-on reads `(rx, ry, rz)` as a Blender
  Euler in XZY order with angles `(rx, ry, -rz)`, meaning
  `R = Ry(ry)·Rz(-rz)·Rx(rx)` (see `../js/rotation.js`). Rewritten in jsfb
  axes, that is `R = Rz(ry)·Ry(rz)·Rx(rx)`. This is the standard X-then-Y-then-Z
  rotation, with angles `(rx, rz, ry)`. It probably explains why the add-on
  uses its unusual convention: it matches the game's.
- **Rotation, from signed zeros:** Blender's `to_euler('XZY')` (used by the
  add-on's export) writes `-0` or `+0` in a fixed pattern for each kind of
  rotation. The jsfb files carry that pattern straight across, with no sign
  changes:

  | Kind of rotation | Add-on writes (rx, ry, rz) | jsfb has (x, y, z) | Props |
  |---|---|---|---|
  | None | (-0, -0, -0) | (-0, -0, -0) | 413 |
  | Turn under 90° | (-0, -0, ψ) | (-0, ψ, -0) | 35 |
  | Turn over 90° | (+0, +0, ψ) | (+0, ψ, +0) | 107 |
  | Turn of exactly ±90° | (+0, -0, ψ) | (+0, ψ, -0) | 124 |
  | Tilt around X only | (α, -0, -0) | (α, -0, -0) | 78 |
  | Tilt around Y only | (-0, β, -0) | (-0, -0, β) | 16 |

More checks, run with the designer's models:

- **Resting heights:** 127 props are tilted. Swapping the rotation axes, or
  flipping the sign of rx, would sink 18 to 23 of them below the floor. The
  mapping above sinks 2. The signs of ry and rz can't be tested this way,
  because most prop models are symmetric left to right.
- **Which way chairs face:** 140 chairs are set up. The mapping above makes 8
  of the 12 in EliminationChamber face the ring (median 10° off). With the
  sign of rz flipped, those 8 face away from it (median 170° off). The one
  chair in Lights_Out, a file the game itself wrote, faces the ring only
  with the mapping above.
- **Game-written files:** in Lights_Out, the tilted folded tables come out
  leaning against the barricade.

The designer rounds values to 3 decimals when it writes a prop it changed or
added, like a .propsprofile does. So exporting a scene straight to .jsfb should
give the same bytes as exporting a profile and running it through the
intermediary. Comparing those two files is the quickest way to confirm the
mapping (step 1 below).

## What the designer can and can't represent

**Props.** The catalog recognizes 826 of the 845 props. It doesn't know these
19, and several of them are what make a match work:

| prop_id | State | File | What it is |
|---|---|---|---|
| 6454 | 0 | Ambulance | the ambulance itself |
| 9299 | not stored | Gameplay_Casket | the match's casket |
| 9300 | not stored | Gameplay_Dumpster | the match's dumpster |
| 9463 (×6), 2065 | not stored | KingOfHell | unknown |
| 32, 9284, 9285, 9438 | 15000 | Wargames | 9438 is the belt pedestal (the catalog only has it as Default); it also has a unk6 list |
| 10000 (×3) | 15001 | Wargames | unknown; each has a unk6 list and unk9 |
| 4324, 4325 | 15009 | Lights_Out | unknown |

**Fields.** A .propsprofile has no place for `unk1`, `unk6`, `unk7`, `unk9`,
`unk11`, `unk12`, scale, or the file's own `unk1`. Scale is always 1, so losing
it costs nothing. The intermediary's files lose nothing either, since it
writes the same `unk1` hash everywhere. But a round trip through a
.propsprofile would drop the extra fields in Wargames, Lights_Out,
KingOfHell and Gameplay_Casket.

Editing the jsfb directly avoids both problems, as long as the designer keeps
what it doesn't understand (see the plan below).

## Plan: editing game files in the designer

The flow:

1. **Open game folder**, once, choosing the folder the game (or your mod loader)
   reads the prop sets from. The designer lists every `PropsSet_*.jsfb` as a
   match type.
2. **Pick a match type.** Its props load, and the arena follows the name:
   Ambulance → AMB, EliminationChamber → EC, HIAC → HIAC, Wargames → WG, and
   everything else → the normal ring.
3. **Edit** as usual.
4. **Save** overwrites that file. The first save copies the original into a
   `backup/` subfolder of the game folder.

What to build:

- **`js/jsfb.js`:** a port of propset.py's reader and writer (about 150 lines,
  using `DataView`, no library, so still no build step). Check it against
  propset.py on all 19 files.
- **Converting jsfb props to the designer's prop records** `{key, state, x, y,
  z, rx, ry, rz}` with the mapping above, and back. Match props to catalog
  entries the same way `parseProfile` in `../js/profile.js` does, by prop_id
  and state id.
- **Hidden fields per prop:** keep everything the designer doesn't show
  (`unk1`, `unk6`, `unk7`, `unk9`, `unk11`, `unk12`, scale, and which fields
  were stored) on the prop record, and write it back unchanged. Prop records
  are plain objects, so undo and autosave (`../js/store.js`) carry it along
  automatically.
- **Opening and saving:** use the browser's File System Access API
  (`showDirectoryPicker`, then write through the file handle). This works in
  Chrome and Edge, including on `localhost` through `tools/dev_server.py`, and
  the browser asks for permission. Firefox can't write files, so there it
  would fall back to a normal file picker plus downloading the saved `.jsfb`.
- **UI:** an "Open game folder" button, a match type picker, Save, and a marker
  for unsaved changes. Also ask before switching match types with unsaved
  changes, since the scene autosave today assumes one scene.
  `importFile` / `importText` in `../js/ui.js` show how imports are wired
  today (the Import button and drag and drop both go through `importFile`).

Rules for saving:

- **Edit the file, don't replace it.** Props the designer doesn't know (the
  table above) stay in the file untouched, in their original order. Showing
  them as locked boxes in the viewport would work well. Dropping them could
  break the match, for example Casket without its casket.
- **New props** use the format the intermediary already writes: every field
  stored, `unk1 = 0x49016AEE`, scale 1, state from the catalog, and an empty
  `unk6`.
- **Keep the file's own `unk1`** as it is.
- **A save without edits must produce the identical file.** That makes a
  cheap automatic check.

The .propsprofile import and export can stay as they are.

## Before retiring the intermediary

1. **Confirm the mapping once.** `test_phy.propsprofile` is a good test,
   because all 22 of its props are tilted on every axis. Run it through the
   intermediary. Then import the same profile into the designer and export it
   as a game prop set. The two files should be identical (`fc /b a.jsfb
   b.jsfb` on Windows). If they differ, read the intermediary's file with
   `python propset.py read -f Files/<resulting file>.jsfb`: every prop should
   show position `(x, -z, y)` and rotation `(rx, rz, ry)` of its line in the
   profile.
2. **Try one edited match type in the game** before editing many.
3. **Worth testing in the game:**
   - whether the empty match types (Falls Count Anywhere, I Quit, Last Man
     Standing) actually show props you add;
   - how many props a set can have (HIAC with 106 works).

## Open questions

- What `unk1` (per prop and per file), `unk6`, `unk7`, `unk9`, `unk11` and
  `unk12` mean. Keeping them untouched is safe; changing them is guesswork.
- Field ids 8 and 10 never appear, so their types are unknown. propset.py
  refuses a file that uses them rather than guessing, and a port should do
  the same.
- Whether props with state 0 behave differently from the catalog states.
