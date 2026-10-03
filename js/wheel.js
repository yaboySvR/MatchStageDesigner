// Hold-Q radial prop picker (port of tools/wheel_tool.py), kept compact: the
// props sit on up to three rings, the first ones (the catalog's order: chair,
// table, ladder, ...) on the inner ring. The slot nearest the pointer is the
// one picked. A multi-state prop shows its alternate state as a second slot
// right beside it; the pointer can go over to it without losing the prop.

import { listedProps, iconFor, initials } from './catalog.js';

const TAU = Math.PI * 2;
const SLOT = 36;          // px, a slot's size
const PITCH = SLOT + 7;   // px between slot centers along a ring
const RING_GAP = SLOT + 9;
const INNER = 92;         // px, the inner ring's radius
const MAX_RINGS = 3;
let st = null;

export const wheelOpen = () => !!st;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function iconHtml(url, name) {
  return url ? `<img src="${esc(url)}" alt="" draggable="false">` : `<span>${esc(initials(name))}</span>`;
}

// How many rings n props need, and how many go on each (in proportion to the
// ring's length, so they're spaced alike). Past what three rings hold, the
// outer ring takes the rest, packed closer.
function layout(n) {
  let rings = 1;
  const cap = (k) => Math.floor((TAU * (INNER + k * RING_GAP)) / PITCH);
  while (rings < MAX_RINGS) {
    let total = 0;
    for (let k = 0; k < rings; k++) total += cap(k);
    if (total >= n) break;
    rings++;
  }
  const radii = Array.from({ length: rings }, (_, k) => INNER + k * RING_GAP);
  const sum = radii.reduce((a, r) => a + r, 0);
  const counts = radii.map((r) => Math.round((n * r) / sum));
  counts[rings - 1] += n - counts.reduce((a, c) => a + c, 0);
  return { radii, counts };
}

// How far the wheel reaches from its middle (walk.js keeps its hidden pointer inside).
export const wheelReach = () => (st ? st.reach : INNER + (MAX_RINGS - 1) * RING_GAP + SLOT * 2);

export function openWheel(clientX, clientY, onPick) {
  const props = listedProps();
  if (!props.length) return false;
  const el = document.getElementById('wheel');
  el.hidden = false;
  const rect = el.getBoundingClientRect();
  const { radii, counts } = layout(props.length);
  const outer = radii.at(-1);
  const reach = outer + SLOT * 1.9;
  const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  const ox = clamp(clientX - rect.left, reach, rect.width - reach);
  const oy = clamp(clientY - rect.top, reach, rect.height - reach);

  // every slot's spot: ring k, evenly round it, starting at the top
  const spots = [];
  radii.forEach((r, k) => {
    const n = counts[k];
    const turn = k % 2 ? Math.PI / n : 0; // stagger neighbouring rings
    for (let j = 0; j < n; j++) {
      const a = Math.PI / 2 - (TAU * j) / n - turn;
      spots.push({ a, r, x: ox + r * Math.cos(a), y: oy - r * Math.sin(a) });
    }
  });

  const centerR = INNER - SLOT / 2 - 12;
  const discR = outer + SLOT / 2 + 14;
  el.innerHTML = `
    <div class="disc" style="left:${ox - discR}px;top:${oy - discR}px;width:${discR * 2}px;height:${discR * 2}px"></div>
    ${props.map((p, i) => `<div class="slot" data-i="${i}" style="left:${spots[i].x}px;top:${spots[i].y}px;width:${SLOT}px;height:${SLOT}px">${iconHtml(p.icon, p.name)}</div>`).join('')}
    <div class="slot alt" hidden></div>
    <div class="center" style="left:${ox}px;top:${oy}px;width:${centerR * 2}px;height:${centerR * 2}px"></div>
    <div class="name" style="left:${ox}px;top:${oy + discR + 10}px">Prop wheel</div>`;

  st = {
    el, props, spots, centerR, ox, oy, rect, onPick, reach,
    hovered: -1, alt: 0,
    slots: [...el.querySelectorAll('.slot[data-i]')],
    altEl: el.querySelector('.slot.alt'),
    centerEl: el.querySelector('.center'),
    nameEl: el.querySelector('.name'),
  };
  render();
  return true;
}

// The alternate state's slot: just outside the prop's own, on its spoke.
function altPos(i) {
  const { a, x, y } = st.spots[i];
  const gap = SLOT * 1.15;
  return { x: x + Math.cos(a) * gap, y: y - Math.sin(a) * gap };
}

export function wheelMove(clientX, clientY) {
  if (!st) return;
  const mx = clientX - st.rect.left, my = clientY - st.rect.top;
  const d = (p) => Math.hypot(mx - p.x, my - p.y);
  const held = st.hovered >= 0 && st.props[st.hovered].altIcon ? st.hovered : -1;
  if (held >= 0 && Math.min(d(st.spots[held]), d(altPos(held))) < SLOT * 0.75) {
    // still on the prop or its other state
    st.alt = d(altPos(held)) < d(st.spots[held]) ? 1 : 0;
  } else if (Math.hypot(mx - st.ox, my - st.oy) <= st.centerR + 4) {
    st.hovered = -1;
    st.alt = 0;
  } else {
    let best = -1, bd = Infinity;
    st.spots.forEach((p, i) => {
      const di = d(p);
      if (di < bd) { bd = di; best = i; }
    });
    st.hovered = best;
    st.alt = 0;
  }
  render();
}

function render() {
  const { hovered: hi, alt } = st;
  st.slots.forEach((s, i) => {
    const on = i === hi;
    s.classList.toggle('hover', on && !alt);
    s.classList.toggle('dim', on && !!alt);
  });

  const pd = hi >= 0 ? st.props[hi] : null;
  if (pd?.altIcon) {
    const a = altPos(hi);
    st.altEl.hidden = false;
    Object.assign(st.altEl.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${SLOT}px`, height: `${SLOT}px` });
    st.altEl.className = `slot alt ${alt ? 'hover' : 'dim'}`;
    st.altEl.innerHTML = iconHtml(pd.altIcon.icon, pd.name);
  } else {
    st.altEl.hidden = true;
  }

  if (pd) {
    const state = alt ? pd.altIcon.state : pd.defaultState;
    st.centerEl.innerHTML = iconHtml(iconFor(pd.key, state), pd.name);
    st.nameEl.innerHTML = `${esc(pd.name)}${pd.altIcon ? `<small>${esc(state)}</small>` : ''}`;
  } else {
    st.centerEl.innerHTML = '';
    st.nameEl.textContent = 'Prop wheel';
  }
}

export function wheelConfirm() {
  if (!st) return;
  const { hovered, alt, props, onPick } = st;
  wheelCancel();
  if (hovered >= 0) {
    const pd = props[hovered];
    onPick(pd.key, alt && pd.altIcon ? pd.altIcon.state : pd.defaultState);
  }
}

export function wheelCancel() {
  if (!st) return;
  st.el.hidden = true;
  st.el.innerHTML = '';
  st = null;
}
