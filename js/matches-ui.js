// The Match panel: pick a match (or free design), step through them with the
// arrows, see where edits are saved, and connect the PropsSet folder
// (matches.js does the work). Connecting is two steps: the dialog first says
// which folder to pick, then how many files there get replaced, and nothing
// is written until the user confirms.

import { S, on } from './state.js';
import * as M from './matches.js';
import * as GF from './gamefolder.js';
import { envForFile } from './propset.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let hooks;          // from ui.js: { setEnv, frameAll, setOpened }
let busy = false;   // a switch is under way
let chosen = null;  // the folder picked in the connect dialog, until confirmed

export function initMatchesUI(h) {
  hooks = h;
  const sel = $('match-select');
  sel.innerHTML = '<option value="">Free design</option>'
    + M.MATCHES.map((m) => `<option value="${m.file}">${esc(m.name)}</option>`).join('');
  sel.addEventListener('change', () => go(sel.value || null));
  $('match-prev').addEventListener('click', () => step(-1));
  $('match-next').addEventListener('click', () => step(1));
  $('match-status').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'connect') openConnect();
    if (act === 'reconnect') reconnect();
  });
  bindConnectDialog();

  on('match', applyMatch);
  on('match-status', renderStatus);
  on('match-edited', renderOptions);
  sync();
  M.initMatches()
    .catch((e) => toast(`Matches: ${e.message}`, { error: true }))
    .finally(() => { renderStatus(); renderOptions(); });
}

async function go(file) {
  if (busy || file === S.match) return;
  busy = true;
  sync();
  try {
    await M.openMatch(file);
  } catch (e) {
    toast(`Couldn’t open that match: ${e.message}`, { error: true, ms: 6000 });
  } finally {
    busy = false;
    sync();
    renderStatus();
  }
}

function step(dir) {
  const files = M.MATCHES.map((m) => m.file);
  const i = files.indexOf(S.match);
  go(files[i < 0 ? (dir > 0 ? 0 : files.length - 1) : (i + dir + files.length) % files.length]);
}

// A match was opened (or free design came back): its arena, the whole view.
function applyMatch({ file, bytes, env } = {}) {
  if (file) {
    hooks.setEnv(envForFile(file));
    hooks.setOpened(M.fileName(file), bytes);
  } else if (env) {
    hooks.setEnv(env);
  }
  hooks.frameAll();
  sync();
  renderStatus();
}

function sync() {
  $('match-select').value = S.match || '';
  for (const id of ['match-select', 'match-prev', 'match-next']) $(id).disabled = busy;
}

// Matches edited here get a dot.
async function renderOptions() {
  const edited = await M.editedMatches();
  for (const o of $('match-select').options) {
    if (o.value) o.textContent = M.matchName(o.value) + (edited.has(o.value) ? ' •' : '');
  }
}

async function renderStatus() {
  const dir = await M.connectedFolder();
  const allowed = dir && (await GF.access()) === 'granted';
  const { state, detail } = M.saveStatus();
  const saved = state === 'saving' ? 'Saving…' : state === 'error' ? `Couldn’t save: ${esc(detail)}` : 'Saved';
  let line;
  if (dir && allowed) {
    line = `PropsSet folder <b>${esc(dir.name)}</b>${S.match ? ` · ${saved}` : ''}`;
  } else if (dir) {
    line = '<button type="button" class="text-btn" data-act="reconnect">Reconnect PropsSet folder</button>'
      + (state === 'pending' ? ' · changes wait in this browser' : '');
  } else {
    line = S.match ? `${saved === 'Saved' ? 'Saved in this browser' : saved}` : 'Pick a match to edit its prop set';
    if (GF.supported()) line += ' · <button type="button" class="text-btn" data-act="connect">Connect PropsSet folder…</button>';
  }
  const kept = S.match ? S.jsfb?.keep?.length || 0 : 0;
  if (kept) {
    line += `<br><span class="muted">Also has ${kept} prop${kept === 1 ? '' : 's'} the site doesn’t show, kept as ${kept === 1 ? 'it is' : 'they are'}.</span>`;
  }
  $('match-status').innerHTML = line;
}

async function reconnect() {
  const n = await M.reconnectFolder();
  if (n === false) toast('The browser wasn’t allowed into the folder', { error: true });
  else toast(n ? `Reconnected · ${n} match${n === 1 ? '' : 'es'} saved into the folder` : 'Reconnected');
  renderStatus();
}

// ---------------------------------------------------------------- connecting

function showStep(n) {
  $('con-step1').hidden = n !== 1;
  $('con-step2').hidden = n !== 2;
  $('con-choose').hidden = n !== 1;
  $('con-ok').hidden = n !== 2;
}

function openConnect() {
  chosen = null;
  showStep(1);
  $('dlg-connect').showModal();
}

function bindConnectDialog() {
  const dlg = $('dlg-connect');
  for (const el of dlg.querySelectorAll('.con-count')) el.textContent = M.MATCHES.length;
  $('con-choose').addEventListener('click', async () => {
    try {
      chosen = await GF.chooseFolder();
    } catch (e) {
      if (e.name !== 'AbortError') toast(`Couldn’t use that folder: ${e.message}`, { error: true });
      return;
    }
    const there = await M.filesIn(chosen);
    const n = M.MATCHES.length;
    $('con-folder').textContent = chosen.name;
    $('con-replace').textContent = there.length
      ? `${there.length} of the ${n} match files are already there and get replaced; each one is kept once as <name>.jsfb.bak.`
      : `None of the ${n} match files are there yet; they get added.`;
    showStep(2);
  });
  $('con-ok').addEventListener('click', async () => {
    if (!chosen) return;
    const btn = $('con-ok');
    btn.disabled = true;
    btn.textContent = 'Writing…';
    try {
      const { count, backedUp } = await M.connect(chosen);
      dlg.close();
      toast(`Connected ${chosen.name}: ${count} match prop sets written${backedUp ? `, ${backedUp} original${backedUp === 1 ? '' : 's'} kept as .bak` : ''}`, { ms: 6000 });
    } catch (e) {
      toast(`Couldn’t connect: ${e.message}`, { error: true });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Replace and connect';
      renderStatus();
      renderOptions();
    }
  });
  dlg.addEventListener('close', () => { chosen = null; });
}
