import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CFG } from '../js/config.js';
import {
  availableLobbyColor,
  acceptPendingCredit,
  boundedPelletDirectionAllowed,
  consumeBoardCredit,
  consumeCreditClaim,
  departedLobbyPlayers,
  isValidNetworkPayload,
  isValidSnapshotPayload,
  killCreditPresentation,
  multiplayerRosterPresentation,
  multiplayerExitDestination,
  peerConnectionIsCurrent,
  removeLobbyPeer,
  remoteShotTargetAllowed,
  remoteSwapSource,
  remoteWeaponClaimAllowed,
  sanitizePerkAnimation,
  shouldHandleRemoteClose,
  shouldRefreshLobbyUi,
  shouldShowGameplayCanvas,
  stableClientReplacement,
  stalePeerIds,
} from '../js/multiplayer-contracts.js';

assert.equal(isValidNetworkPayload({ t: 'ready', ready: true }), true);
assert.equal(isValidNetworkPayload({ t: 'bad', value: Number.POSITIVE_INFINITY }), false);
assert.equal(isValidNetworkPayload({ t: 'bad', value: 'x'.repeat(161) }), false);
assert.equal(isValidNetworkPayload({ t: 'bad', value: Array.from({ length: 65 }, () => 1) }), false);
const validSnapshot = {
  t: 'snap',
  pl: [{ id: 'host', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }],
  z: [[1, 0, 0, 0, 0, 4, 150, 0, 0]],
  round: 1,
};
assert.equal(isValidSnapshotPayload(validSnapshot), true);
assert.equal(isValidSnapshotPayload({ ...validSnapshot, pl: Array(5).fill(validSnapshot.pl[0]) }), false);
assert.equal(isValidSnapshotPayload({ ...validSnapshot, z: [[1, 0]] }), false);
assert.equal(isValidSnapshotPayload({ ...validSnapshot, z: [[1, 0, 0, 0, 0, 99, 150, 0, 0]] }), false);

const origin = { x: 0, y: 1.5, z: 0 };
const forward = { x: 0, y: 0, z: -1 };

// Snapshot interpolation can leave a close moving zombie well outside its tiny
// visual hit sphere by validation time; bounded reconciliation must accept it.
assert.equal(remoteShotTargetAllowed({
  origin, dir: forward, target: { x: 0.65, y: 1.5, z: -3 }, wallDistance: 4,
}), true, 'legitimate latency-offset guest shot is accepted');
assert.equal(remoteShotTargetAllowed({
  origin, dir: forward, target: { x: 0, y: 1.5, z: 3 }, wallDistance: 10,
}), false, 'backwards claim is rejected');
assert.equal(remoteShotTargetAllowed({
  origin, dir: forward, target: { x: 0, y: 1.5, z: -8 }, wallDistance: 4,
}), false, 'through-wall claim is rejected');
assert.equal(remoteShotTargetAllowed({
  origin, dir: forward, target: { x: 0, y: 1.5, z: -130 }, wallDistance: 140,
}), false, 'out-of-range claim is rejected');

assert.equal(boundedPelletDirectionAllowed(forward, { x: 0.06, y: 0.03, z: -0.998 }, 0.05), true,
  'shotgun pellet inside the transmitted center cone is accepted');
assert.equal(boundedPelletDirectionAllowed(forward, { x: 0.4, y: 0, z: -0.916 }, 0.05), false,
  'shotgun pellet cannot redirect a center shot outside bounded spread');

const remoteLoadout = { weaponId: 'kar98', weaponPap: false };
assert.equal(remoteWeaponClaimAllowed(remoteLoadout, 'kar98', false), true);
assert.equal(remoteWeaponClaimAllowed(remoteLoadout, 'dg2', false), false, 'unowned weapon spoof is rejected');
assert.equal(remoteWeaponClaimAllowed(remoteLoadout, 'kar98', true), false, 'PaP spoof is rejected');

const ownedWeapons = new Map([['kar98', false]]);
const spawnWeaponAllowance = new Map([['dg2', true]]);
assert.equal(remoteSwapSource({ weaponId: 'kar98', claimedPap: true, ownedWeapons }), 'owned',
  'equipping an owned weapon cannot mutate its host-owned PaP flag');
