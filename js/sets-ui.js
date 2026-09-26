// Sidebar "Sets" tab, set tiles, the Save-as-set dialog, and share codes (a
// tile's share button copies one; pasting one anywhere, or Import, adds it).

import { S, on } from './state.js';
import * as store from './store.js';
import * as V from './viewport.js';
import * as tools from './tools.js';
import {
  sets, loadSets, captureSet, addSet, renameSet, removeSet, getSet, exportSets, importSets,
  CODE_TAG, setToCode, setFromCode, sameSet,
} from './sets.js';
import { getProp } from './catalog.js';
import { getGeometry } from './geometry.js';
import { settleNow } from './physics.js';
import { download } from './profile.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SHARE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10.5V2.5M5 5.5l3-3 3 3"/><path d="M3 9.5v4h10v-4"/></svg>';
const DISCORD_MAX = 2000; // characters in one Discord message

let tab = 'props';
let pending = null; // set being saved
let shared = null;  // set read from the code box, ready to add
let reading = 0;    // bumps on each new read of the code box

export function initSetsUI() {
  loadSets();
  try { tab = localStorage.getItem('ppg.libTab') === 'sets' ? 'sets' : 'props'; } catch { /* storage unavailable */ }

  $('tab-props').addEventListener('click', () => showTab('props'));
  $('tab-sets').addEventListener('click', () => showTab('sets'));
  $('prop-search').addEventListener('input', renderSets);
  $('set-grid').addEventListener('click', onGridClick);
  $('set-grid').addEventListener('keydown', (e) => {
    const tile = e.target.closest('.set-tile');
    if (tile && e.target === tile && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      tile.click();
    }
  });
  $('btn-sets-export').addEventListener('click', () => {
    if (!sets.length) return toast('No sets to export yet');
    download('prop-sets.json', exportSets());
  });
  $('btn-sets-import').addEventListener('click', () => openCodeDialog(''));
  $('file-sets').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { added, skipped } = importSets(await file.text());
      renderSets();
      toast(`Imported ${added} set${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} already here or invalid` : ''}`);
    } catch (err) {
      toast(`Could not import ${file.name}: ${err.message}`, { error: true });
    }
  });
  $('set-form').addEventListener('submit', onSave);
  $('dlg-set').addEventListener('close', () => { pending = null; });
  bindCodeDialog();
  window.addEventListener('paste', onPaste);

  on('save-set', openSaveSetDialog);
  on('mode', renderSets);
  showTab(tab);
}

function showTab(t) {
  tab = t;
  try { localStorage.setItem('ppg.libTab', t); } catch { /* storage unavailable */ }
  const isSets = t === 'sets';
  $('tab-props').setAttribute('aria-selected', String(!isSets));
  $('tab-sets').setAttribute('aria-selected', String(isSets));
  $('prop-grid').hidden = isSets;
  $('state-bar').hidden = isSets;
  $('props-actions').hidden = isSets;
  $('set-grid').hidden = !isSets;
  $('sets-actions').hidden = !isSets;
  $('prop-search').placeholder = isSets ? 'Search sets…' : 'Search props…';
  renderSets();
}

export function renderSets() {
  $('sets-count').textContent = sets.length ? String(sets.length) : '';
  if (tab !== 'sets') return;
  const grid = $('set-grid');
  if (!sets.length) {
    grid.innerHTML = `
      <div class="sets-empty">
        <b>No sets yet</b>
        <p>Select a group of props in the arena, then press <kbd>Ctrl</kbd>+<kbd>G</kbd> or <em>Save as set</em> in the panel.
        Click a set here to stamp copies anywhere; <kbd>[</kbd> <kbd>]</kbd> turn it, <kbd>M</kbd> mirrors it.
        Got a share code? Press <kbd>Ctrl</kbd>+<kbd>V</kbd> to add it.</p>
      </div>`;
    return;
  }
  const q = $('prop-search').value.trim().toLowerCase();
  const list = sets.filter((s) => !q || s.name.toLowerCase().includes(q));
  const active = S.mode === 'add' && S.addSet ? S.addSet.id : null;
  grid.innerHTML = list.length ? list.map((s) => `
    <div class="set-tile" role="option" tabindex="0" data-set="${esc(s.id)}" aria-selected="${s.id === active}" title="Click to place copies of this set">
      <div class="thumb">${s.thumb ? `<img src="${esc(s.thumb)}" alt="" draggable="false">` : '<div class="fallback-ico">SET</div>'}</div>
      <div class="name">${esc(s.name)}</div>
      <div class="count">${s.items.length} prop${s.items.length === 1 ? '' : 's'}</div>
      <div class="tile-actions">
        <button type="button" data-share title="Copy a share code" aria-label="Copy a share code for ${esc(s.name)}">${SHARE_ICON}</button>
        <button type="button" data-rename title="Rename" aria-label="Rename ${esc(s.name)}">✎</button>
        <button type="button" data-delete title="Delete" aria-label="Delete ${esc(s.name)}">✕</button>
      </div>
    </div>`).join('')
    : `<p class="muted" style="grid-column:1/-1">No sets match “${esc(q)}”.</p>`;
}

function onGridClick(e) {
  const tile = e.target.closest('.set-tile');
  const set = tile && getSet(tile.dataset.set);
  if (!set) return;
  if (e.target.closest('[data-delete]')) {
    if (S.addSet?.id === set.id) tools.exitAdd();
    const undo = removeSet(set.id);
    renderSets();
    toast(`Deleted set “${set.name}”`, { action: { label: 'Undo', onClick: () => { undo(); renderSets(); } } });
    return;
  }
  if (e.target.closest('[data-share]')) return shareSet(set);
  if (e.target.closest('[data-rename]')) return startRename(tile, set);
  if (S.mode === 'add' && S.addSet?.id === set.id) tools.exitAdd();
  else tools.enterSetPlacement(set);
  $('app').classList.remove('sidebar-open');
}

function startRename(tile, set) {
  const nameEl = tile.querySelector('.name');
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = set.name;
  input.maxLength = 60;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) renameSet(set.id, input.value);
    renderSets();
  };
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------- save dialog

export function openSaveSetDialog() {
  settleNow();
  const props = store.selectedProps();
  if (!props.length) return toast('Select the props for the set first');
  pending = captureSet(props);
  pending.thumb = V.renderThumbnail(pending.items.map((it) => ({ ...it, x: it.dx, y: it.dy, z: it.dz })));
  $('set-thumb').src = pending.thumb || '';
  $('set-thumb').hidden = !pending.thumb;
  $('set-name').value = pending.name;
  $('set-summary').textContent = `${props.length} prop${props.length === 1 ? '' : 's'}, saved exactly as they are. When you place it, the whole group follows the cursor and sits on the surface there, unchanged.`;
  $('dlg-set').showModal();
  $('set-name').select();
}

function onSave(e) {
  if (e.submitter?.value === 'cancel') return; // Cancel only closes the dialog
  e.preventDefault();
  if (!pending) return;
  const set = pending;
  set.name = $('set-name').value.trim() || set.name;
  if (!addSet(set)) {
    toast('Could not save: browser storage is full. Export and delete some sets.', { error: true });
    return;
  }
  $('dlg-set').close();
  showTab('sets');
  toast(`Saved set “${set.name}”. Click it in the Sets tab to place copies.`, { ms: 5000 });
}

// ---------------------------------------------------------------- share codes

async function shareSet(set) {
  let code;
  try {
    code = await setToCode(set);
  } catch (err) {
    toast(`Couldn’t make a share code: ${err.message}`, { error: true });
    return;
  }
  const long = code.length > DISCORD_MAX
    ? ` It’s ${code.length} characters, more than one Discord message holds: Discord sends it as a file, and the code in it still works.`
    : '';
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied the share code for “${set.name}”. Whoever gets it presses Ctrl+V on the site to add the set.${long}`, { ms: long ? 9000 : 6000 });
  } catch {
    window.prompt('Copy this share code:', code); // no clipboard access
  }
}

