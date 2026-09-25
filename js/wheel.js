// Hold-Q radial prop picker (port of tools/wheel_tool.py). Multi-state props
// show their alternate state as a second slot, further out on the same spoke.

import { listedProps, iconFor, initials } from './catalog.js';

const TAU = Math.PI * 2;
let st = null;

export const wheelOpen = () => !!st;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function iconHtml(url, name) {
  return url ? `<img src="${esc(url)}" alt="" draggable="false">` : `<span>${esc(initials(name))}</span>`;
}

export function openWheel(clientX, clientY, onPick) {
  const props = listedProps();
  if (!props.length) return false;
  const el = document.getElementById('wheel');
  el.hidden = false;
  const rect = el.getBoundingClientRect();
  const n = props.length;

  const R = Math.max(110, Math.min(400, Math.min(rect.width, rect.height) / 2 - 90));
  const slot = Math.max(24, Math.min(60, (TAU * R / n) * 0.9));
  const hov = Math.round(slot * 1.4);
  const centerR = Math.min(140, R * 0.36);
  const reach = R + hov * 1.6 + 10;
  const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));
  const ox = clamp(clientX - rect.left, reach, rect.width - reach);
  const oy = clamp(clientY - rect.top, reach, rect.height - reach);

  const discR = R + slot / 2 + 22;
  el.innerHTML = `
    <div class="disc" style="left:${ox - discR}px;top:${oy - discR}px;width:${discR * 2}px;height:${discR * 2}px"></div>
    <div class="spoke" hidden></div>
    ${props.map((p, i) => {
      const a = Math.PI / 2 - (TAU * i) / n;
      return `<div class="slot" data-i="${i}" style="left:${ox + R * Math.cos(a)}px;top:${oy - R * Math.sin(a)}px;width:${slot}px;height:${slot}px">${iconHtml(p.icon, p.name)}</div>`;
    }).join('')}
    <div class="slot alt" hidden style="width:${hov}px;height:${hov}px"></div>
    <div class="center" style="left:${ox}px;top:${oy}px;width:${centerR * 2}px;height:${centerR * 2}px"></div>
    <div class="name" style="left:${ox}px;top:${oy + centerR + 14}px">Prop wheel</div>`;

  st = {
    el, props, n, R, slot, hov, centerR, ox, oy, rect, onPick,
    hovered: -1, alt: 0,
    slots: [...el.querySelectorAll('.slot[data-i]')],
    altEl: el.querySelector('.slot.alt'),
    centerEl: el.querySelector('.center'),
    nameEl: el.querySelector('.name'),
    spokeEl: el.querySelector('.spoke'),
  };
  render();
  return true;
}

function slotPos(i) {
  const a = Math.PI / 2 - (TAU * i) / st.n;
  return { a, x: st.ox + st.R * Math.cos(a), y: st.oy - st.R * Math.sin(a) };
}

function altPos(i) {
  const { a, x, y } = slotPos(i);
  const gap = st.hov + 12;
  return { x: x + Math.cos(a) * gap, y: y - Math.sin(a) * gap };
}

export function wheelMove(clientX, clientY) {
  if (!st) return;
  const mx = clientX - st.rect.left, my = clientY - st.rect.top;
  const dx = mx - st.ox, dy = -(my - st.oy);
  if (Math.hypot(dx, dy) > st.centerR + 5) {
    const norm = ((Math.PI / 2 - Math.atan2(dy, dx)) % TAU + TAU) % TAU;
    const i = Math.round(norm / (TAU / st.n)) % st.n;
    st.hovered = i;
    st.alt = 0;
    if (st.props[i].altIcon) {
      const m = slotPos(i), a = altPos(i);
      st.alt = Math.hypot(mx - a.x, my - a.y) < Math.hypot(mx - m.x, my - m.y) ? 1 : 0;
    }
  } else {
    st.hovered = -1;
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
    const size = on ? st.hov : st.slot;
    s.style.width = s.style.height = `${size}px`;
  });

  const pd = hi >= 0 ? st.props[hi] : null;
  if (pd?.altIcon) {
    const a = altPos(hi);
    st.altEl.hidden = false;
    st.altEl.style.left = `${a.x}px`;
    st.altEl.style.top = `${a.y}px`;
    st.altEl.className = `slot alt ${alt ? 'hover' : 'dim'}`;
    st.altEl.innerHTML = iconHtml(pd.altIcon.icon, pd.name);
  } else {
    st.altEl.hidden = true;
  }

  if (pd) {
    const p = slotPos(hi);
    const len = Math.hypot(p.x - st.ox, p.y - st.oy);
    Object.assign(st.spokeEl.style, {
      left: `${st.ox}px`, top: `${st.oy - 1}px`, width: `${len}px`,
      transform: `rotate(${Math.atan2(p.y - st.oy, p.x - st.ox)}rad)`,
    });
    st.spokeEl.hidden = false;
    const state = alt ? pd.altIcon.state : pd.defaultState;
    st.centerEl.innerHTML = iconHtml(iconFor(pd.key, state), pd.name);
    st.nameEl.innerHTML = `${esc(pd.name)}${alt ? `<small>(${esc(state)})</small>` : ''}`;
  } else {
    st.spokeEl.hidden = true;
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
