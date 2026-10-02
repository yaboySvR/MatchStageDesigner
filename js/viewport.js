// three.js scene, set up in Blender's world space: Z is up, and positions are
// the same numbers the .propsprofile uses. Geometry is converted from OBJ
// space when it loads (geometry.js), so nothing here swaps axes.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { S } from './state.js';
import { getGeometry, geomNow, geomFailed, loadEnvGeometry } from './geometry.js';
import { profileToMatrix } from './rotation.js';
import * as G from './gizmo.js';
import { catalog, getProp } from './catalog.js';

const DEG = Math.PI / 180;

export let renderer, scene, camera, controls;
export const envBoxes = {};              // env id -> AABB
const envMeshes = {};
const envLoading = {};
const propMeshes = new Map();            // prop id -> Mesh
const ghostMeshes = [];
let needsRender = true;
let host;

const matOpts = { flatShading: true, side: THREE.DoubleSide };
const MAT = {
  prop: new THREE.MeshStandardMaterial({ color: 0xd9cfc0, roughness: 0.6, metalness: 0.05, ...matOpts }),
  sel: new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0x7a3300, roughness: 0.5, ...matOpts }),
  hover: new THREE.MeshStandardMaterial({ color: 0xf1e8ff, emissive: 0x2c1450, roughness: 0.5, ...matOpts }),
  bad: new THREE.MeshStandardMaterial({ color: 0xff6b7a, emissive: 0x5a0010, roughness: 0.55, ...matOpts }),   // overlapping
  selBad: new THREE.MeshStandardMaterial({ color: 0xff5f3d, emissive: 0x7a1000, roughness: 0.5, ...matOpts }), // selected + overlapping
  ghost: new THREE.MeshBasicMaterial({ color: 0x8be9ff, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }),
};
// Props with the game's own color textures (catalog "textures") get a copy of
// each look above with the texture on it, one set per prop. A prop with more
// than one texture gets a list of them, one per group of its mesh (a null
// texture keeps that part plain). Until the textures have arrived the prop
// keeps the plain look.
const SKINNED = ['prop', 'sel', 'hover', 'bad', 'selBad'];
const skins = new Map(); // prop key -> { ready, prop, sel, ... } or null
const maps = new Map(); // texture file -> { map, ready, waiting: [fn] }
let texLoader = null;

function textureOf(file) {
  let t = maps.get(file);
  if (!t) {
    texLoader ??= new THREE.TextureLoader();
    t = { ready: false, waiting: [] };
    t.map = texLoader.load(`assets/textures/${file}`, () => {
      t.ready = true;
      for (const fn of t.waiting.splice(0)) fn();
    }, undefined, (e) => console.error(e));
    t.map.colorSpace = THREE.SRGBColorSpace;
    t.map.wrapS = t.map.wrapT = THREE.RepeatWrapping; // UVs can go past 1
    t.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    maps.set(file, t);
  }
  return t;
}

function skinOf(key) {
  if (skins.has(key)) return skins.get(key);
  const files = getProp(key)?.textures;
  let skin = null;
  if (files?.some(Boolean)) {
    skin = { ready: false };
    const parts = files.map((file) => file && textureOf(file));
    for (const k of SKINNED) {
      const list = parts.map((t) => {
        if (!t) return MAT[k];
        const m = MAT[k].clone();
        m.map = t.map;
        if (k === 'prop') m.color.set(0xffffff);
        return m;
      });
      skin[k] = list.length === 1 ? list[0] : list;
    }
    const pending = parts.filter((t) => t && !t.ready);
    let left = pending.length;
    skin.ready = !left;
    for (const t of pending) {
      t.waiting.push(() => {
        if (--left) return;
        skin.ready = true;
        for (const [id, mesh] of propMeshes) mesh.material = materialFor(id);
        requestRender();
      });
    }
  }
  skins.set(key, skin);
  return skin;
}
const look = (key, k) => {
  const skin = key != null && skinOf(key);
  return skin?.ready ? skin[k] : MAT[k];
};

