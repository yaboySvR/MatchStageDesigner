// Walk navigation, the way Blender does it (View ‣ Navigation ‣ Walk
// Navigation, Shift+`): the mouse looks around and the keyboard moves the
// view, with Blender's keys and default settings. Click or Enter keeps the new
// view; Esc or right-click goes back to where the walk started.
//
//   W A S D / arrows  move                 Space  teleport to the crosshair
//   E / Q             straight up / down   Tab    gravity on / off
//   R / F             up / down the view   V      jump (gravity; hold for full height)
//   Shift / Alt       faster / slower ×5   wheel, + / -  change the speed
//   . / ,             jump higher / lower
//
// Placing while walking: the prop being placed when the walk started hangs
// at the crosshair; G drops it there (physics; a set goes down as saved),
// hold C for the prop wheel, [ / ] turn it. tools.js does the placing; this
// file only tells it when (events 'walk-drop', 'walk-turn', 'walk-pick').
//
// Those are the default keys; Settings changes them and the mouse speed
// (settings.js). Esc, the mouse buttons and the wheel stay as they are.
//
// The profile works in centimeters, so Blender's defaults become: walk speed
// 2.5 m/s = 250 a second, eye height 1.6 m = 160, jumps 0.4 m, gravity
// 9.81 m/s², teleports 0.2 s. The speed and the gravity choice are remembered.
//
// With gravity the camera stays at eye height above whatever is under it
// (floor, ring, props), hops up onto things it walks into and falls off edges,
// as in Blender. Finding the floor every frame uses the physics engine's copy
// of the scene (physics.js), which downloads the first time gravity is on;
// until it's ready the snap surfaces (floor, ring, stage) stand in. Teleport
// aims at what is drawn (viewport.js castRay).

import * as THREE from 'three';
import { S, emit } from './state.js';
import * as V from './viewport.js';
import * as P from './physics.js';
import * as store from './store.js';
import { snapZ } from './snapping.js';
import { settings, keyId, keyLabel } from './settings.js';
import { getProp } from './catalog.js';
import { openWheel, wheelMove, wheelConfirm, wheelCancel } from './wheel.js';

const DEG = Math.PI / 180;
const UNIT = 100;                  // world units per meter
const LOOK = 0.15 * DEG;           // turn per pixel of mouse movement (× the sensitivity setting)
const TOP = 85 * DEG;              // look up at most this far,
const BOTTOM = -80 * DEG;          // and down this far
const BOOST = 5;                   // Shift / Alt speed factor
const EYE = 1.6 * UNIT;            // camera height above the floor, with gravity
const GRAVITY = 9.80665 * UNIT;    // per second²
const TELEPORT_TIME = 0.2;         // seconds
const JUMP_TIME_MAX = 0.2;         // hold V this long for a full jump;
const JUMP_SPEED_MIN = 1 * UNIT;   // a tap takes off at this speed
const SPIKE = 500;                 // mouse jumps bigger than this are browser glitches
const PICK_REACH = 360;            // prop wheel: how far the (hidden) pointer can go from the middle
const DOWN = { x: 0, y: 0, z: -1 };

let w = null;                      // the walk in progress
let byKey = new Map();             // key -> the walk action it does (settings.js), set as a walk starts
let cross = null, coords = null, lockWatched = false;

export const walking = () => !!w;

const _dir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();

// Unit vector the camera looks along (yaw: 0 = +X, counter-clockwise).
function lookDir(yaw, pitch, out = _dir) {
  const c = Math.cos(pitch);
  return out.set(c * Math.cos(yaw), c * Math.sin(yaw), Math.sin(pitch));
}

// The camera's own up (screen up), for R / F.
function viewUp(out) {
  const s = Math.sin(w.pitch);
  return out.set(-s * Math.cos(w.yaw), -s * Math.sin(w.yaw), Math.cos(w.pitch));
}

// Is one of an action's keys down?
const on = (action) => settings.walkKeys[action].some((k) => k && w.held.has(k));
const axis = (plus, minus) => (on(plus) ? 1 : 0) - (on(minus) ? 1 : 0);
const speedNow = () => S.walkSpeed * UNIT * (w.fast ? BOOST : w.slow ? 1 / BOOST : 1);

function mapKeys() {
  byKey = new Map();
  for (const [action, keys] of Object.entries(settings.walkKeys)) {
    for (const k of keys) if (k && !byKey.has(k)) byKey.set(k, action);
  }
}

