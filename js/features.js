// Parts of the site that are switched off for now. Their code and markup stay
// in place; they just don't show. Set a flag to true to bring one back (a
// browser that has them switched on locally gets all three).
//   jsfbExport: Export → Game prop set (.jsfb), with Save to game folder and
//               Ctrl+S straight into the game folder.
//   jsfbImport: opening a game prop set (.jsfb) with Import or drag and drop.
//   matches:    the Match panel (each match's game prop set, and the
//               connected PropsSet folder).

import { keyId } from './settings.js';

const LOCAL = 'ppg.gf';
const localOn = (() => {
  try {
    return localStorage.getItem(LOCAL) === '1';
  } catch {
    return false;
  }
})();

export const FEATURES = {
  jsfbExport: localOn,
  jsfbImport: localOn,
  matches: localOn,
};

const allOn = (names) => names.split(/\s+/).every((n) => FEATURES[n]);

// The name shown in the page follows the switch too.
export const siteName = () => (localOn ? 'PropSetEditor' : 'Prop Profile Generator');

// Show or hide the page parts tagged data-feature="name …" (shown while all
// those features are on) or data-feature-off="name" (shown while it's off).
// Tooltips that change with a feature keep their text for while it's off in
// title, and the one for while it's on in data-title-on (data-title-feature
// names it).
export function applyFeatures(root = document) {
  for (const el of root.querySelectorAll('[data-feature]')) el.hidden = !allOn(el.dataset.feature);
  for (const el of root.querySelectorAll('[data-feature-off]')) el.hidden = allOn(el.dataset.featureOff);
  for (const el of root.querySelectorAll('[data-title-on]')) {
    el.dataset.titleOff ??= el.title;
    el.title = allOn(el.dataset.titleFeature) ? el.dataset.titleOn : el.dataset.titleOff;
  }
  for (const el of root.querySelectorAll('[data-site-name]')) el.textContent = siteName();
  // The browser tab is always called PropSetEditor.
}

// ---------------------------------------------------------------- local switch

const RUN = 5;
const MARK = 1077589161349732;
const GAP = 800; // ms

function fingerprint(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Flips the local switch when its keys come in, then calls apply(on).
export function watchSwitch(apply) {
  let keys = [];
  let last = 0;
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select') || t?.isContentEditable || document.querySelector('dialog[open]')) return;
    const now = performance.now();
    if (now - last > GAP) keys = [];
    last = now;
    keys.push(keyId(e));
    if (keys.length > RUN) keys.shift();
    if (keys.length < RUN || fingerprint(keys.join(' ')) !== MARK) return;
    keys = [];
    const on = !localOn;
    try {
      if (on) localStorage.setItem(LOCAL, '1');
      else localStorage.removeItem(LOCAL);
    } catch {
      return;
    }
    apply(on);
  }, true);
}
