#!/usr/bin/env node
// Guardrails for the movement/camera feel layer. Like the other validators in
// this directory these are deterministic code-shape checks, not timing tests:
// the point is that a future edit cannot silently undo a fix that was painful
// to find (a key collision, an unstable integrator, a lost momentum term).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveCircleBox, moveCircleWithColliders } from '../js/collision.js';
import { stairFlightColliders, platformSideBlocksAtFeet } from '../js/map-layout.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const [player, game, rig, input, indexHtml, postfx] = await Promise.all([
  read('js/player.js'), read('js/game.js'), read('js/render/CameraRig.js'),
  read('js/input.js'), read('index.html'), read('js/render/PostFX.js'),
]);

// ---------------------------------------------------------------- key budget
// Q is weapon swap and E is aim-down-sights. Any new movement verb that grabs
// either of them silently breaks two core controls, which is exactly what a
// first pass at lean did.
assert.match(input, /input\.rmbDown \|\| !!input\.keys\['KeyE'\]/,
  'E must remain an aim-down-sights key');
assert.doesNotMatch(player, /input\.keys\['KeyE'\]/,
  'player movement must not bind KeyE — it is the aim key');
assert.doesNotMatch(player, /input\.keys\['KeyQ'\]/,
  'player movement must not bind KeyQ — it is the weapon-swap key');

// ------------------------------------------------------------------ momentum
assert.match(player, /this\.vx = 0; this\.vz = 0;/,
  'the player must carry velocity, not teleport by speed * dt');
assert.match(player, /this\.vx \+= \(wishX - this\.vx\) \* Math\.min\(1, accel \* dt\)/,
  'ground movement must accelerate toward a wish velocity');
assert.match(player, /const f = Math\.max\(0, 1 - friction \* dt\);/,
  'released input must bleed off through friction, not stop instantly');
assert.match(player, /this\.vx = \(this\.x - beforeX\) \/ dt;/,
  'collision response must feed back into velocity so walls bleed momentum');