// ---------------------------------------------------------------- start / end

export function startWalk() {
  if (w) return;
  const cam = V.camera, target = V.controls.target;
  const dir = target.clone().sub(cam.position);
  const dist = dir.length();
  dir.divideScalar(dist || 1);
  w = {
    from: { position: cam.position.clone(), target: target.clone() }, dist,
    yaw: Math.atan2(dir.y, dir.x), pitch: Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1)),
    held: new Set(), fast: false, slow: false, look: { x: 0, y: 0 }, wheel: 0,
    vel: new THREE.Vector3(),      // sideways speed while walking (a jump keeps it)
    air: null,                     // falling / jumping
    teleport: null,
    picking: null,                 // prop wheel open: { cx, cy, x, y } (its middle, pointer offset)
    jumpHeight: 0.4 * UNIT,
    last: performance.now(), locked: false,
  };
  mapKeys();
  V.controls.enabled = false;
  listen(true);
  if (!lockWatched) {
    lockWatched = true;
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockChange);
  }
  V.onFrame(frame);
  cross ||= document.getElementById('walk-cross');
  coords ||= document.getElementById('status-coords');
  cross.hidden = false;
  document.body.classList.add('walking');
  showEye();
  const canvas = V.renderer.domElement;
  canvas.focus({ preventScroll: true });
  // Hides the cursor and gives endless mouse movement. If the browser says no
  // (e.g. right after Esc left the last walk), walking still works; the
  // cursor is only hidden.
  try { canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* no pointer lock */ }
  if (S.walkGravity) P.load().catch(() => {});
  emit('walk');
}

// keep: stay at the new view (orbiting then turns around what the crosshair
// is on), or go back to where the walk started.
function end(keep) {
  const s = w;
  if (!s) return;
  w = null;
  if (s.picking) wheelCancel();
  listen(false);
  V.onFrame(null);
  if (document.pointerLockElement) document.exitPointerLock();
  document.body.classList.remove('walking');
  cross.hidden = true;
  const cam = V.camera, controls = V.controls;
  if (keep) {
    const dir = lookDir(s.yaw, s.pitch, new THREE.Vector3());
    const hit = V.castRay(cam.position, dir);
    const dist = THREE.MathUtils.clamp(hit ? hit.dist : s.dist, 50, controls.maxDistance * 0.9);
    controls.target.copy(cam.position).addScaledVector(dir, dist);
  } else {
    cam.position.copy(s.from.position);
    controls.target.copy(s.from.target);
  }
  controls.enabled = true;
  controls.update();
  store.save();
  V.requestRender();
  emit('camera');
  emit('walk');
}

// ---------------------------------------------------------------- input
//
// While walking, every key, click, wheel turn and mouse move is the walk's:
// the listeners run first (capture on window) and stop the rest of the app
// from seeing them. Key releases still pass through.

function listen(on) {
  const f = on ? 'addEventListener' : 'removeEventListener';
  window[f]('keydown', onKeyDown, true);
  window[f]('keyup', onKeyUp, true);
  window[f]('pointerdown', onPointerDown, true);
  window[f]('pointermove', onPointerMove, true);
  window[f]('wheel', onWheel, { capture: true, passive: false });
  window[f]('contextmenu', stop, true);
  window[f]('blur', onBlur);
}

function stop(e) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

// The click that ends the walk shouldn't also click what is under the cursor.
function swallowNext(type) {
  window.addEventListener(type, stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener(type, stop, true), 800);
}

// A Shift or Alt let go while another window had the keyboard never sends its
// key-up; the flags on later events tell.
function dropReleased(e) {
  if (!e.shiftKey) w.held.delete('Shift');
  if (!e.altKey) w.held.delete('Alt');
}

// Faster / slower follow their keys (the HUD shows the speed).
function boost() {
  const fast = on('fast'), slow = on('slow');
  if (fast === w.fast && slow === w.slow) return;
  w.fast = fast;
  w.slow = slow;
  emit('walk');
}

