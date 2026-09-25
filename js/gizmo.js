// Move / rotate handles, drawn in the app's style: thin strokes with a soft
// outline, a fixed size on screen, colored like the X / Y / Z fields, and
// always on top of the scene. Works in Blender world space (Z up).
//
//   move:   arrows (x, y, z) and a ground-plane square (xy)
//   rotate: rings around x, y, z and an inner disc for free rotation

import * as THREE from 'three';

const PX = 84;          // one gizmo unit in screen pixels (arrow length)
const RING_R = 0.86;    // ring radius, in gizmo units
const DISC_R = 0.64;    // free-rotate disc radius
const COLORS = { x: 0xff7b88, y: 0x86e486, z: 0x74adff, xy: 0xb46bff, free: 0xb46bff };
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

let camera, dom;
const root = new THREE.Group();
const moveGroup = new THREE.Group();
const rotateGroup = new THREE.Group();
const handles = new Map();   // name -> handle
const billboards = [];       // meshes that always face the camera
const shared = { center: { value: new THREE.Vector3() }, eye: { value: new THREE.Vector3() } };
let mode = 'move';
let hovered = null;
let drag = null;

// ---------------------------------------------------------------- materials

// Flat color, drawn on top. `fade` dims the half of a ring that is behind
// the gizmo center, which is what makes the rings read as 3D.
function material(color, opacity, fade = 1) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      opacity: { value: opacity },
      fade: { value: fade },
      center: shared.center,
      eye: shared.eye,
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 color;
      uniform float opacity;
      uniform float fade;
      uniform vec3 center;
      uniform vec3 eye;
      varying vec3 vWorld;
      void main() {
        vec3 r = vWorld - center;
        float behind = dot(r / max(length(r), 1e-5), normalize(center - eye));
        gl_FragColor = vec4(color, opacity * mix(1.0, fade, smoothstep(-0.1, 0.25, behind)));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  m.userData.opacity = opacity;
  return m;
}

const SHADOW = 0x0a0a12;

// ---------------------------------------------------------------- geometry helpers

// Cylinder / cone built along +Y, moved to [from, to] on the given axis.
function alongAxis(geom, axis, from, to) {
  geom.translate(0, (from + to) / 2, 0);
  if (axis === 'x') geom.rotateZ(-Math.PI / 2);
  if (axis === 'z') geom.rotateX(Math.PI / 2);
  return geom;
}

function ringGeom(axis, tube) {
  const g = new THREE.TorusGeometry(RING_R, tube, 8, 128);
  if (axis === 'x') g.rotateY(Math.PI / 2);
  if (axis === 'y') g.rotateX(Math.PI / 2);
  return g;
}

function addMesh(parent, geom, mat, order, billboard = false) {
  const m = new THREE.Mesh(geom, mat);
  m.renderOrder = order;
  parent.add(m);
  if (billboard) billboards.push(m);
  return m;
}

function addHandle(name, kind, axis, group, color, parts, pickerGeom, billboardPicker = false) {
  const h = { name, kind, axis, group, mats: [], base: new THREE.Color(color), enabled: true, meshes: [] };
  h.hot = h.base.clone().lerp(new THREE.Color(0xffffff), 0.45);
  for (const [geom, mat, order, billboard] of parts) {
    h.meshes.push(addMesh(group, geom, mat, order, billboard));
    if (mat.userData.colored) h.mats.push(mat);
  }
  h.picker = new THREE.Mesh(pickerGeom, new THREE.MeshBasicMaterial());
  h.picker.visible = false;
  h.picker.userData.handle = name;
  group.add(h.picker);
  if (billboardPicker) billboards.push(h.picker);
  handles.set(name, h);
}

const colored = (m) => { m.userData.colored = true; return m; };