// --------------------------------------------------------------------- slide
// The slide must fire on the key-down edge (not on release), and the press
// that starts it must not also toggle crouch.
const slideBlock = /if \(input\.pressed\['KeyC'\][\s\S]{0,400}this\._slideAtePress = true;/;
assert.match(player, slideBlock, 'slide must trigger on the KeyC down edge');
assert.match(player, /if \(stanceTapped && !this\._slideAtePress\)/,
  'the press that starts a slide must not also toggle crouch');
assert.ok(player.indexOf("input.pressed['KeyC']") < player.indexOf('const stanceKey ='),
  'the slide edge check must run before the stance machine consumes the key');

// -------------------------------------------------------------------- mantle
assert.match(player, /_findMantle\(game\)/, 'ledges must be mantleable');
assert.match(player, /if \(!game\.map\.roomAt\(landX, landZ, top\)\) continue;/,
  'a mantle must never place the player outside a room');
// The mantle arc is scripted and ignores collision, so the LANDING point — not
// just the probe 0.35m short of it — has to be proved clear. Checking only the
// probe let a crate against a wall hand you a landing inside the brick.
assert.match(player, /if \(!this\._standingClear\(game, landX, landZ, top, HEADROOM\)\) continue;/,
  'a mantle must prove its actual landing point is clear, not just the probe');
assert.match(player, /if \(!this\._standingClear\(game, tx, tz, top, HEADROOM\)\) continue;/,
  'mantling must still reject ledges without standing headroom at the probe');
// ...and as the circle the player is, not as a point that can thread a gap the
// body does not fit through.
assert.match(player, /_standingClear\(game, x, z, top, headroom\) \{[\s\S]*?Math\.hypot\(x - cx, z - cz\) >= CFG\.PLAYER_RADIUS\) continue;/,
  'standing room must be tested against the player radius, not a point sample');
assert.match(player, /this\._coyote = this\.grounded \? 0\.12/,
  'jump needs a coyote-time grace window');
assert.match(player, /this\._jumpBuffer = input\.pressed\['Space'\] \? 0\.16/,
  'jump needs an input buffer so an early press is not dropped');

// ------------------------------------------------------------ camera springs
// The explicit Euler spring detonated the view into a spin whenever a frame
// ran slower than ~44fps. Keep the closed-form solution.
assert.match(rig, /const e = Math\.exp\(-omega \* dt\);/,
  'camera springs must use the analytic critically-damped solution');
assert.doesNotMatch(rig, /state\.v \+= \(target - state\.x\) \* f \* dt/,
  'explicit Euler springs are unstable at low framerates — do not reintroduce');
// The clamp must bound the VELOCITY as well as the position. Clamping x alone
// pins the view at the stop while v keeps building behind it, so a burst looks
// still and then springs loose the moment it ends.
assert.match(rig, /clampSpring\(this\.kickPitch, 0\.11\);/,
  'recoil kick must be clamped so sustained fire cannot stack into a spin');
assert.match(rig, /if \(state\.v > 0\) state\.v = 0;/,
  'clamping a spring must drop the velocity pushing into the stop, not just x');
assert.match(rig, /this\.bobPhase \+= \(s\.speed \* dt\) \/ strideLen \* Math\.PI;/,
  'view bob must advance with distance travelled, not wall-clock time');
assert.match(rig, /&& !s\.sliding;/,
  'a slide is a glide — it must not produce footfalls or bob');

// ---------------------------------------------------------------- down camera
// Being down is not a moment for the camera to editorialise, and it is the one
// state where every motion input is frozen rather than updated: player.update()
// returns early for the whole bleedout, so each field keeps the value it held
// the instant you fell. Going down mid-sprint used to leave the view bobbing
// through a full stride — and the viewmodel walking — until you were revived,
// which reads as camera shake coming from a body that is lying still.
assert.match(game, /const sh = \(p\.down \|\| p\.dead\) \? NO_SHAKE : this\.fx\.getShakeOffset\(\);/,
  'trauma shake must not be applied while down or dead');
assert.match(game, /rigState\.health01 = p\.down \? 1 :/,
  'being down must not drive the rig breathing to its at-death depth');
const parkBody = /this\.speed2D = 0;\s*\n\s*this\.moving = false;\s*\n\s*this\.sprinting = false;\s*\n\s*this\.strafeInput = 0;/;
assert.match(player, parkBody,
  'goDown must park the motion state, which the camera rig reads every frame');
assert.ok(player.search(parkBody) > player.indexOf('goDown(game) {')
  && player.search(parkBody) < player.indexOf('revive(full = false'),
  'the motion state must be parked inside goDown, at the transition itself');
assert.match(player, /if \(this\.sliding\) \{\s*\n\s*this\.sliding = false;\s*\n\s*this\.slideCooldown = 0\.55;\s*\n\s*this\.onSlideEnd\?\.\(false\);/,
  'going down mid-slide must end the slide, not freeze its dip, bank and scrape');
assert.match(player, /this\.downEase = damp\(this\.downEase, this\.down \? 1 : 0/,
  'collapsing and standing up must ease the eye height, not cut it');
assert.ok(player.indexOf('this.downEase = damp(') < player.indexOf('return; // no movement while down'),
  'the collapse ease must be integrated before the down branch returns');

// ------------------------------------------------------- viewmodel isolation
assert.match(game, /const LAYER_VIEWMODEL = 1;/, 'the viewmodel needs its own render layer');
assert.match(game, /this\.viewCamera\.layers\.set\(LAYER_VIEWMODEL\)/,
  'the viewmodel camera must draw only its layer');
assert.match(game, /rig\.root\.traverse\(\(o\) => \{ if \(o\.isLight\) o\.layers\.enableAll\(\); else o\.layers\.set\(LAYER_VIEWMODEL\); \}\)/,
  'every viewmodel mesh must be tagged onto the viewmodel layer');
// Newly equipped meshes default to layer 0. If they are tagged after the world
// pass has already run, the first frame of every weapon swap draws the gun at
// point blank through the world camera — a full-screen flash.
assert.match(game, /render\(dt = 1 \/ 60\) \{\s*\n\s*this\._tagViewmodelLayer\(\);/,
  'viewmodel layer tagging must happen before anything is drawn');
assert.match(game, /this\.camera\.layers\.set\(LAYER_WORLD\)/, 'the world camera must not draw the viewmodel');
assert.match(game, /if \(o\.isLight\) o\.layers\.enableAll\(\)/,
  'lights must reach both the world pass and the viewmodel pass');
assert.match(game, /this\.scene\.background = null;/,
  'a Color scene background forces a clear that wipes the HDR buffer before the viewmodel pass');
assert.match(postfx, /drawViewmodel\(src\);/,
  'the viewmodel must be drawn after the depth-consuming passes, into the current HDR buffer');
assert.ok(postfx.indexOf('drawViewmodel(src)') > postfx.indexOf('ambient occlusion'),
  'the viewmodel must not contribute to ambient occlusion or the volumetric raymarch');

// ------------------------------------------------------------------- exposure
assert.match(game, /fxp\.motionBlurStrength = this\._mbUserStrength \* \(1\.0 - p\.adsT \* 0\.55\);/,
  'aiming must ease off motion blur so the sight picture stays readable');
// This per-frame write used to hardcode its base, which silently overwrote the
// player's motion blur slider one frame after applyQuality applied it — the
// setting moved, the image never did, and "Off" still blurred. The ADS falloff
// must therefore scale a value DERIVED from the option, never a literal.
assert.doesNotMatch(game, /fxp\.motionBlurStrength = [\d.]/,
  'the per-frame ADS falloff must scale the player option, not a hardcoded base');
assert.match(game, /this\._mbUserStrength = MB_BASE_STRENGTH \* scale;/,
  'applyQuality must cache the slider-derived shutter for the per-frame path');
assert.match(game, /this\.postfx\.setMotionBlurScale\(scale\);/,
  'the slider must drive the sampled length, which is what actually reads on screen');
// Length and tap count are one knob. Setting the radius without the taps is how
// the smear combs into discrete ghosts, so nothing may write uMaxRadius alone.
assert.match(postfx, /_applyMotionBlurTaps\(\) \{[\s\S]{0,700}taps \* MB_TAP_SPACING/,
  'blur radius must be derived from the tap count, never set independently');
assert.equal(postfx.match(/uMaxRadius'/g)?.length, 1,
  'uMaxRadius must have exactly one writer, so tap spacing cannot drift');

// -------------------------------------------------- solid walls stay solid
// Behavioural, not textual: js/collision.js is Three.js-free precisely so this
// can run the real resolver.
//
// A wall run is 0.4m thick and the player radius is 0.35m. The resolver used to
// eject a trapped centre along the SHALLOWEST penetration axis, so a centre
// 0.2m into a wall was already nearer the far face and got posted through the
// brick. Props are deliberately embedded in the walls they stand against, and
// their own depenetration is what pushed the centre that far — which is how
// you could walk out of the Generator Room beside Teleporter A.
const WALL_T = 0.4, R = 0.35;
const wall = { minX: -32.2, maxX: -31.8, minZ: -20, maxZ: -6, y0: 0, h: 4.5 };
assert.equal(+(wall.maxX - wall.minX).toFixed(2), WALL_T);
assert.ok(R > WALL_T / 2, 'this test is only meaningful while a player is wider than a wall is thick');

for (const depth of [0.01, 0.1, 0.2, 0.3, 0.39]) {
  const west = resolveCircleBox(wall.minX + depth, -13, R, wall, wall.minX - 1, -13);
  assert.ok(west[0] <= wall.minX - R + 1e-9,
    `a mover ${depth}m into a wall from the west must come back out west, not at x=${west[0]}`);
  const east = resolveCircleBox(wall.maxX - depth, -13, R, wall, wall.maxX + 1, -13);
  assert.ok(east[0] >= wall.maxX + R - 1e-9,
    `a mover ${depth}m into a wall from the east must come back out east, not at x=${east[0]}`);
}

// A prop embedded in that wall must not be able to squeeze anyone through it.
// The pillar overlaps the brick by 0.2m, exactly like a perk machine or a wall
// buy, and the mover is driven into the seam between the two at sprint speed.
const pillar = { minX: -32.0, maxX: -31.0, minZ: -13.6, maxZ: -12.4, y0: 0, h: 2.4 };
for (let i = 0; i <= 24; i++) {
  const startZ = -14.6 + i * 0.1;
  let [px, pz] = [wall.minX - R - 0.01, startZ];
  for (let f = 0; f < 120; f++) {
    [px, pz] = moveCircleWithColliders(px, pz, 8 / 60, 0, R, [wall, pillar]);
  }
  assert.ok(px <= wall.minX - R + 1e-6,
    `sprinting east into the wall/prop seam at z=${startZ.toFixed(1)} phased through to x=${px.toFixed(3)}`);
}

// Doors, windows and props must still eject a genuinely stuck mover — one that
// began the step inside the box has no entry side to honour.
const stuck = resolveCircleBox(-31.95, -13, R, wall, -31.95, -13);
assert.ok(stuck[0] >= wall.maxX + R - 1e-9, 'a mover with no entry side must still be pushed clear');

// ------------------------------------------------ stairs climb without a jump
// Behavioural, on the real flight geometry and the real resolver.
//
// A flight's colliders are one-way sides that release once you are on it, and
// the wall closing its high end used to be plain. A player is a 0.35m circle, so
// their body reaches that wall while their feet are still short of the landing:
// both balcony flights dead-ended 0.21m below the deck and had to be jumped. Any
// segment of any flight that is solid at the height the ramp puts your feet is
// the same bug, so this walks the whole run rather than checking the top step.
const FLIGHTS = [
  { id: 'labStairs', xLow: -13.175, xHigh: -8.775, zMin: -13.1, zMax: -10.9, yTop: 2.9, steps: 8, closeHighEnd: true },
  { id: 'garageStairs', xLow: 13.175, xHigh: 8.775, zMin: -13.1, zMax: -10.9, yTop: 2.9, steps: 8, closeHighEnd: true },
  { id: 'catwalkStairs', xLow: -12.6, xHigh: -8.4, zMin: -53.3, zMax: -50.7, yTop: 3.1, steps: 9 },
];

for (const flight of FLIGHTS) {
  const cols = stairFlightColliders({ ...flight, playerRadius: R });
  const run = flight.xHigh - flight.xLow;
  const treadY = (x) => flight.yTop * Math.min(1, Math.max(0, (x - flight.xLow) / run));
  const midZ = (flight.zMin + flight.zMax) / 2;
  // Start on the floor a stride short of the mouth and walk the flight at a
  // sprint, never leaving the ground.
  let x = flight.xLow - Math.sign(run) * 0.5, z = midZ;
  const stride = Math.sign(run) * (7 / 60);
  for (let f = 0; f < 600 && (flight.xHigh - x) * Math.sign(run) > 0; f++) {
    const feet = treadY(x);
    const active = cols.filter((c) => c.y0 <= feet + 1.6 && c.y0 + c.h >= feet + 0.02
      && platformSideBlocksAtFeet(c, feet + 0.02, feet));
    const [nx, nz] = moveCircleWithColliders(x, z, stride, 0, R, active);
    assert.ok(Math.abs(nx - x) > 1e-6,
      `${flight.id} stalls a walking climb at x=${x.toFixed(3)} with feet at ${feet.toFixed(3)}m of ${flight.yTop}m — the last of the climb needs a jump`);
    x = nx; z = nz;
  }
  assert.ok(Math.abs(treadY(x) - flight.yTop) < 1e-6,
    `${flight.id} did not reach its landing on foot (stopped at ${treadY(x).toFixed(3)}m)`);
  // Releasing for the climber must not open the flight up from below: the space
  // under the treads is structure, not a room. (The bottom step's own sides do
  // release at floor level — it is a true step you can walk onto from the side.)
  if (flight.closeHighEnd) {
    const wall = cols[cols.length - 1];
    assert.ok(platformSideBlocksAtFeet(wall, 0.02, 0),
      `${flight.id} must stay closed to anyone standing at floor level under it`);
  }
}

// ------------------------------------------------------------------ controls
assert.match(indexHtml, /<b>C<\/b> crouch/, 'the control legend must still document crouch');

console.log('Movement feel OK: key budget, momentum, slide edge, mantle, spring stability, solid walls, stair climbs, viewmodel isolation.');