// Esc always goes back: with the mouse captured it's the browser's own key
// for letting go, so it can't mean anything else.
function onKeyDown(e) {
  e.stopImmediatePropagation();
  const k = keyId(e);
  dropReleased(e);
  if (k === 'Escape') {
    e.preventDefault();
    end(false);
    return;
  }
  const action = byKey.get(k);
  if (action || k === 'Alt') e.preventDefault(); // a lone Alt opens the browser's menu
  if (!action) return; // other keys keep their browser meaning
  w.held.add(k);
  if (!e.repeat) act(action);
  if (w) boost();
}

function onKeyUp(e) {
  const k = keyId(e);
  w.held.delete(k);
  dropReleased(e);
  const action = byKey.get(k);
  if (action === 'jump' && !on('jump')) jumpRelease();
  if (action === 'wheel' && !on('wheel')) closeWheel(true);
  if (action || k === 'Alt') e.preventDefault();
  boost();
}

// What a key press does (held actions just work while their key is down).
function act(action) {
  switch (action) {
    case 'confirm': end(true); break;
    case 'cancel': end(false); break;
    case 'teleport': teleport(); break;
    case 'gravity': setGravity(!S.walkGravity); break;
    case 'jump': jump(); break;
    case 'speedUp': changeSpeed(1); break;
    case 'speedDown': changeSpeed(-1); break;
    case 'jumpUp': changeJump(1); break;
    case 'jumpDown': changeJump(-1); break;
    case 'place': emit('walk-drop'); break;
    case 'turnLeft': emit('walk-turn', 15); break;
    case 'turnRight': emit('walk-turn', -15); break;
    case 'wheel': openPropWheel(); break;
    default: // held actions (moving, faster / slower) work while down
  }
}

// The prop wheel in the middle of the view. While it's open the mouse moves
// its (hidden) pointer instead of looking; letting go of the key picks.
function openPropWheel() {
  if (w.picking) return;
  const c = V.viewCenter();
  if (!openWheel(c.x, c.y, (key, state) => emit('walk-pick', key, state))) return;
  w.picking = { cx: c.x, cy: c.y, x: 0, y: 0 };
  wheelMove(c.x, c.y);
  cross.hidden = true;
}

function closeWheel(pick) {
  if (!w.picking) return;
  w.picking = null;
  cross.hidden = false;
  if (pick) wheelConfirm();
  else wheelCancel();
}

function onPointerMove(e) {
  e.stopImmediatePropagation();
  dropReleased(e);
  boost();
  const x = e.movementX || 0, y = e.movementY || 0;
  if (Math.abs(x) > SPIKE || Math.abs(y) > SPIKE) return;
  const p = w.picking;
  if (p) {
    p.x += x;
    p.y += y;
    const d = Math.hypot(p.x, p.y);
    if (d > PICK_REACH) { p.x *= PICK_REACH / d; p.y *= PICK_REACH / d; }
    wheelMove(p.cx + p.x, p.cy + p.y);
    return;
  }
  w.look.x += x;
  w.look.y += y;
}

function onPointerDown(e) {
  stop(e);
  if (e.button === 0) {
    end(true);
    swallowNext('click');
  } else if (e.button === 2) {
    end(false);
    swallowNext('contextmenu');
  }
}

// One wheel notch is one speed step; trackpads step every 50 pixels of scroll.
function onWheel(e) {
  stop(e);
  const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  w.wheel = Math.abs(px) >= 50 ? px : w.wheel + px;
  if (Math.abs(w.wheel) < 50) return;
  changeSpeed(w.wheel < 0 ? 1 : -1);
  w.wheel = 0;
}

function onBlur() {
  w.held.clear();
  closeWheel(false);
  boost();
}

// The browser releases the mouse on Esc: go back, like Blender's Esc. Losing
// it by switching to another window keeps the view instead. A lock granted
// after the walk already ended is handed straight back.
function onLockChange() {
  const locked = document.pointerLockElement === V.renderer.domElement;
  if (!w) {
    if (locked) document.exitPointerLock();
  } else if (locked) {
    w.locked = true;
  } else if (w.locked) {
    end(!document.hasFocus());
  }
}

// ---------------------------------------------------------------- actions

function changeSpeed(dir) {
  const f = 1 + (w.slow ? 0.01 : 0.1);
  S.walkSpeed = THREE.MathUtils.clamp(dir > 0 ? S.walkSpeed * f : S.walkSpeed / f, 0.05, 100);
  emit('walk');
}

function changeJump(dir) {
  w.jumpHeight = THREE.MathUtils.clamp(dir > 0 ? w.jumpHeight * 1.5 : w.jumpHeight / 1.5, 0.1 * UNIT, 10 * UNIT);
  emit('walk');
}

