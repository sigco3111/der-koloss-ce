import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createConcurrencyGate,
  MIN_BOX_WEAPON_RESULTS_BEFORE_TEDDY,
  mysteryBoxTeddyChance,
  ROUND_INTERMISSION_SECONDS,
} from '../js/gameplay-rules.js';

assert.equal(MIN_BOX_WEAPON_RESULTS_BEFORE_TEDDY, 2);
assert.equal(mysteryBoxTeddyChance(0), 0, 'first spin must return a weapon');
assert.equal(mysteryBoxTeddyChance(1), 0, 'second spin must return a weapon');
assert.ok(mysteryBoxTeddyChance(2) > 0, 'Teddy may become eligible on the third use');
assert.equal(mysteryBoxTeddyChance(100), 0.28, 'Teddy chance remains capped');

const dogVoices = createConcurrencyGate(2);
assert.equal(dogVoices.tryAcquire(), true);
assert.equal(dogVoices.tryAcquire(), true);
assert.equal(dogVoices.tryAcquire(), false, 'third concurrent dog voice must be rejected');
dogVoices.release();
assert.equal(dogVoices.tryAcquire(), true, 'a finished voice returns capacity');
dogVoices.release(); dogVoices.release(); dogVoices.release();
assert.equal(dogVoices.active, 0, 'extra releases cannot underflow the gate');

assert.equal(ROUND_INTERMISSION_SECONDS, 8);
const game = fs.readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
assert.match(game, /phase = 'intermission';[\s\S]{0,400}if \(this\.player\.dead\) this\.respawnSelf\(\);[\s\S]{0,200}t: 'intermission'/,
  'authority must respawn at intermission and announce it');
assert.doesNotMatch(game, /beginRound\(n\)[\s\S]{0,700}if \(this\.player\.dead\) this\.respawnSelf\(\)/,
  'next-round start must not own respawn timing');
assert.match(game, /case 'intermission':[\s\S]{0,300}if \(this\.player\.dead\) this\.respawnSelf\(\)/,
  'clients must respawn on the intermission event');
assert.match(game, /case 'respawn':[\s\S]{0,500}if \(this\.isAuthority\) this\.netSend\(msg\)/,
  'host must relay a client respawn so every peer clears the dead state');

const net = fs.readFileSync(new URL('../js/net.js', import.meta.url), 'utf8');
assert.match(net, /HOST_ONLY_EVENTS[\s\S]{0,500}'intermission'/);

console.log('Round systems OK: Teddy floor, dog voice cap, and intermission respawn validated.');
