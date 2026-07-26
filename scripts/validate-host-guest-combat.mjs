#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  explosionDamage,
  FRAG_BLAST,
  MELEE_DAMAGE,
  meleeDamage,
} from '../js/combat-rules.js';
import {
  dogCount,
  roundZombieCount,
  roundZombieHealth,
} from '../js/config.js';

// Frags should be decisive near the center, useful through the middle of the
// blast, and harmless outside the declared radius.
assert.equal(explosionDamage(0, FRAG_BLAST), 700);
assert.equal(explosionDamage(2, FRAG_BLAST), 545);
assert.equal(explosionDamage(3, FRAG_BLAST), 351);
assert.equal(explosionDamage(4, FRAG_BLAST), 0);
assert.ok(explosionDamage(1, FRAG_BLAST) > roundZombieHealth(5),
  'a close frag should kill a normal round-five zombie');

assert.equal(meleeDamage(false), MELEE_DAMAGE.knife);
assert.equal(meleeDamage(true), MELEE_DAMAGE.bowie);
assert.equal(meleeDamage(false), roundZombieHealth(1),
  'starting knife remains a one-hit kill only on round one');
assert.ok(meleeDamage(true) >= roundZombieHealth(9),
  'Bowie remains a one-hit kill through round nine');
assert.ok(meleeDamage(true) < roundZombieHealth(10),
  'Bowie correctly stops one-hitting at round ten');

// Co-op scales total work monotonically without multiplying the simultaneous
// renderer/AI cap (CFG.MAX_ALIVE remains separate at 24).
for (const round of [1, 5, 10, 30]) {
  const counts = [1, 2, 3, 4].map((players) => roundZombieCount(round, players));
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] > counts[i - 1], `round ${round} must scale from ${i} to ${i + 1} players`);
  }
}
for (const round of [5, 10, 30]) {
  const counts = [1, 2, 3, 4].map((players) => dogCount(round, players));
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] >= counts[i - 1], `dog round ${round} must not shrink in co-op`);
  }
  assert.ok(counts[3] <= 18, 'hound count must honor the dedicated-round cap');
}

const [game, zombies] = await Promise.all([
  readFile(new URL('../js/game.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/zombies.js', import.meta.url), 'utf8'),
]);
assert.match(game, /ids\.push\(\[zb\.id, dmg, this\._newHitClaim\(\)\]\)/,
  'guest grenade victims need single-use credit ids');
assert.match(game, /msg\.gren[\s\S]{0,180}explosionDamage\(distance, FRAG_BLAST\)/,
  'host must recompute guest frag damage from the shared curve');
assert.equal((game.match(/meleeDamage\(/g) || []).length, 3,
  'solo, guest submission and host validation must share melee calibration');
assert.match(zombies, /if \(!this\.dogRound\) \{[\s\S]{0,220}this\.map\.barriers/,
  'hellhounds must never spawn in boarded exterior alcoves');

console.log('Host/guest combat OK: grenade credits/damage, melee calibration, hound spawning, and 1–4 player scaling passed.');
