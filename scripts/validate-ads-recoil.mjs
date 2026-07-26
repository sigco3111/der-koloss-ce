#!/usr/bin/env node
// Aimed fire must stay readable.
//
// The bug this was written for: the viewmodel's recoil pose was applied at full
// strength whether you were hip-firing or looking through the sights, and
// `WeaponRig.kick` never decays between rounds of an automatic. At the FG42's
// 937rpm the kick oscillated 0.37..1.00 fifteen times a second, driving 5.8
// degrees of muzzle flip and 5.7cm of travel toward a lens 26cm away. Aimed,
// that is not a recoil animation: the sight leaves the aperture on every round
// and the weapon visibly pulses in SIZE, because the travel is along the axis
// the eye measures distance on. Every automatic in the game had it — the FG42
// was just the loudest, being among the fastest.
//
// Three things kept it from being a one-weapon fix, and this validator guards
// all three:
//
//   1. the VIEWMODEL kick must scale down with ADS, and must settle between
//      rounds instead of riding its clamp for a whole burst;
//   2. the CAMERA kick must lose its lateral half when aimed — yaw and roll
//      flip sign every round, so under a narrowed field they read as the screen
//      convulsing rather than as the muzzle climbing;
//   3. the clamps must bound spring VELOCITY, not just position, or a burst
//      winds the spring up behind a pinned view and it snaps loose at the end.
//
// The budget below is deliberately two-sided. Aimed fire must be calm, but hip
// fire must stay lively and aimed fire must not go dead — "fix the spazzing" is
// otherwise trivially satisfied by deleting recoil, which is a worse game.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadGameModule } from './lib/headless-three.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const [weaponsSrc, gameSrc, rigSrc] = await Promise.all([
  read('js/weapons.js'), read('js/game.js'), read('js/render/CameraRig.js'),
]);
const { WEAPONS, getStats } = await loadGameModule('weapons.js');

// Pull the live numbers out of the source rather than restating them, so the
// simulation below tracks whatever the pose actually does today.
const grab = (src, re, what) => {
  const m = src.match(re);
  assert.ok(m, `could not find ${what} — the ADS recoil fix has been refactored away`);
  return m;
};
const num = (src, name) =>
  Number(grab(src, new RegExp(`const ${name} = ([0-9.]+);`), name)[1]);

// ------------------------------------------------- viewmodel: the pose itself
// Both terms must be scaled by the ADS blend `t`, not by a boolean: a shot
// fired halfway through the raise should disturb the weapon halfway as much.
const push = grab(weaponsSrc,
  /g\.position\.z \+= this\.kick \* ([0-9.]+) \* lerp\(1, ADS_KICK_PUSH, t\);/,
  'the ADS-scaled recoil push');
const pitch = grab(weaponsSrc,
  /let rx = this\.kick \* ([0-9.]+) \* lerp\(1, ADS_KICK_PITCH, t\)/,
  'the ADS-scaled muzzle flip');
const impulse = grab(weaponsSrc,
  /this\.kick = Math\.min\(1, this\.kick \+ lerp\(([0-9.]+), ADS_KICK_IMPULSE, this\.adsT\)\);/,
  'the ADS-scaled per-shot kick impulse');
const settle = grab(weaponsSrc,
  /this\.kick = damp\(this\.kick, 0, ([0-9.]+) \+ this\.adsT \* ADS_KICK_SETTLE, dt\);/,
  'the ADS-scaled kick settle rate');

const K = {
  pushZ: Number(push[1]), pitchX: Number(pitch[1]),
  hipImpulse: Number(impulse[1]), hipSettle: Number(settle[1]),
  adsPush: num(weaponsSrc, 'ADS_KICK_PUSH'),
  adsPitch: num(weaponsSrc, 'ADS_KICK_PITCH'),
  adsImpulse: num(weaponsSrc, 'ADS_KICK_IMPULSE'),
  adsSettle: num(weaponsSrc, 'ADS_KICK_SETTLE'),
};

// Recoil must be REDUCED when aiming, never removed. A zero here would read as
// a weapon that does not respond to its own fire.
for (const [name, v] of [['ADS_KICK_PUSH', K.adsPush], ['ADS_KICK_PITCH', K.adsPitch]]) {
  assert.ok(v > 0 && v < 1, `${name} must sit strictly between 0 and 1 — aimed recoil is damped, not deleted (got ${v})`);
}
assert.ok(K.adsImpulse > 0 && K.adsImpulse < K.hipImpulse,
  'a shouldered weapon must be disturbed less per round than a hip-fired one, but still disturbed');
assert.ok(K.adsSettle > 0,
  'an aimed weapon must return to rest FASTER than a hip-fired one, or the kick never settles between rounds');

// ------------------------------------------------------------ the simulation
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));

/**
 * The steady-state swing of the viewmodel kick under sustained fire — the
 * peak-to-trough excursion once the burst has settled into its rhythm. This,
 * not the single-shot peak, is what the player sees during automatic fire, and
 * it is what the original code got wrong: a kick that cannot decay between
 * rounds stops being a series of kicks and becomes a vibration.
 */
function kickSwing(rpm, ads) {
  const dt = 60 / rpm;
  let k = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 400; i++) {
    k = Math.min(1, k + lerp(K.hipImpulse, K.adsImpulse, ads));
    if (i > 200) hi = Math.max(hi, k);
    k = damp(k, 0, K.hipSettle + ads * K.adsSettle, dt);
    if (i > 200) lo = Math.min(lo, k);
  }
  const swing = hi - lo;
  return {
    pitchDeg: swing * K.pitchX * lerp(1, K.adsPitch, ads) * 180 / Math.PI,
    pushCm: swing * K.pushZ * lerp(1, K.adsPush, ads) * 100,
  };
}

