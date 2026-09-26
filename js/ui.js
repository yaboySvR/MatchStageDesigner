// Sidebar, selection card, dialogs, import/export wiring.

import { S, ENVIRONMENTS, on } from './state.js';
import {
  catalog, getProp, listedProps, iconFor, displayName, initials,
  isListed, setListed, addCustomProp, removeCustomProp,
} from './catalog.js';
import * as store from './store.js';
import * as V from './viewport.js';
import * as tools from './tools.js';
import { settleNow } from './physics.js';
import { exportProfile, parseProfile, download } from './profile.js';
import { readPropSet, writePropSet, keptProfileLines, envForFile, MATCH_FILES } from './propset.js';
import { parseObj } from './geometry.js';
import { snapZ } from './snapping.js';
import { toast } from './toast.js';
import { initSetsUI, openSaveSetDialog } from './sets-ui.js';
import { initSettingsUI } from './settings-ui.js';
import { keyId } from './settings.js';
import * as GF from './gamefolder.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function iconHtml(url, name) {
  return url
    ? `<img src="${esc(url)}" alt="" loading="lazy" draggable="false">`
    : `<div class="fallback-ico">${esc(initials(name))}</div>`;
}

export function initUI() {
  buildEnvSeg();
  bindToggles();
  bindCatalog();
  initSetsUI();
  bindToolbar();
  initSettingsUI();
  bindProfile();
  bindCustomDialog();
  bindManageDialog();
  bindDragDrop();

  on('props', () => { renderCard(); refreshCounts(); });
  on('selection', renderCard);
  on('transform', () => updateCardValues());
  on('camera', updateDial);
  on('mode', renderCatalog);

  renderCatalog();
  renderCard();
  refreshCounts();

  try {
    if (!localStorage.getItem('ppg.seenHelp')) {
      localStorage.setItem('ppg.seenHelp', '1');
      $('dlg-help').showModal();
    }
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- arena

function buildEnvSeg() {
  const seg = $('env-seg');
  seg.innerHTML = ENVIRONMENTS.map((e) =>
    `<button type="button" role="radio" data-env="${e.key}" title="${esc(e.name)}">${esc(e.label)}</button>`).join('');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-env]');
    if (b) setEnv(b.dataset.env);
  });
  syncEnvSeg();
}

function syncEnvSeg() {
  for (const b of $('env-seg').children) b.setAttribute('aria-checked', String(b.dataset.env === S.env));
}

export async function loadEnvModels() {
  const needed = V.envModelsFor(S.env);
  const pending = needed.filter((id) => !V.envBoxes[id]);
  V.applyEnvState();
  if (!pending.length) return;
  const t = toast(`Loading ${tools.envLabel()}…`, { ms: 60000 });
  try {
    await Promise.all(pending.map((id) => V.ensureEnv(id)));
  } catch (e) {
    toast(`Could not load arena model: ${e.message}`, { error: true });
  } finally {
    t.remove();
  }
}

function setEnv(env) {
  if (S.env === env) return;
  settleNow();
  S.env = env;
  syncEnvSeg();
  refreshCounts();
  store.save();
  loadEnvModels();
}

function bindToggles() {
  const bind = (id, key, after) => {
    const el = $(id);
    el.checked = S[key];
    el.addEventListener('change', () => {
      settleNow();
      S[key] = el.checked;
      store.save();
      after?.();
    });
  };
  bind('opt-autosnap', 'autoSnap', () => {
    // Same as the add-on: turning snapping on snaps the selection.
    if (!S.autoSnap) return;
    const sel = store.selectedProps();
    if (!sel.length) return;
    store.checkpoint();
    const exclude = new Set(sel.map((p) => p.id));
    for (const p of sel) p.z = snapZ(p.x, p.y, exclude);
    store.changed();
  });
  bind('opt-stacking', 'stacking', () => tools.refreshHud());
  bind('opt-stage', 'stage', loadEnvModels);
  bind('opt-xray', 'xray', () => V.applyEnvState());
}

// ---------------------------------------------------------------- catalog

function bindCatalog() {
  $('prop-search').addEventListener('input', renderCatalog);
  $('prop-grid').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const key = t.dataset.key;
    if (S.mode === 'add' && S.addKey === key) tools.exitAdd();
    else tools.enterAdd(key);
    closeSidebarOnMobile();
  });
  $('state-bar').addEventListener('click', (e) => {
    const c = e.target.closest('.state-chip');
    if (c) tools.enterAdd(S.addKey, c.dataset.state);
  });
}

