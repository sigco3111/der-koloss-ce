import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nextDogRound } from '../js/config.js';
import {
  createConcurrencyGate,
  mysteryBoxTeddyChance,
  papEventMatches,
  papLifecyclePhase,
  PAP_PROCESS_SECONDS,
  PAP_READY_TIMEOUT_SECONDS,
  ROUND_INTERMISSION_SECONDS,
} from '../js/gameplay-rules.js';
import {
  multiplayerExitDestination, remoteShotTargetAllowed, sanitizePerkAnimation,
  shouldHandleRemoteClose, shouldRefreshLobbyUi, shouldShowGameplayCanvas,
} from '../js/multiplayer-contracts.js';
import {
  dogHitZones,
  floorArcTargetAllowed,
  hitscanDamage,
  penetrationProfile,
  rayHitZones,
  shouldSpawnDogRoundReward,
} from '../js/combat-rules.js';
import { interactionLineClear } from '../js/interaction-rules.js';
import { MAP_NAV_LINKS } from '../js/map-layout.js';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);
const rootPath = fileURLToPath(root);
const relativeToRoot = (url) => relative(rootPath, fileURLToPath(url)).split(sep).join('/');
const [zombies, assets, audioSource, inputSource, playerSource, gameSource, weaponSource, mapSource, mainSource, netSource, indexHtml, styleSource, vercelIgnore, vercelConfigText] = await Promise.all([
  readFile(new URL('js/zombies.js', root), 'utf8'),
  readFile(new URL('js/assets.js', root), 'utf8'),
  readFile(new URL('js/audio.js', root), 'utf8'),
  readFile(new URL('js/input.js', root), 'utf8'),
  readFile(new URL('js/player.js', root), 'utf8'),
  readFile(new URL('js/game.js', root), 'utf8'),
  readFile(new URL('js/weapons.js', root), 'utf8'),
  readFile(new URL('js/map.js', root), 'utf8'),
  readFile(new URL('js/main.js', root), 'utf8'),
  readFile(new URL('js/net.js', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('style.css', root), 'utf8'),
  readFile(new URL('.vercelignore', root), 'utf8'),
  readFile(new URL('vercel.json', root), 'utf8'),
]);

const vercelConfig = JSON.parse(vercelConfigText);
const siteHeaders = vercelConfig.headers?.find((entry) => entry.source === '/(.*)')?.headers || [];
const csp = siteHeaders.find((header) => header.key.toLowerCase() === 'content-security-policy')?.value;
assert.ok(csp, 'site-wide Content-Security-Policy header is missing');

const cspDirective = (name) => {
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part === name || part.startsWith(`${name} `));
  return new Set(directive?.split(/\s+/).slice(1) || []);
};
const connectSources = cspDirective('connect-src');
const imageSources = cspDirective('img-src');

// Static game payloads are large and must be edge-cacheable without pinning an
// old deploy in the browser cache. The invite Function must remain short-lived
// and stateless so concurrent users never contend on instance-local data.
for (const source of ['/assets/(.*)', '/js/(.*)', '/vendor/(.*)']) {
  const headers = vercelConfig.headers?.find((entry) => entry.source === source)?.headers || [];
  const cacheControl = headers.find((header) => header.key.toLowerCase() === 'cache-control')?.value || '';
  assert.match(cacheControl, /max-age=0(?:,|$)/, `${source} must revalidate in browsers across deploys`);
  assert.match(cacheControl, /s-maxage=31536000(?:,|$)/, `${source} must use the Vercel edge cache`);
  assert.doesNotMatch(cacheControl, /immutable/, `${source} contains unversioned paths and cannot be browser-immutable`);
}
const inviteFunction = vercelConfig.functions?.['api/invite.js'];
assert.ok(inviteFunction, 'invite Function must have an explicit runtime budget');
assert.ok(inviteFunction.maxDuration > 0 && inviteFunction.maxDuration <= 5, 'invite Function duration must stay at or below five seconds');

const inviteMetadata = require('../api/invite.js');
const invokeInvite = (method, query) => {
  const response = { statusCode: 0, headers: new Map(), body: undefined };
  inviteMetadata({ method, query }, {
    setHeader(name, value) { response.headers.set(String(name).toLowerCase(), String(value)); },
    end(body) { response.body = body; },
    set statusCode(value) { response.statusCode = value; },
    get statusCode() { return response.statusCode; },
  });
  return response;
};
const rejectedInviteWrite = invokeInvite('POST', { code: 'ABCDE' });
assert.equal(rejectedInviteWrite.statusCode, 405);
assert.equal(rejectedInviteWrite.headers.get('allow'), 'GET, HEAD');
assert.equal(rejectedInviteWrite.headers.get('cache-control'), 'no-store');
const inviteHead = invokeInvite('HEAD', { code: 'ABCDE', from: 'Player' });
assert.equal(inviteHead.statusCode, 200);
assert.equal(inviteHead.body, undefined);
const inviteGet = invokeInvite('GET', { code: 'ABCDE', from: '<script>' });
assert.equal(inviteGet.statusCode, 200);
assert.match(inviteGet.headers.get('cache-control'), /s-maxage=300/);
assert.doesNotMatch(inviteGet.body, /<script> invited/);

