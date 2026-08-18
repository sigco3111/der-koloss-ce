// Reject geometry that puts two visible surfaces in the same plane — measured
// from the TRIANGLES, not from the data that describes them.
//
// `validate-coplanar-surfaces.mjs` is the data-level guard: door fits, wall
// skirts, ceiling slab spans, step nosings. It cannot see inside a prop, and it
// cannot see a placement bug, because a prop is a hundred boxes merged by
// `Kit.finish()` into one mesh and a placement bug is two correct props in one
// spot. Both of those shipped anyway, and both read to the player as "the map
// flickers while I am standing still":
//
//   - every crate in the map drew its rails TWICE, exactly co-located, because
//     the rail box is scaled equally in x and z and was placed at both ry and
//     ry + 90 degrees — which is the same box;
//   - every pallet stacked its five deck boards along the axis each board
//     already spans, instead of across the deck, so all five were coplanar;
//   - paired drums stood closer together than their rolling hoops are wide;
//   - the Pack-a-Punch core mass ran 0.125m past the plane its front skin
//     starts on, so the cabinet's side and top fought the skin's side and top;
//   - a door's jamb posts ran up BEHIND the lintel at the same depth;
//   - the room floor slabs were staggered by 0.4mm, which is under the depth
//     buffer's resolution past about 30m.
//
// So this file builds the real thing and measures it. A pair counts as a defect
// when the two faces are parallel, face the SAME way, sit within `planeTol` of
// one plane, and genuinely overlap inside it — see scripts/lib/coplanar-faces.mjs.
//
// Runs in ~8s. That is the price of an audit that needs real triangles.
import assert from 'node:assert/strict';
import { THREE } from './lib/headless-three.mjs';
import { buildHeadlessMap } from './lib/headless-map.mjs';
import { loadGameModule } from './lib/headless-three.mjs';
import { collectTriangles, findCoplanarOverlaps } from './lib/coplanar-faces.mjs';

// ---------------------------------------------------------------------------
// 0. The kernel has to be able to FIND a defect
// ---------------------------------------------------------------------------
// This matters more than anything below it. The first version of the overlap
// kernel clipped each triangle against its own interior — inverted winding —
// and therefore reported 0.0000 m² for every prop in the game, including one
// that had already been proven by hand to have 0.4m² of coplanar cabinet side.
// An audit that cannot fail is worse than no audit, so plant defects with known
// areas and require it to measure them.
{
  const quad = (name, w, h, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial());
    m.name = name; m.position.set(x, y, z); m.rotation.y = ry;
    return m;
  };
  const area = (...meshes) => {
    const g = new THREE.Group();
    for (const m of meshes) g.add(m);
    return findCoplanarOverlaps(collectTriangles(g)).reduce((s, f) => s + f.area, 0);
  };
  const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-6,
    `coplanar kernel: ${what} — expected ${want} m², measured ${got} m²`);

  near(area(quad('a', 1, 1, 0, 0, 0), quad('b', 1, 1, 0, 0, 0)), 1,
    'two identical coplanar quads must measure as a full overlap');
  near(area(quad('a', 1, 1, 0, 0, 0), quad('b', 1, 1, 0.5, 0, 0)), 0.5,
    'a half-offset pair must measure half');
  near(area(quad('a', 1, 1, 0, 0, 0), quad('b', 1, 1, 0.5, 0.5, 0)), 0.25,
    'an offset in both axes must multiply');
  near(area(quad('a', 1, 1, 0, 0, 0), quad('b', 1, 1, 1, 0, 0)), 0,
    'quads butted edge to edge share no area and must not be reported');
  near(area(quad('a', 1, 1, 0, 0, 0), quad('b', 1, 1, 0, 0, 0.0005)), 1,
    'half a millimetre of separation is still one plane to the depth buffer');
  near(area(quad('a', 1, 1, 0, 0, 0), quad('b', 1, 1, 0, 0, 0.005)), 0,
    '5mm of separation must NOT be reported, or every fix looks like a failure');
  near(area(quad('a', 1, 1, 0, 0, 0), quad('b', 1, 1, 0, 0, 0, Math.PI)), 0,
    'back-to-back faces can never both be front-facing and must not be reported');
}

/**
 * Downward-facing surfaces lying on a floor are a prop's underside resting on
 * the ground. They are never rasterised against anything and cannot flicker;
 * counted, they trebled the map's total and buried the real defects.
 */
const buriedOn = (levels) => (f) =>
  f.ny < -0.99 && levels.some((l) => Math.abs(-f.dist - l) < 0.0015);

const visibleArea = (findings, isBuried) =>
  findings.filter((f) => !isBuried(f)).reduce((s, f) => s + f.area, 0);

// ---------------------------------------------------------------------------
// 1. The hero props, each built on its own
// ---------------------------------------------------------------------------
// These are the machines the player walks up to and stares at from half a metre
// away, so they get the strict budget: essentially nothing.
const layout = await loadGameModule('map-layout.js');
const [pap, perk, box, power, tele, door] = await Promise.all([
  loadGameModule('props', 'packAPunch.js'),
  loadGameModule('props', 'perkMachine.js'),
  loadGameModule('props', 'mysteryBox.js'),
  loadGameModule('props', 'powerSwitch.js'),
  loadGameModule('props', 'teleporter.js'),
  loadGameModule('props', 'door.js'),
]);