export function renderCatalog() {
  const q = $('prop-search').value.trim().toLowerCase();
  const items = listedProps().filter((p) => !q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q));
  const active = S.mode === 'add' ? S.addKey : null;
  $('prop-grid').innerHTML = items.length ? items.map((p) => `
    <button type="button" class="tile" role="option" data-key="${esc(p.key)}" aria-selected="${p.key === active}" title="${esc(p.name)} · ID ${p.prop_id}">
      <div class="ico">${iconHtml(p.icon, p.name)}</div>
      <div class="label">${esc(p.name)}</div>
      ${p.stateOrder.length > 1 ? `<div class="multi">${p.stateOrder.length} states</div>` : ''}
    </button>`).join('')
    : `<p class="muted" style="grid-column:1/-1">No props match “${esc(q)}”.</p>`;

  const pd = active && getProp(active);
  $('state-bar').innerHTML = pd && pd.stateOrder.length > 1 ? pd.stateOrder.map((st) => `
    <button type="button" class="state-chip" data-state="${esc(st)}" aria-pressed="${st === S.addState}">
      ${iconHtml(iconFor(pd.key, st), pd.name)}${esc(st)}
    </button>`).join('') : '';
}

// ---------------------------------------------------------------- inspector (selection card)

let cardKey = '';
let scrubbing = null; // field being dragged with the mouse

const f2 = (v) => (Math.round(v * 100) / 100).toString();
const deg = (v) => `${Math.round(v * 10) / 10}`;
const isAngle = (f) => f === 'facing' || f[0] === 'r';

function summary(sel) {
  const counts = new Map();
  for (const p of sel) counts.set(p.key, (counts.get(p.key) || 0) + 1);
  return [...counts].map(([k, n]) => `${n} × ${getProp(k).name}`).join(', ');
}

function field(f, label, cls = '', { disabled = false, title = '', suffix = '' } = {}) {
  return `<label class="fld ${cls}" title="${esc(title)}">
      <span class="scrub" data-scrub="${f}" title="Drag left / right to adjust (Shift ×10, Alt ×0.1)">${label}</span>
      <input data-f="${f}" inputmode="decimal" autocomplete="off" spellcheck="false" ${disabled ? 'disabled' : ''}>
      ${suffix ? `<em>${suffix}</em>` : ''}
    </label>`;
}

const ROT_BUTTONS = `
  <div class="rot-btns">
    <button type="button" data-rot="90" title="Rotate 90° left (Shift+[)">⟲ 90°</button>
    <button type="button" data-rot="15" title="Rotate 15° left ([)">⟲ 15°</button>
    <button type="button" data-rot="-15" title="Rotate 15° right (])">15° ⟳</button>
    <button type="button" data-rot="-90" title="Rotate 90° right (Shift+])">90° ⟳</button>
  </div>`;

function dialSvg() {
  const ticks = [];
  for (let i = 0; i < 24; i++) {
    const major = i % 6 === 0;
    ticks.push(`<line class="${major ? 'maj' : ''}" x1="0" y1="${major ? -34 : -37}" x2="0" y2="-41" transform="rotate(${i * 15})"/>`);
  }
  return `<svg viewBox="-48 -48 96 96" aria-hidden="true">
      <circle class="face" r="44"/>
      <g class="ticks">${ticks.join('')}<text class="zero" y="-24">0</text></g>
      <line class="hand" x1="0" y1="0" x2="0" y2="-30"/>
      <circle class="knob" r="6" cy="-30"/>
      <circle class="hub" r="3"/>
    </svg>`;
}

