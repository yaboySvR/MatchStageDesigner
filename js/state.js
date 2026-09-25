// Shared app state + a tiny event bus.
//
// Coordinates on prop records are Blender world coordinates (Z up, same units
// the game profile uses). Only viewport.js converts to three.js (Y up).

export const ENVIRONMENTS = [
  { key: 'NORMAL', label: 'Ring', name: 'Normal Ring' },
  { key: 'EC', label: 'EC', name: 'Elimination Chamber' },
  { key: 'HIAC', label: 'HIAC', name: 'Hell in a Cell' },
  { key: 'WG', label: 'WG', name: 'WarGames' },
  { key: 'AMB', label: 'Amb.', name: 'Ambulance' },
];

export const S = {
  env: 'NORMAL',
  autoSnap: true,
  stacking: false,
  stage: false,
  xray: false,

  // { id, key, state, x, y, z, rx, ry, rz }
  // x, y, z: Blender world position (same as the profile).
  // rx, ry, rz: the profile's rotation values, kept verbatim (see rotation.js).
  props: [],
  unknownLines: [],        // imported lines with no matching prop, re-exported as-is
  jsfb: null,              // the game prop set file the scene was opened from (propset.js):
                           // { name, root, hasProps, keep: props the catalog doesn't know }
  selected: new Set(),
  nextId: 1,

  mode: 'select',          // select | add | move | rotate
  addKey: null,            // prop being placed, or
  addState: null,
  addSet: null,            // prop set being placed (sets.js)
  placeYaw: 0,             // rotation applied to newly placed props / sets
  placeMirror: false,      // set placement mirrored left-right
  pivot: 'each',           // multi-select rotation: 'each' prop or 'group' center
  gizmo: 'move',           // handles shown on the selection: 'move' | 'rotate'
  space: 'world',          // gizmo axes: 'world' | 'local' (single prop)
  physics: false,          // placing drops props from above the cursor (physics.js)
  dropHeight: 60,          // how far above the surface dropped props start
};

const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
export function emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); }
