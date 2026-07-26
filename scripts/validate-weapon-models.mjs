// Every weapon must be ONE solid object. No floating pieces.
//
// The bug this was written for: the Thompson's vertical foregrip — a wooden
// column plus five finger-groove rings — hung 22mm below the receiver with
// nothing joining it, and the rings were built in the wrong plane so they
// stood off it as separate slabs. On the asset-archive page, which presents
// the weapon alone against a flat background, that read as seven red-brown
// blocks floating in mid-air. It shipped because nothing ever checked that a
// weapon's parts actually touch each other.
//
// Nineteen other weapons had the same class of defect: front sights with no
// boss down to the barrel, bipods clamped to nothing, magazine floorplates and
// spine ribs positioned in the magazine's UNCURVED local space so they slid
// off the bottom of every banana mag, barrel groups that never reached their
// receiver.
//
// The check is purely geometric and needs no renderer: build every weapon,
// take the world-space AABB of every mesh, and union-find them together when
// they are within TOUCH metres of each other. A correct weapon collapses to a
// single component. Anything else is a part hanging in space.
//
// The headless Three.js harness — vendored-module resolution plus a canvas stub
// for the procedural material library — lives in lib/headless-three.mjs.
import assert from 'node:assert';
import { THREE, loadGameModule } from './lib/headless-three.mjs';

const {
  WEAPONS, buildViewmodel, buildDisplayWeapon, buildPapDisplayWeapon, buildMonkey,
} = await loadGameModule('weapons.js');

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// How close two SURFACES must be to count as touching. Generous enough that a
// bevelled edge or a lathe facet does not read as a gap, tight enough that a
// visible sliver of daylight still fails (2mm on a metre-long weapon presented
// at 0.95m is under two pixels).
const TOUCH = 0.002;

/** Axis-separation distance between two AABBs. 0 when they overlap. */
function gap(a, b) {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
  return Math.hypot(dx, dy, dz);
}

/**
 * Every visible mesh under `node`, in world space: AABB, vertices, triangles.
 *
 * Bounding boxes ALONE are not enough to decide whether two parts touch, and
 * trusting them is how the Wunderwaffe shipped with five glowing emitter beads
 * hanging 11mm off the ends of its prongs. The beads sat diagonally out from
 * thin tapered prongs; their boxes overlapped the prongs' boxes handsomely
 * while the surfaces never came near each other. Boxes are used only as a cheap
 * pre-filter now — the actual verdict is a surface-to-surface distance.
 */
function meshData(node) {
  node.updateMatrixWorld(true);
  const out = [];
  node.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const idx = o.geometry.getIndex();
    const verts = new Float64Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
    }
    const tri = idx ? Array.from(idx.array) : [...Array(pos.count).keys()];
    out.push({ mesh: o, box: new THREE.Box3().setFromObject(o), verts, tri });
  });
  return out;
}

/** Squared distance from point p to triangle abc. */
function pointTriSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const t = d1 / (d1 - d3);
          qx = ax + abx * t; qy = ay + aby * t; qz = az + abz * t;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6);
            qx = ax + acx * t; qy = ay + acy * t; qz = az + acz * t;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + (cx - bx) * t; qy = by + (cy - by) * t; qz = bz + (cz - bz) * t;
            } else {
              const den = 1 / (va + vb + vc);
              const v2 = vb * den, w2 = vc * den;
              qx = ax + abx * v2 + acx * w2;
              qy = ay + aby * v2 + acy * w2;
              qz = az + abz * v2 + acz * w2;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Does segment pq cross triangle abc? Möller–Trumbore, clamped to the segment.
 *
 * Proximity alone is not enough: parts here mostly INTERPENETRATE rather than
 * kiss. A Thompson cooling fin is a solid disc threaded onto the barrel — the
 * barrel's surface is buried inside the fin and neither has a vertex anywhere
 * near the other's skin, yet they are obviously one object. What always holds
 * for two interpenetrating closed solids is that an edge of one passes through
 * a face of the other.
 */
function segHitsTri(px, py, pz, qx, qy, qz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (det > -1e-12 && det < 1e-12) return false;         // parallel
  const inv = 1 / det;
  const sx = px - ax, sy = py - ay, sz = pz - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return false;
  const qqx = sy * e1z - sz * e1y, qqy = sz * e1x - sx * e1z, qqz = sx * e1y - sy * e1x;
  const v = (dx * qqx + dy * qqy + dz * qqz) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = (e2x * qqx + e2y * qqy + e2z * qqz) * inv;
  return t >= 0 && t <= 1;
}

/** Triangle indices of `m` whose own box comes within `near` of `region`. */
function trisNear(m, region, near) {
  const out = [];
  const tri = m.tri, v = m.verts;
  const lox = region.min.x - near, hix = region.max.x + near;
  const loy = region.min.y - near, hiy = region.max.y + near;
  const loz = region.min.z - near, hiz = region.max.z + near;
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const i0 = tri[t] * 3, i1 = tri[t + 1] * 3, i2 = tri[t + 2] * 3;
    const x0 = v[i0], x1 = v[i1], x2 = v[i2];
    if (Math.min(x0, x1, x2) > hix || Math.max(x0, x1, x2) < lox) continue;
    const y0 = v[i0 + 1], y1 = v[i1 + 1], y2 = v[i2 + 1];
    if (Math.min(y0, y1, y2) > hiy || Math.max(y0, y1, y2) < loy) continue;
    const z0 = v[i0 + 2], z1 = v[i1 + 2], z2 = v[i2 + 2];
    if (Math.min(z0, z1, z2) > hiz || Math.max(z0, z1, z2) < loz) continue;
    out.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
  }
  return out;
}