const ENV_STYLE = {
  ringmat:   { color: 0x31568f },
  barricade: { color: 0x3b3e49 },
  floor:     { color: 0x25272e },
  ramp:      { color: 0x464955 },
  stage:     { color: 0x51545f },
  ec:        { color: 0x9aa1ad, metalness: 0.4 },
  hiac:      { color: 0x8d949f, metalness: 0.4 },
  wg:        { color: 0x9aa1ad, metalness: 0.4 },
  amb:       { color: 0xe4e4e8 },
};
// The arena piece each arena shows besides the ring (the steel cage, the
// ambulance, ... stand where their match puts them).
const ENV_PIECE = { EC: 'ec', HIAC: 'hiac', WG: 'wg', AMB: 'amb', CAGE: 'cage', DUMPSTER: 'dumpster', CASKET: 'casket' };
// these have a ring of their own
const OWN_RING = new Set(['EC', 'HIAC', 'WG']);

// Arena pieces made from the game's models (catalog "env_textures"): one
// material per group of the mesh. "cut" textures have see-through parts,
// "fence" ones are mostly see-through (the cage's chain-link: blended, so it
// stays a haze from afar), "glass" is see-through as a whole; null stays plain.
function envMaterial(id, style) {
  const plain = () => new THREE.MeshStandardMaterial({ roughness: 0.85, ...matOpts, ...style });
  const list = catalog.envTextures[id];
  if (!list) return plain();
  return list.map((t) => {
    if (!t) return plain();
    const tex = textureOf(t.file);
    const m = new THREE.MeshStandardMaterial({ roughness: 0.8, ...matOpts, map: tex.map });
    if (t.alpha === 'cut') m.alphaTest = 0.5;
    if (t.alpha === 'fence') Object.assign(m, { transparent: true, depthWrite: false });
    if (t.alpha === 'glass') Object.assign(m, { transparent: true, opacity: 0.35, depthWrite: false });
    m.userData.see = t.alpha === 'glass' || t.alpha === 'fence';
    m.userData.opacity = m.opacity;
    if (!tex.ready) tex.waiting.push(requestRender);
    return m;
  });
}

export const requestRender = () => { needsRender = true; };

let cameraListener = null;
export const onCamera = (fn) => { cameraListener = fn; };

// Runs at the start of every animation frame, before drawing (walk.js moves
// the camera here, so a frame shows the camera where it is this frame).
let frameHook = null;
export const onFrame = (fn) => { frameHook = fn; };

// Called right after each frame is drawn, while the picture is still there
// (showcase.js copies it into its 720p recording).
let renderedHook = null;
export const onRendered = (fn) => { renderedHook = fn; };

// Draw the view right now and hand back the canvas (showcase recording).
export function renderNow() {
  G.update();
  renderer.render(scene, camera);
  return renderer.domElement;
}

export function initViewport(container) {
  host = container;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121219);

  camera = new THREE.PerspectiveCamera(45, 1, 2.5, 40000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -1500, 950);

  G.initGizmo(scene, camera, renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 106);
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };
  controls.screenSpacePanning = true;
  controls.maxDistance = 16000;
  controls.minDistance = 20;
  controls.zoomSpeed = 1.4;
  controls.addEventListener('change', () => { requestRender(); cameraListener?.(); });
  controls.update();

  const hemi = new THREE.HemisphereLight(0xe4e8ff, 0x2a2530, 1.4);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(900, -1300, 2200);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xb9a8ff, 0.5);
  fill.position.set(-1500, 1200, 800);
  scene.add(fill);

  const grid = new THREE.GridHelper(12000, 120, 0x2f3140, 0x1d1e27);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -2;
  scene.add(grid);

  new ResizeObserver(resize).observe(container);
  resize();

  const tick = (now = performance.now()) => {
    requestAnimationFrame(tick);
    frameHook?.(now);
    if (!needsRender) return;
    needsRender = false;
    G.update();
    renderer.render(scene, camera);
    renderedHook?.(renderer.domElement);
  };
  tick();
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}

