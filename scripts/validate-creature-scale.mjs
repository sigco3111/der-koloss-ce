#!/usr/bin/env node
// Guard the zombie height contract.
//
// Regression this exists for: `ZombieVisual.calibrate()` measured the skinned
// bounds in WORLD space, zeroing only the group's position and yaw.
// `animate()` pitches a rising corpse's group up to 0.95rad forward on the very
// frame calibration runs, and `getVertexPosition` already skins through
// `bone.matrixWorld` — so the extra `applyMatrix4(o.matrixWorld)` applied that
// pitch a second time. A body folded ~1.9rad measured 0.70m instead of 1.23m,
// `targetH / h` came out roughly double, and the corpse was PERMANENTLY
// 2.4-2.9m tall. Only ground risers were pitched (~6% of a wave), which is why
// it read as "some zombies are huge" rather than "all zombies are huge".
//
// These are code-shape checks, deliberately: the failure mode is structural,
// and a render/timing test could not run deterministically in CI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zombies = await readFile(path.join(root, 'js/zombies.js'), 'utf8');

// ---------------------------------------------------------------- the contract
assert.match(zombies, /const ZOMBIE_MIN_H = 1\.\d+;/, 'a minimum rendered zombie height must be declared');
assert.match(zombies, /const ZOMBIE_MAX_H = [12]\.\d+;/, 'a maximum rendered zombie height must be declared');
const minH = Number(/const ZOMBIE_MIN_H = ([\d.]+);/.exec(zombies)[1]);
const maxH = Number(/const ZOMBIE_MAX_H = ([\d.]+);/.exec(zombies)[1]);
assert.ok(minH >= 1.5 && minH <= 1.75, `ZOMBIE_MIN_H (${minH}) must stay a human floor`);
assert.ok(maxH > minH && maxH <= 2.05, `ZOMBIE_MAX_H (${maxH}) must stay a human ceiling`);

// The randomised target must itself sit inside the contract.
const target = /_targetH = rand\(([\d.]+), ([\d.]+)\)/.exec(zombies);
assert.ok(target, 'ZombieVisual must pick a randomised target height');
assert.ok(Number(target[1]) >= minH && Number(target[2]) <= maxH,
  `_targetH range ${target[1]}..${target[2]} must lie inside [${minH}, ${maxH}]`);

