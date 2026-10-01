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
const TURN_SECONDS = 10;                                 // a recorded turn
const VIDEO_W = 1280, VIDEO_H = 720, VIDEO_FPS = 30;     // small enough to share
const VIDEO_BITS = 1_200_000;                            // about 1.5 MB a turn
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
  if (!playing || dragging || rec?.offline) return;
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
  $('sc-record').textContent = rec ? `■ Cancel${rec.progress != null ? ` (${rec.progress}%)` : ''}` : '● Record a turn';
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

// The video: 720p, 30 fps, one 10-second turn, a fixed low bitrate.
// Where the browser can (WebCodecs), every frame is drawn and encoded one by
// one at a set bitrate: smooth on any computer, and the size is known
// (about 1.5 MB). Elsewhere, MediaRecorder records the turn as it plays.

const what = () => (S.profile ? S.profile.replace(/\.propsprofile$/i, '') : S.match ? M.matchName(S.match) : 'Free design');

// The view cut to 16:9 from the middle, into the 720p canvas.
function copyInto(ctx, src) {
  const sw = src.width, sh = src.height, k = Math.min(sw / VIDEO_W, sh / VIDEO_H);
  const cw = VIDEO_W * k, ch = VIDEO_H * k;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, VIDEO_W, VIDEO_H);
}

async function encoderConfig() {
  if (!window.VideoEncoder || !window.VideoFrame) return null;
  const base = { width: VIDEO_W, height: VIDEO_H, bitrate: VIDEO_BITS, bitrateMode: 'constant', framerate: VIDEO_FPS, avc: { format: 'avc' } };
  const tries = [];
  for (const codec of ['avc1.4d0028', 'avc1.42001f']) {
    tries.push({ ...base, codec, hardwareAcceleration: 'prefer-software' }, { ...base, codec });
  }
  for (const c of tries) {
    try {
      if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
    } catch { /* try the next */ }
  }
  return null;
}

async function record() {
  const config = await encoderConfig();
  if (config) return recordFrames(config);
  return recordLive();
}

async function recordFrames(config) {
  let Muxer, ArrayBufferTarget;
  try {
    ({ Muxer, ArrayBufferTarget } = await import('mp4-muxer'));
  } catch {
    return recordLive();
  }
  const out = document.createElement('canvas');
  out.width = VIDEO_W; out.height = VIDEO_H;
  const ctx = out.getContext('2d');
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: VIDEO_W, height: VIDEO_H, frameRate: VIDEO_FPS }, fastStart: 'in-memory' });
  let failed = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
  enc.configure(config);
  rec = { offline: true, cancelled: false, progress: 0 };
  syncBar();
  const r = rec;
  const total = TURN_SECONDS * VIDEO_FPS, step = (Math.PI * 2) / total;
  const startPolar = basePolar;
  try {
    for (let i = 0; i < total; i++) {
      if (r.cancelled || failed) break;
      if (i) turn(step);
      setPolar(startPolar + Math.sin((i / VIDEO_FPS) * 0.35) * 0.05);
      V.controls.update();
      copyInto(ctx, V.renderNow());
      const frame = new VideoFrame(out, { timestamp: Math.round((i * 1e6) / VIDEO_FPS), duration: Math.round(1e6 / VIDEO_FPS) });
      enc.encode(frame, { keyFrame: i % (VIDEO_FPS * 2) === 0 });
      frame.close();
      const pct = Math.floor((i / total) * 100);
      if (pct !== r.progress) { r.progress = pct; syncBar(); }
      // let the page breathe, and don't run ahead of the encoder
      while (enc.encodeQueueSize > 4) await new Promise((res) => setTimeout(res, 5));
      if (i % 6 === 5) await new Promise((res) => setTimeout(res, 0));
    }
    if (!r.cancelled && !failed) await enc.flush();
  } catch (e) {
    failed ??= e;
  } finally {
    try { enc.close(); } catch { /* already closed */ }
    rec = null;
    t = 0;
    basePolar = startPolar;
    syncBar();
  }
  if (r.cancelled) return;
  if (failed) {
    toast(`Couldn’t make the video: ${failed.message || failed}`, { error: true });
    return;
  }
  muxer.finalize();
  save(new Blob([muxer.target.buffer], { type: 'video/mp4' }), 'mp4');
}

function save(blob, ext) {
  const name = `${siteName()} - ${what()}.${ext}`;
  download(name, blob);
  const mb = blob.size / 1048576;
  toast(`Video saved: ${name} (${mb < 1 ? `${Math.round(blob.size / 1024)} KB` : `${mb.toFixed(1)} MB`})`, { ms: 6000 });
}

// Fallback: record the turn as it plays.
function recordLive() {
  const types = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const type = types.find((x) => window.MediaRecorder?.isTypeSupported?.(x));
  const out = document.createElement('canvas');
  out.width = VIDEO_W; out.height = VIDEO_H;
  const ctx = out.getContext('2d');
  if (!type || !out.captureStream) {
    toast('This browser can’t record video. Chrome or Edge can.', { error: true });
    return;
  }
  V.onRendered((src) => copyInto(ctx, src));
  const stream = out.captureStream(VIDEO_FPS);
  const chunks = [];
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: VIDEO_BITS });
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec = { mr, cancelled: false, timer: 0 };
  mr.onstop = () => {
    V.onRendered(null);
    stream.getTracks().forEach((tr) => tr.stop());
    const r = rec;
    rec = null;
    syncBar();
    if (!r || r.cancelled || !chunks.length) return;
    save(new Blob(chunks, { type }), type.startsWith('video/mp4') ? 'mp4' : 'webm');
  };
  playing = true;
  t = 0;
  mr.start(250);
  rec.timer = setTimeout(() => stopRecording(), TURN_SECONDS * 1000 + 150);
  syncBar();
}

function stopRecording(cancel = false) {
  if (!rec) return;
  if (rec.offline) {
    rec.cancelled = true; // the frame loop stops and saves nothing
    return;
  }
  clearTimeout(rec.timer);
  rec.cancelled = cancel;
  if (rec.mr.state !== 'inactive') rec.mr.stop();
}
