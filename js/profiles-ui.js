// The Match panel's two tabs (Matches / Profiles), and the Profiles tab:
// upload a folder of .propsprofile files into the browser, step through them,
// save and download the open one (profiles.js does the work).

import { S, on } from './state.js';
import * as PF from './profiles.js';
import { download } from './profile.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let hooks;         // from ui.js: { frameAll }
let names = [];    // profiles kept here, as last listed
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
  $('profile-status').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'upload') $('file-profiles').click();
    if (act === 'save') saveProfile();
    if (act === 'download') downloadProfile();
    if (act === 'remove') removeProfile();
  });
  $('file-profiles').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const { added, replaced } = await PF.upload(files);
    if (!added && !replaced) toast('No .propsprofile files in that folder', { error: true });
    else toast(`Uploaded ${added + replaced} profile${added + replaced === 1 ? '' : 's'}${replaced ? ` (${replaced} replaced the ones with the same name)` : ''}`);
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
}

async function refresh() {
  names = await PF.list();
  $('profile-select').innerHTML = '<option value="">Free design</option>'
    + names.map((n) => `<option value="${esc(n)}">${esc(PF.baseName(n))}</option>`).join('');
  render();
}

function render() {
  $('profile-select').value = S.profile || '';
  for (const id of ['profile-select', 'profile-prev', 'profile-next']) $(id).disabled = busy || !names.length;
  const upload = `<button type="button" class="text-btn" data-act="upload" title="Pick a folder: its .propsprofile files are copied into this browser (the folder itself is never touched, so any folder works)">${names.length ? 'Upload more…' : 'Upload a folder of profiles…'}</button>`;
  let line;
  if (!names.length) {
    line = `${upload}<br><span class="muted">They’re copied into this browser; the folder is never touched, so any folder works.</span>`;
  } else {
    line = `${names.length} profile${names.length === 1 ? '' : 's'} in this browser`;
    if (S.profile) {
      line += PF.isDirty()
        ? ' · <button type="button" class="text-btn" data-act="save" title="Keep the changes (Ctrl+S)">Save</button> unsaved changes'
        : ' · Saved';
      line += ' · <button type="button" class="text-btn" data-act="download" title="Download this profile as a .propsprofile file">Download</button>'
        + ' · <button type="button" class="text-btn danger" data-act="remove" title="Remove this profile from the site">Remove</button>';
    }
    line += ` · ${upload}`;
  }
  $('profile-status').innerHTML = line;
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
    const name = await PF.save();
    toast(`Overwrote profile ${name} (the copy in this browser)`);
    return true;
  } catch (e) {
    toast(`Couldn’t save the profile: ${e.message}`, { error: true });
    return false;
  } finally {
    render();
  }
}

function downloadProfile() {
  if (!S.profile) return;
  download(S.profile, PF.currentText());
  toast(`Downloaded profile ${S.profile} (a new file, nothing overwritten)`);
}

async function removeProfile() {
  const name = S.profile;
  if (!name || !window.confirm(`Remove ${PF.baseName(name)} from the site? (Download it first to keep a copy.)`)) return;
  await PF.remove(name);
  toast(`Removed ${PF.baseName(name)}`);
}
