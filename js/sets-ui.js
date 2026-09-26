// Sidebar "Sets" tab, set tiles, and the Save-as-set dialog.

import { S, on } from './state.js';
import * as store from './store.js';
import * as V from './viewport.js';
import * as tools from './tools.js';
import { sets, loadSets, captureSet, addSet, renameSet, removeSet, getSet, exportSets, importSets } from './sets.js';
import { settleNow } from './physics.js';
import { download } from './profile.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let tab = 'props';
let pending = null; // set being saved

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
  $('btn-sets-import').addEventListener('click', () => $('file-sets').click());
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
        Click a set here to stamp copies anywhere; <kbd>[</kbd> <kbd>]</kbd> turn it, <kbd>M</kbd> mirrors it.</p>
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
