// Prove that enemies can actually traverse this map.
//
// The bug this guards against is the one players report as "the zombies get
// stuck on nothing": an enemy walks into a crate, a machine, or the side of a
// balcony stair flight and grinds against it forever, because the only routing
// the AI had was a room-to-room graph that said nothing whatsoever about what
// stands INSIDE a room. Nothing caught it, because every existing map check
// asserts on topology — which rooms connect to which — and topology was never
// the broken part.
//
// So this file asserts on the navigation grid itself, built from the real map:
// real colliders, real floorY, real props, real doors. It is not a source-text
// check. If a prop is ever placed somewhere that seals a route, or a stair
// flight's stringers are ever widened past the lane beside them, or the grid's
// cell size is raised until a doorway stops fitting, one of these fails.
import assert from 'node:assert/strict';
import { THREE, loadGameModule } from './lib/headless-three.mjs';

const { buildMap } = await loadGameModule('map.js');
const { NavGrid, getNavGrid, NAV_CELL, NAV_RADIUS } = await loadGameModule('navmesh.js');

const map = buildMap(new THREE.Scene());
// Every door bought: the state a late round is played in, and the state with the
// most routes to get wrong.
for (const door of map.doors) if (!door.open) map.openDoor(door);

const t0 = Date.now();
const nav = new NavGrid(map);
const buildMs = Date.now() - t0;

// ---------------------------------------------------------------------------
// 1. The grid has to be cheap enough to build during map load.
// ---------------------------------------------------------------------------
assert.ok(buildMs < 400, `navigation build took ${buildMs}ms; it runs at map load`);

// ---------------------------------------------------------------------------
// 2. A body must fit through the tightest legitimate opening.
//
// Doorways are 1.9m and boarded windows 1.6m. With a 0.3m body radius a cell
// centre has to sit 0.3m clear of both jambs, which leaves 1.0m of usable lane
// at a window — so the cell size can never approach that without silently
// sealing every window on the map.
// ---------------------------------------------------------------------------
assert.ok(NAV_CELL < 1.0 - 2 * NAV_RADIUS + 0.6,
  `cell ${NAV_CELL} is too coarse for a ${NAV_RADIUS} body in a 1.6m window`);

// ---------------------------------------------------------------------------
// 3. Connectivity. Every place a player can stand and every place an enemy can
//    enter the map has to be mutually reachable across the walkable graph.
// ---------------------------------------------------------------------------
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const MAX_LEVELS = 3;

