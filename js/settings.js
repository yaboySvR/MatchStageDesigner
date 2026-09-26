// Settings kept in this browser (not part of the scene): the walk navigation
// keys and mouse feel (walk.js), edited in the Settings dialog (settings-ui.js).
//
// Keys are stored by position on the keyboard (KeyboardEvent.code), so a
// binding stays on the same key whatever the layout; labels show what the
// key types on this keyboard when the browser can tell (Chrome, Edge), else
// US names. Left and right Shift count as one key, and so do the two Alts.

import { emit } from './state.js';

const SAVE_KEY = 'ppg.settings';

// Walk actions in the order the dialog lists them; keys are Blender's defaults.
// hold: works while the key is down (the rest act once per press).
export const WALK_GROUPS = [
  { name: 'Move', actions: [
    { id: 'forward', label: 'Forward', hold: true, keys: ['KeyW', 'ArrowUp'] },
    { id: 'back', label: 'Backward', hold: true, keys: ['KeyS', 'ArrowDown'] },
    { id: 'left', label: 'Left', hold: true, keys: ['KeyA', 'ArrowLeft'] },
    { id: 'right', label: 'Right', hold: true, keys: ['KeyD', 'ArrowRight'] },
    { id: 'up', label: 'Up', note: 'straight up, gravity off', hold: true, keys: ['KeyE'] },
    { id: 'down', label: 'Down', note: 'straight down, gravity off', hold: true, keys: ['KeyQ'] },
    { id: 'viewUp', label: 'Up the view', note: 'gravity off', hold: true, keys: ['KeyR'] },
    { id: 'viewDown', label: 'Down the view', note: 'gravity off', hold: true, keys: ['KeyF'] },
  ] },
  { name: 'Speed', actions: [
    { id: 'fast', label: 'Faster ×5 (hold)', hold: true, keys: ['Shift'] },
    { id: 'slow', label: 'Slower ÷5 (hold)', hold: true, keys: ['Alt'] },
    { id: 'speedUp', label: 'Speed up', note: 'also wheel up', keys: ['NumpadAdd', 'Equal'] },
    { id: 'speedDown', label: 'Speed down', note: 'also wheel down', keys: ['NumpadSubtract', 'Minus'] },
  ] },
  { name: 'Actions', actions: [
    { id: 'teleport', label: 'Teleport', note: 'to the crosshair', keys: ['Space'] },
    { id: 'gravity', label: 'Gravity on / off', keys: ['Tab'] },
    { id: 'jump', label: 'Jump', note: 'gravity on', keys: ['KeyV'] },
    { id: 'jumpUp', label: 'Jump higher', keys: ['Period'] },
    { id: 'jumpDown', label: 'Jump lower', keys: ['Comma'] },
  ] },
  { name: 'Finish', actions: [
    { id: 'confirm', label: 'Keep view', note: 'also left click', keys: ['Enter', 'NumpadEnter'] },
    { id: 'cancel', label: 'Go back', note: 'also Esc and right click', keys: [] },
  ] },
];
export const WALK_ACTIONS = WALK_GROUPS.flatMap((g) => g.actions);
const WALK_START = { code: 'Backquote', shift: true, alt: false }; // Blender: Shift+`

export const settings = {
  walkStart: null,   // { code, shift, alt }, or null: only the toolbar button starts a walk
  walkKeys: {},      // action id -> [key, key] ('' = empty slot)
  lookSpeed: 1,      // mouse sensitivity (Blender's default is 1)
  invertMouse: false,
};

function defaults() {
  settings.walkStart = { ...WALK_START };
  settings.walkKeys = Object.fromEntries(WALK_ACTIONS.map((a) => [a.id, [a.keys[0] || '', a.keys[1] || '']]));
  settings.lookSpeed = 1;
  settings.invertMouse = false;
}

export function resetWalkSettings() {
  defaults();
  saveSettings();
}

export function saveSettings() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, ...settings }));
  } catch { /* storage full or unavailable */ }
}

