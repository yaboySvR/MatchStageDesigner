// Prop catalog: built-in props from data/catalog.json (generated from the
// add-on's props.json), plus custom props stored in this browser (IndexedDB).

export const catalog = {
  stateDefs: {},          // state name -> state id
  envModels: {},          // env id -> bin file
  props: new Map(),       // key -> entry
  order: [],
};

const UNLISTED_KEY = 'ppg.unlisted';
let unlistedOverrides = {};

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function register(p, custom = null) {
  const states = p.states;
  const stateOrder = Object.keys(states);
  if (!stateOrder.length) return;
  const label = Array.isArray(p.label) ? p.label : [String(p.label ?? p.key)];
  const entry = {
    key: p.key,
    label,
    name: label[0] || p.key,
    prop_id: p.prop_id ?? p.pid ?? 0,
    states,
    stateOrder,
    defaultState: 'Default' in states ? 'Default' : stateOrder[0],
    icon: p.icon ? (custom ? p.icon : `assets/icons/${p.icon}`) : null,
    altIcon: p.alt_icon ? { state: p.alt_icon.state, icon: `assets/icons/${p.alt_icon.icon}` } : null,
    unlistedDefault: !!p.unlisted,
    custom,
  };
  catalog.props.set(p.key, entry);
  if (!catalog.order.includes(p.key)) catalog.order.push(p.key);
}

export async function loadCatalog() {
  const res = await fetch('data/catalog.json');
  if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status}`);
  const data = await res.json();
  catalog.stateDefs = data.state_definitions || {};
  catalog.envModels = data.env_models || {};
  for (const p of data.props) register(p);
  unlistedOverrides = readLocal(UNLISTED_KEY, {});
  try {
    for (const rec of await dbAll()) registerCustom(rec);
  } catch (e) {
    console.warn('Custom props unavailable:', e);
  }
}

export const getProp = (key) => catalog.props.get(key);

export function isListed(key) {
  const o = unlistedOverrides[key];
  const pd = catalog.props.get(key);
  if (!pd) return false;
  return o === undefined ? !pd.unlistedDefault : !o;
}

export function setListed(key, listed) {
  unlistedOverrides[key] = !listed;
  writeLocal(UNLISTED_KEY, unlistedOverrides);
}

export const listedProps = () => catalog.order.filter(isListed).map(getProp);

export function displayName(key, state) {
  const pd = getProp(key);
  if (!pd) return key;
  const i = pd.stateOrder.indexOf(state);
  return pd.label[i + 1] || pd.label[0] || key;
}

export function iconFor(key, state) {
  const pd = getProp(key);
  if (!pd) return null;
  if (pd.altIcon && pd.altIcon.state === state) return pd.altIcon.icon;
  return pd.icon;
}

export const stateId = (state) => catalog.stateDefs[state];

export function initials(name) {
  return name.split(/[\s_]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

// ---------------------------------------------------------------- custom props

function registerCustom(rec) {
  register({
    key: rec.key,
    label: rec.label,
    prop_id: rec.prop_id,
    states: { [rec.state]: 'custom' },
    icon: rec.icon || null,
  }, { positions: rec.positions, indices: rec.indices });
}

export async function addCustomProp(rec) {
  await dbPut(rec);
  registerCustom(rec);
}

export async function removeCustomProp(key) {
  await dbDelete(key);
  catalog.props.delete(key);
  catalog.order = catalog.order.filter((k) => k !== key);
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB not supported'));
    const req = indexedDB.open('ppg', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('custom', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('custom', mode);
    const req = fn(tx.objectStore('custom'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const dbAll = () => dbTx('readonly', (s) => s.getAll()).then((r) => r || []);
const dbPut = (rec) => dbTx('readwrite', (s) => s.put(rec));
const dbDelete = (key) => dbTx('readwrite', (s) => s.delete(key));
