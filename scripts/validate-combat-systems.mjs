import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  chainArcTargetAllowed,
  dogHitZones,
  floorArcTargetAllowed,
  hitscanDamage,
  MAX_BULLET_PENETRATION,
  penetrationProfile,
  rayHitZones,
  shouldSpawnDogRoundReward,
  shotClaimBudget,
} from '../js/combat-rules.js';

const rifle = { cls: 'rifle', fire: 'hitscan', dmg: 100, penetrate: 3, falloff: 20 };
assert.deepEqual(penetrationProfile(rifle), { maxTargets: 3, retention: 0.68 });
// Penetration is a CLASS property with per-weapon overrides. It used to
// default to a single target, which meant every SMG, the pistol and both
// shotguns could not collateral at all — and those are the guns a player holds
// for most of a match. Assert the class floor explicitly so that regression
// cannot come back silently.
assert.equal(penetrationProfile({ cls: 'smg', dmg: 60 }).maxTargets, 2, 'SMGs must collateral');
assert.equal(penetrationProfile({ cls: 'pistol', dmg: 60 }).maxTargets, 2, 'pistols must collateral');
assert.equal(penetrationProfile({ cls: 'shotgun', pellets: 8 }).maxTargets, 2, 'shotgun pellets must collateral');
assert.equal(penetrationProfile({ cls: 'lmg', dmg: 90 }).maxTargets, 3);
assert.equal(penetrationProfile({ cls: 'sniper', dmg: 900 }).maxTargets, 4);
// Explosives resolve through blast radius, not penetration.
assert.equal(penetrationProfile({ cls: 'launcher' }).maxTargets, 1);
assert.equal(penetrationProfile({ cls: 'melee' }).maxTargets, 1);
// An explicit per-weapon value still wins over the class default, in both
// directions, and the hard ceiling still clamps.
assert.equal(penetrationProfile({ cls: 'smg', penetrate: 5 }).maxTargets, 5);
assert.equal(penetrationProfile({ cls: 'sniper', penetrate: 99 }).maxTargets, MAX_BULLET_PENETRATION);
// Damage must decay through the chain, never grow, and never reach zero.
{
  const smg = { cls: 'smg', dmg: 120 };
  const chain = [0, 1].map((i) => hitscanDamage(smg, 5, i));
  assert.ok(chain[1] < chain[0], 'penetrated bodies must take less damage');
  assert.ok(chain[1] > 0, 'a penetrated body must still take damage');
}
// The host's per-shot claim budget has to cover rays x bodies, or guest
// collateral would be rejected as over-claiming in co-op.
assert.equal(shotClaimBudget({ cls: 'shotgun', pellets: 8 }), 16);
assert.equal(shotClaimBudget({ cls: 'sniper', penetrate: 5 }), 5);
assert.equal(shotClaimBudget({ cls: 'smg', dmg: 60 }), 2);

// Host and guest use this exact calculation. Downstream bodies lose energy,
// while range falloff remains identical on either authority path.
assert.equal(hitscanDamage(rifle, 10, 0), 100);
assert.equal(hitscanDamage(rifle, 10, 1), 68);
assert.equal(hitscanDamage(rifle, 10, 2), 46);
assert.equal(hitscanDamage(rifle, 40, 0), 25);
assert.equal(hitscanDamage(rifle, 40, 1), 17);

const impact = { x: 0, y: 0, z: 0 };
assert.equal(floorArcTargetAllowed({ impact, target: { x: 2.2, y: 0.9, z: 0 }, visible: true }), true,
  'near-feet floor shot should seed the normal chain');
assert.equal(floorArcTargetAllowed({ impact, target: { x: 2.3, y: 0.9, z: 0 }, visible: true }), false,
  'floor shot beyond the strict radius must not chain');
assert.equal(floorArcTargetAllowed({ impact, target: { x: 1, y: 0.9, z: 0 }, visible: false }), false,
  'occluded floor target must not chain');
assert.equal(chainArcTargetAllowed({ from: { x: 0, y: 1, z: 0 }, target: { x: 8, y: 1, z: 0 }, radius: 8, visible: true }), true);
assert.equal(chainArcTargetAllowed({ from: { x: 0, y: 1, z: 0 }, target: { x: 8.01, y: 1, z: 0 }, radius: 8, visible: true }), false);
assert.equal(chainArcTargetAllowed({ from: { x: 0, y: 1, z: 0 }, target: { x: 2, y: 1, z: 0 }, radius: 8, visible: false }), false);

const normalize = (x, y, z) => {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
};
const dog = { x: 0, y: 0, z: 5, yaw: Math.PI, state: 5, stateT: 0.12, anim: 2 };
const localDogZones = dogHitZones(dog);
const origin = { x: 0, y: 1.55, z: 0 };
const centered = normalize(0, 0.70 - origin.y, 4.7);
const edge = normalize(0.38, 0.70 - origin.y, 4.7);
const outside = normalize(0.55, 0.70 - origin.y, 4.7);
assert.ok(rayHitZones({ origin, dir: centered, zones: localDogZones, maxDistance: 15 }),
  'close centered Trench ray must hit a lunging hound');
assert.ok(rayHitZones({ origin, dir: edge, zones: localDogZones, maxDistance: 15 }),
  'edge-of-body ray must hit the rendered flank');
assert.equal(rayHitZones({ origin, dir: outside, zones: localDogZones, maxDistance: 15 }), null,
  'ray outside the rendered silhouette must miss');
const localDogHit = rayHitZones({ origin, dir: centered, zones: localDogZones, maxDistance: 15 });
const remoteDogHit = rayHitZones({
  origin, dir: centered,
  zones: dogHitZones(dog, { interpolationAllowance: 0.16 }),
  maxDistance: 15,
  head: localDogHit.head,
});
assert.ok(remoteDogHit, 'every local hound hit must pass bounded host interpolation validation');

