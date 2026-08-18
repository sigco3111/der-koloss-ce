// You must be able to shoot what you can see, and not shoot through what you can't.
//
// The bug this was written for: a zombie standing in the open void under either
// balcony staircase — the flights beside Juggernog and Double Tap — could be
// seen clearly and shot at all day, and no round ever registered.
//
// `stairFlightColliders` closes each flight with side "stringer" segments that
// stand 1.1m PROUD of the tread they guard and reach all the way down to y=0,
// so that a body on the flight is held on it at every height. That is the right
// shape for movement. It is not the shape of anything the player can see: these
// flights are drawn as eight bare tread plates with open sides, so most of that
// collider volume is empty air. `Game.wallDist` skipped only `noRaycast`, so
// every one of those invisible walls was full bullet cover.
//
// The fix splits the two roles. The scaffolding is `bulletPass` — physical for
// bodies, transparent to shots — and the visible tread plates carry their own
// `shootOk` (bullet-only) collider. This file pins both halves, because fixing
// only the first would let you shoot straight through a solid staircase.
import assert from 'node:assert/strict';
import { THREE, loadGameModule } from './lib/headless-three.mjs';

const { buildMap } = await loadGameModule('map.js');
const { segmentHitsBox } = await loadGameModule('utils.js');

const map = buildMap(new THREE.Scene());
for (const door of map.doors) if (!door.open) map.openDoor(door);

// Game.wallDist, verbatim in behaviour. If that filter and this one ever drift,
// this file is asserting on a raycast the game does not perform.
function wallDist(o, dir, maxDist = 60) {
  const x1 = o.x + dir.x * maxDist, z1 = o.z + dir.z * maxDist, y1 = o.y + dir.y * maxDist;
  let best = maxDist;
  for (const c of map.colliders) {
    if (c.noRaycast || c.bulletPass) continue;
    const t = segmentHitsBox(o.x, o.z, x1, z1, c);
    if (t < 0) continue;
    const yAt = o.y + (y1 - o.y) * t;
    const y0 = c.y0 || 0;
    if (yAt >= y0 && yAt <= y0 + (c.h || 3)) { const d = t * maxDist; if (d < best) best = d; }
  }
  return best;
}

function shot(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  const reach = wallDist(from, { x: dx / len, y: dy / len, z: dz / len });
  return { len, reach, blocked: reach < len - 0.05 };
}

// Both flights: treads x -13.175..-8.775 (mirrored for the garage), z -13.1..-10.9,
// climbing 2.9m in 8 steps. Tread i is a 0.36m plate centred at y 0.18 + 0.35i,
// so the void beneath the upper treads is open air a zombie can stand in.
const CASES = [
  // --- must reach: the open void under the flight, which is what was broken ---
  { want: 'clear', why: 'chest-high shot under the lab flight (Juggernog side)',
    from: { x: -10.5, y: 1.2, z: -16 }, to: { x: -10.5, y: 1.1, z: -12 } },
  { want: 'clear', why: 'chest-high shot under the garage flight (Double Tap side)',
    from: { x: 10.5, y: 1.2, z: -16 }, to: { x: 10.5, y: 1.1, z: -12 } },
  { want: 'clear', why: 'low shot across the lab void, near the high end',
    from: { x: -9.2, y: 0.9, z: -16 }, to: { x: -9.2, y: 0.8, z: -12 } },
  { want: 'clear', why: 'low shot across the garage void, near the high end',
    from: { x: 9.2, y: 0.9, z: -16 }, to: { x: 9.2, y: 0.8, z: -12 } },
  { want: 'clear', why: 'shot out of the lab void back toward the corridor',
    from: { x: -10.0, y: 1.0, z: -12 }, to: { x: -10.0, y: 1.2, z: -16 } },

  // --- must stop: the flight is still a solid object where you can see it ---
  { want: 'blocked', why: 'shot fired squarely into the face of a lab tread plate',
    from: { x: -10.7, y: 1.58, z: -16 }, to: { x: -10.7, y: 1.58, z: -12 } },
  { want: 'blocked', why: 'shot fired squarely into the face of a garage tread plate',
    from: { x: 10.7, y: 1.58, z: -16 }, to: { x: 10.7, y: 1.58, z: -12 } },
  { want: 'blocked', why: 'shot along the lab flight at deck height, through the treads',
    from: { x: -14.5, y: 2.6, z: -12 }, to: { x: -7.5, y: 2.6, z: -12 } },
  { want: 'blocked', why: 'shot along the garage flight at deck height, through the treads',
    from: { x: 14.5, y: 2.6, z: -12 }, to: { x: 7.5, y: 2.6, z: -12 } },
];

const failures = [];
for (const c of CASES) {
  const r = shot(c.from, c.to);
  const got = r.blocked ? 'blocked' : 'clear';
  if (got !== c.want) {
    failures.push(`${c.why}: expected ${c.want}, got ${got} `
      + `(target ${r.len.toFixed(2)}m away, first wall at ${r.reach.toFixed(2)}m)`);
  }
}

if (failures.length) {
  console.error(`✗ shot occlusion: ${failures.length}/${CASES.length} case(s) wrong`);
  for (const f of failures) console.error('   ' + f);
  process.exit(1);
}

// The two halves of the fix must both still be present. A flight whose
// scaffolding stopped being bulletPass would pass the "must stop" cases for the
// wrong reason, and silently re-break the void.
const scaffolding = map.colliders.filter((c) => c.oneWayPlatformSide && c.prop);
const permeable = scaffolding.filter((c) => c.bulletPass);
assert.ok(scaffolding.length > 0, 'no stair scaffolding found: this check is not looking at the flights');
assert.equal(permeable.length, scaffolding.length,
  `${scaffolding.length - permeable.length} of ${scaffolding.length} stair scaffolding colliders are still bullet cover`);

const treads = map.colliders.filter((c) => c.shootOk && c.minZ === -13.1 && c.maxZ === -10.9 && (c.h || 0) === 0.36);
assert.equal(treads.length, 16,
  `expected 16 bullet-only tread colliders (8 per balcony flight), found ${treads.length} — `
  + 'without them the visible staircase is shoot-through');

console.log(`✓ shot occlusion: ${CASES.length} stair cases correct, `
  + `${permeable.length} scaffolding colliders bullet-permeable, ${treads.length} tread plates bullet-solid`);