function build() {
  // move: arrows
  for (const a of ['x', 'y', 'z']) {
    const c = COLORS[a];
    addHandle(`t${a}`, 'axis', a, moveGroup, c, [
      [alongAxis(new THREE.CylinderGeometry(0.036, 0.036, 0.7, 10), a, 0.15, 0.85), material(SHADOW, 0.5), 40],
      [alongAxis(new THREE.ConeGeometry(0.1, 0.23, 20), a, 0.79, 1.02), material(SHADOW, 0.5), 40],
      [alongAxis(new THREE.CylinderGeometry(0.02, 0.02, 0.66, 10), a, 0.16, 0.82), colored(material(c, 0.95)), 42],
      [alongAxis(new THREE.ConeGeometry(0.074, 0.2, 20), a, 0.81, 1.0), colored(material(c, 1)), 43],
    ], alongAxis(new THREE.CylinderGeometry(0.1, 0.1, 0.95, 8), a, 0.1, 1.05));
  }
  // move: ground-plane square
  const sq = new THREE.PlaneGeometry(0.2, 0.2).translate(0.32, 0.32, 0);
  const sqEdge = new THREE.EdgesGeometry(sq);
  const edgeMat = colored(material(COLORS.xy, 0.9));
  addHandle('xy', 'plane', 'z', moveGroup, COLORS.xy, [
    [sq, colored(material(COLORS.xy, 0.28)), 41],
  ], new THREE.PlaneGeometry(0.27, 0.27).translate(0.32, 0.32, 0));
  const edges = new THREE.LineSegments(sqEdge, edgeMat);
  edges.renderOrder = 42;
  moveGroup.add(edges);
  handles.get('xy').mats.push(edgeMat);
  handles.get('xy').meshes.push(edges);

  // rotate: rings
  for (const a of ['x', 'y', 'z']) {
    addHandle(`r${a}`, 'ring', a, rotateGroup, COLORS[a], [
      [ringGeom(a, 0.034), material(SHADOW, 0.45, 0.3), 40],
      [ringGeom(a, 0.02), colored(material(COLORS[a], 0.95, 0.28)), 42],
    ], ringGeom(a, 0.085));
  }
  // rotate: free disc (faces the camera)
  addHandle('free', 'free', null, rotateGroup, COLORS.free, [
    [new THREE.CircleGeometry(DISC_R, 64), colored(material(COLORS.free, 0.035)), 39, true],
    [new THREE.RingGeometry(DISC_R - 0.016, DISC_R, 128), colored(material(COLORS.free, 0.18)), 41, true],
  ], new THREE.CircleGeometry(DISC_R - 0.04, 48), true);
  const free = handles.get('free');
  free.mats[0].userData.hotOpacity = 0.1;
  free.mats[1].userData.hotOpacity = 0.7;

  // center dot
  addMesh(root, new THREE.CircleGeometry(0.075, 24), material(SHADOW, 0.55), 44, true);
  addMesh(root, new THREE.CircleGeometry(0.048, 24), material(0xffffff, 0.95), 45, true);

  root.add(moveGroup, rotateGroup);
  root.visible = false;
}

// ---------------------------------------------------------------- public: setup + per frame

// While dragging: a guide line along the axis being moved, and a wedge showing
// how far a ring has turned. Both live in world space.
const guide = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5, depthTest: false, depthWrite: false }));
const SWEEP_SEGS = 64;
const sweep = new THREE.Mesh(new THREE.BufferGeometry(), material(0xffffff, 0.24));

export function initGizmo(scene, cam, domElement) {
  camera = cam;
  dom = domElement;
  build();
  guide.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  sweep.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SWEEP_SEGS * 9), 3));
  guide.renderOrder = 38;
  sweep.renderOrder = 38;
  guide.frustumCulled = sweep.frustumCulled = false;
  guide.visible = sweep.visible = false;
  scene.add(root, guide, sweep);
}

// Show the turned angle (degrees) of the ring being dragged.
export function setSweep(deg) {
  const st = drag;
  if (!st || st.kind !== 'ring') return;
  const r = RING_R * root.scale.x;
  const pos = sweep.geometry.attributes.position;
  const t = (deg * Math.PI) / 180;
  const pt = (a) => st.p0.clone().addScaledVector(st.e1, Math.cos(a) * r).addScaledVector(st.e2, Math.sin(a) * r);
  for (let i = 0; i < SWEEP_SEGS; i++) {
    const a0 = st.a0 + (t * i) / SWEEP_SEGS, a1 = st.a0 + (t * (i + 1)) / SWEEP_SEGS;
    const p1 = pt(a0), p2 = pt(a1);
    pos.setXYZ(i * 3, st.p0.x, st.p0.y, st.p0.z);
    pos.setXYZ(i * 3 + 1, p1.x, p1.y, p1.z);
    pos.setXYZ(i * 3 + 2, p2.x, p2.y, p2.z);
  }
  pos.needsUpdate = true;
  sweep.geometry.computeBoundingSphere();
  sweep.visible = Math.abs(deg) > 0.01;
}

// target: { x, y, z, quaternion: THREE.Quaternion | null } or null to hide.
export function setTarget(target, { mode: m = 'move' } = {}) {
  if (drag) return;
  if (!target) {
    root.visible = false;
    hovered = null;
    return;
  }
  root.visible = true;
  root.position.set(target.x, target.y, target.z);
  if (target.quaternion) root.quaternion.copy(target.quaternion);
  else root.quaternion.identity();
  mode = m;
  moveGroup.visible = mode === 'move';
  rotateGroup.visible = mode === 'rotate';
  update();
}

export const isVisible = () => root.visible;

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function worldPerPixel() {
  const dist = camera.position.distanceTo(root.position);
  return (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, dom.clientHeight);
}

