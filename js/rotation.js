// Rotation conventions, matched to the Blender add-on and checked against real
// Blender output (see tools/rotation-check/verify_rotation.mjs).
//
// A .propsprofile line stores (rx, ry, rz) in degrees. The add-on imports it as
// a Blender Euler in 'XZY' order with angles (rx, ry, -rz), so the rotation
// matrix in Blender world space (Z up) is
//
//     R = Ry(ry) · Rz(-rz) · Rx(rx)          (X applied first)
//
// The web app keeps the file's (rx, ry, rz) as-is and derives the matrix from
// them. A prop the user did not rotate never has its angles re-derived, so an
// import → export round trip is lossless. When a prop IS rotated freely (gizmo
// rings, trackball), the new matrix is turned back into angles with a port of
// Blender's matrix.to_euler('XZY') — the same numbers the add-on would write.
//
// "Yaw" in the UI is the Blender Euler Z the add-on edits with its compass and
// R tool: yaw = -rz.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const FLT_EPSILON = 1.1920929e-7;

// Row-major 3x3, Blender world axes.
export function profileToMatrix(rx, ry, rz) {
  const x = rx * D2R, y = ry * D2R, z = -rz * D2R;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  // Ry · Rz · Rx
  return [
    [cy * cz, -cy * sz * cx + sy * sx, cy * sz * sx + sy * cx],
    [sz, cz * cx, -cz * sx],
    [-sy * cz, sy * sz * cx + cy * sx, -sy * sz * sx + cy * cx],
  ];
}

// Port of Blender's mat3_normalized_to_eulO for order XZY (what
// matrix.to_euler('XZY') returns), converted to profile angles.
export function matrixToProfile(R) {
  const m = (col, row) => R[row][col]; // Blender indexes mat[col][row]
  const i = 0, j = 2, k = 1;           // XZY axis order, odd parity
  const cy = Math.hypot(m(i, i), m(i, j));
  let e1 = [0, 0, 0], e2 = [0, 0, 0];
  if (cy > 16 * FLT_EPSILON) {
    e1[i] = Math.atan2(m(j, k), m(k, k));
    e1[j] = Math.atan2(-m(i, k), cy);
    e1[k] = Math.atan2(m(i, j), m(i, i));
    e2[i] = Math.atan2(-m(j, k), -m(k, k));
    e2[j] = Math.atan2(-m(i, k), -cy);
    e2[k] = Math.atan2(-m(i, j), -m(i, i));
  } else {
    e1[i] = Math.atan2(-m(k, j), m(j, j));
    e1[j] = Math.atan2(-m(i, k), cy);
    e1[k] = 0;
    e2 = [...e1];
  }
  e1 = e1.map((v) => -v); // odd parity
  e2 = e2.map((v) => -v);
  const d1 = Math.abs(e1[0]) + Math.abs(e1[1]) + Math.abs(e1[2]);
  const d2 = Math.abs(e2[0]) + Math.abs(e2[1]) + Math.abs(e2[2]);
  const [ex, ey, ez] = d1 > d2 ? e2 : e1;
  return [clean(ex * R2D), clean(ey * R2D), clean(-ez * R2D)];
}

// Trim float noise (1e-6°) and negative zero from derived angles.
const clean = (v) => Math.round(v * 1e6) / 1e6 || 0;

// Yaw (Blender Euler Z, degrees) -> profile rz, normalised the way the
// add-on's export ends up writing it: rz in (-180, 180].
export function yawToRz(yaw) {
  const z = ((((yaw + 180) % 360) + 360) % 360) - 180; // [-180, 180)
  return z === 0 ? 0 : -z;
}

// Rotate a prop's orientation by D (a world-space rotation) and return the new
// profile angles. A turn around world Z on a prop without RY tilt only changes
// rz (exactly, no re-derivation); anything else goes through the matrix.
export function rotateProfile(rx, ry, rz, D, zTurn = null) {
  if (zTurn != null && Math.abs(ry) < 1e-9) return [rx, ry, yawToRz(-rz + zTurn)];
  return matrixToProfile(mul(D, profileToMatrix(rx, ry, rz)));
}

// The orientation of a prop's mirror image across the X axis (x -> -x), for
// props that are left-right symmetric in their own frame: reflecting X turns
// Ry(ry)·Rz(-rz)·Rx(rx) into Ry(-ry)·Rz(rz)·Rx(rx), i.e. (rx, -ry, -rz).
export function mirrorX(rx, ry, rz) {
  const nrz = rz === 180 || rz === -180 ? 180 : -rz || 0;
  return [rx, -ry || 0, nrz];
}

// Across the Y axis (y -> -y): the X mirror turned 180° around Z.
export const mirrorY = (rx, ry, rz) => rotateProfile(...mirrorX(rx, ry, rz), rotZ(180), 180);

// ---------------------------------------------------------------- 3x3 helpers

export function mul(A, B) {
  return A.map((row) => [0, 1, 2].map((c) => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c]));
}

export const apply = (A, v) => A.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

export function rotZ(deg) {
  const t = deg * D2R, c = Math.cos(t), s = Math.sin(t);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

// Rotation of `deg` degrees around unit axis [x, y, z] (right-handed).
export function axisAngleMatrix([x, y, z], deg) {
  const t = deg * D2R, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
  return [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ];
}

// Unit quaternion (x, y, z, w) -> row-major 3x3.
export function quatToMatrix(x, y, z, w) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

// ---------------------------------------------------------------- number format

// Python's f"{v:.3f}": exact binary value, ties rounded half-to-even.
// JS toFixed rounds ties away from zero (12.0625 -> "12.063", Python "12.062").
export function pyFixed3(v) {
  const s = v.toFixed(3);
  const exact = /^(\d+)\.(\d{3})5(0*)$/.exec(Math.abs(v).toFixed(25));
  if (exact && +exact[2][2] % 2 === 0) return `${v < 0 ? '-' : ''}${exact[1]}.${exact[2]}`;
  return s;
}