// Ctrl+V anywhere outside a text box: a share code opens the import dialog.
function onPaste(e) {
  const t = e.target;
  if (t?.closest?.('input, textarea') || t?.isContentEditable || document.querySelector('dialog[open]')) return;
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!text.includes(CODE_TAG)) return;
  e.preventDefault();
  openCodeDialog(text);
}

function openCodeDialog(text) {
  $('code-input').value = text.trim();
  readCode();
  $('dlg-set-code').showModal();
  if (!text) $('code-input').focus();
}

function bindCodeDialog() {
  let timer;
  $('code-input').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(readCode, 150);
  });
  $('code-file').addEventListener('click', () => {
    $('dlg-set-code').close();
    $('file-sets').click();
  });
  $('code-form').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'cancel') return; // Cancel only closes the dialog
    e.preventDefault();
    const set = shared;
    if (!set) return;
    if (!addSet(set)) {
      toast('Could not add it: browser storage is full. Export and delete some sets.', { error: true });
      return;
    }
    $('dlg-set-code').close();
    showTab('sets');
    toast(`Added the set “${set.name}”. Click it in the Sets tab to place copies.`, { ms: 5000 });
  });
  $('dlg-set-code').addEventListener('close', () => {
    shared = null;
    reading++;
  });
}

// Read the code box and show the set in it, with its picture.
async function readCode() {
  const token = ++reading;
  const text = $('code-input').value.trim();
  shared = null;
  $('code-add').disabled = true;
  $('code-preview').hidden = true;
  $('code-note').textContent = '';
  $('code-error').textContent = '';
  if (!text) return;
  let set;
  try {
    set = await setFromCode(text);
  } catch (err) {
    if (token === reading) $('code-error').textContent = err.message;
    return;
  }
  const known = set.items.filter((it) => getProp(it.key)?.states[it.state] !== undefined);
  if (!known.length) {
    if (token === reading) $('code-error').textContent = 'None of the props in this set are on this site';
    return;
  }
  const kinds = new Map(known.map((it) => [`${it.key}/${it.state}`, it]));
  await Promise.all([...kinds.values()].map((it) => getGeometry(it.key, it.state).catch(() => null)));
  if (token !== reading) return;
  set.thumb = V.renderThumbnail(known.map((it) => ({ ...it, x: it.dx, y: it.dy, z: it.dz })));
  const n = set.items.length;
  const missing = n - known.length;
  $('code-thumb').src = set.thumb || '';
  $('code-thumb').hidden = !set.thumb;
  $('code-name').textContent = set.name;
  $('code-count').textContent = `${n} prop${n === 1 ? '' : 's'}${missing ? ` (${missing} not on this site, left out when placing)` : ''}`;
  $('code-preview').hidden = false;
  const same = sameSet(set);
  if (same) {
    $('code-note').textContent = `You already have this set: “${same.name}”.`;
    return;
  }
  shared = set;
  $('code-add').disabled = false;
}