// Call before each render: keeps the size fixed on screen, faces billboards
// to the camera, and hides handles that point straight at the viewer.
export function update() {
  if (!root.visible) return;
  camera.updateMatrixWorld();
  root.scale.setScalar(PX * worldPerPixel());
  shared.center.value.copy(root.position);
  shared.eye.value.copy(camera.position);
  _q.copy(root.quaternion).invert().multiply(camera.quaternion);
  for (const b of billboards) b.quaternion.copy(_q);
  const view = _v.copy(root.position).sub(camera.position).normalize();
  for (const h of handles.values()) {
    if (h.kind === 'axis') h.enabled = Math.abs(_w.copy(AXIS[h.axis]).applyQuaternion(root.quaternion).dot(view)) < 0.97;
    else if (h.kind === 'plane') h.enabled = Math.abs(_w.copy(AXIS.z).applyQuaternion(root.quaternion).dot(view)) > 0.12;
    else h.enabled = true;
    const show = h.enabled && (!drag || drag.name === h.name);
    for (const m of h.meshes) m.visible = show;
  }
  paint();
  root.updateMatrixWorld(true);
}

function paint() {
  for (const h of handles.values()) {
    const hot = h.name === hovered || h.name === drag?.name;
    for (const m of h.mats) {
      m.uniforms.color.value.copy(hot ? h.hot : h.base);
      m.uniforms.opacity.value = hot ? (m.userData.hotOpacity ?? 1) : m.userData.opacity;
    }
  }
}