const PROP_BUDGET = 0.002;   // m² per prop
const onGround = buriedOn([0]);
const props = [
  ['packAPunch', () => pap.buildPackAPunch()],
  ['papSignFrame', () => pap.buildPapSignFrame(2.2, 0.4)],
  ['mysteryBox', () => box.buildMysteryBox()],
  ['powerSwitch', () => power.buildPowerSwitch()],
  ['doorLeaf', () => door.buildDoorLeaf(1.9, 1000)],
  ['doorFrame', () => door.buildDoorFrame(1.9, true)],
  ['doorLamp', () => door.buildDoorLamp()],
  ...layout.MAP_PERKS.map((pd) => [`perk:${pd.id}`, () => perk.buildPerkMachine(pd, { displayPrice: 2500 })]),
  ...layout.MAP_TELEPORTERS.map((td) => [`tele:${td.id}`, () => tele.buildTeleporter(td, null)]),
];

const propReport = [];
for (const [name, build] of props) {
  const built = build();
  const root = built?.group ?? built;
  assert.ok(root && root.isObject3D, `${name} did not build`);
  const tris = collectTriangles(root, (m) => m.name || 'mesh');
  assert.ok(tris.length > 50, `${name} built only ${tris.length} triangles — it did not really build`);
  const area = visibleArea(findCoplanarOverlaps(tris), onGround);
  propReport.push(`${name} ${area.toFixed(4)}`);
  assert.ok(area <= PROP_BUDGET,
    `${name} has ${area.toFixed(4)} m² of coplanar same-facing surface (budget ${PROP_BUDGET} m²).\n`
    + '  Two faces in one plane have no depth-buffer winner and the seam crawls.\n'
    + '  Usual causes: a frame whose jambs are given the full height instead of the\n'
    + '  clear span between head and sill, so every corner is lapped twice; a member\n'
    + '  run past a joint at the same depth as the member it meets; or two plates\n'
    + '  laid on one skin at the same nominal depth. Cut the hidden overlap so the\n'
    + '  members BUTT, or overrun one so its end cap is buried inside the other.');
}

// ---------------------------------------------------------------------------
// 2. The whole map
// ---------------------------------------------------------------------------
const { scene, map, inventory } = await buildHeadlessMap();

// A build that silently drops half the map would measure clean. Fail loudly
// instead: these floors are far below the real figures and only catch collapse.
assert.ok(inventory.meshes > 500,
  `only ${inventory.meshes} meshes built — the audit would be measuring a fraction of the map`);
assert.ok(inventory.triangles > 150000,
  `only ${inventory.triangles} triangles built — the audit would be measuring a fraction of the map`);

// Undersides resting on an ELEVATED floor are just as invisible as ones on the
// ground, and the map has plenty: the Chemical Testing teleporter alone sits on
// a deck 2.9m up. Take the levels from the map instead of assuming y = 0.
const floorLevels = [0, ...(map.floorZones || []).map((z) => z.y)].filter(Number.isFinite);
const mapFindings = findCoplanarOverlaps(collectTriangles(scene));
const mapArea = visibleArea(mapFindings, buriedOn(floorLevels));

// The budget ratchets: it is the measured figure plus a little headroom, so a
// new defect fails the build but an honest improvement never does. Lower it
// whenever the measurement drops — that is the point of it being a number.
//
// What is still inside it, deliberately, is the tops of the tall wall runs
// where two runs cross at a corner and cap at the same height (y = 4.5 and
// y = 6.1, above the 3m ceilings). Those are in `wallRun` in js/map.js, which
// `validate-wall-overlaps.mjs` and `validate-coplanar-surfaces.mjs` already
// constrain from the layout data; they are left for a change that can be made
// against those guards rather than around them.
// Measured 187.7 m² before this pass, 6.08 m² after.
const MAP_BUDGET = 6.5;   // m² of same-facing coplanar overlap, whole map
assert.ok(mapArea <= MAP_BUDGET,
  `the map has ${mapArea.toFixed(3)} m² of coplanar same-facing surface (budget ${MAP_BUDGET} m²).\n`
  + `  Worst offenders:\n`
  + mapFindings.filter((f) => !buriedOn(floorLevels)(f)).slice(0, 8).map((f) =>
    `    ${f.area.toFixed(3)} m²  ${f.owners}  plane ${f.plane}  gap ${f.gap.toFixed(5)}m\n`
    + `        at [${f.lo.map((v) => v.toFixed(2)).join(', ')}] .. [${f.hi.map((v) => v.toFixed(2)).join(', ')}]`).join('\n')
  + '\n  Two faces in one plane have no depth-buffer winner, so the seam crawls as the\n'
  + '  camera moves — and the camera always moves, because the rig breathes. Look for\n'
  + '  a prop placed inside another prop, a member run past the joint it meets, or a\n'
  + '  repeated part placed twice in the same spot.');

console.log(
  `coplanar geometry OK (${props.length} props, all <= ${PROP_BUDGET} m²; `
  + `map ${mapArea.toFixed(3)}/${MAP_BUDGET} m² over ${inventory.triangles} triangles in ${inventory.meshes} meshes)`,
);
