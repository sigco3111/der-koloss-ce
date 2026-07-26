// Find z-fighting surfaces in built geometry, from the triangles themselves.
//
// `validate-coplanar-surfaces.mjs` checks the *data* that describes the map:
// door fits, wall skirts, ceiling slab spans. It cannot see inside a prop,
// because a prop is a hundred boxes merged by `Kit.finish()` into one mesh —
// the two faces that fight are triangles in the same buffer, with no seam in
// the source that a data check could name.
//
// This walks the real triangles instead. A pair is a defect when it is:
//
//   - parallel and facing the SAME way (n1 · n2 ≈ +1). Two faces that look
//     away from each other can never both be front-facing, so back-to-back
//     surfaces — a cabinet's top and the hood's underside — are not a fight;
//   - within `planeTol` of the same plane. The depth buffer has to separate
//     them, and at the map's near/far range it cannot below about a
//     millimetre;
//   - genuinely OVERLAPPING inside that plane, by more than `minArea`. Two
//     triangles of one quad share an edge and overlap by zero; two boxes butted
//     edge to edge likewise. Only real double coverage flickers.
//
// The overlap is computed exactly, by clipping one triangle against the other
// in the plane's own 2D basis, so the reported number is in square metres of
// screen-visible fighting surface and can be compared across fixes.
import { THREE } from './headless-three.mjs';

/** Convex-clip polygon `poly` against the half-plane left of edge a->b. */
function clipHalf(poly, ax, ay, bx, by) {
  const out = [];
  const ex = bx - ax, ey = by - ay;
  const side = (px, py) => (px - ax) * ey - (py - ay) * ex;
  for (let i = 0; i < poly.length; i += 2) {
    const cx = poly[i], cy = poly[i + 1];
    const j = (i + 2) % poly.length;
    const nx = poly[j], ny = poly[j + 1];
    const sc = side(cx, cy), sn = side(nx, ny);
    if (sc <= 0) out.push(cx, cy);
    if ((sc < 0 && sn > 0) || (sc > 0 && sn < 0)) {
      const t = sc / (sc - sn);
      out.push(cx + (nx - cx) * t, cy + (ny - cy) * t);
    }
  }
  return out;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(a) / 2;
}

/** Area shared by two 2D triangles, each [x0,y0,x1,y1,x2,y2]. */
function triOverlap(a, b) {
  // `clipHalf` keeps the side with a non-positive cross product, which is the
  // interior only for COUNTER-clockwise winding. Getting this backwards clips
  // every triangle against its own interior and silently reports no overlap
  // anywhere — an audit that always passes.
  const ccw = (t) => ((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]) < 0
    ? [t[0], t[1], t[4], t[5], t[2], t[3]] : [...t]);
  const A = ccw(a), B = ccw(b);
  let poly = A;
  for (let i = 0; i < 6 && poly.length; i += 2) {
    const j = (i + 2) % 6;
    poly = clipHalf(poly, B[i], B[i + 1], B[j], B[j + 1]);
  }
  return poly.length < 6 ? 0 : polyArea(poly);
}

/**
 * Collect every world-space triangle under `root`.
 * `label(mesh)` names the owner reported in findings.
 */
export function collectTriangles(root, label = (m) => m.name || m.uuid.slice(0, 6)) {
  root.updateMatrixWorld(true);
  const tris = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (o.userData?.skipCoplanarAudit) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const count = idx ? idx.count : pos.count;
    const owner = label(o);
    const doubleSided = o.material?.side === THREE.DoubleSide;
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      ab.subVectors(b, a); ac.subVectors(c, a);
      n.crossVectors(ab, ac);
      const len = n.length();
      if (len < 1e-12) continue;              // degenerate
      tris.push({
        __i: tris.length, owner, doubleSided,
        nx: n.x / len, ny: n.y / len, nz: n.z / len,
        ax: a.x, ay: a.y, az: a.z,
        bx: b.x, by: b.y, bz: b.z,
        cx: c.x, cy: c.y, cz: c.z,
        area: len / 2,
      });
    }
  });
  return tris;
}