function renderCard() {
  const card = $('selection-card');
  const sel = store.selectedProps();
  if (!sel.length) {
    card.hidden = true;
    cardKey = '';
    return;
  }
  card.hidden = false;
  const key = `${sel.map((p) => `${p.id}:${p.state}`).join(',')}|${S.autoSnap}|${S.pivot}`;
  if (key === cardKey) return updateCardValues();
  cardKey = key;

  const one = sel.length === 1 ? sel[0] : null;
  const keys = new Set(sel.map((p) => p.key));
  const pd = keys.size === 1 ? getProp(sel[0].key) : null;

  const states = pd && pd.stateOrder.length > 1 ? `
      <div class="seg states" role="radiogroup" aria-label="State">
        ${pd.stateOrder.map((st) => `<button type="button" role="radio" data-state="${esc(st)}" aria-checked="${sel.every((p) => p.state === st)}">${iconHtml(iconFor(pd.key, st), pd.name)}<span>${esc(st)}</span></button>`).join('')}
      </div>` : '';

  const head = one ? `
      <div class="insp-head">
        ${iconHtml(iconFor(one.key, one.state), pd.name)}
        <div class="grow"><h3>${esc(pd.name)}</h3><p class="sub">${esc(displayName(one.key, one.state))} · ID ${pd.prop_id}</p></div>
        <button type="button" class="icon-btn" data-act="close" title="Deselect (Esc)" aria-label="Deselect">✕</button>
      </div>` : `
      <div class="insp-head">
        <div class="grow"><h3>${sel.length} props</h3><p class="sub">${esc(summary(sel))}</p></div>
        <button type="button" class="icon-btn" data-act="close" title="Deselect (Esc)" aria-label="Deselect">✕</button>
      </div>`;

  const position = `
      <div class="sec-title">${one ? 'Position' : 'Group center'}<span>drag a letter to adjust · W handles</span></div>
      <div class="fields3">
        ${field('x', 'X', 'x')}
        ${field('y', 'Y', 'y')}
        ${field('z', 'Z', 'z', { title: S.autoSnap ? 'Height above the surface is kept when the prop moves' : '' })}
      </div>
      <button type="button" class="text-btn level" data-act="drop" title="Let ${one ? 'it' : 'them'} fall with physics until ${one ? 'it comes' : 'they come'} to rest (End)">⤓ Drop with physics</button>
      <div class="mirror-row"><span>Mirror a copy</span>
        <button type="button" class="text-btn" data-mirror="lr" title="Copy to the other side of the ring, left ↔ right as you look at it (M)">⇋ Left ↔ right</button>
        <button type="button" class="text-btn" data-mirror="fb" title="Copy to the other side of the ring, front ↔ back as you look at it (Shift+M)">⇵ Front ↔ back</button>
      </div>`;

  const rotation = one ? `
      <div class="sec-title">Rotation<span>profile values · E handles</span></div>
      <div class="fields3 rot-fields">
        ${field('rx', 'RX', 'r', { title: 'Tilt around X (profile rx)' })}
        ${field('ry', 'RY', 'r', { title: 'Tilt around Y (profile ry)' })}
        ${field('rz', 'RZ', 'r', { title: 'Profile rz. Facing = -RZ' })}
      </div>
      <div class="rot">
        <div class="dial" id="dial" tabindex="0" role="slider" aria-label="Facing angle" aria-valuemin="0" aria-valuemax="359" title="Facing: drag to turn (snaps to 15°, Shift for free)">${dialSvg()}</div>
        <div class="rot-side">
          ${field('facing', 'Facing', 'facing wide', { suffix: '°', title: 'The add-on compass angle (= -RZ)' })}
          ${ROT_BUTTONS}
          <button type="button" class="text-btn level" data-act="level" title="Set RX and RY to 0">Stand upright (clear tilt)</button>
        </div>
      </div>` : `
      <div class="sec-title">Rotation<span>E handles</span></div>
      <div class="seg pivot" role="radiogroup" aria-label="Rotate around">
        <button type="button" role="radio" data-pivot="each" aria-checked="${S.pivot === 'each'}" title="Each prop turns in place">Each in place</button>
        <button type="button" role="radio" data-pivot="group" aria-checked="${S.pivot === 'group'}" title="The whole group turns around its center">Around center</button>
      </div>
      ${ROT_BUTTONS}
      <div class="fields3 one">${field('facing', 'Face all', 'facing wide', { suffix: '°' })}</div>
      <button type="button" class="text-btn level" data-act="level" title="Set RX and RY to 0 on every selected prop">Stand all upright (clear tilt)</button>`;

  card.innerHTML = `${head}${states}<div class="insp-sec">${position}</div><div class="insp-sec">${rotation}</div>
      <div class="insp-actions">
        <button type="button" class="btn" data-act="dup" title="Ctrl+D">Duplicate</button>
        <button type="button" class="btn" data-act="save-set" title="Save as a reusable set (Ctrl+G)">Save as set</button>
        <button type="button" class="btn danger" data-act="del" title="Delete">Delete</button>
      </div>`;

  bindCard(card);
  updateCardValues();
}

// Current value of a field for the selection.
function fieldValue(f) {
  const sel = store.selectedProps();
  if (!sel.length) return 0;
  if (f === 'facing') return tools.facingOf(sel[0]);
  if (sel.length > 1 && (f === 'x' || f === 'y' || f === 'z')) return sel.reduce((s, p) => s + p[f], 0) / sel.length;
  return sel[0][f];
}

// Apply a new value. record=false while dragging (one undo step per drag).
function setFieldValue(f, v, record) {
  settleNow();
  const cur = fieldValue(f);
  if (Math.abs(v - cur) < 1e-9) return;
  if (f === 'x') tools.moveBy(v - cur, 0, 0, { record, tag: 'field' });
  else if (f === 'y') tools.moveBy(0, v - cur, 0, { record, tag: 'field' });
  else if (f === 'z') tools.moveBy(0, 0, v - cur, { record, tag: 'field' });
  else if (f === 'facing') tools.setFacing(v, { record });
  else tools.setRawRotation(store.selectedProps()[0], f, v, { record });
}

