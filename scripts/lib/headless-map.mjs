// Build the real map in Node, with no browser, no WebGL and no audio.
//
// `headless-three.mjs` resolves the bare 'three' specifier and stubs the canvas
// the procedural material library draws on. `buildMap()` needs a little more of
// the browser than that — but only a little, and none of it can move a vertex:
// a frame scheduler, a clock, a settings store, a media query, and the two
// shims GLTFLoader uses to decode an embedded image. Everything here is a
// no-op or a pure function.
//
// The point of this file is that a geometry audit which quietly fails to BUILD
// half the map reports a small number and looks like a pass. So the build is
// shared, and callers are handed the inventory to check against.
import { THREE, loadGameModule } from './headless-three.mjs';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
globalThis.performance ??= { now: () => 0 };
globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); },
};
globalThis.sessionStorage ??= globalThis.localStorage;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.fetch ??= () => Promise.reject(new Error('no network in a headless build'));
globalThis.devicePixelRatio ??= 1;
globalThis.ProgressEvent ??= class { constructor(type, o = {}) { Object.assign(this, o); this.type = type; } };
globalThis.createImageBitmap ??= async () => ({ width: 4, height: 4, close() {} });
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:headless';
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};

/**
 * Pin Math.random.
 *
 * `js/map-props.js` dresses from its own seeded PRNG, but map.js scatters a
 * little hand-placed dressing through `utils.rand()`, which is Math.random
 * underneath. Unseeded, a geometry measurement moves by a few hundredths every
 * run, and then no fix can be shown to have worked — the number has to be a
 * function of the source alone.
 */
export function seedRandom(seed = 0x13579BDF) {
  let s = seed;
  Math.random = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the map. Returns the scene, the map handle and a geometry inventory. */
export async function buildHeadlessMap({ mode = 'solo', seed } = {}) {
  seedRandom(seed);
  const { buildMap } = await loadGameModule('map.js');
  const scene = new THREE.Scene();
  const map = buildMap(scene, { mode });

  let meshes = 0, triangles = 0;
  const byName = new Map();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const pos = o.isMesh && o.geometry?.attributes?.position;
    if (!pos) return;
    meshes++;
    const n = (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
    triangles += n;
    const key = o.name || o.geometry.type;
    byName.set(key, (byName.get(key) || 0) + n);
  });

  return { THREE, scene, map, inventory: { meshes, triangles, byName } };
}