/** Is `inner`'s box swallowed by `outer`'s? */
function contains(outer, inner) {
  return outer.min.x <= inner.min.x && outer.max.x >= inner.max.x
    && outer.min.y <= inner.min.y && outer.max.y >= inner.max.y
    && outer.min.z <= inner.min.z && outer.max.z >= inner.max.z;
}

/**
 * Two meshes are attached when their surfaces come within TOUCH of each other
 * or when they interpenetrate. Only triangles inside the boxes' shared region
 * are ever compared, which keeps this fast enough to run over the whole roster.
 */
function touches(A, B) {
  if (gap(A.box, B.box) > TOUCH) return false;           // cheap reject
  // Detail swallowed whole by another part — a bore inside a barrel, a
  // floorplate inlet into a stock — is embedded, not floating, and its nearest
  // surface can be a long way from the surface that encloses it.
  if (contains(A.box, B.box) || contains(B.box, A.box)) return true;
  const region = A.box.clone().intersect(B.box);
  if (region.isEmpty()) region.copy(A.box).union(B.box); // boxes only near-miss
  const ta = trisNear(A, region, TOUCH);
  const tb = trisNear(B, region, TOUCH);
  if (!ta.length || !tb.length) return false;
  const nearSq = TOUCH * TOUCH;
  for (let i = 0; i < ta.length; i += 9) {
    for (let j = 0; j < tb.length; j += 9) {
      // proximity, both directions
      for (let k = 0; k < 9; k += 3) {
        if (pointTriSq(ta[i + k], ta[i + k + 1], ta[i + k + 2],
          tb[j], tb[j + 1], tb[j + 2], tb[j + 3], tb[j + 4], tb[j + 5],
          tb[j + 6], tb[j + 7], tb[j + 8]) <= nearSq) return true;
        if (pointTriSq(tb[j + k], tb[j + k + 1], tb[j + k + 2],
          ta[i], ta[i + 1], ta[i + 2], ta[i + 3], ta[i + 4], ta[i + 5],
          ta[i + 6], ta[i + 7], ta[i + 8]) <= nearSq) return true;
      }
      // interpenetration: an edge of one through a face of the other
      for (let k = 0; k < 9; k += 3) {
        const l = (k + 3) % 9;
        if (segHitsTri(ta[i + k], ta[i + k + 1], ta[i + k + 2], ta[i + l], ta[i + l + 1], ta[i + l + 2],
          tb[j], tb[j + 1], tb[j + 2], tb[j + 3], tb[j + 4], tb[j + 5],
          tb[j + 6], tb[j + 7], tb[j + 8])) return true;
        if (segHitsTri(tb[j + k], tb[j + k + 1], tb[j + k + 2], tb[j + l], tb[j + l + 1], tb[j + l + 2],
          ta[i], ta[i + 1], ta[i + 2], ta[i + 3], ta[i + 4], ta[i + 5],
          ta[i + 6], ta[i + 7], ta[i + 8])) return true;
      }
    }
  }
  return false;
}

