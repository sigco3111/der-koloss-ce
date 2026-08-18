// A boarded window's alcove is a brick shaft, and brick has to stop a body.
//
// Every barrier gets a three-panel enclosure so the window does not read as a
// black void (see addBarrier in js/map.js). Sixteen of the seventeen hang off
// the OUTSIDE of the map shell where no player can ever touch them, which is
// why they shipped for so long with visible brickwork and no collider behind
// it. The two on `animal_west` are the exception: that run separates two
// PLAYABLE rooms, so its windows face the Animal Lab and its alcoves stand
// 2.8m out into the Generator Room, either side of Teleporter A's door. They
// looked like two free-standing brick boxes, and you could sprint through both.
//
// Asserted behaviourally, against the real colliders and the real movement
// integrator, because the shape of the source is not the thing that was wrong.
import assert from 'node:assert';
import { THREE, loadGameModule } from './lib/headless-three.mjs';

const { buildMap } = await loadGameModule('map.js');
const { CFG } = await loadGameModule('config.js');
const { moveCircleWithColliders } = await loadGameModule('utils.js');
const { NAV_RADIUS } = await loadGameModule('navmesh.js');

const map = buildMap(new THREE.Scene());
// Every purchasable door bought: the Generator Room alcoves are only reachable
// once d_gen is open, which is exactly the state the bug was reported in.
for (const d of map.doors) if (!d.open) map.openDoor(d);

// The player's own collider filter, at standing height. See Player._activeMapColliders.
const solidToPlayer = map.colliders.filter((c) => !c.shootOk && !c.vault
  && !(c.y0 !== undefined && (c.y0 > CFG.PLAYER_HEIGHT || c.y0 + c.h < 0.02)));

const HALF = 1.24;          // pocket interior half-extent (1.3 centre - 0.06 panel)
const through = [];
const stranded = [];

for (const b of map.barriers) {
  const ax = b.alcove.x, az = b.alcove.z;
  // The three sealed sides are everything except the window the barrier is in.
  // Approach each from 4m out, as one hitched lunge and then a sprint, and
  // check the body never ends up inside the pocket.
  const sides = b.nx
    ? [[-b.nx, 0], [0, 1], [0, -1]]      // vertical run: back panel + two cheeks
    : [[0, -b.nz], [1, 0], [-1, 0]];
  for (const [dx, dz] of sides) {
    for (const lateral of [-0.9, 0, 0.9]) {
      const sx = ax - dx * 4 - dz * lateral;
      const sz = az - dz * 4 - dx * lateral;
      let [x, z] = moveCircleWithColliders(sx, sz, dx * 6, dz * 6, CFG.PLAYER_RADIUS, solidToPlayer);
      for (let i = 0; i < 10; i++) {
        [x, z] = moveCircleWithColliders(x, z, dx * 0.12, dz * 0.12, CFG.PLAYER_RADIUS, solidToPlayer);
      }
      if (Math.abs(x - ax) < HALF && Math.abs(z - az) < HALF) {
        through.push(`barrier ${b.id} (${b.room}) at (${b.x}, ${b.z}): entered its alcove from (${dx}, ${dz})`);
      }
    }
  }

  // ...and sealing the pocket must not wall its occupant in. A zombie spawns at
  // the alcove centre in APPROACH and walks the 1.5m to the barrier before it
  // starts tearing; only the climb through the frame is scripted.
  const [zx, zz] = moveCircleWithColliders(ax, az, b.nx * 1.5, b.nz * 1.5, NAV_RADIUS,
    // A zombie working a barrier ignores the window panel it is standing in.
    solidToPlayer.filter((c) => !c.window && !c.playerOnly));
  if (Math.hypot(b.x - zx, b.z - zz) > 0.35) {
    stranded.push(`barrier ${b.id} (${b.room}): occupant stops ${Math.hypot(b.x - zx, b.z - zz).toFixed(2)}m short of the boards`);
  }
}

assert.deepEqual(through, [],
  `players can walk through alcove brickwork:\n  ${through.join('\n  ')}`);
assert.deepEqual(stranded, [],
  `alcove enclosure blocks its own occupant from reaching the boards:\n  ${stranded.join('\n  ')}`);

console.log(`barrier alcoves OK (${map.barriers.length} shafts solid from every sealed side, all reach their boards)`);
