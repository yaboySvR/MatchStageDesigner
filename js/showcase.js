// Showcase mode: the panels go away and the camera circles the props slowly,
// without handles or highlights. Drag to change the angle, scroll to zoom.
// "Record a turn" saves one full circle as a video to share.

import * as V from './viewport.js';
import { S } from './state.js';
import * as tools from './tools.js';
import * as M from './matches.js';
import { toast } from './toast.js';
import { download } from './profile.js';
import { siteName } from './features.js';

const $ = (id) => document.getElementById(id);
const SPEEDS = { slow: 0.06, normal: 0.12, fast: 0.24 }; // radians per second
const TURN_SECONDS = 16;                                 // a recorded turn
const VIDEO_W = 1280, VIDEO_H = 720, VIDEO_FPS = 30;     // small enough to share
const VIDEO_BITS = 2_000_000;                            // about 4 MB a turn
const IDLE_MS = 2500;                                    // the bar fades after this

let on = false, playing = true, speed = 'normal';
let raf = 0, last = 0, t = 0, basePolar = 0, dragging = false, idle = 0;
let rec = null;

export const showcaseOn = () => on;

export function initShowcase() {
  $('btn-showcase').addEventListener('click', enter);
  $('sc-play').addEventListener('click', togglePlay);
  $('sc-exit').addEventListener('click', exit);
  $('sc-record').addEventListener('click', () => (rec ? stopRecording() : record()));
  for (const b of document.querySelectorAll('#sc-speed [data-speed]')) b.addEventListener('click', () => setSpeed(b.dataset.speed));
  V.controls.addEventListener('start', () => { dragging = true; });
  V.controls.addEventListener('end', () => { dragging = false; basePolar = polar(); t = 0; });
  // While showing, keys don't reach the editor: Esc leaves, Space pauses.
  window.addEventListener('keydown', (e) => {
    if (!on) return;
    if (document.querySelector('dialog[open]')) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); rec ? stopRecording() : exit(); }
    else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  }, true);
  window.addEventListener('keyup', (e) => { if (on) e.stopImmediatePropagation(); }, true);
  $('viewport').addEventListener('pointermove', wake);
}

function enter() {
  if (on) return;
  if (S.mode === 'add') tools.exitAdd();
  tools.selectOnly([]);
  on = true;
  playing = true;
  document.body.classList.add('showcase');
  $('showcase-bar').hidden = false;
  V.setClean(true);
  V.controls.mouseButtons.LEFT = 0; // THREE.MOUSE.ROTATE: drag to look around
  requestAnimationFrame(() => {
    V.frameScene();
    // a slightly high, cinematic angle
    const k = Math.min(Math.max(polar(), 0.9), 1.25);
    setPolar(k);
    V.controls.update();
    basePolar = k;
    t = 0;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  });
  syncBar();
  wake();
}

function exit() {
  if (!on) return;
  stopRecording(true);
  on = false;
  cancelAnimationFrame(raf);
  document.body.classList.remove('showcase', 'showcase-idle');
  $('showcase-bar').hidden = true;
  V.setClean(false);
  V.controls.mouseButtons.LEFT = null;
  V.requestRender();
}

function frame(now) {
  if (!on) return;
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!playing || dragging) return;
  t += dt;
  const rate = rec ? (Math.PI * 2) / TURN_SECONDS : SPEEDS[speed];
  turn(rate * dt);
  setPolar(basePolar + Math.sin(t * 0.35) * 0.05); // a gentle rise and fall
  V.controls.update();
  V.requestRender();
}

// Angle from straight up, and turning around the target, keeping the distance.
function polar() {
  const d = V.camera.position.clone().sub(V.controls.target);
  return Math.acos(Math.min(1, Math.max(-1, d.z / d.length())));
}
function setPolar(p) {
  const tg = V.controls.target, d = V.camera.position.clone().sub(tg);
  const r = d.length(), az = Math.atan2(d.y, d.x);
  V.camera.position.set(tg.x + r * Math.sin(p) * Math.cos(az), tg.y + r * Math.sin(p) * Math.sin(az), tg.z + r * Math.cos(p));
}
function turn(a) {
  const tg = V.controls.target, p = V.camera.position;
  const x = p.x - tg.x, y = p.y - tg.y, c = Math.cos(a), s = Math.sin(a);
  p.x = tg.x + x * c - y * s;
  p.y = tg.y + x * s + y * c;
}

function togglePlay() {
  playing = !playing;
  syncBar();
}

function setSpeed(s) {
  speed = s;
  syncBar();
}

function syncBar() {
  $('sc-play').textContent = playing ? '❚❚ Pause' : '▶ Play';
  for (const b of document.querySelectorAll('#sc-speed [data-speed]')) b.setAttribute('aria-checked', String(b.dataset.speed === speed));
  $('sc-record').textContent = rec ? '■ Stop recording' : '● Record a turn';
  $('sc-record').classList.toggle('recording', !!rec);
  $('sc-speed').classList.toggle('disabled', !!rec);
}

// The bar fades when the mouse rests, so the view is clean.
function wake() {
  if (!on) return;
  document.body.classList.remove('showcase-idle');
  clearTimeout(idle);
  idle = setTimeout(() => { if (on) document.body.classList.add('showcase-idle'); }, IDLE_MS);
}

// ---------------------------------------------------------------- recording

function pickType() {
  const types = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || null;
}

function record() {
  const type = pickType();
  // The view is copied, cut to 16:9 from the middle, into a 720p canvas that is recorded.
  const out = document.createElement('canvas');
  out.width = VIDEO_W; out.height = VIDEO_H;
  const ctx = out.getContext('2d');
  if (!type || !out.captureStream) {
    toast('This browser can’t record video. Chrome or Edge can.', { error: true });
    return;
  }
  V.onRendered((src) => {
    const sw = src.width, sh = src.height, k = Math.min(sw / VIDEO_W, sh / VIDEO_H);
    const cw = VIDEO_W * k, ch = VIDEO_H * k;
    ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, VIDEO_W, VIDEO_H);
  });
  const stream = out.captureStream(VIDEO_FPS);
  const chunks = [];
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: VIDEO_BITS });
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec = { mr, stream, chunks, type, cancelled: false, timer: 0 };
  mr.onstop = () => {
    V.onRendered(null);
    stream.getTracks().forEach((tr) => tr.stop());
    const r = rec;
    rec = null;
    syncBar();
    if (!r || r.cancelled || !chunks.length) return;
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const what = S.profile ? S.profile.replace(/\.propsprofile$/i, '') : S.match ? M.matchName(S.match) : 'Free design';
    const name = `${siteName()} - ${what}.${ext}`;
    download(name, new Blob(chunks, { type }));
    toast(`Video saved: ${name}`, { ms: 6000 });
  };
  playing = true;
  t = 0;
  mr.start(250);
  rec.timer = setTimeout(() => stopRecording(), TURN_SECONDS * 1000 + 150);
  syncBar();
}

function stopRecording(cancel = false) {
  if (!rec) return;
  clearTimeout(rec.timer);
  rec.cancelled = cancel;
  if (rec.mr.state !== 'inactive') rec.mr.stop();
}