// ---------------------------------------------------------------- environment

const boxOf = (b) => ({ minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z });

export function ensureEnv(id) {
  if (envLoading[id]) return envLoading[id];
  envLoading[id] = loadEnvGeometry(id).then((geom) => {
    const mesh = new THREE.Mesh(geom, envMaterial(id, ENV_STYLE[id] || { color: 0x777777 }));
    mesh.name = id;
    envMeshes[id] = mesh;
    envBoxes[id] = boxOf(geom.boundingBox);
    scene.add(mesh);
    applyEnvState();
    return mesh;
  }).catch((e) => {
    delete envLoading[id];
    throw e;
  });
  return envLoading[id];
}

export function envModelsFor(env) {
  const need = ['floor', 'barricade', 'ringmat'];
  if (ENV_PIECE[env]) need.push(ENV_PIECE[env]);
  if (S.stage) need.push('ramp', 'stage');
  return need;
}

// Loaded arena models and whether they show (physics.js collides with these).
export const envMeshList = () => Object.entries(envMeshes).map(([id, m]) => ({ id, geom: m.geometry, visible: m.visible }));

export function applyEnvState() {
  const vis = {
    floor: true,
    barricade: true,
    ringmat: !OWN_RING.has(S.env),
    ramp: S.stage,
    stage: S.stage,
  };
  if (ENV_PIECE[S.env]) vis[ENV_PIECE[S.env]] = true;
  for (const [id, mesh] of Object.entries(envMeshes)) {
    mesh.visible = !!vis[id];
    const xray = S.xray && id !== 'floor';
    for (const m of [mesh.material].flat()) {
      const see = m.userData.see; // glass
      m.transparent = xray || see;
      m.opacity = xray ? 0.22 : see ? m.userData.opacity : 1;
      m.depthWrite = !xray && !see;
      m.needsUpdate = true;
    }
  }
  requestRender();
}

// ---------------------------------------------------------------- props

const _m4 = new THREE.Matrix4();
function rotationQuat(rx, ry, rz, out) {
  const R = profileToMatrix(rx, ry, rz);
  _m4.set(
    R[0][0], R[0][1], R[0][2], 0,
    R[1][0], R[1][1], R[1][2], 0,
    R[2][0], R[2][1], R[2][2], 0,
    0, 0, 0, 1,
  );
  return out.setFromRotationMatrix(_m4);
}

function place(obj, p) {
  obj.position.set(p.x, p.y, p.z);
  rotationQuat(p.rx, p.ry, p.rz, obj.quaternion);
}

let hoverId = null;
let overlapIds = new Set(); // props going into another one (overlaps.js)
// Showcase: every prop in its plain color, no handles (showcase.js).
let clean = false;
let showHandles = null;
export function setClean(on) {
  clean = on;
  if (on) showHandles ??= G.hideForPicture();
  else { showHandles?.(); showHandles = null; }
  for (const [id, mesh] of propMeshes) mesh.material = materialFor(id);
  requestRender();
}

const lookFor = (id) => {
  if (clean) return 'prop';
  if (S.selected.has(id)) return overlapIds.has(id) ? 'selBad' : 'sel';
  if (id === hoverId) return 'hover';
  return overlapIds.has(id) ? 'bad' : 'prop';
};
const materialFor = (id) => look(propMeshes.get(id)?.userData.key, lookFor(id));

export function setOverlaps(ids) {
  overlapIds = ids;
  for (const [id, mesh] of propMeshes) mesh.material = materialFor(id);
  requestRender();
}

// A prop's placement as a matrix (the same one its mesh gets).
export function propMatrix(p) {
  return new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), rotationQuat(p.rx, p.ry, p.rz, new THREE.Quaternion()), new THREE.Vector3(1, 1, 1));
}

