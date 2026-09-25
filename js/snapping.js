// Port of snapping/logic.py. All values are Blender world coordinates.

import { S } from './state.js';
import { envBoxes, propBox } from './viewport.js';

export const RING_Z = 106.0;
const STACK_BASE_ZS = [0.0, RING_Z];
const STACK_BASE_TOL = 12.0;

const inXY = (b, x, y) => !!b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

function stageTop(x, y) {
  const b = envBoxes.stage;
  return S.stage && inXY(b, x, y) ? b.maxZ : null;
}

// Top of a placed prop resting on a base surface (floor / ring) whose footprint
// covers (x, y). One level only: stacked props are never platforms.
function placedTop(x, y, exclude) {
  let best = null;
  for (const p of S.props) {
    if (exclude?.has(p.id)) continue;
    if (!STACK_BASE_ZS.some((bz) => Math.abs(p.z - bz) <= STACK_BASE_TOL)) continue;
    const b = propBox(p.id);
    if (inXY(b, x, y) && (best === null || b.maxZ > best)) best = b.maxZ;
  }
  return best;
}

export function snapZ(x, y, exclude = null) {
  if (S.stacking) {
    const top = placedTop(x, y, exclude);
    if (top !== null) return top;
  }
  const ring = envBoxes.ringmat;
  const fallback = () => stageTop(x, y) ?? 0.0;
  switch (S.env) {
    case 'EC':
      return inXY(envBoxes.ec, x, y) ? RING_Z : fallback();
    case 'WG':
      return inXY(envBoxes.wg, x, y) ? RING_Z : fallback();
    case 'HIAC':
      if (inXY(ring, x, y)) return RING_Z;
      if (inXY(envBoxes.hiac, x, y)) return envBoxes.hiac.maxZ; // cell roof
      return fallback();
    case 'AMB':
      if (inXY(ring, x, y)) return RING_Z;
      if (inXY(envBoxes.amb, x, y)) return envBoxes.amb.maxZ;   // ambulance roof
      return fallback();
    default:
      return inXY(ring, x, y) ? RING_Z : fallback();
  }
}