/** Group meshes into islands of mutually touching parts. */
function islands(entries) {
  const n = entries.length;
  const parent = [...Array(n).keys()];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      if (!touches(entries[i], entries[j])) continue;
      parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Name of the registered part a mesh belongs to, for a useful failure message. */
function partOf(mesh, parts) {
  for (let o = mesh; o; o = o.parent) {
    for (const key in parts) if (parts[key] === o) return key;
  }
  return '(unregistered)';
}

/** Describe an island's detachment, or null when the model is solid. */
function detachmentReport(node, parts, label) {
  const entries = meshData(node);
  if (entries.length === 0) return `${label}: built nothing`;
  const groups = islands(entries);
  if (groups.length === 1) return null;
  const lines = [`${label}: ${groups.length} disconnected pieces (must be 1)`];
  groups.slice(1).forEach((g) => {
    let nearest = Infinity;
    let nearestName = '?';
    for (const i of g) {
      for (let j = 0; j < entries.length; j++) {
        if (g.includes(j)) continue;
        const d = gap(entries[i].box, entries[j].box);
        if (d < nearest) { nearest = d; nearestName = partOf(entries[j].mesh, parts); }
      }
    }
    const names = [...new Set(g.map((i) => partOf(entries[i].mesh, parts)))].join(', ');
    const c = new THREE.Box3();
    for (const i of g) c.union(entries[i].box);
    const ctr = c.getCenter(new THREE.Vector3());
    lines.push(`    floating: [${names}] — ${(nearest * 1000).toFixed(1)}mm of air to '${nearestName}'`
      + ` at (${ctr.x.toFixed(3)}, ${ctr.y.toFixed(3)}, ${ctr.z.toFixed(3)})`);
    // WEAPON_MODEL_DEBUG=1 prints the exact box of every offending mesh, which
    // is what you actually need to work out where to move it to.
    if (process.env.WEAPON_MODEL_DEBUG) {
      for (const i of g) {
        const b = entries[i].box;
        lines.push(`        ${partOf(entries[i].mesh, parts)} x[${b.min.x.toFixed(4)},${b.max.x.toFixed(4)}]`
          + ` y[${b.min.y.toFixed(4)},${b.max.y.toFixed(4)}] z[${b.min.z.toFixed(4)},${b.max.z.toFixed(4)}]`);
      }
    }
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 1. Every weapon is one solid object, stock and Pack-a-Punched
// ---------------------------------------------------------------------------
const failures = [];
const ids = Object.keys(WEAPONS);
assert.ok(ids.length > 20, 'the weapon roster should not be nearly empty');

for (const id of ids) {
  for (const pap of [false, true]) {
    const root3 = buildViewmodel(id, pap);
    const view = root3.userData.viewNode;
    assert.ok(view, `${id}: buildViewmodel must expose userData.viewNode`);
    const report = detachmentReport(view, root3.userData.parts || {}, `${id}${pap ? ' (PaP)' : ''}`);
    if (report) failures.push(report);
  }
}

// The melee/utility models go through the same builders and get the same rule.
{
  const monkey = buildMonkey();
  const report = detachmentReport(monkey, {}, 'monkey bomb');
  if (report) failures.push(report);
}

// ---------------------------------------------------------------------------
// 2. World displays present the weapon ALONE — no gloves, no sleeve
// ---------------------------------------------------------------------------
//
// buildViewmodel() keeps the hands in a detached container that only
// WeaponRig.equip() re-attaches. If a display builder ever ends up with them,
// the mystery box grows a pair of disembodied hands.
function handMeshCount(node) {
  let n = 0;
  node.traverse((o) => { if (o.isMesh && o.userData?.isGlove) n++; });
  return n;
}
for (const id of ids.slice(0, 6)) {
  for (const build of [() => buildDisplayWeapon(id), () => buildPapDisplayWeapon(id)]) {
    const g = build();
    assert.strictEqual(handMeshCount(g), 0, `${id}: world display must not contain glove meshes`);
    assert.strictEqual(g.userData.handsGroup, null, `${id}: world display must drop the hands container`);
  }
}

// A first-person view-model, by contrast, keeps its gloves in the detached
// container — never inside the weapon tree, where a world display would have to
// hunt them back out.
let gloved = 0;
for (const id of ids) {
  const g = buildViewmodel(id, false);
  const hands = g.userData.handsGroup;
  const parts = g.userData.parts || {};
  assert.ok(hands, `${id}: buildViewmodel must hand back a hands container`);
  assert.strictEqual(handMeshCount(g.userData.viewNode), 0,
    `${id}: gloves must not be inside the weapon tree`);
  for (const key of ['hand_l', 'hand_r']) {
    if (!parts[key]) continue;
    gloved++;
    assert.strictEqual(parts[key].parent, hands,
      `${id}: parts.${key} must be parented to the hands container`);
    assert.ok(handMeshCount(parts[key]) > 0, `${id}: parts.${key} must contain glove meshes`);
  }
}
assert.ok(gloved > 40, 'most weapons should still be held by a pair of gloved hands');

// ---------------------------------------------------------------------------
// 3. Nothing but a glove may be hidden by a "hands off" filter
// ---------------------------------------------------------------------------
//
// The asset archive used to hide every part whose NAME started with "hand",
// which silently deleted `handguard` and `handle` — the wooden forend and the
// carry handle — from fifteen weapons. Hands are identified by the glove flag,
// never by a name prefix, and this asserts the parts registry still contains
// names that a prefix test would eat, so the shortcut cannot creep back in
// unnoticed.
{
  const g = buildViewmodel('m1garand', false);
  const parts = g.userData.parts;
  assert.ok(parts.handguard, 'm1garand should still have a handguard part');
  assert.ok(handMeshCount(parts.hand_l) > 0 && handMeshCount(parts.hand_r) > 0,
    'gloves must be flagged with userData.isGlove so they can be found by kind, not by name');
  assert.strictEqual(handMeshCount(parts.handguard), 0,
    'a handguard is furniture, not flesh — it must never be flagged as a glove');
}

if (failures.length) {
  console.error(`\n${failures.length} weapon model(s) have parts floating in mid-air:\n`);
  console.error(failures.join('\n'));
  console.error('');
  throw new Error(`${failures.length} weapon model(s) have detached parts`);
}

console.log(`weapon models OK — ${ids.length} weapons, every part connected`);
