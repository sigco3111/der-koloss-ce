// Build the game's Three.js models in Node, with no browser and no renderer.
//
// js/weapons.js imports the bare specifier 'three', which Node cannot resolve
// (there is no node_modules — Three is vendored and wired up by the page's
// import map). A resolve hook maps it to the vendored module, and a minimal
// canvas stub stands in for the DOM that the procedural material library draws
// its textures on. Neither needs a browser: validators built on this only ever
// look at transforms and geometry.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const threeURL = pathToFileURL(join(repoRoot, 'vendor', 'three.module.js')).href;

// Resolve 'three' the way the browser's import map does.
register(`data:text/javascript,
  const THREE_URL = ${JSON.stringify(threeURL)};
  export function resolve(spec, ctx, next) {
    if (spec === 'three') return { url: THREE_URL, shortCircuit: true };
    return next(spec, ctx);
  }
`);

// ---------------------------------------------------------------------------
// Headless canvas. The weapon material library generates every map procedurally
// on a 2D context; none of it affects geometry, so no-ops are enough.
// ---------------------------------------------------------------------------
function stubContext() {
  const noop = () => {};
  return {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'left', textBaseline: 'alphabetic', lineCap: 'butt',
    lineJoin: 'miter', filter: 'none', shadowBlur: 0, shadowColor: '#000',
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    transform: noop, setTransform: noop, resetTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop,
    arcTo: noop, ellipse: noop, rect: noop, quadraticCurveTo: noop,
    bezierCurveTo: noop, fill: noop, stroke: noop, clip: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop,
    fillText: noop, strokeText: noop, drawImage: noop,
    setLineDash: noop, getLineDash: () => [],
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
  };
}
function stubCanvas() {
  const c = { width: 300, height: 150, style: {} };
  let ctx = null;
  c.getContext = () => (ctx ??= stubContext());
  c.toDataURL = () => 'data:,';
  return c;
}
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? stubCanvas() : { style: {}, appendChild() {}, setAttribute() {} }),
  createElementNS: () => stubCanvas(),
  body: { appendChild() {} },
};
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.navigator ??= { userAgent: 'node' };
globalThis.OffscreenCanvas = function (w, h) { const c = stubCanvas(); c.width = w; c.height = h; return c; };

export const THREE = await import('three');

/** Import a module from js/ with 'three' resolved and the DOM stubbed. */
export function loadGameModule(...parts) {
  return import(pathToFileURL(join(repoRoot, 'js', ...parts)).href);
}