// Budgets. The aimed numbers are what "super smooth" has to mean in units: at
// under a degree of flip and a centimetre of travel the sight stays in its
// aperture and the weapon holds its apparent size through a burst.
const ADS_MAX_PITCH_DEG = 1.2;
const ADS_MAX_PUSH_CM = 1.5;
const ADS_MIN_PITCH_DEG = 0.05;   // still alive
const HIP_MIN_PITCH_DEG = 3.0;    // hip fire must not be flattened to fix ADS

const autos = Object.entries(WEAPONS)
  .filter(([, w]) => w.auto && w.rpm)
  .map(([id, w]) => ({ id, rpm: Math.max(w.rpm, w.pap?.rpm ?? 0), cls: getStats(id, false).cls }));
assert.ok(autos.length >= 10,
  'expected the automatic weapons to be discoverable — has the WEAPONS table changed shape?');

for (const { id, rpm } of autos) {
  const ads = kickSwing(rpm, 1);
  const hip = kickSwing(rpm, 0);
  assert.ok(ads.pitchDeg <= ADS_MAX_PITCH_DEG,
    `${id}: aimed muzzle flip swings ${ads.pitchDeg.toFixed(2)}deg at ${rpm}rpm (budget ${ADS_MAX_PITCH_DEG}) — the sight will not stay in the aperture`);
  assert.ok(ads.pushCm <= ADS_MAX_PUSH_CM,
    `${id}: aimed recoil travel swings ${ads.pushCm.toFixed(2)}cm at ${rpm}rpm (budget ${ADS_MAX_PUSH_CM}) — the weapon will pulse in apparent size`);
  assert.ok(ads.pitchDeg >= ADS_MIN_PITCH_DEG,
    `${id}: aimed recoil is dead (${ads.pitchDeg.toFixed(3)}deg) — damp it, do not delete it`);
  assert.ok(hip.pitchDeg >= HIP_MIN_PITCH_DEG,
    `${id}: hip-fire recoil has been flattened to ${hip.pitchDeg.toFixed(2)}deg — aimed fire was the problem, not fire from the hip`);
}

// -------------------------------------------------------- camera: the aim kick
// Vertical climb is the half of recoil a player reads and answers, so it is
// trimmed. The lateral half flips sign every round and is what actually reads
// as the screen convulsing, so aiming takes nearly all of it.
const climb = num(gameSrc, 'ADS_RECOIL_CLIMB');
const scatter = num(gameSrc, 'ADS_RECOIL_SCATTER');
assert.ok(scatter > climb,
  'aiming must suppress lateral scatter harder than vertical climb — the sideways half is the half that reads as spazzing');
assert.ok(climb > 0 && climb < 1 && scatter > 0 && scatter < 1,
  'ADS recoil scalars must damp rather than delete recoil');

assert.match(gameSrc, /const climb = 1 - aim \* ADS_RECOIL_CLIMB;/,
  'the aimed climb scalar must be derived from the ADS blend, not from a boolean');
assert.match(gameSrc, /const scatter = 1 - aim \* ADS_RECOIL_SCATTER;/,
  'the aimed scatter scalar must be derived from the ADS blend, not from a boolean');
assert.match(gameSrc, /p\.recoilPitch \+= s\.kick \* rand\(0\.8, 1\.2\) \* climb;/,
  'aim climb must be scaled by ADS');
assert.match(gameSrc, /p\.yaw \+= rand\(-0\.3, 0\.3\) \* s\.kick \* 0\.5 \* scatter;/,
  'the per-shot yaw walk must be scaled out by ADS — it moves where you are actually aiming');
assert.match(gameSrc, /rand\(-1, 1\) \* s\.kick \* 16 \* lateralScale,\s*\n\s*rand\(-1, 1\) \* s\.kick \* 22 \* lateralScale,/,
  'camera yaw and roll kick must use the lateral (scatter) scale, not the vertical one');
// Trauma is aliased noise — three detuned sines sampled at 30Hz, above the
// frame rate. Behind a hip-fired burst that is grit; behind an aimed one it is
// flicker.
assert.match(gameSrc, /this\.fx\.shake\(\(heavy \? 0\.22 : 0\.08\) \* scatter\);/,
  'muzzle trauma shake must be scaled out by ADS');

// ------------------------------------------------------------- spring clamps
assert.match(rigSrc, /function clampSpring\(state, lim\)/,
  'spring clamps must go through clampSpring, which bounds velocity as well as position');
assert.doesNotMatch(rigSrc, /this\.kick(Pitch|Yaw|Roll)\.x = clamp\(/,
  'clamping a kick spring on position alone leaves it wound up behind the stop');

const worst = autos
  .map((w) => ({ ...w, ...kickSwing(w.rpm, 1) }))
  .sort((a, b) => b.pitchDeg - a.pitchDeg)[0];
console.log(`ADS recoil OK: ${autos.length} automatics within budget (worst: ${worst.id} at ${worst.rpm}rpm, ${worst.pitchDeg.toFixed(2)}deg / ${worst.pushCm.toFixed(2)}cm aimed), hip-fire punch intact, lateral scatter suppressed, spring clamps bound velocity.`);
