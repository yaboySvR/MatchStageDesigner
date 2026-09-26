// The Settings dialog (toolbar gear): walk navigation keys and mouse feel
// (settings.js). Also keeps the keys named elsewhere up to date: the Walk
// button's tooltip and the Walk section of the Controls help.
//
// Changing a key: click it, then press the new key (for the start key, the
// whole combination, e.g. Shift + `). Backspace clears it, Esc cancels.

import { on, emit } from './state.js';
import {
  settings, WALK_GROUPS, WALK_ACTIONS, saveSettings, resetWalkSettings, bindWalkKey,
  keyId, keyLabel, comboLabel, walkKeyLabels,
} from './settings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const actionLabel = (id) => WALK_ACTIONS.find((a) => a.id === id)?.label ?? id;

// The app's own one-key shortcuts (tools.js), to warn when the walk key takes
// one over (the walk key is checked first).
const APP_KEYS = {
  KeyW: 'Move handles', KeyE: 'Rotate handles', KeyQ: 'the prop wheel', KeyG: 'Move', KeyR: 'Rotate',
  KeyX: 'Delete', Delete: 'Delete', Backspace: 'Delete', KeyA: 'Select all', KeyF: 'Frame selection',
  Home: 'Frame all', KeyT: 'Top view', KeyP: 'Physics', End: 'Drop', KeyM: 'Mirror set',
  BracketLeft: 'Rotate', BracketRight: 'Rotate', ArrowUp: 'Nudge', ArrowDown: 'Nudge',
  ArrowLeft: 'Nudge', ArrowRight: 'Nudge', PageUp: 'Nudge', PageDown: 'Nudge',
};
const appUse = ({ code, shift }) => (code === 'KeyD' ? (shift ? 'Duplicate' : null) : APP_KEYS[code] || null);

let dlg;
let capture = null;      // the key waiting for a press: { btn, action, i } or { btn, start: true }
let captureEnded = 0;    // when the last one finished (its Esc mustn't also close the dialog)
let swallowUp = null;    // key whose release belongs to a finished capture

export function initSettingsUI() {
  dlg = $('dlg-settings');
  $('btn-settings').addEventListener('click', open);
  renderKeys();

  $('kb-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.kb-key');
    if (btn) startCapture(btn);
  });
  dlg.addEventListener('keydown', onCaptureKey, true);
  dlg.addEventListener('keyup', (e) => {
    if (swallowUp && keyId(e) === swallowUp) {
      e.preventDefault();
      e.stopPropagation();
      swallowUp = null;
    }
  }, true);
  dlg.addEventListener('pointerdown', (e) => {
    if (capture && !capture.btn.contains(e.target)) stopCapture();
  }, true);
  dlg.addEventListener('cancel', (e) => {
    if (capture || performance.now() - captureEnded < 300) e.preventDefault();
  });
  dlg.addEventListener('close', () => { stopCapture(); note(''); });

  $('set-look').addEventListener('input', (e) => {
    settings.lookSpeed = +e.target.value;
    showLook();
    saveSettings();
  });
  $('set-invert').addEventListener('change', (e) => {
    settings.invertMouse = e.target.checked;
    saveSettings();
  });
  $('set-reset').addEventListener('click', () => {
    stopCapture();
    resetWalkSettings();
    syncControls();
    paintAll();
    note('Back to the defaults (Blender’s keys).');
    emit('settings');
  });

  on('settings', refreshLabels);
  refreshLabels();
}

function open() {
  syncControls();
  paintAll();
  note('');
  dlg.showModal();
}

function syncControls() {
  $('set-look').value = settings.lookSpeed;
  $('set-invert').checked = settings.invertMouse;
  showLook();
}

const showLook = () => { $('set-look-val').textContent = `${settings.lookSpeed.toFixed(2)}×`; };
const note = (html) => { $('kb-note').innerHTML = html; };

// ---------------------------------------------------------------- the key list

function slot(action, i) {
  return `<button type="button" class="kb-key" data-action="${action}" data-i="${i}" title="Click, then press a key"></button>`;
}

function renderKeys() {
  const group = (g) => `<div class="kb-group"><h5>${esc(g.name)}</h5>${g.actions.map((a) => `
    <div class="kb-row"><span class="kb-name">${esc(a.label)}${a.note ? `<small>${esc(a.note)}</small>` : ''}</span>${slot(a.id, 0)}${slot(a.id, 1)}</div>`).join('')}</div>`;
  const start = `<div class="kb-group"><h5>Start</h5>
    <div class="kb-row start"><span class="kb-name">Start walking<small>or the toolbar’s Walk</small></span>
    <button type="button" class="kb-key" data-start title="Click, then press the keys"></button></div></div>`;
  const [move, ...rest] = WALK_GROUPS;
  $('kb-list').innerHTML = `<div class="kb-col">${start}${group(move)}</div><div class="kb-col">${rest.map(group).join('')}</div>`;
  paintAll();
}

