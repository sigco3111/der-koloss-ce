// The Courtyard must be able to spawn its own zombies.
//
// It holds the first mystery box, but for a long time it had no boarded windows
// of its own: `courtyard_west`, both east runs and the north run all shipped
// with `gaps: []`, and the only ways in were two purchasable doors. spawnOne's
// preference order is
//
//   1. windows in a room a player is standing in
//   2. windows anywhere else the players can be reached from
//   ...
//
// so standing in the Courtyard fell straight through tier 1 to tier 2 every
// time. Every zombie was born somewhere else and walked in through a door,
// which made the box a safe room: no pressure, no rebuild, nothing to hold.
//
// Asserted against the real spawner and the real map rather than the layout
// table, because "the window exists in MAP_WALL_RUNS" is not the property that
// matters — "a player standing at the box draws window spawns in their own
// room" is.
import assert from 'node:assert/strict';
import { THREE, loadGameModule } from './lib/headless-three.mjs';

const { buildMap } = await loadGameModule('map.js');
const { ZombieManager } = await loadGameModule('zombies.js');
const { INITIAL_MYSTERY_BOX } = await loadGameModule('map-layout.js');

const map = buildMap(new THREE.Scene());
for (const door of map.doors) if (!door.open) map.openDoor(door);

// The box's own room is the thing under test — if the box ever moves, this
// should follow it rather than silently guarding an empty patch of ground.
const boxRoom = map.roomAt(INITIAL_MYSTERY_BOX.x, INITIAL_MYSTERY_BOX.z, 0);
assert.equal(boxRoom, 'courtyard', `the initial mystery box is in ${boxRoom}, not the courtyard`);

const courtyardWindows = map.barriers.filter((b) => b.room === 'courtyard');
assert.ok(courtyardWindows.length >= 1,
  'the courtyard has no boarded windows: every zombie reaching the first box has to walk in through a door');

// Alcoves are a 2.8m brick pocket hung off the far side of the wall. Inside a
// playable room that is a free-standing box players collide with (see
// validate-barrier-alcoves). Every courtyard alcove must land outside the shell.
for (const b of courtyardWindows) {
  const room = map.roomAt(b.alcove.x, b.alcove.z, 0);
  assert.equal(room, null,
    `courtyard window at (${b.x}, ${b.z}) puts its alcove inside ${room} — it would be a brick pocket in a playable room`);
}

// ---------------------------------------------------------------------------
// The real spawner, with a player standing at the box.
// ---------------------------------------------------------------------------
const spawned = [];
const zm = new ZombieManager(new THREE.Scene(), map, {
  onSpawned: () => {},
  onKilled: () => {},
  onPlayerDamaged: () => {},
  onBoardTorn: () => {},
  onRiseDirt: () => {},
  onRiseDone: () => {},
}, true);

const atBox = [{ id: 'local', x: INITIAL_MYSTERY_BOX.x, z: INITIAL_MYSTERY_BOX.z, y: 0, dead: false, down: false }];

zm.round = 6;
zm.toSpawn = 40;
for (let i = 0; i < 40; i++) {
  const before = zm.zombies.size;
  zm.spawnOne(atBox);
  if (zm.zombies.size === before) break;
  const z = [...zm.zombies.values()].pop();
  // Assert on the BARRIER, not on roomAt(z.x, z.z). A window spawn is placed in
  // the alcove — 1.5m outside the shell — and climbs in from there, so its
  // room is legitimately null on the frame it is created.
  spawned.push({ room: z.barrier?.room ?? null, rising: !!z.rising });
  // Free the window again so one wave does not simply exhaust the two of them;
  // we are measuring which tier the spawner reaches for, not occupancy.
  for (const b of map.barriers) b.occupant = null;
}

assert.ok(spawned.length > 0, 'the spawner produced nothing at all');

const fromCourtyard = spawned.filter((s) => s.room === 'courtyard');
const risers = spawned.filter((s) => s.rising);

// Tier 1 wins outright when it is non-empty, so a player standing at the box
// should be drawing essentially every spawn from the two courtyard windows.
assert.ok(fromCourtyard.length >= spawned.length * 0.9,
  `only ${fromCourtyard.length}/${spawned.length} spawns landed in the courtyard with a player standing in it — `
  + 'tier 1 (windows in the player\'s own room) is not being reached');

assert.equal(risers.length, 0,
  `${risers.length} of ${spawned.length} spawns rose out of the floor while windows were free`);

console.log(`✓ courtyard spawns: ${courtyardWindows.length} windows `
  + `(${courtyardWindows.map((b) => `${b.x},${b.z}`).join(' · ')}), alcoves outside the shell, `
  + `${fromCourtyard.length}/${spawned.length} spawns land in the courtyard for a player at the mystery box`);