function loadSettings() {
  defaults();
  let d = null;
  try { d = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { /* unreadable: defaults */ }
  if (d?.v !== 1) return;
  const ok = (k) => typeof k === 'string' && k.length < 40;
  if (d.walkStart === null) settings.walkStart = null;
  else if (ok(d.walkStart?.code)) settings.walkStart = { code: d.walkStart.code, shift: !!d.walkStart.shift, alt: !!d.walkStart.alt };
  const seen = new Set();
  for (const a of WALK_ACTIONS) {
    const keys = d.walkKeys?.[a.id];
    if (!Array.isArray(keys)) continue;
    settings.walkKeys[a.id] = [0, 1].map((i) => {
      const k = ok(keys[i]) && !seen.has(keys[i]) ? keys[i] : '';
      if (k) seen.add(k);
      return k;
    });
  }
  if (d.lookSpeed >= 0.1 && d.lookSpeed <= 5) settings.lookSpeed = d.lookSpeed;
  settings.invertMouse = !!d.invertMouse;
}

// Put key k in slot i of an action. A key does one thing, so any other slot
// holding it is emptied; returns the action it was taken from, if any.
export function bindWalkKey(action, i, k) {
  let from = null;
  for (const [a, keys] of Object.entries(settings.walkKeys)) {
    keys.forEach((kk, j) => {
      if (k && kk === k && !(a === action && j === i)) {
        keys[j] = '';
        from = a;
      }
    });
  }
  settings.walkKeys[action][i] = k;
  saveSettings();
  return from;
}

// ---------------------------------------------------------------- keys

// Which key an event is about. Some remote-desktop and automation keyboards
// send only the character, which is mapped back to its key here.
const BY_CHAR = { ' ': 'Space', '`': 'Backquote', '~': 'Backquote', '+': 'NumpadAdd', '=': 'Equal', '-': 'Minus', '.': 'Period', ',': 'Comma' };
const SAME = { ShiftLeft: 'Shift', ShiftRight: 'Shift', AltLeft: 'Alt', AltRight: 'Alt', ControlLeft: 'Control', ControlRight: 'Control', MetaLeft: 'Meta', MetaRight: 'Meta', OSLeft: 'Meta', OSRight: 'Meta' };
export function keyId(e) {
  let k = e.code;
  if (!k) {
    const ch = e.key || '';
    k = /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : BY_CHAR[ch] || ch;
  }
  return SAME[k] || k;
}

// Does this key press start a walk?
export function isWalkStart(e) {
  const s = settings.walkStart;
  return !!s && keyId(e) === s.code && e.shiftKey === s.shift && e.altKey === s.alt && !e.ctrlKey && !e.metaKey;
}

// What each key types on this keyboard, once the browser says ('settings' is
// emitted then, so labels already on screen catch up).
let layout = null;
try {
  navigator.keyboard?.getLayoutMap?.().then((m) => { layout = m; emit('settings'); }, () => {});
} catch { /* not offered here */ }

const NAMES = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Num Enter', Escape: 'Esc', Backspace: 'Backspace',
  Shift: 'Shift', Alt: 'Alt', CapsLock: 'Caps Lock', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  PageUp: 'Page Up', PageDown: 'Page Down', Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
  ContextMenu: 'Menu', NumLock: 'Num Lock', ScrollLock: 'Scroll Lock', Pause: 'Pause',
};
const US = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };

export function keyLabel(k) {
  if (!k) return '';
  if (NAMES[k]) return NAMES[k];
  if (/^Numpad\d$/.test(k)) return `Num ${k.slice(6)}`;
  const ch = layout?.get(k);
  if (ch && ch.trim()) return ch.toUpperCase();
  if (k.startsWith('Key')) return k.slice(3);
  if (k.startsWith('Digit')) return k.slice(5);
  return US[k] || k;
}

export const comboLabel = (s) => (s ? [s.shift && 'Shift', s.alt && 'Alt', keyLabel(s.code)].filter(Boolean).join(' + ') : '');

// The keys of a walk action as labels ('' when it has none).
export const walkKeyLabels = (action) => settings.walkKeys[action].filter(Boolean).map(keyLabel);

loadSettings();