function setGravity(on) {
  S.walkGravity = on;
  w.air = null;
  if (on) P.load().catch(() => {});
  emit('walk');
}

// Space: fly to where the crosshair points, stopping eye height short of the
// surface (above a floor, in front of a wall).
function teleport() {
  const cam = V.camera;
  const dir = lookDir(w.yaw, w.pitch, new THREE.Vector3());
  const hit = V.castRay(cam.position, dir);
  if (!hit) return;
  const to = cam.position.clone().addScaledVector(dir, hit.dist).addScaledVector(hit.normal, EYE);
  w.air = null;
  w.teleport = { t0: performance.now(), from: cam.position.clone(), to };
}

function jump() {
  if (!S.walkGravity || w.air || w.teleport) return;
  const v0 = Math.sqrt(2 * GRAVITY * w.jumpHeight);
  w.air = { t0: performance.now(), z0: V.camera.position.z, v0, rise: v0 / GRAVITY, vx: w.vel.x, vy: w.vel.y, full: v0, holding: true };
}

// Letting go of V early makes a smaller jump (Blender: a tap takes off at
// 1 m/s, holding 0.2 s gives the full height). The arc carries on smoothly.
function jumpRelease() {
  const a = w.air;
  if (!a?.holding) return;
  a.holding = false;
  const now = performance.now();
  const t = (now - a.t0) / 1000;
  if (t >= JUMP_TIME_MAX) return;
  const v = JUMP_SPEED_MIN + (t * (a.full - JUMP_SPEED_MIN)) / JUMP_TIME_MAX - GRAVITY * t;
  Object.assign(a, { t0: now, z0: V.camera.position.z, v0: v, rise: Math.max(v, 0) / GRAVITY });
}

// Height of the first surface under (x, y), looking down from z.
function floorBelow(x, y, z) {
  if (P.ready()) {
    const dist = P.castRay({ x, y, z }, DOWN);
    return dist != null ? z - dist : z >= 0 ? 0 : -Infinity;
  }
  const s = snapZ(x, y);
  return s <= z ? s : 0;
}

// ---------------------------------------------------------------- every frame

function frame(now) {
  if (!w) return;
  const dt = THREE.MathUtils.clamp((now - w.last) / 1000, 0, 0.1);
  w.last = now;
  const cam = V.camera;

  // Mouse right turns right, mouse up looks up (down with Invert mouse),
  // never past the limits.
  let turned = false;
  if (w.look.x || w.look.y) {
    const look = LOOK * settings.lookSpeed;
    w.yaw -= w.look.x * look;
    const dp = w.look.y * look * (settings.invertMouse ? 1 : -1);
    if (dp > 0 && w.pitch < TOP) w.pitch = Math.min(w.pitch + dp, TOP);
    if (dp < 0 && w.pitch > BOTTOM) w.pitch = Math.max(w.pitch + dp, BOTTOM);
    w.look.x = w.look.y = 0;
    turned = true;
  }

  const d = _d.set(0, 0, 0);
  if (w.teleport) {
    teleportStep(d, now);
  } else {
    if (!w.air) walkStep(d, dt, now);
    if (w.air) airStep(d, dt, now);
  }

  const moved = d.lengthSq() > 0;
  if (moved) cam.position.add(d);
  if (!moved && !turned) return;
  cam.lookAt(_v.copy(cam.position).add(lookDir(w.yaw, w.pitch)));
  V.requestRender();
  emit('camera');
  showEye();
}