function bindCard(card) {
  card.querySelector('[data-act="close"]').addEventListener('click', () => tools.selectOnly([]));
  card.querySelector('[data-act="dup"]').addEventListener('click', tools.duplicateSelected);
  card.querySelector('[data-act="save-set"]').addEventListener('click', openSaveSetDialog);
  card.querySelector('[data-act="del"]').addEventListener('click', tools.deleteSelected);
  card.querySelector('[data-act="level"]')?.addEventListener('click', tools.levelSelection);
  card.querySelector('[data-act="drop"]').addEventListener('click', tools.dropSelected);
  card.querySelectorAll('[data-mirror]').forEach((b) => b.addEventListener('click', () => tools.mirrorSelected(b.dataset.mirror)));
  card.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => tools.rotateBy(+b.dataset.rot)));
  card.querySelectorAll('[data-pivot]').forEach((b) => b.addEventListener('click', () => {
    S.pivot = b.dataset.pivot;
    store.save();
    renderCard();
    tools.refreshGizmo();
  }));
  card.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => {
    const sel = store.selectedProps();
    if (sel.every((p) => p.state === b.dataset.state)) return;
    store.checkpoint();
    for (const p of sel) p.state = b.dataset.state;
    store.changed();
  }));

  // Typed values: Enter / blur applies, arrow keys step, Esc reverts.
  card.querySelectorAll('input[data-f]').forEach((inp) => {
    const f = inp.dataset.f;
    const apply = () => {
      const v = parseFloat(inp.value);
      if (!Number.isNaN(v)) setFieldValue(f, v, true);
      updateCardValues(true);
    };
    inp.addEventListener('change', apply);
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { apply(); inp.blur(); }
      else if (e.key === 'Escape') { updateCardValues(true); inp.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const step = (isAngle(f) ? 15 : 1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        setFieldValue(f, fieldValue(f) + step, true);
        updateCardValues(true);
        inp.select();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
  });

  // Drag a field's letter left / right to scrub its value.
  card.querySelectorAll('.scrub').forEach((el) => {
    const f = el.dataset.scrub;
    el.addEventListener('pointerdown', (e) => {
      const inp = card.querySelector(`input[data-f="${f}"]`);
      if (e.button !== 0 || inp.disabled) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      store.checkpoint();
      scrubbing = { f, x: e.clientX, start: fieldValue(f) };
      document.body.classList.add('scrubbing');
    });
    el.addEventListener('pointermove', (e) => {
      if (!scrubbing || scrubbing.f !== f) return;
      const perPx = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      let v = scrubbing.start + (e.clientX - scrubbing.x) * perPx;
      v = e.altKey ? Math.round(v * 10) / 10 : Math.round(v);
      setFieldValue(f, v, false);
    });
    const end = () => {
      if (!scrubbing) return;
      scrubbing = null;
      document.body.classList.remove('scrubbing');
      store.changed();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });

  const dial = card.querySelector('#dial');
  if (dial) bindDial(dial);
}

// The dial is a small top-down view that turns with the camera, so its hand
// points the same way as the prop's rotation on screen.
function dialAngleFromPointer(dial, e) {
  const r = dial.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const screen = (Math.atan2(-dx, -dy) * 180) / Math.PI; // CCW from screen-up
  const yaw = screen + V.viewYaw();
  const snapped = e.shiftKey ? Math.round(yaw) : Math.round(yaw / 15) * 15;
  return ((snapped % 360) + 360) % 360;
}

function bindDial(dial) {
  let dragging = false;
  dial.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    try { dial.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    store.checkpoint();
    tools.setFacing(dialAngleFromPointer(dial, e), { record: false });
  });
  dial.addEventListener('pointermove', (e) => {
    if (dragging) tools.setFacing(dialAngleFromPointer(dial, e), { record: false });
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    store.changed();
  };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 90 : e.altKey ? 1 : 15;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') tools.rotateBy(step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') tools.rotateBy(-step);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

function updateDial() {
  const dial = document.getElementById('dial');
  const sel = store.selectedProps();
  if (!dial || sel.length !== 1) return;
  const facing = tools.facingOf(sel[0]);
  const view = V.viewYaw();
  // SVG rotate() turns clockwise; facing angles are counter-clockwise.
  dial.querySelector('.ticks').setAttribute('transform', `rotate(${view})`);
  const hand = `rotate(${view - facing})`;
  dial.querySelector('.hand').setAttribute('transform', hand);
  dial.querySelector('.knob').setAttribute('transform', hand);
  dial.setAttribute('aria-valuenow', Math.round(facing));
}

function updateCardValues(force = false) {
  const card = $('selection-card');
  const sel = store.selectedProps();
  if (card.hidden || !sel.length) return;
  card.querySelectorAll('input[data-f]').forEach((inp) => {
    if (!force && inp === document.activeElement) return;
    const f = inp.dataset.f;
    const v = fieldValue(f);
    if (f === 'facing' && sel.length > 1) {
      const same = sel.every((p) => Math.abs(tools.facingOf(p) - v) < 0.05);
      inp.value = same ? deg(v) : '';
      inp.placeholder = same ? '' : 'mixed';
    } else {
      inp.value = isAngle(f) ? deg(v) : f2(v);
    }
  });
  updateDial();
}

// ---------------------------------------------------------------- toolbar

function closeSidebarOnMobile() {
  $('app').classList.remove('sidebar-open');
}

function syncGizmoButtons() {
  $('btn-gizmo-move').setAttribute('aria-checked', String(S.gizmo !== 'rotate'));
  $('btn-gizmo-rotate').setAttribute('aria-checked', String(S.gizmo === 'rotate'));
  $('btn-space').textContent = S.space === 'local' ? 'Local' : 'World';
  $('btn-space').setAttribute('aria-pressed', String(S.space === 'local'));
  $('btn-physics').setAttribute('aria-pressed', String(S.physics));
}

function bindToolbar() {
  $('btn-view-top').addEventListener('click', () => V.viewTop());
  $('btn-view-persp').addEventListener('click', () => V.viewPerspective());
  $('btn-frame').addEventListener('click', () => tools.frameSelectionOrAll());
  $('btn-walk').addEventListener('click', () => tools.beginWalk());
  $('btn-undo').addEventListener('click', tools.doUndo);
  $('btn-redo').addEventListener('click', tools.doRedo);
  $('btn-help').addEventListener('click', () => $('dlg-help').showModal());
  $('btn-gizmo-move').addEventListener('click', () => tools.setGizmoMode('move'));
  $('btn-gizmo-rotate').addEventListener('click', () => tools.setGizmoMode('rotate'));
  $('btn-space').addEventListener('click', () => tools.setGizmoSpace(S.space === 'local' ? 'world' : 'local'));
  $('btn-physics').addEventListener('click', () => tools.setPhysics(!S.physics));
  on('gizmo', syncGizmoButtons);
  on('physics', syncGizmoButtons);
  syncGizmoButtons();
  $('btn-sidebar').addEventListener('click', () => $('app').classList.add('sidebar-open'));
  $('btn-sidebar-close').addEventListener('click', closeSidebarOnMobile);
}

function refreshCounts() {
  const n = S.props.length;
  $('placed-count').textContent = `${n} prop${n === 1 ? '' : 's'} placed`;
  $('status-env').textContent = `${tools.envLabel()} · ${n} prop${n === 1 ? '' : 's'}`;
  $('btn-undo').disabled = !store.canUndo();
  $('btn-redo').disabled = !store.canRedo();
}

// ---------------------------------------------------------------- import / export
//
// Two file types: a .propsprofile (the add-on's format) adds its props to the
// scene and exports as text; a game prop set (PropsSet_<Mode>.jsfb) opens as
// the whole scene and saves back as the game's binary file (propset.js).

let expFormat = 'profile';                      // 'profile' | 'jsfb'
const expNames = { profile: 'untitled', jsfb: '' };
let opened = null;                              // { name, bytes } of the last game file opened

const extOf = (format) => (format === 'jsfb' ? '.jsfb' : '.propsprofile');
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function exportSet() {
  const onlySel = $('exp-selected').checked && S.selected.size > 0;
  return onlySel ? S.props.filter((p) => S.selected.has(p.id)) : S.props;
}

// Entries a profile keeps even though no catalog prop matches: lines from
// imported profiles, and props an opened game file had that the catalog lacks.
const unrecognized = () => [...S.unknownLines, ...keptProfileLines(S.jsfb)];

// Refresh the preview; returns what Download saves (text, or bytes for a game file).
function refreshExportPreview() {
  if (expFormat === 'jsfb') return refreshPropSetPreview();
  const onlySel = $('exp-selected').checked && S.selected.size > 0;
  const keepUnknown = $('exp-unknown').checked && !onlySel;
  const text = exportProfile(exportSet(), keepUnknown ? unrecognized() : []);
  const lines = text ? text.trimEnd().split('\n').length : 0;
  $('exp-preview').value = text;
  $('exp-summary').textContent = `${lines} line${lines === 1 ? '' : 's'}`;
  return text;
}

function refreshPropSetPreview() {
  const box = $('exp-jsfb');
  let bytes;
  try {
    bytes = writePropSet({ props: S.props, unknownLines: S.unknownLines, file: S.jsfb });
  } catch (e) {
    box.innerHTML = `<p class="form-error">This scene can't be written as a game file: ${esc(e.message)}</p>`;
    $('exp-download').disabled = true;
    $('exp-folder').disabled = true;
    return null;
  }
  $('exp-download').disabled = false;
  $('exp-folder').disabled = false;
  const kept = S.jsfb?.keep.length || 0;
  const lines = S.unknownLines.length;
  const total = S.props.length + kept + lines;
  const extra = [
    kept && `${kept} prop${kept === 1 ? '' : 's'} the designer can't show, kept as they were`,
    lines && `${lines} unrecognized profile line${lines === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');
  const same = opened && S.jsfb?.name === opened.name && sameBytes(bytes, opened.bytes);
  box.innerHTML = `
    <p><b>${total} prop${total === 1 ? '' : 's'}</b> · ${bytes.length.toLocaleString()} bytes</p>
    ${extra ? `<p class="muted">Includes ${extra}.</p>` : ''}
    <p class="${same ? 'ok' : 'muted'}">${same
      ? `✓ Unchanged: identical to the ${esc(S.jsfb.name)} you opened.`
      : S.jsfb ? `Edits to ${esc(S.jsfb.name)}. Everything else in the file is kept.` : 'A new prop set, written the way the intermediary program writes them.'}</p>
    <p class="muted">${GF.supported()
      ? '<b>Save to game folder</b> writes it over the game’s file for that match type and keeps the original as .bak; or Download it and put it in place yourself.'
      : 'Put it in place of the game’s file for that match type, and keep a copy of the original.'}</p>`;
  return bytes;
}

// Where a game prop set has to go: baking the BakeMe folder only picks it up
// from there. Shown in the export dialog as information.
const BAKE_DIR = 'BakeMe\\Environment\\PropsSet';

function showBakePath() {
  $('exp-bake-path').textContent = `${BAKE_DIR}\\${exportFileName()}`;
}

// ---------------------------------------------------------------- the game folder (gamefolder.js)

// Shown once a folder is picked (next to Save to game folder), to change it.
async function showFolderLine() {
  const line = $('exp-folder-line');
  const dir = await GF.folder();
  line.hidden = !dir || $('exp-folder').hidden;
  line.innerHTML = dir
    ? `Game folder: <b>${esc(dir.name)}</b> <button type="button" class="text-btn" id="exp-folder-change">Change folder</button>`
    : '';
  $('exp-folder-change')?.addEventListener('click', async () => {
    try {
      await pickAndReport();
    } catch (e) {
      if (e.name !== 'AbortError') toast(`Couldn’t use that folder: ${e.message}`, { error: true });
    }
    showFolderLine();
  });
}

async function pickAndReport() {
  const { name, propSets } = await GF.pickFolder();
  if (!propSets) toast(`No PropsSet files in ${name}. If that's the wrong folder, use Change folder.`, { ms: 6000 });
  return name;
}

// Save bytes as `name` in the game folder, asking for the folder first if
// none is picked yet. Returns whether it saved.
async function saveToFolder(name, bytes) {
  try {
    if (!(await GF.folder())) await pickAndReport();
    const { folder, backedUp } = await GF.saveFile(name, bytes);
    toast(`Saved ${name} into ${folder}${backedUp ? ` (the original is kept as ${name}.bak)` : ''}`, { ms: 5000 });
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Couldn’t save into the game folder: ${e.message}`, { error: true });
    return false;
  } finally {
    showFolderLine();
  }
}

// Ctrl+S: a scene opened from a game file goes straight back into the game
// folder; anything else opens Export. Inside Export it's the main button.
async function quickSave() {
  const exp = $('dlg-export');
  if (exp.open) {
    const main = !$('exp-folder').hidden ? $('exp-folder') : $('exp-download');
    if (!main.disabled) main.click();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  settleNow();
  if (S.jsfb && GF.supported() && (await GF.folder())) {
    let bytes;
    try {
      bytes = writePropSet({ props: S.props, unknownLines: S.unknownLines, file: S.jsfb });
    } catch (e) {
      toast(`This scene can't be written as a game file: ${e.message}`, { error: true });
      return;
    }
    const name = /\.jsfb$/i.test(S.jsfb.name) ? S.jsfb.name : `${S.jsfb.name}.jsfb`;
    saveToFolder(name, bytes);
    return;
  }
  $('btn-export').click();
}

function setExportFormat(format) {
  expNames[expFormat] = $('exp-name').value;
  expFormat = format;
  const jsfb = format === 'jsfb';
  for (const b of $('exp-format').children) b.setAttribute('aria-checked', String(b.dataset.format === format));
  $('exp-name').value = expNames[format];
  $('exp-name').placeholder = jsfb ? 'PropsSet_HIAC' : 'untitled';
  if (jsfb) $('exp-name').setAttribute('list', 'exp-names');
  else $('exp-name').removeAttribute('list');
  $('exp-ext').textContent = extOf(format);
  $('exp-preview-field').hidden = jsfb;
  $('exp-jsfb').hidden = !jsfb;
  $('exp-bake').hidden = !jsfb;
  if (jsfb) showBakePath();
  $('exp-copy').hidden = jsfb;
  $('exp-append').hidden = jsfb;
  const toFolder = jsfb && GF.supported();
  $('exp-folder').hidden = !toFolder;
  $('exp-folder-line').hidden = !toFolder;
  $('exp-folder').classList.toggle('primary', toFolder);
  $('exp-download').classList.toggle('primary', !toFolder);
  if (toFolder) showFolderLine();
  $('exp-selected').parentElement.hidden = jsfb || !S.selected.size;
  $('exp-unknown').parentElement.hidden = jsfb || !unrecognized().length;
  $('exp-download').disabled = false;
  $('exp-folder').disabled = false;
  refreshExportPreview();
}

function exportFileName() {
  const fallback = expFormat === 'jsfb' ? 'PropsSet_Custom' : 'untitled';
  const base = $('exp-name').value.trim().replace(/\.(propsprofile|jsfb)$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || fallback;
  return base + extOf(expFormat);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function importText(text, name = 'file') {
  const { items, unknown, invalid } = parseProfile(text);
  if (!items.length && !unknown.length) {
    toast(`No props found in ${name}`, { error: true });
    return;
  }
  store.checkpoint();
  S.unknownLines = [...S.unknownLines, ...unknown];
  const ids = items.map((it) => store.addProp(it).id);
  S.selected = new Set(ids);
  store.changed();
  V.syncProps();
  let msg = `Imported ${items.length} prop${items.length === 1 ? '' : 's'} from ${name}`;
  if (unknown.length) msg += ` · ${unknown.length} unrecognized line${unknown.length === 1 ? '' : 's'} kept for export`;
  if (invalid) msg += ` · ${invalid} malformed entr${invalid === 1 ? 'y' : 'ies'} ignored`;
  toast(msg, { ms: 5000 });
}

// A game prop set replaces the scene (Ctrl+Z brings the old one back), and the
// arena follows the match type.
function openPropSet(bytes, name) {
  const { items, file } = readPropSet(bytes);
  store.checkpoint();
  S.props = [];
  S.unknownLines = [];
  S.selected.clear();
  for (const it of items) store.addProp(it, { jsfb: it.jsfb });
  S.jsfb = { name, ...file };
  opened = { name, bytes };
  store.changed();
  tools.selectOnly([]);
  setEnv(envForFile(name));
  tools.frameSelectionOrAll(true);
  const kept = file.keep.length;
  const more = kept ? `, plus ${kept} the designer can't show (kept in the file)` : '';
  toast(`Opened ${name}: ${items.length} prop${items.length === 1 ? '' : 's'}${more} · Ctrl+Z to undo`, { ms: 6000 });
}

const isPropSet = (b) => b.length >= 8 && String.fromCharCode(...b.subarray(4, 8)) === 'Prop';

async function importFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isPropSet(bytes)) openPropSet(bytes, file.name);
    else importText(new TextDecoder().decode(bytes), file.name);
  } catch (e) {
    toast(`Cannot read ${file.name}: ${e.message}`, { error: true });
  }
}

function bindProfile() {
  const dlg = $('dlg-export');
  $('exp-names').innerHTML = MATCH_FILES.map((n) => `<option value="${n}">`).join('');
  $('exp-format').addEventListener('click', (e) => {
    const b = e.target.closest('[data-format]');
    if (b && b.dataset.format !== expFormat) setExportFormat(b.dataset.format);
  });
  $('btn-export').addEventListener('click', () => {
    settleNow();
    if (!S.props.length && !S.unknownLines.length && !S.jsfb) return toast('Place some props first');
    $('exp-selected').checked = false;
    const n = unrecognized().length;
    $('exp-unknown-label').textContent = `Keep ${n} unrecognized entr${n === 1 ? 'y' : 'ies'} from imported files`;
    // A scene opened from a game file saves back to it by default.
    if (S.jsfb) {
      expNames[expFormat] = $('exp-name').value;
      expNames.jsfb = S.jsfb.name.replace(/\.jsfb$/i, '');
      expFormat = 'jsfb';
      $('exp-name').value = expNames.jsfb;
    }
    setExportFormat(expFormat);
    dlg.showModal();
  });
  $('exp-selected').addEventListener('change', refreshExportPreview);
  $('exp-unknown').addEventListener('change', refreshExportPreview);
  $('exp-download').addEventListener('click', () => {
    const data = refreshExportPreview();
    if (data == null) return;
    const name = exportFileName();
    download(name, data);
    if (expFormat === 'jsfb') toast(`Saved ${name}. Put it in ${BAKE_DIR}, then bake.`, { ms: 8000 });
    dlg.close();
  });
  $('exp-name').addEventListener('input', () => { if (expFormat === 'jsfb') showBakePath(); });
  $('exp-folder').addEventListener('click', async () => {
    const bytes = refreshExportPreview();
    if (bytes == null) return;
    if (await saveToFolder(exportFileName(), bytes)) dlg.close();
  });
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || keyId(e) !== 'KeyS') return;
    e.preventDefault();
    if (!e.repeat) quickSave();
  });
  $('exp-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(refreshExportPreview());
      toast('Copied to clipboard');
    } catch {
      $('exp-preview').select();
      toast('Press Ctrl+C to copy', { error: true });
    }
  });
  $('exp-append').addEventListener('click', () => $('file-append').click());
  $('file-append').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let existing = await readFile(file);
    if (existing && !existing.endsWith('\n')) existing += '\n';
    download(file.name, existing + refreshExportPreview());
    dlg.close();
    toast(`Saved ${file.name} with your props appended`);
  });

  // With a game folder picked (Chrome / Edge), Import's dialog opens in it.
  $('btn-import').addEventListener('click', async () => {
    if (GF.supported() && GF.canOpenFromFolder() && (await GF.folder())) {
      try {
        const file = await GF.openFromFolder();
        if (file) importFile(file);
      } catch (e) {
        toast(`Cannot open: ${e.message}`, { error: true });
      }
      return;
    }
    $('file-import').click();
  });
  $('file-import').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });

  $('btn-clear').addEventListener('click', () => {
    if (!S.props.length && !S.unknownLines.length && !S.jsfb) return;
    store.checkpoint();
    S.props = [];
    S.unknownLines = [];
    S.jsfb = null;
    S.selected.clear();
    store.changed();
    toast('Scene cleared · Ctrl+Z to undo');
  });
}