assert.equal(remoteSwapSource({ weaponId: 'dg2', claimedPap: true, ownedWeapons, spawnWeaponAllowance }), 'spawn');
assert.equal(remoteSwapSource({ weaponId: 'dg2', claimedPap: false, ownedWeapons, spawnWeaponAllowance }), null,
  'spawn-loadout PaP mismatch is rejected');
assert.equal(remoteSwapSource({ weaponId: 'mg42', ownedWeapons }), null, 'unvalidated arbitrary swap is rejected');
assert.equal(remoteSwapSource({ weaponId: 'type100', ownedWeapons, nearMatchingWallbuy: true }), 'wallbuy');
assert.equal(remoteSwapSource({ weaponId: 'raygun', ownedWeapons, readyBoxWeapon: 'raygun' }), 'box');
assert.equal(remoteSwapSource({ weaponId: 'raygun', claimedPap: true, ownedWeapons, readyBoxWeapon: 'raygun' }), null,
  'box acquisition cannot spoof PaP');

const hostCreditLedger = new Set();
assert.equal(consumeCreditClaim(hostCreditLedger, 71), true, 'first authenticated hit claim is consumed');
assert.equal(consumeCreditClaim(hostCreditLedger, 71), false, 'duplicate hit claim is rejected');
assert.equal(consumeCreditClaim(hostCreditLedger, -1), false, 'malformed hit claim is rejected');
const boardCredits = new Set();
assert.equal(consumeBoardCredit(boardCredits, 'barrier-a:1'), true, 'accepted board rebuild awards once');
assert.equal(consumeBoardCredit(boardCredits, 'barrier-a:1'), false, 'echoed board credit awards zero');
assert.equal(consumeBoardCredit(boardCredits, ''), false, 'malformed board credit awards zero');
const pendingCredits = new Map([[71, { at: 1000, hit: false, kill: false }]]);
assert.equal(acceptPendingCredit(pendingCredits, 71, 'hit', 1200), true, 'accepted host hit credit awards once');
assert.equal(acceptPendingCredit(pendingCredits, 71, 'hit', 1250), false, 'duplicate host hit credit awards zero');
assert.equal(acceptPendingCredit(pendingCredits, 71, 'kill', 1300), true, 'same accepted hit may receive one kill reward');
assert.equal(acceptPendingCredit(pendingCredits, 71, 'kill', 1400), false, 'duplicate kill credit awards zero');
pendingCredits.set(72, { at: 1000, hit: false, kill: false });
assert.equal(acceptPendingCredit(pendingCredits, 72, 'hit', 10001), false, 'late credit awards zero');
assert.equal(acceptPendingCredit(pendingCredits, 999, 'hit', 1200), false, 'unrequested credit awards zero');

assert.deepEqual(killCreditPresentation(), { basePoints: 60, displayedPoints: 60, color: '#e8e4d8' });
assert.deepEqual(killCreditPresentation({ head: true }), { basePoints: 100, displayedPoints: 100, color: '#ffd24a' });
assert.equal(killCreditPresentation({ knife: true }).basePoints, 130, 'knife kill uses the configured personal reward');
assert.equal(killCreditPresentation({ doubleActive: true }).displayedPoints, 120, 'Double Points doubles normal kill popup');
assert.equal(killCreditPresentation({ head: true, doubleActive: true }).displayedPoints, 200, 'Double Points doubles headshot popup');
assert.equal(killCreditPresentation({ knife: true, doubleActive: true }).displayedPoints, 260, 'Double Points doubles knife popup');

const oldLobby = [{ id: 'host', name: 'Host' }, { id: 'guest-a', name: 'Alice' }, { id: 'guest-b', name: 'Bob' }];
const nextLobby = [{ id: 'host', name: 'Host' }, { id: 'guest-b', name: 'Bob' }];
assert.deepEqual(departedLobbyPlayers(oldLobby, nextLobby, 'host'), [{ id: 'guest-a', name: 'Alice' }]);
assert.deepEqual(departedLobbyPlayers(oldLobby, [], 'guest-a').map((p) => p.id), ['host', 'guest-b']);