// Keyboard movement, Blender's way: forward / back along the view (kept level
// with gravity), sideways always level, E / Q straight up / down and R / F
// along the view's up (both only without gravity), all at the same speed.
function walkStep(d, dt, now) {
  const speed = speedNow();
  const f = axis('forward', 'back');
  const s = axis('right', 'left');
  if (f) {
    const dir = lookDir(w.yaw, w.pitch, _v);
    if (S.walkGravity) dir.setZ(0).normalize();
    d.addScaledVector(dir, f);
  }
  if (s) {
    d.x += s * Math.sin(w.yaw);
    d.y -= s * Math.cos(w.yaw);
  }
  if (!S.walkGravity) {
    d.z += axis('up', 'down');
    const u = axis('viewUp', 'viewDown');
    if (u) d.addScaledVector(viewUp(_v), u);
  }
  if (d.lengthSq() > 1e-12) d.normalize().multiplyScalar(speed * dt);
  if (dt > 0) w.vel.set(d.x / dt, d.y / dt, 0);
  if (!S.walkGravity) return;

  // Stay at eye height above the floor ahead, following steps and slopes up
  // to what fast walking covers in a frame. Anything bigger starts a fall (a
  // drop) or hops straight up onto it (something walked into).
  const pos = V.camera.position;
  const diff = floorBelow(pos.x + d.x, pos.y + d.y, pos.z) + EYE - pos.z;
  if (Math.abs(diff) <= Math.max(dt * speed * BOOST, 0.01)) d.z = diff;
  else w.air = { t0: now, z0: pos.z, v0: 0, rise: 0, vx: w.vel.x, vy: w.vel.y };
}

// Falling or jumping: the height follows the jump / fall curve and the camera
// keeps the sideways speed it had. Once past the top of the arc it lands on
// the first surface under it.
function airStep(d, dt, now) {
  const a = w.air, pos = V.camera.position;
  const t = Math.max(0, (now - a.t0) / 1000);
  d.set(a.vx * dt, a.vy * dt, 0);
  const z = a.z0 + a.v0 * t - (GRAVITY * t * t) / 2;
  if (t >= a.rise) {
    const floor = floorBelow(pos.x + d.x, pos.y + d.y, pos.z);
    if (z <= floor + EYE) {
      d.z = floor + EYE - pos.z;
      w.air = null;
      return;
    }
  }
  d.z = z - pos.z;
}

function teleportStep(d, now) {
  const tp = w.teleport;
  const t = THREE.MathUtils.clamp((now - tp.t0) / 1000 / TELEPORT_TIME, 0, 1);
  d.lerpVectors(tp.from, tp.to, t).sub(V.camera.position);
  if (t >= 1) w.teleport = null;
}

// ---------------------------------------------------------------- HUD

function showEye() {
  const p = V.camera.position;
  coords.textContent = `Eye   X ${p.x.toFixed(1)}   Y ${p.y.toFixed(1)}   Z ${p.z.toFixed(1)}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kbd = (k) => `<kbd>${esc(k)}</kbd>`;
const meters = (v) => String(+v.toPrecision(3));

// The first key of each action, as keycaps ('' for an action with no key).
const keys = (...actions) => actions.map((a) => settings.walkKeys[a].find(Boolean)).filter(Boolean).map((k) => kbd(keyLabel(k))).join(' ');
const hint = (caps, text) => (caps ? `${caps} ${text}` : '');

// The walk's lines in the viewport HUD (tools.js shows them), with the keys
// as they are set.
export function hudHtml() {
  if (!w) return '';
  const tab = keys('gravity');
  const jumpKeys = keys('jumpUp', 'jumpDown');
  const placing = S.mode === 'add' ? S.addSet?.name ?? getProp(S.addKey)?.name : null;
  const placeKeys = [hint(keys('place'), 'drop'), hint(keys('turnLeft', 'turnRight'), 'turn')].filter(Boolean).join(', ');
  const status = [
    '<b>WALK</b>',
    `speed <b>${meters(speedNow() / UNIT)} m/s</b>${w.fast ? ' (fast)' : w.slow ? ' (slow)' : ''}`,
    `gravity <b>${S.walkGravity ? 'on' : 'off'}</b>${tab ? ` (${tab})` : ''}`,
    S.walkGravity
      ? hint(keys('jump'), `jump <b>${meters(w.jumpHeight / UNIT)} m</b>${jumpKeys ? ` (${jumpKeys})` : ''}`)
      : hint(keys('up', 'down'), 'up / down'),
    placing && `placing <b>${esc(placing)}</b>${placeKeys ? ` (${placeKeys})` : ''}`,
  ];
  const help = [
    hint(keys('forward', 'left', 'back', 'right'), 'move'),
    hint(keys('fast'), 'fast'),
    hint(keys('slow'), 'slow'),
    'wheel speed',
    hint(keys('teleport'), 'teleport'),
    hint(keys('wheel'), 'props'),
    'click keep view',
    `${kbd('Esc')} go back`,
  ];
  return `${status.filter(Boolean).join(' · ')}<br>${help.filter(Boolean).join(' · ')}`;
}
