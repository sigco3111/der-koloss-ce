// Guard the spawn-source contract: windows are the rule, ground rise the
// exception. This regressed once already, silently, because a leaked barrier
// claim degraded every wave into floor spawns without any error.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../js/zombies.js', import.meta.url), 'utf8');

// Ground risers must be budgeted per wave, not used as a fallback.
assert.match(src, /const RISER_SHARE = 0\.0[0-9]/, 'RISER_SHARE must stay a small share of the wave');
assert.match(src, /this\._riserBudget = Math\.floor\(this\.toSpawn \* RISER_SHARE\)/,
  'the riser budget must be floor()ed so early rounds are pure windows');

// Barriers must be tried strictly before risers.
const pick = src.slice(src.indexOf('spawnOne(players)'), src.indexOf('z.room ||='));
const barrierTier = pick.indexOf('barrierRings.find(');
const riserTier = pick.indexOf('riserRings.find(');
assert.ok(barrierTier > -1 && riserTier > -1, 'spawn tiers must exist');
assert.ok(barrierTier < riserTier, 'windows must be selected before ground risers');

// Both tiers must be RINGED by hop count, not pooled flat. Flat, the tail of a
// wave was picked uniformly from every window on the map, so the last zombie of
// an early round was routinely born at the far shell and walked for over a
// minute — the "I can't find the last zombie" report. See roomDepthsToPlayers.
assert.match(pick, /const depth = this\.activeSpawnRoomDepths\(players\)/,
  'spawnOne must rank spawn rooms by distance from the players');
for (const [ring, kind] of [['barrierRings', 'windows'], ['riserRings', 'risers']]) {
  assert.match(pick, new RegExp(`\\(${ring}\\[d\\] \\|\\|= \\[\\]\\)\\.push`),
    `${kind} must be bucketed by hop count so the nearest ring is used first`);
}
assert.ok(!/barriersElsewhere|risersElsewhere/.test(pick),
  'the flat "anywhere on the map" spawn pools must not come back');

// The self-heal is what stops one leaked claim locking a window forever.
assert.match(src, /if \(b\.occupant != null && !this\.zombies\.has\(b\.occupant\)\) b\.occupant = null;/,
  'spawnOne must release windows whose claimant no longer exists');
assert.match(src, /for \(const b of this\.map\.barriers\) b\.occupant = null;/,
  'clear\\(\\) must hand every window back');
// A relocated zombie never returns to its window, so respawnNear must hand the
// claim back itself — the self-heal above only reclaims from claimants that no
// longer exist, and this one is still very much alive.
assert.match(src, /if \(z\.barrier\.occupant === z\.id\) z\.barrier\.occupant = null;/,
  'respawnNear must release the barrier claim of the zombie it relocates');

console.log('spawn-source invariants OK');