async function findGltfFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files.push(...await findGltfFiles(url));
    else if (entry.name.endsWith('.gltf')) files.push(url);
  }
  return files;
}

const modelBlock = /const MODELS = \{([\s\S]*?)\n\};/.exec(assets)?.[1] || '';
const configuredModelPaths = [...modelBlock.matchAll(/^\s*\w+:\s*['"]([^'"]+\.gltf)['"]/gm)].map((match) => match[1]);
assert.ok(configuredModelPaths.length, 'assets.js contains no configured GLTF models');

const gltfFiles = await findGltfFiles(new URL('assets/models/', root));
const shippedModelPaths = new Set(gltfFiles.map(relativeToRoot));
for (const modelPath of configuredModelPaths) {
  assert.ok(shippedModelPaths.has(modelPath), `configured model is not shipped: ${modelPath}`);
}

let embeddedDataBuffers = 0;
let bufferViewImages = 0;
for (const modelUrl of gltfFiles) {
  const name = decodeURIComponent(modelUrl.pathname.split('/').pop());
  const model = JSON.parse(await readFile(modelUrl, 'utf8'));
  assert.ok(model.scenes?.length, `${name} has no scene`);

  const bufferLengths = [];
  for (const [index, buffer] of (model.buffers || []).entries()) {
    assert.ok(buffer.uri, `${name} buffer ${index} has no URI`);
    if (buffer.uri.startsWith('data:')) {
      embeddedDataBuffers++;
      assert.ok(connectSources.has('data:'), `${name} embeds a data: buffer but CSP connect-src does not allow data:`);
      const match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(buffer.uri);
      assert.ok(match?.[2], `${name} buffer ${index} is not a base64 data URI`);
      const bytes = Buffer.from(match[3], 'base64');
      assert.equal(bytes.byteLength, buffer.byteLength, `${name} buffer ${index} byteLength does not match its embedded bytes`);
      bufferLengths[index] = bytes.byteLength;
    } else {
      assert.doesNotMatch(buffer.uri, /^[a-z][a-z\d+.-]*:/i, `${name} uses a non-local buffer URI: ${buffer.uri}`);
      const bytes = await readFile(new URL(buffer.uri, modelUrl));
      assert.equal(bytes.byteLength, buffer.byteLength, `${name} buffer ${index} byteLength does not match its external file`);
      bufferLengths[index] = bytes.byteLength;
    }
  }

  for (const [index, view] of (model.bufferViews || []).entries()) {
    const end = (view.byteOffset || 0) + view.byteLength;
    assert.ok(Number.isInteger(bufferLengths[view.buffer]), `${name} bufferView ${index} references missing buffer ${view.buffer}`);
    assert.ok(end <= bufferLengths[view.buffer], `${name} bufferView ${index} exceeds buffer ${view.buffer}`);
  }

  for (const [index, image] of (model.images || []).entries()) {
    if (image.uri?.startsWith('data:')) {
      assert.ok(imageSources.has('data:'), `${name} image ${index} uses data: but CSP img-src does not allow it`);
    }
    if (image.bufferView != null) {
      bufferViewImages++;
      assert.ok(connectSources.has('blob:'), `${name} embeds image ${index} in a bufferView but CSP connect-src does not allow GLTFLoader's blob: URL`);
      assert.ok(imageSources.has('blob:'), `${name} embeds image ${index} in a bufferView but CSP img-src does not allow GLTFLoader's blob: URL`);
      assert.ok(model.bufferViews?.[image.bufferView], `${name} image ${index} references missing bufferView ${image.bufferView}`);
    }
  }

  if (modelUrl.pathname.includes('/zombies/')) {
    assert.ok(model.animations?.length, `${name} has no animations`);
  }
}
assert.ok(embeddedDataBuffers > 0, 'expected shipped GLTF models to contain embedded data: buffers');
assert.ok(bufferViewImages > 0, 'expected shipped GLTF models to contain bufferView images');
assert.doesNotMatch(vercelIgnore, /assets\/models|assets\/\*\*|^assets$/m);