// Props whose model is still downloading get one wait per model, and all the
// waits share one queued re-sync. (Registering a re-sync per prop per call
// compounds: every re-sync registers more, and a big scene locks the page.)
const waiting = new Set();
let resyncQueued = false;

function resyncSoon() {
  if (resyncQueued) return;
  resyncQueued = true;
  setTimeout(() => {
    resyncQueued = false;
    syncProps();
  }, 0);
}

function waitForGeometry(key, state) {
  const id = `${key}\u0000${state}`;
  if (waiting.has(id) || geomFailed(key, state)) return;
  waiting.add(id);
  getGeometry(key, state)
    .then(resyncSoon, (e) => console.error(e))
    .finally(() => waiting.delete(id));
}

export function syncProps() {
  const alive = new Set();
  for (const p of S.props) {
    alive.add(p.id);
    let mesh = propMeshes.get(p.id);
    const geom = geomNow(p.key, p.state);
    if (!geom) {
      waitForGeometry(p.key, p.state);
      if (!mesh) continue;
    } else if (!mesh) {
      mesh = new THREE.Mesh(geom, MAT.prop);
      mesh.userData.id = p.id;
      propMeshes.set(p.id, mesh);
      scene.add(mesh);
    } else if (mesh.geometry !== geom) {
      mesh.geometry = geom;
    }
    // ids are reused (switching matches), so the prop under an id can change
    mesh.userData.key = p.key;
    place(mesh, p);
    mesh.material = materialFor(p.id);
  }
  for (const [id, mesh] of propMeshes) {
    if (!alive.has(id)) {
      scene.remove(mesh);
      propMeshes.delete(id);
    }
  }
  requestRender();
}

export function setHover(id) {
  if (id === hoverId) return;
  const old = hoverId;
  hoverId = id;
  for (const i of [old, id]) {
    const m = i != null && propMeshes.get(i);
    if (m) m.material = materialFor(i);
  }
  requestRender();
}

const _box = new THREE.Box3();
export function propBox(id) {
  const mesh = propMeshes.get(id);
  if (!mesh) return null;
  mesh.updateMatrixWorld();
  _box.setFromObject(mesh);
  return boxOf(_box);
}

// ---------------------------------------------------------------- ghosts

// items: [{ geom, x, y, z, rx?, ry?, rz? }]
export function setGhosts(items) {
  while (ghostMeshes.length < items.length) {
    const m = new THREE.Mesh(undefined, MAT.ghost);
    m.renderOrder = 10;
    ghostMeshes.push(m);
    scene.add(m);
  }
  ghostMeshes.forEach((m, i) => {
    const it = items[i];
    m.visible = !!it;
    if (!it) return;
    m.geometry = it.geom;
    place(m, { ...it, rx: it.rx || 0, ry: it.ry || 0, rz: it.rz || 0 });
  });
  requestRender();
}

// Physics placing: a dashed line from each raised ghost down to the spot below
// it, and a ring on that spot.
//   items: [{ x, y, bottom, land, r }] (ghost's lowest Z, landing Z, ring radius)
const dropGuides = [];
const guideLineMat = new THREE.LineDashedMaterial({ color: 0xd6f7ff, dashSize: 5, gapSize: 4, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false });
const guideRingMat = new THREE.MeshBasicMaterial({ color: 0x8be9ff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
const guideRingGeom = new THREE.RingGeometry(0.7, 1, 40);

export function setDropGuides(items) {
  while (dropGuides.length < items.length) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geom, guideLineMat);
    const ring = new THREE.Mesh(guideRingGeom, guideRingMat);
    line.renderOrder = ring.renderOrder = 11;
    line.frustumCulled = false;
    scene.add(line, ring);
    dropGuides.push({ line, ring });
  }
  dropGuides.forEach(({ line, ring }, i) => {
    const it = items[i];
    line.visible = ring.visible = !!it;
    if (!it) return;
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, it.x, it.y, it.bottom);
    pos.setXYZ(1, it.x, it.y, it.land);
    pos.needsUpdate = true;
    line.computeLineDistances();
    ring.position.set(it.x, it.y, it.land + 0.3);
    ring.scale.setScalar(it.r);
  });
  requestRender();
}