assert.equal(multiplayerExitDestination({ mode: 'solo', gameOver: true }), 'menu');
assert.equal(multiplayerExitDestination({ mode: 'host', gameOver: true }), 'lobby');
assert.equal(multiplayerExitDestination({ mode: 'client', hostEnded: true }), 'lobby');
assert.equal(multiplayerExitDestination({ mode: 'client' }), 'menu');

assert.deepEqual(
  sanitizePerkAnimation('authenticated-guest', { id: 'jug', pid: 'spoofed-host' }),
  { t: 'perk_anim', pid: 'authenticated-guest', id: 'jug' },
  'perk animation identity comes from the authenticated sender, never payload pid',
);
for (const id of ['jug', 'speed', 'dtap', 'qr']) {
  assert.equal(sanitizePerkAnimation('guest', { id })?.id, id);
}
assert.equal(sanitizePerkAnimation('guest', { id: 'godmode' }), null);
assert.equal(sanitizePerkAnimation('', { id: 'jug' }), null);

assert.equal(shouldShowGameplayCanvas('game', true), true);
assert.equal(shouldShowGameplayCanvas('pause', true), true);
assert.equal(shouldShowGameplayCanvas('options', true), true);
assert.equal(shouldShowGameplayCanvas('lobby', false), false);
assert.equal(shouldShowGameplayCanvas('menu', false), false);
// The game screen shows the canvas unconditionally. Gating it on the game
// existing meant a showScreen('game') that landed one tick before app.game was
// assigned hid the canvas forever: the renderer kept drawing into
// display:none, so the player saw black with a working HUD and had to reload.
assert.equal(shouldShowGameplayCanvas('game', false), true);
assert.equal(shouldRefreshLobbyUi('lobby', false), true);
assert.equal(shouldRefreshLobbyUi('cheats', false), true);
assert.equal(shouldRefreshLobbyUi('game', true), false);
assert.equal(shouldRefreshLobbyUi('pause', true), false);

assert.equal(shouldHandleRemoteClose({ connected: true }), true);
assert.equal(shouldHandleRemoteClose({ connected: true, intentional: true }), false);
assert.equal(shouldHandleRemoteClose({ connected: true, handled: true }), false);
assert.equal(shouldHandleRemoteClose({ connected: false }), false);

const heartbeatPeers = new Map([
  ['active', { authenticated: true, lastSeen: 19_000 }],
  ['stale', { authenticated: true, lastSeen: 900 }],
  ['half-open', { authenticated: false, lastSeen: 0 }],
]);
assert.deepEqual(stalePeerIds(heartbeatPeers, 21_000, 20_000), ['stale']);
assert.deepEqual(stalePeerIds(heartbeatPeers, 21_000, -1), []);
assert.equal(stableClientReplacement(new Map([['stable-a', 'old-peer']]), 'stable-a', 'new-peer'), 'old-peer');
assert.equal(stableClientReplacement(new Map([['stable-a', 'same-peer']]), 'stable-a', 'same-peer'), null);

const hostAndGuest = [
  { id: 'host', name: 'Host', color: 0, host: true },
  { id: 'guest', name: 'Guest', color: 1, host: false },
];
const firstDeparture = removeLobbyPeer(hostAndGuest, 'guest');
const duplicateDeparture = removeLobbyPeer(firstDeparture.players, 'guest');
assert.equal(firstDeparture.departed?.id, 'guest');
assert.deepEqual(firstDeparture.players.map((player) => player.id), ['host'], 'explicit/abrupt cleanup never removes the host');
assert.equal(duplicateDeparture.departed, null, 'close + error + timeout cleanup is idempotent');
assert.equal(duplicateDeparture.players, firstDeparture.players, 'duplicate cleanup does not churn lobby state');
assert.equal(removeLobbyPeer(hostAndGuest, 'half-open').departed, null, 'unauthenticated half-open transport has no visible departure');