function bindDragDrop() {
  const hint = $('drop-hint');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; hint.hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    const file = e.dataTransfer.files[0];
    if (file) importFile(file);
  });
}

// ---------------------------------------------------------------- custom props

function resizeIcon(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 256 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function bindCustomDialog() {
  const dlg = $('dlg-custom');
  const err = $('cus-error');
  $('btn-custom').addEventListener('click', () => {
    $('custom-form').reset();
    err.textContent = '';
    $('cus-state').innerHTML = Object.keys(catalog.stateDefs)
      .map((s) => `<option ${s === 'Default' ? 'selected' : ''}>${esc(s)}</option>`).join('');
    dlg.showModal();
  });
  $('custom-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const label = $('cus-label').value.trim();
    const key = label.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
    const pid = parseInt($('cus-pid').value, 10);
    const objFile = $('cus-obj').files[0];
    if (!key) return (err.textContent = 'Label needs at least one letter or number.');
    if (getProp(key)) return (err.textContent = `A prop called ${key} already exists.`);
    if (Number.isNaN(pid) || pid < 0) return (err.textContent = 'Prop ID must be a whole number.');
    if (!objFile) return (err.textContent = 'Choose an OBJ file.');
    $('cus-save').disabled = true;
    try {
      const { positions, indices } = parseObj(await readFile(objFile));
      const iconFile = $('cus-icon').files[0];
      await addCustomProp({
        key,
        label: [label, label.toLowerCase().replace(/\s+/g, '_')],
        prop_id: pid,
        state: $('cus-state').value,
        icon: iconFile ? await resizeIcon(iconFile) : null,
        positions: positions.buffer,
        indices: indices.buffer,
      });
      dlg.close();
      renderCatalog();
      toast(`Added ${label} (${positions.length / 3} vertices)`);
      tools.enterAdd(key);
    } catch (ex) {
      err.textContent = `Could not add prop: ${ex.message}`;
    } finally {
      $('cus-save').disabled = false;
    }
  });
}

