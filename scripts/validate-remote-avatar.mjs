// Guard the co-op avatar contract. Every assertion here corresponds to a bug
// that was actually in the shipped build, and every one of them is silent —
// nothing throws, the game just quietly shows the wrong thing to somebody.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const player = readFileSync(new URL('../js/player.js', import.meta.url), 'utf8');
const gear = readFileSync(new URL('../js/render/SoldierGear.js', import.meta.url), 'utf8');
const face = readFileSync(new URL('../js/render/SoldierFace.js', import.meta.url), 'utf8');
const zombies = readFileSync(new URL('../js/zombies.js', import.meta.url), 'utf8');
const game = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
const net = readFileSync(new URL('../js/net.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 0. THE HORDE KEEPS ITS SCREAM.
// ---------------------------------------------------------------------------
// SkeletonUtils.clone() shares geometry by reference: every zombie and every
// soldier point at the same BufferGeometry. The face reshape therefore MUST
// work on a clone. Writing the source in place would give all twenty-four
// corpses a calm, closed-mouth face and nothing would throw — the horde would
// just quietly stop being frightening.
assert.match(face, /const out = source\.clone\(\);/,
  'the face reshape must operate on a CLONE of the shipped geometry');
assert.ok(!/position\.setXYZ\(/.test(face.replace(/dst\.setXYZ\(/g, '')),
  'only the cloned position attribute (dst) may be written, never the source');
assert.match(face, /const _cache = new WeakMap\(\)/,
  'reshaped heads must be cached per source geometry, not rebuilt per soldier');
assert.ok(!/SoldierFace/.test(zombies),
  'js/zombies.js must never import the soldier face reshape');
// Only the soldier avatar may call it, and only on its own clone.
const faceCalls = [...player.matchAll(/humaniseSoldierFace\(/g)];
assert.strictEqual(faceCalls.length, 1, 'the face reshape must be invoked exactly once, on the soldier clone');
assert.match(player, /this\.inner = skClone\(src\.scene\);[\s\S]{0,400}?humaniseSoldierFace\(this\.inner\)/,
  'the reshape must run on the freshly cloned rig, before anything measures it');
// ---------------------------------------------------------------------------
// 0a. THE HORDE KEEPS ITS EMPTY SOCKETS.
// ---------------------------------------------------------------------------
// The shipped atlas is a grid of flat swatches: the entire eye socket samples
// ONE near-black texel and there is no UV space to paint an eye into. So the
// soldiers' sockets are given UVs of their own, pointing at a patch that
// js/player.js paints an eye into. Both halves of that have to stay on the
// soldier side of the fence, or the horde gets eyes and stops being frightening.
assert.match(face, /export const EYE_PATCH/,
  'the eye patch rect must be exported, so the atlas painter and the UVs agree');
assert.match(face, /const outUV = out\.attributes\.uv;/,
  'eye UVs must be written on the CLONE (out), never on the source geometry');
assert.ok(!/\buv\.setXY\(/.test(face),
  'the source UV attribute must never be written — that is the horde\'s copy');
// The paint goes on the per-persona canvas, after the recolour, and only there.
assert.match(player, /g\.putImageData\(d, 0, 0\);[\s\S]{0,900}?paintSoldierEye\(g, c\.width, look, face\)/,
  'the eye must be painted onto the per-persona canvas AFTER the recolour pass');
const paintCalls = [...player.matchAll(/paintSoldierEye\(/g)];
assert.strictEqual(paintCalls.length, 2, 'paintSoldierEye must be defined once and called once');
assert.match(player, /const _atlasCache = new Map\(\);/,
  'the painted atlas must stay cached per persona — it is a full 512x512 repaint');
// The tongue is its own bone chain and no geometry edit reaches it.
assert.match(player, /B\.Tongue1\.scale\.setScalar\(0\.001\)/,
  'the tongue must be retracted — geometry edits do not touch the tongue chain');

// ---------------------------------------------------------------------------
// 0b. Proportions.
// ---------------------------------------------------------------------------
// The thigh is lengthened by moving the knee BONE. Scaling it instead shears
// every rotated child below it, and the knee rotates in every locomotion clip.
assert.match(player, /knee\.position\.y = this\._restKneeY \* LEG_STRETCH/,
  'the thigh must be lengthened by moving the knee bone, not by scaling it');
assert.ok(!/UpperLeg[LR]: \[[\d.]+, (?!1[,\]])/.test(gear),
  'leg bones must not be scaled along Y — it shears the shin');
// The IK solves in world metres, so its segment lengths have to be measured
// after the height calibration rescales the rig. Measuring before it sends the
// knees hunting sideways for targets in the wrong units.
const calibrateAt = player.indexOf('this.inner.scale.multiplyScalar(f2)');
const legMeasureAt = player.indexOf('this.legLengths = [hip.distanceTo(knee)');
assert.ok(calibrateAt > -1 && legMeasureAt > calibrateAt,
  'leg segment lengths must be measured AFTER the final height calibration');

// ---------------------------------------------------------------------------
// 1. The teammate you see must not be carrying first-person hands.
// ---------------------------------------------------------------------------
// buildViewmodel returns the gun WITH a gloved-hands group attached; only
// buildDisplayWeapon strips it. Using the wrong one puts a spare pair of hands
// floating in the middle of every teammate, and it looks fine in a screenshot
// taken from the front.
assert.ok(player.includes('buildDisplayWeapon'),
  'the remote avatar must build its held weapon with buildDisplayWeapon');
assert.ok(!/\bbuildViewmodel\b/.test(player),
  'player.js must never import or call buildViewmodel — it carries first-person gloves');

// ---------------------------------------------------------------------------
// 2. Gear is bone-parented, never free-floating.
// ---------------------------------------------------------------------------
// The whole point of the gear module is that a helmet is a child of the Head
// bone. An `add` onto anything but a bone means it will slide off the body the
// moment the animation moves.
assert.match(gear, /bone\.add\(mesh\)/,
  'gear meshes must be parented to their bone');
assert.match(gear, /mesh\.quaternion\.copy\(_scratchQuat\)\.invert\(\)/,
  'mounts must cancel the bone rest rotation — bone axes are not world axes');
// The bone chain scale is strongly non-uniform — LIMB_SHAPE narrows the hips,
// abdomen and torso across X and Z only, and that compounds, so the Head bone
// ends up roughly twice as tall as it is wide. Cancelling the MEAN of that left
// head gear 1.4x too tall and 0.7x too narrow and put the torso collar above
// the crown: the cap, hair and beard closed over the face and every marine
// rendered as a black block. The cancel must be per axis, and it must come
// after the rest rotation is undone or it really would shear.
assert.match(gear, /mesh\.quaternion\.copy\(_scratchQuat\)\.invert\(\);[\s\S]{0,1200}?mesh\.scale\.set\(\s*1 \/ Math\.max\(1e-4, Math\.abs\(_scratchScale\.x\)\)/,
  'mounts must cancel the bone world scale PER AXIS, after undoing the rest rotation');
assert.ok(!/mesh\.scale\.setScalar\(/.test(gear),
  'a uniform mount scale cannot cancel a non-uniform bone chain — see above');
assert.ok(!/boneName === 'Head'\) s \*= HEAD_SCALE/.test(gear),
  'head gear must not pre-divide HEAD_SCALE: _applyRig has already squashed the '
  + 'head bone by the time gear is attached, so that made every helmet 1/0.42 too big');

// ---------------------------------------------------------------------------
// 3. The pose layer must not accumulate.
// ---------------------------------------------------------------------------
// three's PropertyMixer skips writing a bone whose clip value has not changed
// since the last write. Post-multiplying a correction onto such a bone without
// restoring the clip pose first compounds it every frame, and the spine rolls
// through 180 degrees within seconds. This is the single nastiest bug in this
// area and it only shows up on bones that are momentarily still.
assert.match(player, /this\._clipQ/,
  'the pure clip pose must be cached so it can be restored before the mixer runs');
const updateBody = player.slice(player.indexOf('  update(dt) {\n    // Hand the skeleton back'));
const restoreAt = updateBody.indexOf('b.quaternion.copy(clip[name])');
const mixerAt = updateBody.indexOf('this.mixer.update(dt)');
assert.ok(restoreAt > -1 && mixerAt > -1 && restoreAt < mixerAt,
  'SoldierVisual.update must restore the cached clip pose BEFORE mixer.update');

// ---------------------------------------------------------------------------
// 4. The four must not be interchangeable.
// ---------------------------------------------------------------------------
// Silhouette is what reads at distance: headgear first, then coat length, then
// pack. Colour alone is what the old avatar did and it was why nobody could
// tell the squad apart.
const looks = [...gear.matchAll(/id: '(\w+)',[\s\S]*?headgear: '([\w_]+)', coat: '(\w+)', pack: '(\w+)',/g)]
  .map(([, id, headgear, coat, pack]) => ({ id, headgear, coat, pack }));
assert.strictEqual(looks.length, 4, 'there must be exactly four personas');
assert.deepStrictEqual(looks.map((l) => l.id), ['dempsey', 'nikolai', 'takeo', 'richtofen'],
  'persona order must match the order game.js resolves them in');
for (const key of ['headgear', 'coat', 'pack']) {
  const values = looks.map((l) => l[key]);
  assert.strictEqual(new Set(values).size, 4,
    `all four personas must have a distinct ${key} — that is what reads at range`);
}
// Takeo wears a soft field cap with neck flaps, NOT a stiff peaked visor cap.
assert.strictEqual(looks[2].headgear, 'havelock',
  'Takeo must wear the soft field cap with neck flaps, not a peaked visor cap');

// ---------------------------------------------------------------------------
// 5. No Nazi insignia, ever.
// ---------------------------------------------------------------------------
// Comments are stripped first: the module documents the constraint in prose
// ("no eagle, no wreath, no insignia of any kind"), and that sentence is the
// thing we want kept, not flagged.
const gearCode = gear.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const word of ['swastika', 'hakenkreuz', 'ssrune', 'ss_rune', 'reichsadler', 'wreath', 'eagle']) {
  assert.ok(!new RegExp(word, 'i').test(gearCode),
    `the gear module must contain no ${word} — period silhouettes only`);
}

// ---------------------------------------------------------------------------
// 6. Host/guest parity on gunfire.
// ---------------------------------------------------------------------------
// A guest receives every reliable message labelled 'host', so resolving the
// shooter from `from` meant a guest saw NOBODY's muzzle flash — not the host's
// (wrong id) and not another guest's (never relayed at all). Both halves of
// that fix have to stay.
assert.match(game, /t: 'shoot', pid: p\.id/,
  "the local shot must carry `pid` so a guest can attribute it to the shooter");
assert.match(game, /const shooterId = msg\.pid \|\| from;/,
  'the shoot handler must resolve the shooter from `pid`, falling back to `from`');
assert.match(net, /'pap_take', 'shoot'\]\.includes\(msg\.t\)\) msg\.pid = fromId/,
  'the host must stamp the shooter id itself rather than trust the sender');
const shootCase = net.slice(net.indexOf("      case 'shoot': {"), net.indexOf("      case 'hello': {"));
assert.ok(shootCase.includes('this._broadcastRel(msg)'),
  'the host must relay guest shots, or guest-to-guest gunfire is invisible');
assert.ok(shootCase.includes('SHOT_RELAY_MIN_MS'),
  'the shot relay must be throttled — it shares the reliable channel with the combat feed');
// Damage arbitration stays host-only; a guest building claim ledgers is waste
// at best and a divergence at worst.
const handler = game.slice(game.indexOf("      case 'shoot': {"), game.indexOf("      case 'grenade': {"));
assert.ok(handler.indexOf('if (this.isAuthority) {') < handler.indexOf('remoteClaims.push('),
  'remote shot claims must be built only on the authority');
// The anti-cheat that was already there must survive the rework.
for (const guard of ['remoteWeaponClaimAllowed', '_remoteActionReady']) {
  assert.ok(handler.includes(guard), `the shoot handler must keep its ${guard} guard`);
}

// ---------------------------------------------------------------------------
// 7. Transmitted state must actually reach the avatar.
// ---------------------------------------------------------------------------
// pitch, weapon, PaP and stance were all on the wire already and all ignored.
for (const [call, why] of [
  ['v.setWeapon(this.weaponId, this.weaponPap)', 'the held weapon'],
  ['v.setAim(this._aim)', 'aim pitch'],
  ['v.setCrouch(this._crouchBlend)', 'stance'],
]) {
  assert.ok(player.includes(call), `the avatar must be driven by ${why} from the wire`);
}
assert.match(player, /damp\(this\._aim \?\? 0/, 'remote aim must be interpolated, not snapped');

// ---------------------------------------------------------------------------
// 8. Cost control.
// ---------------------------------------------------------------------------
// At most three remote avatars are ever on screen, but a persona's geometry is
// built once for the process and shared. Rebuilding per avatar would leak for
// the whole session, exactly as it would for the horde.
assert.match(gear, /const _pool = new Map\(\)/, 'the wardrobe must be pooled per persona');
assert.match(gear, /_pool\.set\(look\.id, wardrobe\)/, 'the built wardrobe must be cached');
assert.ok(/Deliberately does NOT dispose geometry/.test(gear),
  'detach must not dispose shared geometry — it would undress the whole squad');
assert.match(player, /this\._weaponCache/, 'held weapons must be cached per id+PaP');
assert.match(gear, /export function setSoldierGearLOD/, 'distant avatars must be able to shed gear');

console.log('remote avatar invariants OK: horde/soldier geometry separation, gear parenting,\n  pose stability, proportions, persona silhouettes, host/guest fire parity');