const reusedConnection = {};
const oldRecord = { r: reusedConnection };
const replacementRecord = { r: {} };
const connectionPeers = new Map([['reused-id', oldRecord]]);
assert.equal(peerConnectionIsCurrent(connectionPeers, 'reused-id', oldRecord, 'r', reusedConnection), true);
connectionPeers.set('reused-id', replacementRecord);
assert.equal(peerConnectionIsCurrent(connectionPeers, 'reused-id', oldRecord, 'r', reusedConnection), false,
  'late close/error/data from an old connection cannot act on its replacement');

const fullLobby = [
  { id: 'host', color: 0, host: true },
  { id: 'old-peer', color: 1, host: false },
  { id: 'guest-2', color: 2, host: false },
  { id: 'guest-3', color: 3, host: false },
];
const rejoinRemoval = removeLobbyPeer(fullLobby, 'old-peer');
const replacementColor = availableLobbyColor(rejoinRemoval.players, rejoinRemoval.departed.color, 4);
const rejoinedLobby = [...rejoinRemoval.players, { id: 'new-peer', color: replacementColor, host: false }];
assert.deepEqual(rejoinedLobby.map((player) => player.id), ['host', 'guest-2', 'guest-3', 'new-peer']);
assert.deepEqual(new Set(rejoinedLobby.map((player) => player.color)), new Set([0, 1, 2, 3]),
  'stable rejoin frees its slot and preserves a unique player color');

const unsafeRoster = [
  { id: 'host', name: '  Alice\u0000   Host  ', persona: 'dempsey', c: 1, points: 1234.9, mic: true, speaking: true },
  { id: 'guest', name: '<img onerror=boom>', marine: 'Field Medic', color: -2, points: Number.POSITIVE_INFINITY, micEnabled: true },
  { id: 'guest', name: '', persona: 'not-real', color: 'bad', points: -80, speaking: true },
  null,
  { id: 'fifth', name: 'Must be capped' },
];
const roster = multiplayerRosterPresentation(true, unsafeRoster);
assert.equal(roster.visible, true);
assert.equal(roster.rows.length, 4, 'compact roster is capped at four players');
assert.deepEqual(roster.rows[0], {
  id: 'host', name: 'Alice Host', persona: 'Tank Dempsey', color: CFG.COLORS[1], colorIndex: 1,
  points: 1234, voice: 'speaking',
});
assert.equal(roster.rows[1].name, '<img onerror=b', 'names are bounded and remain inert text for textContent rendering');
assert.equal(roster.rows[1].points, 0, 'non-finite points never reach the HUD');
assert.equal(roster.rows[1].voice, 'idle');
assert.equal(roster.rows[2].id, 'guest-2', 'duplicate DOM keys are made unique');
assert.equal(roster.rows[2].persona, 'Soldier');
assert.equal(roster.rows[2].points, 0);
assert.equal(roster.rows[2].voice, 'muted', 'speaking cannot be presented without an enabled microphone');
assert.notEqual(
  roster.signature,
  multiplayerRosterPresentation(true, [{ ...unsafeRoster[0], points: 1235 }]).signature,
  'synchronized point changes invalidate the render signature',
);
assert.equal(
  roster.signature,
  multiplayerRosterPresentation(true, unsafeRoster).signature,
  'equivalent presentation produces a stable render signature',
);
assert.deepEqual(multiplayerRosterPresentation(false, unsafeRoster), { visible: false, signature: 'solo', rows: [] });
assert.deepEqual(multiplayerRosterPresentation(true, null), { visible: true, signature: 'multi:', rows: [] });

// A duplicate lobby packet after a departure cannot emit a second soldier
// removal, even if close and error handlers both fired for the same peer.
assert.equal(departedLobbyPlayers(oldLobby, nextLobby, 'host').length, 1);
assert.equal(departedLobbyPlayers(nextLobby, nextLobby, 'host').length, 0);

const [netSource, mainSource, gameSource, playerSource, hudSource, indexHtml, styleSource] = await Promise.all([
  readFile(new URL('../js/net.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/game.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/player.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/hud.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../style.css', import.meta.url), 'utf8'),
]);