/**
 * Pairs of same-facing triangles sharing a plane and overlapping within it.
 * Returns findings aggregated by owner pair, worst area first.
 */
export function findCoplanarOverlaps(tris, { planeTol = 0.0015, minArea = 1e-5 } = {}) {
  // Bucket by facing direction and signed plane distance. Two triangles that
  // fight must land in the same or an adjacent distance bucket, so the pair
  // test only ever runs on a handful of candidates.
  const cell = Math.max(planeTol * 2, 1e-4);
  const buckets = new Map();
  const key = (t, bin) => `${Math.round(t.nx * 100)},${Math.round(t.ny * 100)},${Math.round(t.nz * 100)},${bin}`;
  for (const t of tris) {
    t.d = t.nx * t.ax + t.ny * t.ay + t.nz * t.az;
    const bin = Math.round(t.d / cell);
    for (const nb of [bin - 1, bin, bin + 1]) {
      const k = key(t, nb);
      let arr = buckets.get(k);
      if (!arr) buckets.set(k, (arr = []));
      // only file into its own bin; neighbours are read, not written
      if (nb === bin) arr.push(t);
    }
  }

  const seen = new Set();
  const byPair = new Map();
  const scratchA = new Float64Array(6), scratchB = new Float64Array(6);

  for (const t of tris) {
    const bin = Math.round(t.d / cell);
    // pick the plane's 2D basis from its dominant axis
    const ax = Math.abs(t.nx), ay = Math.abs(t.ny), az = Math.abs(t.nz);
    const drop = ax > ay && ax > az ? 0 : (ay > az ? 1 : 2);
    const pick = (tri, o) => {
      const p = [tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz];
      for (let v = 0; v < 3; v++) {
        let w = 0;
        for (let k = 0; k < 3; k++) if (k !== drop) o[v * 2 + w++] = p[v * 3 + k];
      }
      return o;
    };
    for (const nb of [bin - 1, bin, bin + 1]) {
      const arr = buckets.get(key(t, nb));
      if (!arr) continue;
      for (const u of arr) {
        if (u === t) continue;
        const dot = t.nx * u.nx + t.ny * u.ny + t.nz * u.nz;
        if (dot < 0.9999) continue;                  // not same-facing & parallel
        if (Math.abs(t.d - u.d) > planeTol) continue;
        const pk = t.__i < u.__i ? `${t.__i}:${u.__i}` : `${u.__i}:${t.__i}`;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const overlap = triOverlap(pick(t, scratchA), pick(u, scratchB));
        if (overlap <= minArea) continue;
        const owners = [t.owner, u.owner].sort();
        // Key by plane as well as owner. One prop fights on several planes at
        // once and they are different defects with different fixes; merging
        // them into a single per-prop number hides which face to go and look at.
        const nrm = `${t.nx.toFixed(2)},${t.ny.toFixed(2)},${t.nz.toFixed(2)}`;
        const plane = `${nrm} @ ${t.d.toFixed(4)}`;
        const ok = `${owners[0]} ↔ ${owners[1]} | ${plane}`;
        let rec = byPair.get(ok);
        if (!rec) {
          byPair.set(ok, (rec = {
            owners: `${owners[0]} ↔ ${owners[1]}`, plane, normal: nrm,
            nx: t.nx, ny: t.ny, nz: t.nz, dist: t.d,
            area: 0, pairs: 0, gap: Math.abs(t.d - u.d),
            lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity],
          }));
        }
        rec.area += overlap;
        rec.pairs++;
        rec.gap = Math.min(rec.gap, Math.abs(t.d - u.d));
        for (const p of [[t.ax, t.ay, t.az], [t.bx, t.by, t.bz], [t.cx, t.cy, t.cz]]) {
          for (let k = 0; k < 3; k++) {
            if (p[k] < rec.lo[k]) rec.lo[k] = p[k];
            if (p[k] > rec.hi[k]) rec.hi[k] = p[k];
          }
        }
      }
    }
  }
  return [...byPair.values()].sort((x, y) => y.area - x.area);
}

/** Total square metres of fighting surface. */
export function totalOverlapArea(findings) {
  return findings.reduce((s, f) => s + f.area, 0);
}
