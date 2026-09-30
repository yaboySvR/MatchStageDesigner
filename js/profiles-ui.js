// The Match panel's two tabs (Matches / Profiles), and the Profiles tab:
// connect a folder of .propsprofile files, step through them, save the open
// one (profiles.js does the work).

import { S, on } from './state.js';
import * as PF from './profiles.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let hooks;         // from ui.js: { frameAll }
let names = [];    // files in the folder, as last listed
let busy = false;

export function initProfilesUI(h) {
  hooks = h;
  let tab = 'matches';
  try { tab = localStorage.getItem('ppg.layoutTab') === 'profiles' || S.profile ? 'profiles' : 'matches'; } catch { /* storage unavailable */ }
  showTab(tab);
  $('tab-matches').addEventListener('click', () => showTab('matches'));
  $('tab-profiles').addEventListener('click', () => showTab('profiles'));

  $('profile-select').addEventListener('change', (e) => go(e.target.value || null));
  $('profile-prev').addEventListener('click', () => step(-1));
  $('profile-next').addEventListener('click', () => step(1));
  $('profile-status').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'connect') connect();
    if (act === 'reconnect') { await PF.allowed(); refresh(); }
    if (act === 'save') saveProfile();
  });
  on('profile', () => { hooks.frameAll(); refresh(); });
  on('profile-status', render);
  on('profiles', refresh);
  refresh();
}

function showTab(t) {
  const profiles = t === 'profiles';
  $('tab-matches').setAttribute('aria-selected', String(!profiles));
  $('tab-profiles').setAttribute('aria-selected', String(profiles));
  $('matches-view').hidden = profiles;
  $('profiles-view').hidden = !profiles;
  try { localStorage.setItem('ppg.layoutTab', t); } catch { /* storage unavailable */ }
  if (profiles) refresh();
}

async function refresh() {
  names = (await PF.list().catch(() => null)) || (S.profile ? [S.profile] : []);
  if (S.profile && !names.includes(S.profile)) names.unshift(S.profile);
  $('profile-select').innerHTML = '<option value="">Free design</option>'
    + names.map((n) => `<option value="${esc(n)}">${esc(PF.baseName(n))}</option>`).join('');
  render();
}

async function render() {
  const sel = $('profile-select');
  sel.value = S.profile || '';
  const on = PF.supported() && !!(await PF.folder());
  for (const id of ['profile-select', 'profile-prev', 'profile-next']) $(id).disabled = busy || !on;
  let line;
  if (!PF.supported()) {
    line = 'A profiles folder needs Chrome or Edge.';
  } else if (!(await PF.folder())) {
    line = '<button type="button" class="text-btn" data-act="connect">Connect profiles folder…</button>'
      + '<br><span class="muted">It can’t be inside Program Files, Windows or AppData (the browser refuses those): keep it in Documents, Desktop or Downloads.</span>';
  } else if ((await PF.access()) !== 'granted') {
    line = '<button type="button" class="text-btn" data-act="reconnect">Reconnect profiles folder</button>'
      + (S.profile && PF.isDirty() ? ' · unsaved changes' : '');
  } else {
    const d = await PF.folder();
    line = `Folder <b>${esc(d.name)}</b> · ${names.length} profile${names.length === 1 ? '' : 's'}`;
    if (S.profile) {
      line += PF.isDirty()
        ? ' · <button type="button" class="text-btn" data-act="save" title="Write it into its file (Ctrl+S)">Save</button> unsaved changes'
        : ' · Saved';
    }
    line += ' · <button type="button" class="text-btn" data-act="connect">Change folder</button>';
  }
  $('profile-status').innerHTML = line;
}

async function connect() {
  if (S.profile && !(await leaveProfile())) return;
  try {
    await PF.choose();
    const n = (await PF.list())?.length ?? 0;
    toast(`Profiles folder connected: ${n} profile${n === 1 ? '' : 's'}`);
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Couldn’t use that folder: ${e.message}`, { error: true });
  }
  refresh();
}

// Settle unsaved changes before the open profile goes away: Save, Don't
// save, or Cancel (returns false).
export async function settleProfile() {
  if (!S.profile || !PF.isDirty()) return true;
  const dlg = $('dlg-unsaved');
  $('unsaved-name').textContent = PF.baseName(S.profile);
  dlg.returnValue = '';
  dlg.showModal();
  const answer = await new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue), { once: true }));
  if (answer === 'save') return saveProfile();
  return answer === 'discard';
}

// Close the open profile (back to free design), unsaved changes settled.
export async function leaveProfile() {
  if (!S.profile) return true;
  if (!(await settleProfile())) return false;
  await PF.open(null);
  return true;
}

async function go(name) {
  if (busy || name === S.profile) return;
  if (!(await settleProfile())) { render(); return; }
  busy = true;
  render();
  try {
    await PF.open(name);
  } catch (e) {
    toast(`Couldn’t open that profile: ${e.message}`, { error: true });
  } finally {
    busy = false;
    refresh();
  }
}

function step(dir) {
  if (!names.length) return;
  const i = names.indexOf(S.profile);
  go(names[i < 0 ? (dir > 0 ? 0 : names.length - 1) : (i + dir + names.length) % names.length]);
}

export async function saveProfile() {
  try {
    const { name, backedUp } = await PF.save();
    toast(`Saved ${name}${backedUp ? ` (the original is kept as ${name}.bak)` : ''}`);
    return true;
  } catch (e) {
    toast(`Couldn’t save the profile: ${e.message}`, { error: true });
    return false;
  } finally {
    render();
  }
}