// --------------------------------------------------- measure in the right frame
// One sampler, and it must neutralise every transform between the skeleton and
// the ruler before it bounds anything.
assert.match(zombies, /function measureNeutralBounds\(inner, group\) \{/,
  'a single transform-neutral bounds sampler must exist');
const start = zombies.indexOf('function measureNeutralBounds(inner, group) {');
const sampler = zombies.slice(start, zombies.indexOf('\n}\n', start) + 3);

for (const [re, why] of [
  [/inner\.position\.set\(0, 0, 0\)/, "the rig's own offset must be neutralised before measuring"],
  [/inner\.scale\.setScalar\(1\)/, 'the rig must be measured at UNIT SCALE so the result is comparable before and after scaling'],
  [/group\.position\.set\(0, 0, 0\)/, "the group's placement must be neutralised"],
  [/group\.scale\.setScalar\(1\)/, "the group's scale must be neutralised"],
  [/group\.quaternion\.identity\(\)/, "the group's FULL rotation must be neutralised — zeroing yaw alone is the original bug"],
]) assert.match(sampler, re, why);

// It must restore everything it touched, or a measurement would teleport a zombie.
for (const [re, why] of [
  [/inner\.position\.copy\(_neutralPos\)/, 'the rig offset must be restored'],
  [/inner\.scale\.copy\(_neutralScale\)/, 'the rig scale must be restored'],
  [/group\.position\.copy\(_neutralGPos\)/, 'the group position must be restored'],
  [/group\.scale\.copy\(_neutralGScale\)/, 'the group scale must be restored'],
  [/group\.quaternion\.copy\(_neutralGQuat\)/, 'the group rotation must be restored'],
]) assert.match(sampler, re, why);

assert.doesNotMatch(sampler, /new THREE\.(Box3|Vector3|Matrix4|Quaternion)\(\)/,
  'the bounds sampler must reuse module scratch, not allocate per call');

// Every skinned-vertex sweep in this file must go through that one sampler.
const sweeps = zombies.match(/getVertexPosition\(/g) || [];
assert.equal(sweeps.length, 1,
  `js/zombies.js must sample skinned bounds in exactly one place (found ${sweeps.length}); ` +
  'a second copy is how the world-space measurement survived');

// Nothing may reintroduce a partial neutralisation (position + yaw only).
assert.doesNotMatch(zombies, /this\.group\.rotation\.y = 0;/,
  'zeroing group yaw alone is the original giant-zombie bug; neutralise the whole transform');

// --------------------------------------------------------- clamp + postcondition
const cal = zombies.slice(zombies.indexOf('  calibrate() {'), zombies.indexOf('\n  update(dt) {'));
assert.ok(cal.length > 200, 'ZombieVisual.calibrate() must be locatable');

// The scale must be clamped into the contract before it is ever applied.
assert.match(cal, /const scale = clamp\(target \/ h, ZOMBIE_MIN_H \/ h, ZOMBIE_MAX_H \/ h\);/,
  'the calibration scale must be clamped into the height contract');
const clampIdx = cal.indexOf('const scale = clamp(');
const applyIdx = cal.indexOf('this.inner.scale.setScalar(scale)');
assert.ok(applyIdx > -1, 'calibrate() must apply the fitted scale');
assert.ok(clampIdx > -1 && clampIdx < applyIdx,
  'the fitted scale must not be reachable before it is clamped');

// A unit-scale measurement must be assigned, never compounded.
assert.doesNotMatch(zombies, /inner\.scale\.multiplyScalar\(/,
  'zombie rigs must be scaled with setScalar; multiplyScalar compounds a repeat calibration into a giant');

// Sanity band on the RAW measurement, so a degenerate sample is rejected outright.
assert.match(zombies, /const CAL_SANE_LO = 0\.\d+;/, 'a lower sanity bound for the raw measurement must exist');
assert.match(zombies, /const CAL_SANE_HI = [12]\.\d+;/, 'an upper sanity bound for the raw measurement must exist');
assert.match(cal, /measuredH >= native \* CAL_SANE_LO && measuredH <= native \* CAL_SANE_HI/,
  'the raw measured height must be validated against the cached native standing height');

// Hard post-condition: re-measure and fall back deterministically.
assert.match(cal, /const after = measureNeutralBounds\(this\.inner, this\.group\);/,
  'calibrate() must RE-MEASURE after scaling — asserting the outcome, not assuming it');
assert.match(cal, /if \(!\(finalH >= ZOMBIE_MIN_H && finalH <= ZOMBIE_MAX_H\)\)/,
  'the post-condition must assert the final height lands inside the contract');
assert.match(cal, /this\.inner\.scale\.setScalar\(safe\)/,
  'a failed post-condition must fall back to the deterministic cached-native scale');
assert.match(cal, /clamp\(target \/ native, ZOMBIE_MIN_H \/ native, ZOMBIE_MAX_H \/ native\)/,
  'the fallback scale must itself be clamped into the contract');

// Calibration must stay one-shot; nothing may clear the flag and re-fit a rig.
assert.equal((zombies.match(/_calibrated = true/g) || []).length, 1,
  'there must be exactly one place that marks a zombie calibrated');
assert.equal((zombies.match(/_calibrated = false/g) || []).length, 1,
  'only the constructor may clear _calibrated; resetting it re-fits an already-scaled rig');

// ------------------------------------------------------------- O(1) per zombie
// The native standing height is a property of the SOURCE MODEL. Measuring it
// per instance would put a full skinned sweep of a throwaway clone on every
// spawn frame, which co-op cannot afford.
assert.match(zombies, /const _nativeStandingH = new WeakMap\(\);/,
  'native standing height must be cached per source model');
const natStart = zombies.indexOf('function nativeStandingHeight(src)');
const natBody = zombies.slice(natStart, zombies.indexOf('\n}\n', natStart) + 3);
assert.match(natBody, /if \(_nativeStandingH\.has\(src\)\) return _nativeStandingH\.get\(src\);/,
  'nativeStandingHeight must return the cached value before doing any work');
assert.match(natBody, /_nativeStandingH\.set\(src, h\);/,
  'nativeStandingHeight must memoise failures too, or a broken model re-clones on every spawn');
assert.match(natBody, /mixer\.uncacheRoot\(probe\)/,
  'the probe rig must be released from the mixer cache');
assert.doesNotMatch(cal, /skClone\(/, 'calibrate() must never clone a rig per instance');

console.log('creature scale contract OK');
