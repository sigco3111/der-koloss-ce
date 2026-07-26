import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PERK_DRINK_TIMELINE, PERK_IDS, perkDrinkPhase } from '../js/gameplay-rules.js';

assert.deepEqual(PERK_IDS, ['jug', 'speed', 'dtap', 'qr']);
assert.ok(PERK_DRINK_TIMELINE.raiseEnd < PERK_DRINK_TIMELINE.gulpEnd);
assert.ok(PERK_DRINK_TIMELINE.grantAt > PERK_DRINK_TIMELINE.raiseEnd);
assert.ok(PERK_DRINK_TIMELINE.grantAt < PERK_DRINK_TIMELINE.gulpEnd);
assert.ok(PERK_DRINK_TIMELINE.gulpEnd < PERK_DRINK_TIMELINE.throwAt);
assert.ok(PERK_DRINK_TIMELINE.throwAt < PERK_DRINK_TIMELINE.breakAt);
assert.ok(PERK_DRINK_TIMELINE.breakAt < PERK_DRINK_TIMELINE.belchAt);
assert.ok(PERK_DRINK_TIMELINE.belchAt - PERK_DRINK_TIMELINE.breakAt >= 0.35, 'belch must not be masked by the glass transient');
assert.ok(PERK_DRINK_TIMELINE.belchAt < PERK_DRINK_TIMELINE.duration);
assert.equal(perkDrinkPhase(0.1), 'raise');
assert.equal(perkDrinkPhase(0.8), 'drink');
assert.equal(perkDrinkPhase(1.9), 'lower');
assert.equal(perkDrinkPhase(2.4), 'throw');
assert.equal(perkDrinkPhase(3.0), 'finish');
assert.equal(perkDrinkPhase(9), 'done');

const [game, weapons, player, audio, net, assets, assetsPage] = await Promise.all([
  readFile(new URL('../js/game.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/weapons.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/player.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/audio.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/net.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/assets.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/assets-page.js', import.meta.url), 'utf8'),
]);

assert.match(game, /beginLocalPerkDrink\(perk\)/);
assert.match(game, /drink\.elapsed >= PERK_DRINK_TIMELINE\.grantAt/);
assert.match(game, /drink\.elapsed >= PERK_DRINK_TIMELINE\.breakAt/);
assert.match(game, /drink\.elapsed >= PERK_DRINK_TIMELINE\.belchAt/);
assert.match(game, /p\.perks\.has\(perk\.id\) \|\| this\.localPerkDrink/);
assert.match(game, /\(p\.down \|\| p\.dead\) && !drink\.granted/);
assert.match(weapons, /export function buildPerkBottle/);
assert.match(weapons, /new THREE\.LatheGeometry/);
// One spelling only: the bottle label must match the machine marquee, the HUD
// tooltip and MAP_PERKS, all of which say "Juggernog" (never "Jugger-Nog").
assert.match(weapons, /JUGGERNOG/);
assert.doesNotMatch(weapons, /JUGGER-NOG/);
assert.match(weapons, /SPEED COLA/);
assert.match(weapons, /DOUBLE TAP/);
assert.match(weapons, /QUICK REVIVE/);
assert.match(weapons, /mark: 'shield'/);
assert.match(weapons, /mark: 'bolt'/);
assert.match(weapons, /mark: 'double'/);
assert.match(weapons, /mark: 'revive'/);
assert.match(weapons, /perkBottleMaterials\.has\(id\)/, 'perk materials and label textures must be cached');
assert.doesNotMatch(weapons, /const PERK_BOTTLE_COLORS/, 'obsolete milk-bottle implementation returned');
assert.match(weapons, /get isDrinkingPerk\(\)/);
assert.match(weapons, /b\.rotation\.set\(1\.02 \+ Math\.sin/, 'first-person bottle neck must tilt toward the mouth');
assert.match(player, /startPerkDrink\(perkId\)/);
assert.match(player, /updatePerkDrink\(dt\)/);
assert.match(player, /b\.rotation\.set\(1\.15 \+ Math\.sin/, 'remote bottle neck must tilt toward the mouth');

// A drink starts from updateInteract, which runs AFTER the rig update, so a
// bottle that waits for the next frame to be posed renders once at its parent's
// origin — on the camera in first person, between the boots on a remote actor.
// Both spawn paths must pose the bottle before it is ever drawn.
{
  const rigStart = weapons.match(/startPerkDrink\(perkId\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(rigStart, 'WeaponRig.startPerkDrink not found');
  assert.match(rigStart, /posePerkBottle\(this\.perkBottle, 0\)/, 'first-person bottle must be posed on the frame it is created');
  assert.ok(
    rigStart.indexOf('posePerkBottle') < rigStart.indexOf('this.root.add'),
    'pose the first-person bottle before adding it to the rig',
  );
  assert.match(rigStart, /this\.current\.group\.visible = false/, 'the gun must go away on the same frame the bottle arrives');
  const remoteStart = player.match(/startPerkDrink\(perkId\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(remoteStart, 'RemotePlayer.startPerkDrink not found');
  assert.ok(
    /bottle\.position\.set\(/.test(remoteStart) && remoteStart.indexOf('bottle.position.set') < remoteStart.indexOf('this.group.add'),
    'remote bottle must be posed before it is added to the actor',
  );
}

// The grant lands at 1.56s, mid-gulp. A full-screen flash there reads as a
// glitch, not as feedback, and the post path drives a colourless uFlash so it
// cannot even be tinted to the perk. The HUD chip and the SFX carry the beat.
{
  const grantBlock = game.match(/drink\.granted = true;[\s\S]*?netSend\(\{ t: 'perk'/)?.[0];
  assert.ok(grantBlock, 'perk grant block not found');
  assert.doesNotMatch(grantBlock, /screenFlash/, 'no screen flash mid-gulp on perk grant');
}
assert.match(audio, /sfx_bottle_break\(o\)/);
assert.match(audio, /sfx_belch\(o\)/);
assert.match(net, /perk_anim: 1500/);
assert.match(assets, /['"]bottle_break['"]/);
assert.match(assets, /['"]belch['"]/);
assert.match(assets, /bottle_break: 'perk-v4'/);
assert.match(assets, /belch: 'perk-v4'/);
assert.match(assetsPage, /bottle_break/);
assert.match(assetsPage, /belch/);
assert.match(assetsPage, /bottle_break: 'perk-v4'/);
assert.match(assetsPage, /belch: 'perk-v4'/);
const hashes = new Set();
for (const filename of ['bottle_break.mp3', 'belch.mp3']) {
  const info = await stat(new URL(`../assets/audio/${filename}`, import.meta.url));
  assert.ok(info.size > 12000, `${filename} is missing or implausibly small`);
  const bytes = await readFile(new URL(`../assets/audio/${filename}`, import.meta.url));
  hashes.add(createHash('sha256').update(bytes).digest('hex'));
}
assert.equal(hashes.size, 2, 'glass break and belch must be distinct original assets');

console.log('Perk drink validation passed: cached branded soda props, distinct remastered SFX, ordered local/remote grant/throw/break/belch timing, and cleanup.');