// ---------------------------------------------------------------- screenshots

// A picture of the view as it is, without the editing aids (handles, ghosts,
// drop guides, and the selection / hover / overlap colors), about longEdge
// pixels on its long side. Everything happens in one go, so the screen never
// shows the big frame. Resolves to a PNG Blob.
export function screenshot(longEdge = 2560) {
  const w = host.clientWidth, h = host.clientHeight;
  const k = Math.min(4, Math.max(1, longEdge / Math.max(w, h)));
  const W = Math.round(w * k), H = Math.round(h * k);
  const showHandles = G.hideForPicture();
  const aids = [...ghostMeshes, ...dropGuides.flatMap((g) => [g.line, g.ring])].filter((o) => o.visible);
  for (const o of aids) o.visible = false;
  for (const mesh of propMeshes.values()) mesh.material = look(mesh.userData.key, 'prop');
  const ratio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const png = new Promise((resolve, reject) => {
    renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('the picture could not be made'))), 'image/png');
  });
  renderer.setPixelRatio(ratio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  showHandles();
  for (const o of aids) o.visible = true;
  for (const [id, mesh] of propMeshes) mesh.material = materialFor(id);
  renderer.render(scene, camera);
  return png;
}

// ---------------------------------------------------------------- thumbnails

// Small 3D picture of some props (relative positions), as a data URL. Uses its
// own little renderer so the main view is never disturbed.
let thumbRenderer = null;
export function renderThumbnail(items, size = 192) {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setSize(size, size, false);
  }
  const s = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xe4e8ff, 0x2a2530, 1.6);
  hemi.position.set(0, 0, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(900, -1300, 2200);
  s.add(hemi, sun);
  const box = new THREE.Box3();
  for (const it of items) {
    const g = geomNow(it.key, it.state);
    if (!g) continue;
    const m = new THREE.Mesh(g, look(it.key, 'prop'));
    place(m, it);
    m.updateMatrixWorld();
    box.expandByObject(m);
    s.add(m);
  }
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 10);
  const cam = new THREE.PerspectiveCamera(35, 1, 1, 50000);
  cam.up.set(0, 0, 1);
  cam.position.copy(center).addScaledVector(new THREE.Vector3(0.35, -0.65, 1).normalize(), (radius / Math.sin(17.5 * DEG)) * 1.02);
  cam.lookAt(center);
  thumbRenderer.setClearColor(0x000000, 0);
  thumbRenderer.render(s, cam);
  return thumbRenderer.domElement.toDataURL('image/webp', 0.85);
}

// ---------------------------------------------------------------- gizmo

// Orientation of a prop as a quaternion (for Local-space handles).
export const quatOf = (rx, ry, rz) => rotationQuat(rx, ry, rz, new THREE.Quaternion());

// ---------------------------------------------------------------- picking / projection

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function setRay(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
}

export function pickProp(clientX, clientY) {
  setRay(clientX, clientY);
  scene.updateMatrixWorld();
  const hits = raycaster.intersectObjects([...propMeshes.values()], false);
  return hits.length ? hits[0].object.userData.id : null;
}