// ---------------------------------------------------------------- picking

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function rayAt(clientX, clientY) {
  const r = dom.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

// Handle under the pointer: { name, point } or null. Rings and arrows win
// over the free-rotate disc behind them.
export function hit(clientX, clientY) {
  if (!root.visible) return null;
  update();
  rayAt(clientX, clientY);
  const group = mode === 'move' ? moveGroup : rotateGroup;
  const pickers = [...handles.values()].filter((h) => h.enabled && h.group === group).map((h) => h.picker);
  const hits = raycaster.intersectObjects(pickers, false);
  const best = hits.find((x) => x.object.userData.handle !== 'free') || hits[0];
  return best ? { name: best.object.userData.handle, point: best.point.clone() } : null;
}

export function setHovered(name) {
  if (name === hovered) return false;
  hovered = name;
  paint();
  return true;
}

// ---------------------------------------------------------------- dragging

const worldAxis = (a) => AXIS[a].clone().applyQuaternion(root.quaternion);

// Parameter s of the point on line p0 + s·a closest to the ray (a, ray dir unit).
function lineParam(ray, p0, a) {
  const w0 = _w.copy(p0).sub(ray.origin);
  const b = a.dot(ray.direction);
  const denom = 1 - b * b;
  if (denom < 1e-4) return null;
  return (b * ray.direction.dot(w0) - a.dot(w0)) / denom;
}

function toScreen(p) {
  const r = dom.getBoundingClientRect();
  const v = p.clone().project(camera);
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}

function planeAngle(ray, st) {
  const p = ray.intersectPlane(st.plane, new THREE.Vector3());
  if (!p) return null;
  p.sub(st.p0);
  return Math.atan2(p.dot(st.e2), p.dot(st.e1));
}

// Start dragging handle `h` (from hit()). Returns false if it can't be used
// from this view.
export function begin(h, clientX, clientY) {
  const handle = handles.get(h.name);
  if (!handle) return false;
  const ray = rayAt(clientX, clientY);
  const st = { name: h.name, kind: handle.kind, axisName: handle.axis, p0: root.position.clone(), x0: clientX, y0: clientY, space: root.quaternion.clone() };
  if (handle.kind === 'axis') {
    st.a = worldAxis(handle.axis);
    st.s0 = lineParam(ray, st.p0, st.a);
    if (st.s0 == null) return false;
    const g = guide.geometry.attributes.position;
    g.setXYZ(0, st.p0.x - st.a.x * 1e5, st.p0.y - st.a.y * 1e5, st.p0.z - st.a.z * 1e5);
    g.setXYZ(1, st.p0.x + st.a.x * 1e5, st.p0.y + st.a.y * 1e5, st.p0.z + st.a.z * 1e5);
    g.needsUpdate = true;
    guide.material.color.copy(handle.base);
    guide.visible = true;
  } else if (handle.kind === 'plane') {
    st.n = worldAxis('z');
    st.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(st.n, st.p0);
    st.h0 = ray.intersectPlane(st.plane, new THREE.Vector3());
    if (!st.h0) return false;
  } else if (handle.kind === 'ring') {
    st.a = worldAxis(handle.axis);
    const view = st.p0.clone().sub(camera.position).normalize();
    st.e1 = Math.abs(st.a.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(st.a).normalize() : new THREE.Vector3(1, 0, 0).cross(st.a).normalize();
    st.e2 = st.a.clone().cross(st.e1);
    st.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(st.a, st.p0);
    // Ring facing the camera: follow the pointer around it. Seen edge-on:
    // drag along the ring's direction on screen.
    st.angular = Math.abs(st.a.dot(view)) > 0.3;
    if (st.angular) {
      st.last = planeAngle(ray, st);
      if (st.last == null) st.angular = false;
      else st.a0 = st.last;
    }
    if (!st.angular) {
      const radial = h.point.clone().sub(st.p0);
      radial.addScaledVector(st.a, -radial.dot(st.a));
      if (radial.lengthSq() < 1e-9) radial.copy(st.e1);
      st.a0 = Math.atan2(radial.dot(st.e2), radial.dot(st.e1));
      const g = st.p0.clone().addScaledVector(radial.normalize(), RING_R * root.scale.x);
      const t = st.a.clone().cross(radial);
      const s0 = toScreen(g), s1 = toScreen(g.clone().addScaledVector(t, root.scale.x * 0.2));
      const len = Math.hypot(s1.x - s0.x, s1.y - s0.y) || 1;
      st.t2 = { x: (s1.x - s0.x) / len, y: (s1.y - s0.y) / len };
    }
    st.raw = 0;
    sweep.material.uniforms.color.value.copy(handle.hot);
  } else {
    st.q = new THREE.Quaternion();
    st.lx = clientX; st.ly = clientY;
  }
  drag = st;
  update();
  return true;
}

// Current result of the drag:
//   { kind: 'move', delta: [dx, dy, dz] }
//   { kind: 'rotate', axis: [x, y, z] | null, angle: degrees (for axis),
//     quaternion: [x, y, z, w] (free), worldZ: boolean }
export function dragTo(clientX, clientY, { ctrl = false, grid = 10 } = {}) {
  const st = drag;
  if (!st) return null;
  const ray = rayAt(clientX, clientY);
  if (st.kind === 'axis') {
    const s = lineParam(ray, st.p0, st.a);
    if (s == null) return null;
    let d = s - st.s0;
    if (ctrl) {
      // world axis: land the pivot on the grid; tilted axis: step by the grid
      const i = [0, 1, 2].find((k) => Math.abs(st.a.getComponent(k)) > 0.9999);
      if (i === undefined) d = Math.round(d / grid) * grid;
      else {
        const sign = Math.sign(st.a.getComponent(i));
        d = (Math.round((st.p0.getComponent(i) + d * sign) / grid) * grid - st.p0.getComponent(i)) * sign;
      }
    }
    root.position.copy(st.p0).addScaledVector(st.a, d);
    return { kind: 'move', delta: [st.a.x * d, st.a.y * d, st.a.z * d], along: st.axisName, amount: d };
  }
  if (st.kind === 'plane') {
    const p = ray.intersectPlane(st.plane, new THREE.Vector3());
    if (!p) return null;
    const d = p.sub(st.h0);
    if (ctrl) {
      const tx = Math.round((st.p0.x + d.x) / grid) * grid, ty = Math.round((st.p0.y + d.y) / grid) * grid;
      d.x = tx - st.p0.x;
      d.y = ty - st.p0.y;
    }
    root.position.copy(st.p0).add(d);
    return { kind: 'move', delta: [d.x, d.y, d.z], along: 'xy' };
  }
  if (st.kind === 'ring') {
    if (st.angular) {
      const a = planeAngle(ray, st);
      if (a != null) {
        let da = a - st.last;
        da = ((da + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        st.raw += da;
        st.last = a;
      }
    } else {
      st.raw = ((clientX - st.x0) * st.t2.x + (clientY - st.y0) * st.t2.y) / (RING_R * PX);
    }
    const worldZ = st.a.z > 0.999999;
    return { kind: 'rotate', axis: [st.a.x, st.a.y, st.a.z], angle: (st.raw * 180) / Math.PI, worldZ };
  }
  // free: tumble around the axis perpendicular to the pointer motion
  const dx = clientX - st.lx, dy = clientY - st.ly;
  st.lx = clientX; st.ly = clientY;
  const dist = Math.hypot(dx, dy);
  if (dist > 0) {
    const e = camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]);
    const up = new THREE.Vector3(e[4], e[5], e[6]);
    const axis = up.multiplyScalar(dx).add(right.multiplyScalar(dy)).normalize();
    st.q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, (dist * Math.PI) / (2 * DISC_R * PX)));
  }
  return { kind: 'rotate', axis: null, quaternion: [st.q.x, st.q.y, st.q.z, st.q.w], worldZ: false };
}

// Where the dragged handle is on screen, for the readout label.
export function dragging() {
  return drag ? drag.name : null;
}

export function end() {
  drag = null;
  guide.visible = false;
  sweep.visible = false;
  update();
}
