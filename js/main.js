import { S, on } from './state.js';
import { loadCatalog } from './catalog.js';
import * as V from './viewport.js';
import * as store from './store.js';
import { initTools, preloadPhysics } from './tools.js';
import { initUI } from './ui.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  try {
    await loadCatalog();
    const restored = store.loadSaved();

    V.initViewport($('canvas-host'));
    initTools();
    initUI();
    on('props', V.syncProps);

    const needed = V.envModelsFor(S.env);
    let done = 0;
    await Promise.all(needed.map((id) => V.ensureEnv(id).then(() => {
      done++;
      $('loading-bar').style.width = `${(done / needed.length) * 100}%`;
      $('loading-text').textContent = `Loading arena… ${done}/${needed.length}`;
    })));

    V.applyEnvState();
    V.syncProps();
    $('loading').classList.add('done');
    preloadPhysics();
    if (restored && S.props.length) {
      toast(`Restored ${S.props.length} props from your last session`);
    }
  } catch (e) {
    console.error(e);
    $('loading-text').textContent = location.protocol === 'file:'
      ? 'Open this page through a web server, not as a file (see README).'
      : `Failed to load: ${e.message}`;
  }
}

boot();