// Laptop-friendly aiming must stay wired through the same state used by player
// movement/FOV and the first-person weapon rig.
assert.match(inputSource, /return input\.rmbDown \|\| !!input\.keys\[['"]KeyE['"]\];/);
assert.match(playerSource, /const wantAds = isAimDown\(\)/);
assert.match(gameSource, /(?:ads:|rigState\.ads =) isAimDown\(\)/);
assert.match(indexHtml, /RMB \/ E<\/b> aim/);
assert.match(gameSource, /this\.player\.yaw = 0; \/\/ -Z from the mainframe spawn faces the courtyard/);
// Exposure moved out of the forward renderer and into the HDR post composite:
// the world is rendered linear into a float buffer and tonemapped by PostFX.
// The invariant is unchanged in intent — 100% brightness must resolve to the
// map's authored production baseline, scaled only by the player's slider.
assert.match(gameSource, /toneMapping = THREE\.NoToneMapping/,
  'the forward pass must stay linear; tone mapping belongs to the post composite');
assert.match(gameSource, /fx\.exposure = \(fx\.baseExposure \?\? 1\) \* this\.exposureScale[\s\S]{0,160}options\.brightness \?\? 1\), 0\.5, 1\.6\)/,
  '100% brightness must use the readable production exposure baseline');
assert.match(mapSource, /export const GRADE = \{[\s\S]{0,200}exposure: \d+(\.\d+)?,/,
  'the map must author a single production exposure baseline for the post stack');
assert.match(mainSource, /saved\.brightness = 1;[\s\S]{0,120}saved\.brightnessCalibration = 2/,
  'returning players must be migrated to the newly readable 100% baseline');
assert.match(gameSource, /play\('trap', \{ pos: \{ x: trap\.x[\s\S]{0,120}maxDist: 18/,
  'active trap crackle must remain spatial and inaudible across the map');
assert.match(playerSource, /this\.yaw = 0; this\.pitch = 0;/);

// Lobby ergonomics and authority: compute the markup roles and ordering rather
// than checking only that each control exists. This preserves the same hierarchy
// for hosts (all four actions) and guests (START GAME hidden at runtime).
const buttonTag = (id) => {
  const tag = new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(indexHtml)?.[0];
  assert.ok(tag, `missing lobby button #${id}`);
  return tag;
};
const tagClasses = (tag) => new Set(/\bclass="([^"]*)"/i.exec(tag)?.[1].trim().split(/\s+/).filter(Boolean) || []);
const cssDeclarations = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(styleSource)?.[1];
  assert.ok(body, `missing CSS rule ${selector}`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
};
const lobbyButtonIds = ['btn-ready', 'btn-start-game', 'btn-lobby-cheats', 'btn-leave-lobby', 'btn-lobby-fs'];
const lobbyButtons = Object.fromEntries(lobbyButtonIds.map((id) => [id, tagClasses(buttonTag(id))]));
assert.deepEqual(
  lobbyButtonIds.map((id) => indexHtml.indexOf(`id="${id}"`)),
  [...lobbyButtonIds.map((id) => indexHtml.indexOf(`id="${id}"`))].sort((a, b) => a - b),
  'fullscreen must follow the main lobby action row',
);
assert.ok(lobbyButtons['btn-ready'].has('lobby-primary-action'), 'READY UP must be the primary lobby action');
assert.equal(lobbyButtonIds.filter((id) => lobbyButtons[id].has('lobby-primary-action')).length, 1, 'READY UP must be the sole primary lobby action');
for (const id of ['btn-start-game', 'btn-lobby-cheats', 'btn-leave-lobby']) {
  assert.ok(lobbyButtons[id].has('lobby-ghost-action'), `#${id} must be a ghost action`);
}
assert.ok(lobbyButtons['btn-lobby-fs'].has('lobby-secondary-action'), 'fullscreen must be a strong secondary action');
assert.equal(lobbyButtons['btn-lobby-fs'].has('lobby-primary-action'), false);
assert.equal(lobbyButtons['btn-lobby-fs'].has('lobby-ghost-action'), false);
assert.match(buttonTag('btn-lobby-fs'), /aria-describedby="lobby-fullscreen-note"/);
assert.match(indexHtml, /<div class="lobby-fullscreen-prompt">\s*<p id="lobby-fullscreen-note"[\s\S]*?<\/p>\s*<button id="btn-lobby-fs"/);
const fullscreenPromptStyle = cssDeclarations('.lobby-fullscreen-prompt');
const fullscreenNoteStyle = cssDeclarations('.lobby-fullscreen-note');
const fullscreenButtonStyle = cssDeclarations('#lobby .lobby-secondary-action');
const lobbyActionStyle = cssDeclarations('#lobby .lobby-action-row');
assert.equal(fullscreenPromptStyle['align-items'], 'center');
assert.equal(fullscreenNoteStyle.color, '#fffdf4');
assert.ok(Number.parseFloat(fullscreenNoteStyle['font-size']) >= 16, 'fullscreen recommendation must stay prominent');
assert.match(fullscreenButtonStyle.width, /^min\(\d+px, (?:[1-9]\d?)%\)$/, 'fullscreen must be centered, wider, and below full width');
assert.equal(lobbyActionStyle.display, 'grid');
const actionMinWidth = Number.parseFloat(/minmax\((\d+)px/.exec(lobbyActionStyle['grid-template-columns'])?.[1]);
const fullscreenMaxWidth = Number.parseFloat(/min\((\d+)px/.exec(fullscreenButtonStyle.width)?.[1]);
assert.ok(fullscreenMaxWidth > actionMinWidth * 2, 'fullscreen row should read wider than an individual main action');
const responsiveFullscreenWidths = [...styleSource.matchAll(/#lobby \.lobby-secondary-action\s*\{[^}]*\bwidth:\s*([^;]+);/g)].map((match) => match[1].trim());
assert.ok(responsiveFullscreenWidths.length >= 3, 'fullscreen needs desktop, tablet, and mobile widths');
assert.equal(responsiveFullscreenWidths.some((width) => /(?:^|[, (])100%/.test(width)), false, 'fullscreen must never become full width');
assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?#lobby \.lobby-action-row \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
assert.match(styleSource, /@media \(max-width: 440px\)[\s\S]*?#lobby \.lobby-action-row \{ grid-template-columns: 1fr; \}/);
assert.match(mainSource, /lobbyFs\.classList\.toggle\('fullscreen-callout', !on\)/, 'shimmer must be removed while fullscreen is active');
assert.match(mainSource, /\$\('btn-start-game'\)\.classList\.toggle\('hidden', !isHost\)/, 'guest layout must hide the host-only start action');
assert.match(indexHtml, /id="btn-lobby-fs"[^>]*>FULL SCREEN<\/button>/);
assert.match(mainSource, /\$\('btn-lobby-fs'\)\.addEventListener\('click'/);
assert.match(indexHtml, /id="solo-fs-modal"/);
assert.match(indexHtml, /id="btn-solo-fs-toggle"/);
assert.match(mainSource, /syncSoloFsUI/);
assert.match(mainSource, /resetInputState\(\)/);
assert.match(mainSource, /\$\('btn-lobby-cheats'\)\.textContent = isHost \? 'CHEAT CODES' : 'VIEW CHEAT CODES'/);
assert.match(mainSource, /el\.disabled = guest/);
assert.match(mainSource, /if \(cheatsReadOnly\(\)\) \{ syncCheatsUI\(\); return; \}/);
assert.match(netSource, /cheats: this\.lobbyCheats/);
assert.match(netSource, /setLobbyCheats\(settings\)/);
assert.match(indexHtml, /recommend entering full screen before the match/i);
assert.match(netSource, /voiceEnabled: this\.lobbyVoiceEnabled/);
assert.match(netSource, /this\.lobbyVoiceEnabled = msg\.voiceEnabled === true/);
assert.match(netSource, /if \(this\._enableVoicePromise\) return this\._enableVoicePromise/);
assert.match(mainSource, /setLobbyVoiceEnabled\(options\.voiceChat !== false\)/);
assert.match(gameSource, /case 'return_lobby'/);
assert.equal(multiplayerExitDestination({ mode: 'host', gameOver: true }), 'lobby');
assert.equal(multiplayerExitDestination({ mode: 'client' }), 'menu');
assert.equal(remoteShotTargetAllowed({
  origin: { x: 0, y: 1.5, z: 0 }, dir: { x: 0, y: 0, z: -1 },
  target: { x: 0.65, y: 1.5, z: -3 }, wallDistance: 4,
}), true, 'bounded snapshot drift should not nullify a legitimate guest hit');
assert.equal(remoteShotTargetAllowed({
  origin: { x: 0, y: 1.5, z: 0 }, dir: { x: 0, y: 0, z: -1 },
  target: { x: 0, y: 1.5, z: -8 }, wallDistance: 4,
}), false, 'guest hit reconciliation must still reject through-wall claims');
assert.deepEqual(
  sanitizePerkAnimation('authenticated-guest', { id: 'jug', pid: 'spoofed-host' }),
  { t: 'perk_anim', pid: 'authenticated-guest', id: 'jug' },
);
assert.equal(sanitizePerkAnimation('authenticated-guest', { id: 'unknown' }), null);
assert.match(netSource, /perk_anim: 1500/);
assert.match(netSource, /const event = sanitizePerkAnimation\(fromId, msg\)/);
assert.match(gameSource, /msg\.pid !== p\.id\) this\.startRemotePerkDrink/);
assert.equal(shouldShowGameplayCanvas('lobby', false), false);
assert.equal(shouldShowGameplayCanvas('game', true), true);
assert.match(mainSource, /canvas\?\.classList\.toggle\('hidden', !showCanvas\)/);
assert.match(mainSource, /showScreen\('lobby'\);[\s\S]*startMenuMusic\(\);[\s\S]*enableLobbyVoice\(\)/);
// The public build ships no feedback collector. The dialog, its stylesheet, and
// the third-party endpoint it posted to were removed for the open-source repo;
// re-adding any of them would send players' reports to someone else's inbox.
assert.doesNotMatch(indexHtml, /data-feedback-open|feedback\.css|js\/feedback\.js/);
assert.match(mainSource, /pauseMic\.classList\.toggle\('hidden', app\.game\.mode === 'solo'\)/);
assert.match(mainSource, /pauseMic\.disabled = voiceDisabled/);
assert.match(mainSource, /voiceDisabled \? 'VOICE: DISABLED'/);
assert.match(indexHtml, /created by <a[^>]+>Vesper<\/a>/);
assert.equal(shouldRefreshLobbyUi('game', true), false);
assert.equal(shouldRefreshLobbyUi('lobby', false), true);
assert.equal(shouldHandleRemoteClose({ connected: true, intentional: true }), false);
assert.equal(shouldHandleRemoteClose({ connected: true }), true);
assert.match(mainSource, /if \(app\.net !== net \|\| !shouldRefreshLobbyUi\(app\.screen, !!app\.game\)\) return/);
assert.match(netSource, /leave\(\) \{\s*this\._intentionalLeave = true;[\s\S]{0,220}send\(\{ t: 'leave' \}\);[\s\S]{0,120}this\._teardown\(\)/);

// The visual shell is backed by a room-union containment guard, so a future
// missed wall segment cannot reopen the global dirt plane to players.
assert.match(playerSource, /if \(!game\.map\.roomAt\(this\.x, this\.z, this\.y\)\)/);
assert.match(mapSource, /Ground-level shell below Chemical Testing/);

// Interaction prompts and host-authoritative requests must not pass through a
// structural wall, while an interactable's own prop collider may sit at the
// endpoint without blocking itself.
const interactionWall = { minX: -0.1, maxX: 0.1, minZ: -1, maxZ: 1, y0: 0, h: 3 };
assert.equal(interactionLineClear(
  { x: -1, y: 1.2, z: 0 }, { x: 1, y: 1.1, z: 0 }, [interactionWall],
), false, 'interaction ray crossed a structural wall');
assert.equal(interactionLineClear(
  { x: -1, y: 1.2, z: 0 }, { x: 1, y: 1.1, z: 0 }, [],
), true, 'unobstructed interaction ray was rejected');
assert.equal(interactionLineClear(
  { x: -1, y: 1.2, z: 0 }, { x: 1, y: 1.1, z: 0 }, [
    { minX: 0.7, maxX: 1.1, minZ: -0.3, maxZ: 0.3, y0: 0, h: 1.5, prop: true },
  ],
), true, 'an interactable blocked access to itself');
assert.match(gameSource, /_remoteNearVisible\(from, this\.map\.box\.pos, 3\)/);
assert.match(gameSource, /_remoteNearVisible\(from, this\.map\.pap\.pos, 3\)/);
assert.match(gameSource, /_remoteNearVisible\(from, tele, 3\)/);
assert.match(gameSource, /_remoteNearVisible\(from, trap, 3\)/);
assert.match(mapSource, /x: boxLocations\[0\]\.x[\s\S]{0,100}z: boxLocations\[0\]\.z/);
assert.match(gameSource, /this\.renderer\.setSize\(w, h, false\)/);

// Classic schedule: first dog round is 5, then the gap is always 5–7 rounds.
assert.equal(nextDogRound(0, 1, () => 0.99), 5);
assert.equal(nextDogRound(5, 1, () => 0), 10);
assert.equal(nextDogRound(5, 1, () => 0.999), 12);
assert.equal(nextDogRound(0, 20, () => 0), 23);
assert.equal(nextDogRound(0, 20, () => 0.999), 25);

const rolls = [0, 0.49, 0.999, 0.2, 0.8];
let rollIndex = 0;
let lastDogRound = 0;
let scheduledDogRound = nextDogRound(lastDogRound, 1, () => rolls[rollIndex++ % rolls.length]);
const dogRounds = [];
for (let round = 1; round <= 40; round++) {
  if (round !== scheduledDogRound) continue;
  dogRounds.push(round);
  lastDogRound = round;
  scheduledDogRound = nextDogRound(lastDogRound, 1, () => rolls[rollIndex++ % rolls.length]);
}
assert.equal(dogRounds[0], 5);
for (let i = 1; i < dogRounds.length; i++) {
  const gap = dogRounds[i] - dogRounds[i - 1];
  assert.ok(gap >= 5 && gap <= 7, `invalid dog-round gap ${gap}: ${dogRounds.join(', ')}`);
}

// Entity identity must survive visual asset failure. These checks deliberately
// reject the exact normal-zombie -> hellhound fallbacks that caused the incident.
assert.match(zombies, /const makeDog = this\.dogRound;/);
assert.match(zombies, /z\.model = z\.visual \? z\.visual\.group : createZombieModel\(false\);/);
assert.match(zombies, /model: visual \? visual\.group : createZombieModel\(!!dog,/);
assert.equal((zombies.match(/enforceEnemyVisualIdentity\(z\);/g) || []).length, 2);
assert.match(zombies, /const hasBasic = !!assets\.models\.zombie1;/);
assert.match(zombies, /const hasChubby = !!assets\.models\.zombie2;/);
assert.match(zombies, /hasChubby && \(!hasBasic \|\| Math\.random\(\) >= 0\.75\)/);
assert.doesNotMatch(zombies, /z\.visual \? z\.visual\.group : createZombieModel\(true/);
assert.doesNotMatch(zombies, /model: visual \? visual\.group : createZombieModel\(true/);
assert.doesNotMatch(zombies, /mixedDogs/);
assert.match(assets, /['"]dog_death['"]/);

// Teleporter C's elevated catwalk is destination-only for zombies. They must
// spawn on the factory floor and use the bidirectional physical stair route.
assert.match(zombies, /export function isZombieSpawnRoomAllowed\(room\)/);
assert.match(zombies, /return room !== 'catwalk';/);
assert.match(zombies, /isZombieSpawnRoomAllowed\(b\.room\)/,
  'barrier spawn selection must reject destination-only rooms');
assert.match(zombies, /isZombieSpawnRoomAllowed\(r\.room\)/,
  'riser spawn selection must reject destination-only rooms');
assert.match(zombies, /targetRoom === 'catwalk'[\s\S]{0,120}\? \{ x: target\.x, y: 0, z: target\.z \}/);
assert.match(zombies, /spot && isZombieSpawnRoomAllowed\(spot\.room\) \? spot : null/);
for (const [from, to] of [['factory', 'catwalk'], ['catwalk', 'factory']]) {
  assert.ok(
    MAP_NAV_LINKS.some((link) => link.from === from && link.to === to && link.stair && link.route === 'catwalkStairs'),
    `Teleporter C path must include ${from}->${to} over catwalkStairs`,
  );
}

// Round-transition and ambient-voice regressions are production invariants.
assert.equal(mysteryBoxTeddyChance(0), 0);
assert.equal(mysteryBoxTeddyChance(1), 0);
assert.ok(mysteryBoxTeddyChance(2) > 0, 'Teddy must be eligible no earlier than use three');
const dogVoiceGate = createConcurrencyGate(2);
assert.ok(dogVoiceGate.tryAcquire());
assert.ok(dogVoiceGate.tryAcquire());
assert.equal(dogVoiceGate.tryAcquire(), false, 'dog bark/growl concurrency exceeded two voices');
assert.match(audioSource, /_dogVoiceGate = createConcurrencyGate\(2\)/);
assert.equal(ROUND_INTERMISSION_SECONDS, 8);
assert.match(gameSource, /phase = 'intermission';[\s\S]{0,400}if \(this\.player\.dead\) this\.respawnSelf\(\);[\s\S]{0,200}t: 'intermission'/);
assert.doesNotMatch(gameSource, /beginRound\(n\)[\s\S]{0,700}if \(this\.player\.dead\) this\.respawnSelf\(\)/);
assert.match(gameSource, /case 'respawn':[\s\S]{0,500}if \(this\.isAuthority\) this\.netSend\(msg\)/);
assert.match(netSource, /HOST_ONLY_EVENTS[\s\S]{0,500}'intermission'/);

// Guest score and loadout authority: no predicted points, no replayed credits,
// and no weapon/PaP identity sourced from unreliable snapshots.
assert.match(netSource, /'hitcredit', 'killcredit'/);
assert.match(netSource, /shoot: 25, zhit: 0, zsplash: 100/);
assert.match(gameSource, /case 'hitcredit':[\s\S]{0,240}_acceptLocalCredit\(msg\.cid, 'hit'\)/);
assert.match(gameSource, /case 'killcredit':[\s\S]{0,180}_acceptLocalCredit\(msg\.cid, 'kill'\)/);
assert.match(gameSource, /this\._consumeRemoteCredit\(from, msg\.cid\)/);
assert.match(gameSource, /state\.w = rp\.weaponId;\s*state\.pap = rp\.weaponPap/);
assert.match(gameSource, /remoteWeaponClaimAllowed\(rp, msg\.w, msg\.pap\)/);
assert.match(gameSource, /case 'boardpoints':[\s\S]{0,240}consumeBoardCredit\(this\._seenBoardCredits, msg\.cid\)/);
assert.doesNotMatch(gameSource, /client: predict feedback, host confirms/);
assert.match(netSource, /this\._mediaConnections\.get\(mc\.peer\) !== mc/);
assert.match(netSource, /generation !== this\._voiceRequestGeneration \|\| !this\._isAllowedVoicePeer/);

// Collateral and wonder-weapon claims must remain host/client symmetric.
const coltDefinition = /m1911:\s*\{([\s\S]*?)\n  \},\n  magnum:/.exec(weaponSource)?.[1] || '';
// Assert the three properties independently rather than as one adjacent
// string. Requiring them to sit next to each other on the same line made this
// fail the moment an unrelated field (a shell-casing descriptor) was inserted
// between them, which is a false alarm: the invariant is that the base M1911
// is a hitscan pistol, not that nobody may ever add a property to it.
const coltBase = coltDefinition.split(/pap:\s*\{/)[0];
for (const [re, what] of [
  [/name: 'M1911'/, 'name'],
  [/cls: 'pistol'/, 'class'],
  [/fire: 'hitscan'/, 'fire mode'],
]) {
  assert.match(coltBase, re, `the starting M1911 must remain a normal hitscan pistol (${what} drifted)`);
}
assert.match(coltDefinition, /pap:\s*\{[\s\S]*?fire: 'projectile', dmg: 1000/,
  'the upgraded M1911 must launch calibrated explosive rounds');
assert.match(coltDefinition, /splash: \{ radius: 3\.2, dmg: 400 \}, projSpeed: 44/,
  'upgraded M1911 splash or projectile speed drifted out of calibration');
assert.match(coltDefinition, /mag: 6, reserve: 50, reload: 1\.4/,
  'upgraded M1911 ammo or reload calibration drifted');
assert.doesNotMatch(coltDefinition.split(/pap:\s*\{/)[0], /^\s*(?:splash|projSpeed)\s*:/m,
  'the starting M1911 must not inherit explosive projectile behavior');
const invariantRifle = { cls: 'rifle', dmg: 100, penetrate: 3 };
assert.equal(penetrationProfile(invariantRifle).maxTargets, 3);
assert.equal(hitscanDamage(invariantRifle, 10, 1), 68);
assert.equal((gameSource.match(/hitscanDamage\(/g) || []).length, 2);
assert.match(gameSource, /this\.fireArc\(mw, s, w, dir\)/);
assert.ok(floorArcTargetAllowed({ impact: { x: 0, y: 0, z: 0 }, target: { x: 2, y: 0.9, z: 0 }, visible: true }));
assert.equal(floorArcTargetAllowed({ impact: { x: 0, y: 0, z: 0 }, target: { x: 3, y: 0.9, z: 0 }, visible: true }), false);
assert.match(gameSource, /floorImpact: s\.fire === 'arc'[\s\S]{0,180}_dg2FloorImpact/);
const invariantDog = { x: 0, y: 0, z: 5, yaw: Math.PI, state: 5, stateT: 0.12, anim: 2 };
const dogOrigin = { x: 0, y: 1.55, z: 0 };
const dogAimRaw = { x: 0, y: 0.7 - dogOrigin.y, z: 4.7 };
const dogAimLen = Math.hypot(dogAimRaw.x, dogAimRaw.y, dogAimRaw.z);
const dogAim = { x: dogAimRaw.x / dogAimLen, y: dogAimRaw.y / dogAimLen, z: dogAimRaw.z / dogAimLen };
assert.ok(rayHitZones({ origin: dogOrigin, dir: dogAim, zones: dogHitZones(invariantDog), maxDistance: 15 }));
assert.match(gameSource, /dogHitZones\(zombie, \{ interpolationAllowance: 0\.16 \}\)/);
assert.ok(shouldSpawnDogRoundReward({ dogRound: true, victimDog: true, remaining: 0, alreadySpawned: false }));
assert.equal(shouldSpawnDogRoundReward({ dogRound: false, victimDog: true, remaining: 0, alreadySpawned: false }), false);
assert.match(gameSource, /shouldSpawnDogRoundReward\([\s\S]{0,500}spawnDrop\('maxammo', z\.x, z\.z\)/);
assert.doesNotMatch(gameSource, /guaranteed max ammo after dog round/);

// Pack-a-Punch is host-clocked and has three explicit presentation phases.
assert.equal(PAP_PROCESS_SECONDS, 4);
assert.equal(PAP_READY_TIMEOUT_SECONDS, 30);
assert.equal(papLifecyclePhase({ busy: false }), 'idle');
assert.equal(papLifecyclePhase({ busy: true, ready: false }), 'processing');
assert.equal(papLifecyclePhase({ busy: true, ready: true }), 'ready');
const papCycle = { busy: true, ready: false, owner: 'guest-a', weapon: 'mg42' };
assert.equal(papEventMatches(papCycle, 'guest-a', 'mg42'), true);
assert.equal(papEventMatches(papCycle, 'guest-b', 'mg42'), false, 'stale/wrong-owner ready event rejected');
assert.equal(papEventMatches(papCycle, 'guest-a', 'dg2'), false, 'stale/wrong-weapon ready event rejected');
assert.match(gameSource, /ps\.t <= 0 && this\.isAuthority/,
  'only the authority may complete the PaP processing clock');
assert.match(gameSource, /case 'pap_ready':[\s\S]{0,180}papEventMatches\(this\.papState, msg\.pid, msg\.w\)/);
assert.match(gameSource, /case 'pap_reject':[\s\S]{0,220}_cancelLocalPapAttempt\(true\)/);
assert.match(gameSource, /case 'pap_take':[\s\S]{0,900}this\.papTake\(false\)/,
  'owner must accept an authority timeout grant without echoing another request');
assert.match(gameSource, /dispose\(\)[\s\S]{0,800}_clearPapOutputWeapon\(\)/,
  'world PaP weapon must be removed when the game exits');
assert.match(gameSource, /p\.weapons\.length > 1 && p\.weapon\.upgrading[\s\S]{0,500}papHide = !!p\.weapon\?\.upgrading/,
  'a single weapon must stay hidden while it is inside Pack-a-Punch');

// The whirr is one shot spanning the whole cycle, so the sample length and the
// process clock have to stay welded together — change one, change the other.
const audioLoudness = JSON.parse(await readFile(new URL('scripts/audio-loudness.json', root), 'utf8'));
const papWhirrSeconds = audioLoudness.files?.pap?.seconds;
assert.equal(papWhirrSeconds, PAP_PROCESS_SECONDS,
  `pap.mp3 is ${papWhirrSeconds}s but a PaP cycle is ${PAP_PROCESS_SECONDS}s — the whirr must span exactly one cycle`);
assert.match(gameSource, /_papWhirrStarted[\s\S]{0,200}audio\.play\('pap_whirr'/,
  'the whirr must fire once per cycle, not on a retrigger timer');
assert.match(gameSource, /_resetPapState\(\)[\s\S]{0,320}_stopPapWhirr\(\)/,
  'a cycle that ends early must cut the whirr');
assert.doesNotMatch(gameSource, /_papSndT/, 'the old whirr retrigger timer must be gone');
assert.match(gameSource, /const echoOfMine = this\.papState\.mine && msg\.pid === p\.id && this\.papState\.weapon === msg\.w;/,
  'pap_start must recognise the authority echo of our own request');
assert.match(gameSource, /if \(!echoOfMine\) audio\.play\('pap_insert'/,
  'the authority echo of our own pap_start must not double-ring the insert');
assert.match(gameSource, /const slot = echoOfMine \? this\.papState\.slot : null;/,
  'the echo must carry the recorded slot forward');

// The gun in the machine is tracked by slot identity: the box can hand out a
// second copy of the same id mid-cycle, and an id lookup would upgrade the wrong
// one and strand the real slot as permanently `upgrading`.
assert.match(gameSource, /_papSlot\(\)[\s\S]{0,300}this\.player\.weapons\.includes\(slot\)/,
  'PaP must resolve its weapon by slot reference before falling back to id');
// This used to pin `this._papSlot() || p.weapon`, which is the exact expression
// that BREAKS the invariant stated above it: when the recorded slot is no longer
// in the player's hands (goDown stashes the loadout and issues a fresh m1911)
// the fallback upgraded whatever was being held — the down pistol, discarded on
// revive — and left the real slot stranded as permanently `upgrading`, which is
// the failure the comment above describes. There must be no fallback.
assert.match(gameSource, /papTake\(notifyAuthority = true\)[\s\S]{0,1200}const w = this\._papSlot\(\);/,
  'papTake must upgrade the exact slot that went into the machine, with no fallback');
assert.doesNotMatch(gameSource, /this\._papSlot\(\) \|\| p\.weapon/,
  'papTake must never substitute the held weapon for the slot in the machine');
assert.match(gameSource, /this\.papState\.slot = p\.weapon/,
  'papUse must record the slot handed to the machine');
// Buying bypasses switchWeapon(), the only other thing that clears papHide.
assert.equal((gameSource.match(/this\._revealAcquiredWeapon\(\);/g) || []).length, 2,
  'both the wall buy and the box must reveal a weapon acquired mid-PaP');
assert.match(gameSource, /_revealAcquiredWeapon\(\) \{[\s\S]{0,220}papHide = false/,
  'a gun bought while your other gun is in the machine must be visible and fireable');
assert.match(mapSource, /const papProcessing = pap\.processing/);
assert.match(mapSource, /papSlot\.material\.emissiveIntensity = papProcessing/);

// Taking the upgraded gun out of the machine used to open on one frame of
// full-frame blurred receiver. equip() is called from papTake() and from the box,
// both of which run AFTER the rig update in the same tick that renders — so a
// model left on the identity transform is drawn once with its authored origin ON
// the lens, and that frame is the longest in the hand-over because it is also the
// frame the view-model's materials compile. The pose has to be applied by equip()
// itself, not left for the next update(). Same class as the perk bottle
// (validate-perk-drink.mjs) — that one appeared on the camera, this one fills it.
{
  const equipBody = weaponSource.match(/\n  equip\(id, pap\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(equipBody, 'WeaponRig.equip not found');
  assert.match(equipBody, /this\._poseRaiseStart\(group\)/,
    'equip() must pose the new view-model on the frame it is built');
  assert.match(weaponSource, /_poseRaiseStart\(group\) \{[\s\S]{0,240}group\.position\.copy\(this\.hipPos\)[\s\S]{0,240}EQUIP_RAISE_DROP/,
    'the primed pose must be the bottom of the raise, in the rig frame');
  const papTakeBody = gameSource.match(/papTake\(notifyAuthority = true\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(papTakeBody, 'Game.papTake not found');
  assert.doesNotMatch(papTakeBody, /current\.group\.visible = true/,
    'papTake must leave view-model visibility to the rig gate, or a scoped take draws the gun into the scope picture');
  // uFlash is a scalar added pre-tonemap, so the post path cannot be tinted: at
  // the old 0.3 this purple event flashed the screen white for three frames.
  const takeFlash = papTakeBody.match(/screenFlash\('#c9a2ff', (\d+), ([\d.]+)\)/);
  assert.ok(takeFlash, 'papTake must keep its PaP-tinted screen wash');
  assert.ok(Number(takeFlash[2]) <= 0.12,
    `PaP take flash is ${takeFlash[2]}; a colourless post lift above ~0.12 reads as a glitch, not as feedback`);
  // The HUD is not refreshed again until the next shot, so it has to be handed
  // the upgraded capacity, not the one the gun went into the machine with.
  assert.ok(
    papTakeBody.indexOf('w.mag = s.mag') < papTakeBody.indexOf('this.hud.setAmmo'),
    'papTake must set the upgraded mag/reserve before it pushes them to the HUD',
  );
}
// An inspect that starts on the same frame as an equip stacks its lift on the
// raise: the weapon overshoots toward the eye and then sags back into rest.
assert.match(weaponSource, /if \(this\.inspectT > 0 && this\.equipT >= 1\)/,
  'the inspect flourish must wait for the equip raise to finish');
assert.match(weaponSource, /const eq = \(1 - this\.equipT\) \*\* 2;/,
  'the equip raise must ease out rather than stop dead at full speed');

console.log(`Game invariants OK. Validated ${gltfFiles.length} GLTF models (${embeddedDataBuffers} embedded data buffers, ${bufferViewImages} blob-backed images). Dog rounds through 40: ${dogRounds.join(', ')}`);