// The middle of the view in client coordinates (walk navigation's crosshair).
export function viewCenter() {
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// The camera ray through a screen point ({ origin, direction }, reused: read
// it right away).
export function mouseRay(clientX, clientY) {
  setRay(clientX, clientY);
  return raycaster.ray;
}

// First thing along a ray (origin, unit direction): the arena models that
// show, placed props, or else the ground (Z = 0). { dist, normal } with the
// normal turned to face back along the ray, or null.
export function castRay(origin, direction, far = 40000) {
  raycaster.set(origin, direction);
  raycaster.far = far;
  scene.updateMatrixWorld();
  const targets = [...Object.values(envMeshes).filter((m) => m.visible), ...propMeshes.values()];
  const hit = raycaster.intersectObjects(targets, false)[0];
  raycaster.far = Infinity;
  if (hit) {
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (normal.dot(direction) > 0) normal.negate();
    return { dist: hit.distance, normal };
  }
  const t = direction.z < -1e-6 ? -origin.z / direction.z : -1;
  return t > 0 && t < far ? { dist: t, normal: new THREE.Vector3(0, 0, 1) } : null;
}

// Intersect the mouse ray with the horizontal plane Z = z.
export function rayToPlaneZ(clientX, clientY, z) {
  setRay(clientX, clientY);
  const { origin: o, direction: d } = raycaster.ray;
  if (Math.abs(d.z) < 1e-6) return null;
  const t = (z - o.z) / d.z;
  if (t < 0) return null;
  return { x: o.x + d.x * t, y: o.y + d.y * t };
}

const _v = new THREE.Vector3();
export function projectToScreen(x, y, z) {
  camera.updateMatrixWorld();
  _v.set(x, y, z).project(camera);
  if (_v.z > 1) return null;
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (_v.x + 1) / 2 * r.width, y: r.top + (1 - _v.y) / 2 * r.height };
}

// ---------------------------------------------------------------- camera

function fitBox(box3) {
  const center = box3.getCenter(new THREE.Vector3());
  const radius = Math.max(box3.getSize(new THREE.Vector3()).length() / 2, 60);
  const dist = radius / Math.sin((camera.fov * DEG) / 2) * 0.9;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.update();
}

export function frameProps(ids) {
  const box = new THREE.Box3();
  for (const id of ids) {
    const m = propMeshes.get(id);
    if (m) box.expandByObject(m);
  }
  if (box.isEmpty()) {
    const ring = envMeshes.ringmat || envMeshes.barricade;
    if (!ring) return;
    box.setFromObject(ring);
  }
  fitBox(box);
}

// Showcase framing: the props and the ring (or the arena's own model) together,
// with a little room around them.
const SHOWCASE_TOP = 650; // cm, about a cage's height
export function frameScene() {
  const box = new THREE.Box3();
  for (const m of propMeshes.values()) box.expandByObject(m);
  // the arena models that show (the ring, a cage, the ambulance...), up to cage
  // height: the chamber's hanging cables reach 18 m
  for (const id of ['ringmat', ...Object.values(ENV_PIECE)]) {
    const m = envMeshes[id];
    if (!m?.visible) continue;
    const a = new THREE.Box3().setFromObject(m);
    a.max.z = Math.min(a.max.z, SHOWCASE_TOP);
    box.union(a);
  }
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.36);
  fitBox(new THREE.Box3(c.clone().sub(half), c.clone().add(half)));
}

export function viewTop() {
  const t = controls.target;
  const dist = Math.max(camera.position.distanceTo(t), 600);
  camera.position.set(t.x, t.y - dist * 0.001, t.z + dist);
  controls.update();
}

export function viewPerspective() {
  controls.target.set(0, 0, 106);
  camera.position.set(0, -1500, 950);
  controls.update();
}

// Screen "up" projected on the ground (falls back to the view direction when
// looking level).
function screenUpOnGround() {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  let fx = e[4], fy = e[5];
  if (Math.hypot(fx, fy) < 0.2) { fx = -e[8]; fy = -e[9]; }
  return [fx, fy];
}

// Horizontal view axes snapped to the nearest world axis, for arrow-key
// nudges: "up" moves away from the camera, "right" to its right.
export function viewAxes() {
  const [fx, fy] = screenUpOnGround();
  const forward = Math.abs(fx) >= Math.abs(fy) ? [Math.sign(fx), 0] : [0, Math.sign(fy)];
  return { forward, right: [forward[1], -forward[0]] };
}

// Screen "up" on the ground as a yaw angle (degrees, 0 = +Y, CCW).
export function viewYaw() {
  const [fx, fy] = screenUpOnGround();
  return (Math.atan2(-fx, fy) * 180) / Math.PI;
}