const trench = { cls: 'shotgun', dmg: 45, pellets: 8, spreadHip: 0.072, spreadAds: 0.052, falloff: 10 };
// 8 pellets x 2 bodies each: the host must budget for pellets that pass
// through, or a legitimate point-blank collateral would be rejected in co-op.
assert.equal(shotClaimBudget(trench), 16);
assert.equal(hitscanDamage(trench, 5, 0), 45, 'Trench Gun keeps full close-range pellet damage');
assert.equal(hitscanDamage(trench, 15, 0), 23, 'Trench Gun falls off meaningfully beyond its intended range');
assert.equal(hitscanDamage(trench, 30, 0), 11, 'Trench Gun cannot retain close damage at long range');

const dogReward = { spawned: false };
assert.ok(shouldSpawnDogRoundReward({ dogRound: true, victimDog: true, remaining: 0, alreadySpawned: dogReward.spawned }));
dogReward.spawned = true;
assert.equal(shouldSpawnDogRoundReward({ dogRound: true, victimDog: true, remaining: 0, alreadySpawned: dogReward.spawned }), false,
  'duplicate final-death callbacks cannot spawn a second guaranteed Max Ammo');
assert.equal(shouldSpawnDogRoundReward({ dogRound: false, victimDog: true, remaining: 0, alreadySpawned: false }), false,
  'normal rounds never receive the dog-round guarantee');
assert.equal(shouldSpawnDogRoundReward({ dogRound: true, victimDog: true, remaining: 1, alreadySpawned: false }), false,
  'only the final confirmed hound death triggers the reward');

const game = fs.readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
const weapons = fs.readFileSync(new URL('../js/weapons.js', import.meta.url), 'utf8');
const player = fs.readFileSync(new URL('../js/player.js', import.meta.url), 'utf8');
assert.equal((game.match(/hitscanDamage\(/g) || []).length, 2,
  'local and host-validated guest hits must share the damage rule');
assert.match(game, /this\.fireArc\(mw, s, w, dir\)/,
  'DG-2 local aim must reuse the direction submitted to the host');
assert.match(game, /floorImpact: s\.fire === 'arc'[\s\S]{0,180}_dg2FloorImpact/,
  'host must derive the floor impact from the authenticated shot claim');
assert.match(game, /const weapon = p\.weapon;[\s\S]{0,180}const token = this\._reloadToken/,
  'reload completion must be bound to the exact weapon slot and generation');
assert.match(game, /token !== this\._reloadToken \|\| p\.weapon !== weapon/,
  'weapon swaps must cancel delayed reload completion');
assert.match(player, /const cap = getStats\(this\.weapon\.id, this\.weapon\.pap\)\.mag;[\s\S]{0,120}this\.weapon\.mag = clamp/,
  'active weapon magazines must be clamped to the selected base or PaP variant before firing');
assert.match(player, /this\.monkeys = 0; this\.ownsMonkeys = false/,
  'Monkey Bomb ownership must be tracked separately from the remaining charge count');
assert.match(player, /if \(this\.ownsMonkeys\) this\.monkeys = 2/,
  'Max Ammo must refill owned Monkey Bombs even after the charge count reaches zero');
assert.match(game, /wid === 'monkey'[\s\S]{0,80}p\.ownsMonkeys = true/,
  'taking Monkey Bombs from the box must unlock future Max Ammo refills');
assert.match(game, /floorArcTargetAllowed\([\s\S]{0,180}_arcHasLineOfSight/);
assert.match(game, /chainArcTargetAllowed\([\s\S]{0,220}_arcHasLineOfSight/);

const weaponBlock = (id, nextId) => {
  const start = weapons.indexOf(`  ${id}: {`);
  const end = nextId ? weapons.indexOf(`  ${nextId}: {`, start + 1) : weapons.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, `missing weapon block ${id}`);
  return weapons.slice(start, end);
};
assert.match(weaponBlock('kar98', 'gewehr43'), /penetrate: 3/);
assert.match(weaponBlock('ptrs41', 'panzerschreck'), /penetrate: 5/);
assert.match(weaponBlock('bar', 'mg42'), /penetrate: 3/);
assert.doesNotMatch(weaponBlock('type100', 'mp40'), /penetrate:/);
assert.doesNotMatch(weaponBlock('dbshotgun', 'trench'), /penetrate:/);
assert.doesNotMatch(weaponBlock('ppsh', 'ump45'), /penetrate:/);
const trenchBlock = weaponBlock('trench', 'stg44');
assert.match(trenchBlock, /pellets: 8/);
assert.match(trenchBlock, /spreadHip: 0\.072, spreadAds: 0\.052/);
assert.match(trenchBlock, /falloff: 10/);
assert.match(game, /zones: dogHitZones\(z\)/);
assert.match(game, /dogHitZones\(zombie, \{ interpolationAllowance: 0\.16 \}\)/);
assert.match(game, /shouldSpawnDogRoundReward\([\s\S]{0,500}spawnDrop\('maxammo', z\.x, z\.z\)/);
assert.doesNotMatch(game, /guaranteed max ammo after dog round/);

const zombies = fs.readFileSync(new URL('../js/zombies.js', import.meta.url), 'utf8');
assert.match(zombies, /m\.rotation\.y = z\.yaw - \(z\.dog \? Math\.PI \/ 2 : 0\)/,
  'rendered hound forward axis must match its navigation and hit zones');

console.log('Combat systems OK: penetration, DG-2, hound anatomy, Trench falloff, and dog reward passed.');