assert.match(netSource, /voiceEnabled: this\.lobbyVoiceEnabled/);
assert.match(netSource, /this\.lobbyVoiceEnabled = msg\.voiceEnabled === true/);
assert.match(netSource, /if \(!this\.lobbyVoiceEnabled \|\| this\.myStream/);
assert.match(netSource, /if \(this\._enableVoicePromise\) return this\._enableVoicePromise/);
assert.match(netSource, /requestGeneration !== this\._voiceRequestGeneration/);
assert.match(netSource, /perk_anim: 1500/);
assert.match(netSource, /'hitcredit', 'killcredit'/);
assert.match(netSource, /shoot: 25, zhit: 0, zsplash: 100/);
assert.match(netSource, /this\._mediaConnections\.get\(mc\.peer\) !== mc/);
assert.match(netSource, /generation !== this\._voiceRequestGeneration \|\| !this\._isAllowedVoicePeer/);
assert.match(netSource, /const event = sanitizePerkAnimation\(fromId, msg\)/);
assert.match(netSource, /this\._broadcastRel\(event\)/);
assert.match(netSource, /leave\(\) \{\s*this\._intentionalLeave = true;[\s\S]{0,220}send\(\{ t: 'leave' \}\);[\s\S]{0,120}this\._teardown\(\)/);
assert.match(netSource, /const onClosed = this\.onClosed;\s*this\._teardown\(\);\s*onClosed\?\.\(reason\)/);
const dropPeerSource = netSource.slice(netSource.indexOf('_dropPeer(id,'), netSource.indexOf('_hostData(fromId'));
assert.ok(
  dropPeerSource.indexOf('this.peers.delete(id)') < dropPeerSource.indexOf('p.r?.close()'),
  'peer must be removed before synchronous close-handler re-entry',
);
assert.match(netSource, /this\.onLobby = null;[\s\S]*this\.onClosed = null/);
assert.match(netSource, /setInterval\(\(\) => this\._pruneStalePeers\(Date\.now\(\)\), PEER_SWEEP_INTERVAL_MS\)/);
assert.match(netSource, /setInterval\(\(\) => this\.sendRel\(\{ t: 'heartbeat' \}\), HEARTBEAT_INTERVAL_MS\)/);
assert.match(netSource, /peerConnectionIsCurrent\(this\.peers, conn\.peer, p, ch, conn\)/);
assert.match(netSource, /if \(!p && this\.matchActive\)[\s\S]{0,240}Match in progress/, 'mid-match reconnects must not create lobby ghosts without game-state resync');
assert.match(netSource, /resetLobbyReady\(\) \{\s*this\.matchActive = false;/);
assert.match(mainSource, /setLobbyVoiceEnabled\(options\.voiceChat !== false\)/);
assert.match(mainSource, /destination === 'lobby' \? returnToLobby\(message\) : exitToMenu\(\)/);
assert.match(mainSource, /canvas\?\.classList\.toggle\('hidden', !showCanvas\)/);
assert.match(mainSource, /else app\.net\.setReady\(false\)/);
assert.match(mainSource, /showScreen\('lobby'\);[\s\S]*startMenuMusic\(\);[\s\S]*enableLobbyVoice\(\)/);
assert.match(mainSource, /if \(app\.net !== net \|\| !shouldRefreshLobbyUi\(app\.screen, !!app\.game\)\) return/);
assert.match(mainSource, /net\.onStart = \(payload\) => \{\s*if \(app\.net !== net \|\| app\.game\) return/);
assert.match(mainSource, /if \(app\.net !== countdownNet \|\| !shouldRefreshLobbyUi\(app\.screen, !!app\.game\)\)/);
const returnToLobbySource = mainSource.slice(
  mainSource.indexOf('function returnToLobby('),
  mainSource.indexOf('function pauseGame('),
);
assert.doesNotMatch(returnToLobbySource, /\.leave\(/, 'return-to-lobby must preserve the live PeerJS room');
assert.match(returnToLobbySource, /app\.game = null/);
assert.match(returnToLobbySource, /unlockPointer\(\)/);
assert.match(returnToLobbySource, /startMenuMusic\(\)/);
assert.match(gameSource, /case 'return_lobby'/);
assert.match(gameSource, /case 'hitcredit'/);
assert.match(gameSource, /onKillConfirm\(z, head, knife = false\)[\s\S]{0,420}killCreditPresentation/);
assert.match(gameSource, /if \(res\.killed\) this\.onKillConfirm\(z, false, true\)/);
assert.match(gameSource, /if \(msg\.pid === p\.id && this\._acceptLocalCredit/);
assert.match(gameSource, /this\._consumeRemoteCredit\(from, msg\.cid\)/);
assert.match(gameSource, /remoteWeaponClaimAllowed\(rp, msg\.w, msg\.pap\)/);
assert.match(gameSource, /state\.w = rp\.weaponId;\s*state\.pap = rp\.weaponPap/);
assert.match(netSource, /'pap_ready', 'pap_reject', 'pap_start'/,
  'PaP acceptance/rejection lifecycle must be host-only');
assert.match(gameSource, /pap_reject[\s\S]{0,300}Your points were refunded/,
  'a rejected simultaneous guest request must restore its local weapon and points');
assert.match(gameSource, /case 'boardpoints'[\s\S]*consumeBoardCredit\(this\._seenBoardCredits, msg\.cid\)/);
assert.match(gameSource, /msg\.pid !== p\.id\) this\.startRemotePerkDrink/);
assert.match(gameSource, /LEFT THE GAME/);
assert.match(indexHtml, /recommend entering full screen before the match/i);
assert.match(indexHtml, /id="multiplayer-roster" class="hidden"[\s\S]*?id="multiplayer-roster-rows" role="list"/);
assert.match(indexHtml, /id="scoreboard" class="hidden"/, 'Tab scoreboard remains independent');
assert.match(hudSource, /multiplayerRoster\(multiplayer, players\)/);
assert.match(gameSource, /this\.hud\.multiplayerRoster\(this\.mode !== 'solo', this\.multiplayerRosterRows\(\)\)/,
  'the live game loop must feed synchronized co-op state into the roster');
assert.match(gameSource, /multiplayerRosterRows\(\)[\s\S]{0,1800}voiceStreams/,
  'the live roster must include player identity, points, and voice state');
assert.match(gameSource, /dispose\(\)[\s\S]{0,1000}multiplayerRoster\(false, \[\]\)/,
  'leaving gameplay must clear the persistent multiplayer roster');
assert.match(hudSource, /presentation\.signature === this\._multiplayerRosterSig/);
assert.match(hudSource, /row\.dataset\.signature !== rowSignature/);
assert.match(hudSource, /\.textContent = player\.name/, 'untrusted names must render as inert text');
const multiplayerRosterSource = hudSource.slice(
  hudSource.indexOf('  multiplayerRoster(multiplayer, players)'),
  hudSource.indexOf('  drawMinimap(g)'),
);
assert.doesNotMatch(multiplayerRosterSource, /innerHTML/);
assert.match(styleSource, /#multiplayer-roster \{[\s\S]*?width: clamp\(190px, 21vw, 248px\)/);
assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?#multiplayer-roster \{ width: min\(226px, calc\(100vw - 36px\)\); right: 18px; \}/);
assert.match(gameSource, /this\.hud\.prompt\(`Hold <b>F<\/b> — revive \$\{escapeHtml\(reviveTarget\.name\)\}`\);/,
  'revive interaction prompt must stay text-only because the dedicated revive UI owns progress');
assert.doesNotMatch(gameSource, /this\.hud\.prompt\(`Hold <b>F<\/b> — revive[\s\S]{0,100}this\.holdF \/ need\)/,
  'revive must never render both the generic hold bar and the dedicated revive bar');
assert.match(playerSource, /this\.selfReviveAvailable = game\.mode === 'solo'[\s\S]{0,180}this\.perks\.clear\(\)/,
  'going down must clear perks while preserving only a one-time solo self-revive state');
assert.match(gameSource, /case 'down':[\s\S]{0,150}rp\.perks = \[\]/,
  'remote down events must immediately clear synchronized perk presentation');

console.log('Multiplayer contracts OK: authority, lifecycle, departure, voice policy, lobby UX, and co-op roster presentation.');
