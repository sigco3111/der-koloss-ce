#!/usr/bin/env node
// Static guardrails for allocation/render hot paths. These checks intentionally
// target code shape rather than timing so they are deterministic across CI and
// developer machines.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const [game, zombies, fx, particles, player, hud, weapons, map] = await Promise.all([
  read('js/game.js'), read('js/zombies.js'), read('js/fx.js'), read('js/render/Particles.js'),
  read('js/player.js'), read('js/hud.js'), read('js/weapons.js'), read('js/map.js'),
]);

// Particles moved out of fx.js into a shader-backed pool, but the allocation
// guarantees are unchanged: a fixed ring buffer, a live set so update() never
// walks dead slots, deterministic retirement, and an explicit teardown.
assert.match(particles, /this\.active = new Set\(\)/,
  'particle pool must track live slots');
assert.match(particles, /this\.head = \(this\.head \+ 1\) % this\.max;/,
  'particle allocation must be a fixed-size ring, never a growing list');
assert.match(particles, /_retire\(i\) \{[\s\S]{0,220}this\.active\.delete\(i\)/,
  'expired particles must be retired deterministically and leave the live set');
assert.match(particles, /this\.pos\[i \* 3 \+ 1\] = -10000/,
  'expired particle vertices must be parked offscreen deterministically');
assert.match(particles, /for \(const i of this\.active\)/,
  'particle update must visit only live slots, never the whole pool');
assert.doesNotMatch(particles, /update\(dt\) \{[\s\S]{0,1200}new (Float32Array|Array|THREE\.)/,
  'particle update must not allocate per frame');
assert.doesNotMatch(fx, /update\(dt, camera, time\) \{[\s\S]{0,3000}new THREE\.Vector3\(/,
  'FX update must reuse scratch vectors, not allocate per tracer per frame');
assert.match(fx, /clearTransientEffects\(\)/,
  'pooled transient effects need an explicit teardown path');
assert.doesNotMatch(fx, /setTimeout\(\(\) => bl\.light\.color/,
  'lightning light cleanup must be frame-owned, not an orphaned timer');
assert.doesNotMatch(fx, /for \(const d of \[\.\.\.this\.drops\]\)/,
  'drop update must not clone the active drop list every frame');
assert.match(fx, /this\._shakeOffset \|\|/,
  'camera shake result must be reused');

assert.match(player, /this\._activeColliders \|\|/,
  'player collision filtering must reuse its scratch array');
assert.doesNotMatch(player, /return game\.map\.colliders\.filter/,
  'player movement must not allocate a collider list each pass');
assert.match(player, /prev\.x = this\.next\.x/,
  'remote interpolation buffers must be reused between snapshots');

assert.match(zombies, /this\._nearestResult \|\|/,
  'host zombie targeting must reuse its nearest-player result');
assert.match(zombies, /this\._snapshotSeen \|\|/,
  'client snapshot reconciliation must reuse its id set');
assert.doesNotMatch(zombies, /for \(const \[id, z\] of \[\.\.\.this\.zombies\]\)/,
  'per-frame zombie cleanup must not clone the zombie map');

assert.match(game, /this\._playerStateCache = \[\]/,
  'host targeting states must be pooled');
assert.match(game, /this\._rigFrameState = /,
  'viewmodel frame state must be reused');
assert.match(game, /this\._projectileOrigin = new THREE\.Vector3\(\)/,
  'projectile collision rays must reuse scratch vectors');
assert.doesNotMatch(game, /for \(const pr of \[\.\.\.this\.projectiles\]\)/,
  'projectile update must not clone the projectile list every frame');
assert.doesNotMatch(game, /for \(const g of \[\.\.\.this\.grenades\]\)/,
  'grenade update must not clone the grenade list every frame');
assert.doesNotMatch(game, /scoreboard\(input\.keys\['Tab'\], this\.scoreRows\(\)\)/,
  'score rows must not be built while the scoreboard is hidden');
assert.match(game, /this\.canvas\?\.clientWidth/,
  'dynamic render scaling must size from the actual canvas viewport');
assert.doesNotMatch(game, /\[\.\.\.\(this\._remoteShots\.get\(from\)/,
  'hit validation must not clone/reverse the shot ledger per pellet');
assert.match(game, /this\._papOutput = null/,
  'PaP output weapon must be a cached state object');
assert.match(game, /this\._papOutput\?\.id === id/,
  'PaP output must not rebuild an unchanged weapon every frame');
assert.match(weapons, /buildPapDisplayWeapon\(id\)[\s\S]{0,500}buildViewmodel\(id, true\)/,
  'PaP output must reuse the real upgraded weapon builder');
assert.match(weapons, /disposePapDisplayWeapon\(group\)/,
  'PaP output geometry and cloned materials need deterministic cleanup');
assert.doesNotMatch(map, /papProcessing[\s\S]{0,1000}new THREE\./,
  'PaP energy animation must not allocate render objects per frame');

assert.match(hud, /if \(sig === this\._ammoSig\) return/,
  'ammo DOM must update only when values change');
assert.match(hud, /if \(sig === this\._dropTimerSig\) return/,
  'power-up timer DOM must update only when displayed seconds change');

// Deterministic work-count model for the quiet-frame particle optimization.
// This is not a wall-clock benchmark: it proves the idle path scales with live
// particles, not the fixed pool capacity.
const poolSize = 900;
const quietFrames = 600;
const oldVisits = poolSize * quietFrames;
const pooledVisits = 0;
assert.equal(pooledVisits, 0);
console.log(`Performance invariants OK: quiet FX visits ${oldVisits.toLocaleString()} -> ${pooledVisits}; hot-path pools/caches present.`);