function bindManageDialog() {
  const dlg = $('dlg-manage');
  const list = $('manage-list');
  const render = () => {
    const all = [...catalog.order].map(getProp).sort((a, b) => a.name.localeCompare(b.name));
    list.innerHTML = all.map((p) => `
      <label class="manage-row">
        <span class="toggle"><input type="checkbox" data-key="${esc(p.key)}" ${isListed(p.key) ? 'checked' : ''}><span></span></span>
        ${iconHtml(p.icon, p.name)}
        <span class="grow">${esc(p.name)} <span class="muted">· ${p.prop_id}</span></span>
        ${p.custom ? `<span class="tag">custom</span><button type="button" class="text-btn danger" data-remove="${esc(p.key)}">Remove</button>` : ''}
      </label>`).join('');
  };
  $('btn-manage').addEventListener('click', () => { render(); dlg.showModal(); });
  list.addEventListener('change', (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    setListed(key, e.target.checked);
    renderCatalog();
  });
  list.addEventListener('click', async (e) => {
    const key = e.target.dataset.remove;
    if (!key) return;
    e.preventDefault();
    const used = S.props.filter((p) => p.key === key).length;
    if (used && !confirm(`${used} placed prop(s) use ${key}. Remove them too?`)) return;
    if (used) {
      store.checkpoint();
      store.removeProps(S.props.filter((p) => p.key === key).map((p) => p.id));
      store.changed();
    }
    if (S.addKey === key) tools.exitAdd();
    await removeCustomProp(key);
    render();
    renderCatalog();
  });
}