function paintSlot(btn) {
  const text = 'start' in btn.dataset
    ? comboLabel(settings.walkStart)
    : keyLabel(settings.walkKeys[btn.dataset.action][+btn.dataset.i]);
  btn.textContent = text || '—';
  btn.classList.toggle('empty', !text);
  btn.classList.remove('listening');
}

const paintAll = () => $('kb-list').querySelectorAll('.kb-key').forEach(paintSlot);

function startCapture(btn) {
  if (capture?.btn === btn) return;
  stopCapture();
  capture = 'start' in btn.dataset ? { btn, start: true } : { btn, action: btn.dataset.action, i: +btn.dataset.i };
  btn.classList.add('listening');
  btn.classList.remove('empty');
  btn.textContent = capture.start ? 'Press the keys' : 'Press a key';
  note('');
}

function stopCapture() {
  if (!capture) return;
  const { btn } = capture;
  capture = null;
  captureEnded = performance.now();
  paintSlot(btn);
}

function onCaptureKey(e) {
  if (!capture) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  const k = keyId(e);
  swallowUp = k;
  if (k === 'Escape') return stopCapture();
  if (k === 'Control' || k === 'Meta' || e.ctrlKey || e.metaKey) {
    note('Ctrl and ⌘ can’t be used: the browser keeps its own shortcuts, like Ctrl + W.');
    return;
  }
  const clear = k === 'Backspace' || k === 'Delete';
  if (capture.start) {
    if (k === 'Shift' || k === 'Alt') { // wait for the rest of the combination
      capture.btn.textContent = `${[e.shiftKey && 'Shift', e.altKey && 'Alt'].filter(Boolean).join(' + ')} + …`;
      return;
    }
    settings.walkStart = clear ? null : { code: k, shift: e.shiftKey, alt: e.altKey };
    saveSettings();
    const taken = settings.walkStart && appUse(settings.walkStart);
    note(clear ? 'No walk key: the toolbar’s <b>Walk</b> button still starts a walk.'
      : taken ? `<kbd>${esc(comboLabel(settings.walkStart))}</kbd> was ${esc(taken)}; it starts walking now instead.` : '');
  } else {
    const from = bindWalkKey(capture.action, capture.i, clear ? '' : k);
    note(from ? `<kbd>${esc(keyLabel(k))}</kbd> moved here from <b>${esc(actionLabel(from))}</b>.` : '');
  }
  capture = null;
  captureEnded = performance.now();
  paintAll();
  emit('settings');
}

// ---------------------------------------------------------------- keys named elsewhere

function refreshLabels() {
  const list = (a) => walkKeyLabels(a).join(' / ') || '—';
  const firsts = (...as) => as.map((a) => walkKeyLabels(a)[0]).filter(Boolean).join(' ');
  const seconds = (...as) => as.map((a) => walkKeyLabels(a)[1]).filter(Boolean).join(' ');
  const move = [firsts('forward', 'left', 'back', 'right'), seconds('forward', 'left', 'back', 'right')].filter(Boolean).join(' · ') || '—';
  const start = comboLabel(settings.walkStart);

  $('btn-walk').title = `Walk navigation${start ? ` (${start})` : ''}, like Blender’s: the mouse looks around, ${move} move. `
    + 'Click keeps the view, Esc goes back. Keys: Settings';

  const back = walkKeyLabels('cancel');
  const rows = [
    [start ? `${start} · toolbar Walk` : 'Toolbar Walk', 'Walk around like Blender’s walk mode: the mouse looks'],
    [move, 'Move'],
    [`${list('up')} · ${list('down')}`, 'Straight up · down (gravity off)'],
    [`${list('viewUp')} · ${list('viewDown')}`, 'Up · down along the view (gravity off)'],
    [`${list('fast')} · ${list('slow')} (hold)`, 'Five times faster · slower'],
    [`Wheel · ${list('speedUp')} · ${list('speedDown')}`, 'Walk speed (remembered)'],
    [list('teleport'), 'Teleport to what the crosshair is on'],
    [`${list('gravity')} · ${list('jump')}`, 'Gravity on / off (stay on the floor, fall off edges) · jump'],
    [`Click · ${list('confirm')}`, 'Keep the new view'],
    [['Esc', 'right-click', ...back].join(' · '), 'Go back to where the walk started'],
    ['Settings (gear)', 'Change these keys and the mouse speed'],
  ];
  $('help-walk').innerHTML = rows.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>`).join('');
}