function flood(fromNode) {
  const seen = new Set([fromNode]);
  const stack = [fromNode];
  while (stack.length) {
    const node = stack.pop();
    const col = (node / MAX_LEVELS) | 0;
    const i = col % nav.cols, j = (col / nav.cols) | 0;
    for (let d = 0; d < 8; d++) {
      const level = nav.link[node * 8 + d];
      if (level === 255) continue;
      const next = ((j + DIRS[d][1]) * nav.cols + (i + DIRS[d][0])) * MAX_LEVELS + level;
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return seen;
}

// Somewhere central and unambiguous to measure the connected world from.
const hub = nav.nearestNode(0, -32, 0);            // the courtyard
assert.ok(hub >= 0, 'the courtyard must be walkable');
const reachable = flood(hub);

// Every room an enemy or a player occupies, sampled at the height it is used at.
const PLACES = [
  ['courtyard', 0, -32, 0], ['factory floor', 0, -52, 0],
  ['left corridor', -10, 0, 0], ['garage entrance', 10, 0, 0],
  ['animal lab', -22, -13, 0], ['generator room', -38, -13, 0],
  ['auto garage', 23, -13, 0], ['mainframe deck', 0, 16, 0.9],
  ['lab balcony', -10, -18, 2.9], ['garage balcony', 10, -18, 2.9],
  ['chemical testing', 17, -30, 2.9], ['bridge', 0, -12, 2.9],
  ['catwalk west', -6, -52, 3.1], ['catwalk east', 10, -52, 3.1],
];
for (const [name, x, z, y] of PLACES) {
  const node = nav.nearestNode(x, z, y);
  assert.ok(node >= 0, `${name} has no walkable navigation cell at all`);
  assert.ok(reachable.has(node), `${name} is walkable but unreachable — enemies can never get there`);
}

// Enemy entry points. For a boarded window the point that matters is where the
// climb DEPOSITS the body — one step inside the room. The alcove it spawns in is
// a deliberately walled brick shaft on the outside of the map and is supposed to
// be unwalkable, so asserting on that would be asserting the map is broken.
// See the CLIMB case in js/zombies.js for where this offset comes from.
for (const b of map.barriers) {
  const x = b.x + b.nx * 0.7, z = b.z + b.nz * 0.7;
  const node = nav.nearestNode(x, z, 0);
  assert.ok(node >= 0 && reachable.has(node),
    `window in ${b.room} drops climbers at (${x.toFixed(1)}, ${z.toFixed(1)}), which is unreachable`);
}
for (const r of map.risers) {
  const node = nav.nearestNode(r.x, r.z, r.y ?? 0);
  assert.ok(node >= 0 && reachable.has(node),
    `riser in ${r.room} at (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) is sealed off`);
}

// ---------------------------------------------------------------------------
// 4. Real routes, end to end. A route that stops short is the failure mode the
//    player actually experiences, so assert on ARRIVAL, never on "returned
//    something". Every pair here is one an enemy has to solve during a round.
// ---------------------------------------------------------------------------
function route(label, from, to) {
  const path = nav.findPath(from[0], from[1], from[2], to[0], to[1], to[2]);
  assert.ok(path && path.length, `${label}: no route at all`);
  const end = path[path.length - 1];
  const miss = Math.hypot(end.x - to[0], end.z - to[2]);
  assert.ok(miss < 1.6 && Math.abs(end.y - to[1]) < 0.6,
    `${label}: route stops ${miss.toFixed(1)}m short at (${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)})`);
  return path;
}

// The reported case, and the reason this file exists. The balcony stair flight
// is a solid 4.4 x 2.6m block standing in an 8m corridor as far as an enemy is
// concerned — only the PLAYER honours its one-way stringers. An enemy on the far
// side of it has to walk around, and used to walk into it instead.
for (const [label, sign] of [['lab', -1], ['garage', 1]]) {
  const x = 10 * sign;
  route(`past the ${label} stair flight`, [x * 1.1, 0, -16], [x * 1.1, 0, -4]);
  route(`across the ${label} stair flight`, [x * 1.35, 0, -12], [x * 0.7, 0, -12]);
}

// Every upper deck has to be gained by its real flight, from the floor below.
route('corridor -> lab balcony', [-10, 0, -4], [-10, 2.9, -18]);
route('garage -> garage balcony', [10, 0, -4], [10, 2.9, -18]);
route('garage -> chemical testing', [20, 0, -12], [17, 2.9, -30]);
route('factory -> catwalk', [0, 0, -58], [6, 3.1, -52]);

// Full-map hauls, which is what a straggler at the far spawn has to solve.
route('factory -> mainframe', [0, 0, -58], [0, 0.9, 16]);
route('catwalk -> mainframe', [6, 3.1, -52], [0, 0.9, 16]);
route('generator room -> auto garage', [-38, 0, -13], [23, 0, -13]);
route('lab balcony -> factory', [-10, 2.9, -18], [0, 0, -58]);

// ---------------------------------------------------------------------------
// 5. A route may not cheat. Enemies climb stairs and step off ledges; they do
//    not levitate onto a balcony or fall down a shaft the map never authored.
// ---------------------------------------------------------------------------
const climb = route('corridor -> lab balcony', [-10, 0, -4], [-10, 2.9, -18]);
let prevY = 0;
for (const wp of climb) {
  const rise = wp.y - prevY;
  assert.ok(rise <= 1.56, `route climbs ${rise.toFixed(2)}m in one hop — enemies cannot do that`);
  assert.ok(rise >= -3.45, `route drops ${(-rise).toFixed(2)}m in one hop — that is a pit, not a ledge`);
  prevY = wp.y;
}

// ---------------------------------------------------------------------------
// 6. Cost. Pathing runs inside the frame budget with a full wave alive.
// ---------------------------------------------------------------------------
const player = [0, 0.9, 16];
let worst = 0;
for (const r of map.risers) {
  const t = process.hrtime.bigint();
  nav.findPath(r.x, r.y ?? 0, r.z, player[0], player[1], player[2]);
  worst = Math.max(worst, Number(process.hrtime.bigint() - t) / 1e6);
}
assert.ok(worst < 12, `worst single search ${worst.toFixed(1)}ms is too slow for a frame`);

// ---------------------------------------------------------------------------
// 7. Opening a door has to re-derive the grid. A door's collider is spliced out
//    of the map when it is bought, and a navigation grid that kept routing
//    around it would leave the horde taking the long way round for the rest of
//    the match — or refusing to come at all.
// ---------------------------------------------------------------------------
{
  const fresh = buildMap(new THREE.Scene());
  // getNavGrid, not `new NavGrid`: invalidation is routed through the registry
  // that maps a map instance to its grid, which is exactly the wiring under test.
  const grid = getNavGrid(fresh);
  const shut = fresh.doors.find((d) => !d.open);
  assert.ok(shut, 'the map must start with at least one closed door');
  const y = shut.y || 0;
  assert.equal(grid.nodeAt(shut.x, shut.z, y), -1,
    `${shut.id}: its threshold is walkable while the door is still shut`);
  fresh.openDoor(shut);
  assert.ok(grid.nodeAt(shut.x, shut.z, y) >= 0,
    `${shut.id}: its threshold is still unwalkable after opening — navInvalidate did not run, `
    + 'so the horde would keep routing around a wall that no longer exists');
}

// ---------------------------------------------------------------------------
// 8. The one that actually matters: drive the real AI and require enemies to
//    ARRIVE UNDER THEIR OWN POWER.
//
//    This is the assertion the whole file is built around. Every previous check
//    proves a route exists; this one proves a body can walk it. And it forbids
//    the teleport failsafe from firing, because that failsafe is precisely what
//    hid this bug for so long: enemies wedged against a crate or the side of a
//    stair flight were quietly relocated next to the player, so the horde still
//    "arrived" and nothing ever looked broken from the outside. Fifteen of
//    twenty-five bodies needed that rescue before this rework. If it ever fires
//    here again, routing has regressed no matter what the reachability checks
//    above say.
// ---------------------------------------------------------------------------
{
  const { ZombieManager, ZSTATES } = await loadGameModule('zombies.js');
  const player = { id: 1, x: -10, y: 0, z: -4, down: false, dead: false };
  // The far corners, plus both sides of a balcony stair flight — the geometry
  // from the original report.
  const STARTS = [
    ['factory floor', 0, -52], ['catwalk stair foot', -12, -52],
    ['generator room', -38, -13], ['auto garage', 28, -13],
    ['north of the lab flight', -10, -16], ['north of the garage flight', 10, -16],
  ];
  for (const [label, sx, sz] of STARTS) {
    for (const dog of [false, true]) {
      const zm = new ZombieManager(new THREE.Scene(), map, {}, true);
      const y = map.floorY(sx, sz, 0);
      const body = {
        id: 1, dog, x: sx, y, z: sz, yaw: 0, hp: 100, maxHp: 100,
        state: ZSTATES.CHASE, stateT: 0, riseT: 1, speed: dog ? 6.4 : 1.1,
        targetId: null, retarget: 0, navPath: null, navIdx: 0, repath: 0, slideSide: 0,
        attackT: 0, hitApplied: false, anim: 0, barrier: null, deadT: 0,
        model: new THREE.Group(), visual: null, crawler: false, stepT: 0,
        lastX: sx, lastZ: sz, lastY: y, repoT: 0, stuckT: 0, age: 0,
        nearT: 0, lastD: 1e9, groanT: 1e9, riseFloor: y, settleT: 0,
      };
      zm.zombies.set(1, body);
      let rescued = 0;
      zm.respawnNear = () => { rescued++; };          // refuse the cheat outright
      let arrived = 0;
      for (let step = 0; step < 60 * 75 && !arrived; step++) {
        zm._pathBudget = 8;
        zm.stepZombie(body, 1 / 60, [player]);
        if (Math.hypot(body.x - player.x, body.z - player.z) < 2.0) arrived = step / 60;
      }
      const who = dog ? 'hellhound' : 'shambler';
      assert.ok(arrived, `${who} from ${label} never reached the player — `
        + `gave up at (${body.x.toFixed(1)}, ${body.y.toFixed(1)}, ${body.z.toFixed(1)})`);
      assert.equal(rescued, 0, `${who} from ${label} only arrived because the teleport `
        + 'failsafe rescued it; it could not navigate there on its own');
    }
  }

  // Climbing to a target on an upper deck, walked rather than merely planned.
  //
  // Checking that a ROUTE to the catwalk exists is not the same as checking a
  // body can walk it, and the difference hid a real bug: waypoint arrival was
  // tested in x/z only, so an enemy on the factory floor UNDER the stair flight
  // was within a waypoint radius of every step above it, swallowed the whole
  // climb without gaining a centimetre, and oscillated at the foot of the stairs
  // indefinitely. Every route assertion above still passed while that was true.
  // Assert on the height actually gained.
  for (const [label, tx, ty, tz, sx, sz] of [
    ['catwalk', 6, 3.1, -52, 0, -58],
    ['lab balcony', -10, 2.9, -18, -10, -4],
    ['chemical testing', 17, 2.9, -30, 20, -12],
  ]) {
    for (const dog of [false, true]) {
      const zm = new ZombieManager(new THREE.Scene(), map, {}, true);
      const player = { id: 1, x: tx, y: ty, z: tz, down: false, dead: false };
      const y = map.floorY(sx, sz, 0);
      const body = {
        id: 1, dog, x: sx, y, z: sz, yaw: 0, hp: 100, maxHp: 100,
        state: ZSTATES.CHASE, stateT: 0, riseT: 1, speed: dog ? 6.4 : 1.4,
        targetId: null, retarget: 0, navPath: null, navIdx: 0, repath: 0, slideSide: 0,
        attackT: 0, hitApplied: false, anim: 0, barrier: null, deadT: 0,
        model: new THREE.Group(), visual: null, crawler: false, stepT: 0,
        lastX: sx, lastZ: sz, lastY: y, repoT: 0, stuckT: 0, age: 0,
        nearT: 0, lastD: 1e9, groanT: 1e9, riseFloor: y, settleT: 0,
      };
      zm.zombies.set(1, body);
      let rescued = 0;
      zm.respawnNear = () => { rescued++; };
      let arrived = 0;
      for (let step = 0; step < 60 * 75 && !arrived; step++) {
        zm._pathBudget = 8;
        zm.stepZombie(body, 1 / 60, [player]);
        if (Math.hypot(body.x - tx, body.z - tz) < 2.2 && Math.abs(body.y - ty) < 1.0) {
          arrived = step / 60;
        }
      }
      const who = dog ? 'hellhound' : 'shambler';
      assert.ok(arrived, `${who} never climbed to the ${label}: it stopped at `
        + `(${body.x.toFixed(1)}, ${body.y.toFixed(2)}, ${body.z.toFixed(1)}) and the deck is at y=${ty}`);
      assert.equal(rescued, 0, `${who} only reached the ${label} via the teleport failsafe`);
    }
  }
}

console.log(`enemy navigation OK: ${nav.cols}x${nav.rows} grid built in ${buildMs}ms, `
  + `${reachable.size} connected cells, worst search ${worst.toFixed(1)}ms, `
  + `${PLACES.length} areas and ${map.barriers.length} windows all reachable`);
