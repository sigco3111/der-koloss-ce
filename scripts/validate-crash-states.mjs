// Softlocks and unguarded wire input found in a systematic crash audit.
//
// None of these are crashes in the "exception on screen" sense. They are the
// worse kind: the game keeps running while something the player paid for is
// permanently gone, or a state machine is retried every frame with no exit.
// Each one is cheap to reintroduce and expensive to notice, so each gets a pin.
//
// Where an assertion is on source text rather than behaviour it is because the
// state needed is a mid-match co-op session with a disconnecting peer, which is
// not reachable from a headless harness. The text pinned is the specific
// expression that was wrong, not the general shape of the function.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THREE, loadGameModule } from './lib/headless-three.mjs';

const { buildMap } = await loadGameModule('map.js');
const game = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
const hellhoundFx = readFileSync(new URL('../js/render/HellhoundFX.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// moveBox: an out-of-range index must not half-apply (behavioural)
// ---------------------------------------------------------------------------
// `box_move` arrives from the wire. moveBox used to assign box.locIdx and THEN
// dereference box.locations[locIdx], so a bad index threw out of the peerjs data
// handler with the crate's index pointing at nothing while its mesh, collider
// and navmesh stayed put.
const map = buildMap(new THREE.Scene());
const start = map.box.locIdx;
for (const bad of [99, -1, undefined, NaN, 1e7, 'x', null, Infinity]) {
  map.moveBox(bad);
  assert.strictEqual(map.box.locIdx, start,
    `moveBox(${String(bad)}) changed locIdx instead of bailing`);
}
// A numeric string resolves by array-index coercion, so it must be normalised:
// the "pick a different spot" filter in game.js compares with !==, and '2' !== 2
// would leave the current location in the candidate list.
map.moveBox('2');
assert.strictEqual(map.box.locIdx, 2, 'a numeric-string index must be stored as a number');
map.moveBox(1);
assert.strictEqual(map.box.locIdx, 1, 'a valid index must still move the box');
assert.strictEqual(typeof map.box.locIdx, 'number', 'locIdx must always be a number');

// The caller must range-check too, so a bad index never reaches the map.
assert.match(game, /if \(!Number\.isInteger\(boxIdx\) \|\| boxIdx < 0 \|\| boxIdx >= this\.map\.box\.locations\.length\) break;/,
  'the box_move handler must range-check msg.idx');

// ---------------------------------------------------------------------------
// Pack-a-Punch must never eat the gun you paid for
// ---------------------------------------------------------------------------
// papTake did `this._papSlot() || p.weapon`. _papSlot() correctly returns null
// when the inserted gun is no longer in the player's hands — going down moves
// the whole loadout into _stashedWeapons and hands out a fresh m1911 — and the
// fallback then upgraded the DOWN PISTOL, which is discarded on revive. The real
// weapon stayed in the stash with `upgrading` still set, and switchWeapon
// refuses to select an upgrading slot, so it was unreachable for the rest of the
// run and the 5000 points were gone.
const papTake = game.slice(game.indexOf('papTake(notifyAuthority'));
assert.ok(!/_papSlot\(\)\s*\|\|\s*p\.weapon/.test(papTake.slice(0, 1600)),
  'papTake must not substitute the held weapon for the slot that went into the machine');
// And the upgrade still LANDS on that stashed slot: the cycle completed and the
// player paid 5000 for it, so the gun should be waiting upgraded on revive
// rather than merely unlocked.
assert.match(papTake.slice(0, 1800), /const stashed = this\.papState\.slot;[\s\S]{0,320}stashed\.pap = true;/,
  'papTake must still apply the upgrade to the recorded slot when it is no longer held');
assert.match(papTake.slice(0, 1800), /stashed\.upgrading = false;/,
  'papTake must clear `upgrading` on the recorded slot even when it is no longer held');

const cancel = game.slice(game.indexOf('_cancelLocalPapAttempt'));
assert.match(cancel.slice(0, 700), /this\._papSlot\(\) \|\| this\.papState\.slot/,
  '_cancelLocalPapAttempt leaks the same flag the same way — it must also reach the stashed slot');

// ---------------------------------------------------------------------------
// A guest's Pack-a-Punch must always have an exit
// ---------------------------------------------------------------------------
// In the ready branch the only escapes were `ownerIsMe` and `isAuthority`. A
// guest who is neither waits on the host's `pap_take` — and onPeerLeave cleared
// the host's state while sending nothing, so if the owner disconnected mid-cycle
// every other client sat on "Upgrading…" with a dead machine for the rest of the
// match. Verified 120s of frames with papState.busy true and t still falling.
assert.match(game, /this\.netSend\(\{ t: 'pap_take', pid: id, w: this\.papState\.weapon \}\);/,
  'onPeerLeave must notify the squad before clearing the host PaP state');
assert.match(game, /else if \(ps\.t < -\(PAP_READY_TIMEOUT_SECONDS \+ 10\)\) \{/,
  'a non-owner, non-authority client needs its own timeout out of the PaP ready branch');

// ---------------------------------------------------------------------------
// The mystery box prize must not go invisible
// ---------------------------------------------------------------------------
// Going idle removes the current prize from the crate group but leaves it in the
// per-weapon cache, so the next spin landing on the same weapon found it, set
// visible = true, and presented a mesh no longer in the scene: "take Thompson"
// over an empty crate, spreading to more weapons as the run went on.
assert.match(game, /if \(!m\.parent\) this\.map\.box\.group\.add\(m\);/,
  '_boxCycleShow must re-parent a cached prize that was removed from the crate group');

// ---------------------------------------------------------------------------
// Game over must fire when the squad is dead rather than down
// ---------------------------------------------------------------------------
// allPlayerStates() DROPS sources that are already dead, so once the last
// players die the list is empty — and the old `all.length > 0` guard made the
// condition false at exactly the moment it should be true. Nothing standing
// means the horde goes dormant, so the wave never finishes, the phase never
// reaches intermission, and respawnSelf is never called: no banner, no lobby,
// no respawn.
assert.ok(!/all\.length > 0 && all\.every\(\(pl\) => pl\.dead \|\| pl\.down\)/.test(game),
  'the game-over check must not require a non-empty player list');
assert.match(game, /const everyoneDead = this\.mode === 'solo'/,
  'the game-over check must still special-case solo');

// ---------------------------------------------------------------------------
// Board counts from the wire must be bounded
// ---------------------------------------------------------------------------
// The generic payload validator bounds magnitude at 1e7, not range. TEAR removes
// one board every 1.35s and only completes at zero, so a huge count makes the
// window untearable and its occupant immortal — the round could never end. Not
// reachable today (`barrier` is host-only and only the authority runs zombie AI)
// but one line of insurance against host migration.
assert.match(game, /clamp\(Math\.trunc\(Number\(msg\.n\)\) \|\| 0, 0, b\.maxBoards\)/,
  'an inbound board count must be clamped to the barrier capacity');

// ---------------------------------------------------------------------------
// The hellhound ember accumulator must not bank work while culled
// ---------------------------------------------------------------------------
// The drain loop is inside the 30m distance cull; the accumulator was not. A
// hound held at range for a whole dog round banked ~20 embers/s and spent the
// entire backlog in the one frame the player closed the distance.
assert.match(hellhoundFx, /Math\.min\(\(z\._emberAcc \|\| 0\) \+ dt \* rate, 4\)/,
  'the ember accumulator must be clamped so a culled hound cannot bank a spike');

console.log('✓ crash states: moveBox bails and normalises, PaP cannot eat a stashed weapon, '
  + 'guests can always leave the PaP ready branch, box prize re-parents, game over fires on a dead squad, '
  + 'board counts and ember backlog bounded');
