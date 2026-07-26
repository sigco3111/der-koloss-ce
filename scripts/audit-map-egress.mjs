#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  MAP_ROOMS,
  MAP_DOOR_DEFS,
  MAP_TELEPORTERS,
  MAINFRAME_PLATFORM,
  MAINFRAME_STEPS,
  MAINFRAME_EAST_ENTRY_KEEP_CLEAR,
  FACTORY_CATWALK,
  PAP_ENERGY_VISUAL,
  MAP_RAMPS,
  MAP_NAV_LINKS,
  MAP_WALL_RUNS,
  MAP_WALLBUYS,
  MAP_PERKS,
  auditMapEgress,
  auditMapStructure,
  auditInteractableApproaches,
  auditKeepClearZone,
  elevationAwareRiseCandidate,
  roomsThatCanReachPlayers,
  papEnergyEnvelope,
  platformSideBlocksAtFeet,
  teleporterPromptState,
} from '../js/map-layout.js';
import { readFile } from 'node:fs/promises';

const mapSource = await readFile(new URL('../js/map.js', import.meta.url), 'utf8');

const audit = auditMapEgress();
assert.equal(audit.ok, true, audit.issues.join('\n'));
assert.equal(audit.roomsChecked, MAP_ROOMS.length);

const structure = auditMapStructure();
assert.equal(structure.ok, true, structure.issues.join('\n'));
assert.equal(structure.wallsChecked, MAP_WALL_RUNS.length);
assert.equal(structure.doorsChecked, MAP_DOOR_DEFS.length);
assert.ok(structure.windowsChecked > 0, 'map must retain physical zombie windows');
assert.ok(structure.solidSegments > MAP_WALL_RUNS.length, 'gapped walls must retain collider-backed solid segments');

// Every visible door has exactly one wall opening and a direct interaction
// price. Power-only doors used to render identically while being omitted from
// the interaction list, which made them appear broken.
for (const door of MAP_DOOR_DEFS) {
  assert.ok(Number.isFinite(door.cost), `${door.id} must be directly purchasable`);
  assert.notEqual(door.auto, true, `${door.id} must not be an unprompted auto-only door`);
  assert.equal(door.visibilityTreatment, 'framed-lit-cost', `${door.id} must have frame, practical light, and cost sign`);
}

// All zombie barriers are real ground-floor windows with a non-zero inward
// normal. The old positional W(...) helper silently assigned 0 to vertical
// normals, so zombies spawned inside the wall and attacked sideways.
for (const wall of MAP_WALL_RUNS) {
  for (const gap of wall.gaps || []) {
    if (gap.kind !== 'window') continue;
    assert.ok(gap.in === -1 || gap.in === 1, `${wall.id} window must face into its room`);
    assert.equal(wall.y0 || 0, 0, `${wall.id} must not create an elevated ground-level zombie barrier`);
  }
}

// Starter and other wall buys must be centered on a solid panel, not a window,
// door, or permanent passage.
assert.equal(MAP_WALLBUYS.length, 10);
for (const wb of MAP_WALLBUYS) assert.ok(wb.wallId, `${wb.weapon} must declare its mounting wall`);

const roomAt = (x, z, y) => MAP_ROOMS.find((room) => (
  (room.yMin === undefined || y >= room.yMin)
  && (room.yMax === undefined || y <= room.yMax)
  && x >= room.rect.minX && x <= room.rect.maxX
  && z >= room.rect.minZ && z <= room.rect.maxZ
))?.id || null;

// Every physical elevation route must have a declared room at both ends. This
// catches roomless pits and ramps that visually end against the wrong floor.
for (const ramp of MAP_RAMPS) {
  const [groundAxis, topAxis] = ramp.dir > 0
    ? [ramp.axis === 'x' ? ramp.minX : ramp.minZ, ramp.axis === 'x' ? ramp.maxX : ramp.maxZ]
    : [ramp.axis === 'x' ? ramp.maxX : ramp.maxZ, ramp.axis === 'x' ? ramp.minX : ramp.minZ];
  const otherAxis = ramp.axis === 'x'
    ? (ramp.minZ + ramp.maxZ) / 2
    : (ramp.minX + ramp.maxX) / 2;
  const groundRoom = ramp.axis === 'x'
    ? roomAt(groundAxis, otherAxis, ramp.y0)
    : roomAt(otherAxis, groundAxis, ramp.y0);
  const topRoom = ramp.axis === 'x'
    ? roomAt(topAxis, otherAxis, ramp.y1)
    : roomAt(otherAxis, topAxis, ramp.y1);
  assert.ok(groundRoom, `${ramp.id} has a roomless ground endpoint`);
  assert.ok(topRoom, `${ramp.id} has a roomless upper endpoint`);

  // Endpoints alone missed the bridge regression: the middle of each sloped
  // flight exceeded Central Passage's former yMax and containment snapped the
  // player back. Sample every ramp continuously from bottom to landing.
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const along = ramp.dir > 0 ? t : 1 - t;
    const axisPos = ramp.axis === 'x'
      ? ramp.minX + (ramp.maxX - ramp.minX) * along
      : ramp.minZ + (ramp.maxZ - ramp.minZ) * along;
    const y = ramp.y0 + (ramp.y1 - ramp.y0) * t;
    const sampleRoom = ramp.axis === 'x'
      ? roomAt(axisPos, otherAxis, y)
      : roomAt(otherAxis, axisPos, y);
    assert.ok(sampleRoom, `${ramp.id} has a roomless slope sample at ${(t * 100).toFixed(0)}%`);
  }
}

// The former underbridge pocket and both exterior stair flights are deliberately
// gone. The bridge is an upper connector reached only through indoor stairs.
assert.equal(MAP_ROOMS.some((room) => room.id === 'underbridge'), false);
assert.equal(MAP_RAMPS.some((ramp) => ramp.id.startsWith('underbridge')), false);
assert.equal(MAP_NAV_LINKS.some((link) => link.from === 'underbridge' || link.to === 'underbridge'), false);
assert.equal(MAP_DOOR_DEFS.some((door) => ['d_startBridge', 'd_bridgeCourt'].includes(door.id)), false);

// Prove the invariant catches regressions instead of only accepting current data.

const oneWayLinks = MAP_NAV_LINKS.filter(
  (link) => !(link.from === 'catwalk' && link.to === 'factory'),
);
const oneWayAudit = auditMapEgress({ navLinks: oneWayLinks });
assert.equal(oneWayAudit.ok, false, 'audit must reject a one-way stair');
assert.ok(oneWayAudit.issues.some((issue) => issue.includes('catwalk cannot return to mainframe')));

const roomIds = new Set(MAP_ROOMS.map((room) => room.id));
for (const door of MAP_DOOR_DEFS) {
  assert.ok(roomIds.has(door.rooms[0]) && roomIds.has(door.rooms[1]), `${door.id} must connect declared rooms`);
}

const doubleTapDoor = MAP_DOOR_DEFS.find((door) => door.id === 'd_pwrR');
assert.ok(doubleTapDoor, 'Double Tap side must retain a courtyard door');
assert.equal(doubleTapDoor.cost, 1000, 'Double Tap courtyard door must be directly purchasable');
assert.equal(doubleTapDoor.auto, undefined, 'Double Tap courtyard door must not wait for power');
assert.deepEqual(doubleTapDoor.rooms, ['garageentrance', 'courtyard']);
assert.equal(doubleTapDoor.w, 3.2, 'Double Tap courtyard gate must read as a wide walk-through opening');
assert.equal(doubleTapDoor.openingStyle, 'wide-passage');
const doubleTapGap = MAP_WALL_RUNS
  .flatMap((wall) => wall.gaps.map((gap) => ({ wall, gap })))
  .find(({ gap }) => gap.doorId === 'd_pwrR');
assert.equal(doubleTapGap?.gap.w, doubleTapDoor.w, 'courtyard shell opening must match the wide gate');
assert.equal(doubleTapGap?.gap.kind, 'door', 'courtyard gate gap must not render a lower window/sill segment');
assert.match(mapSource, /openingStyle === 'wide-passage'[\s\S]{0,160}door\.mesh\.visible = false/,
  'wide gate collider and leaf must disappear together instead of leaving a traversable panel');

// The two adjacent Automobile Garage doors connected the exact same rooms.
// Keep only the stairs-side gate so one purchase always means one new route.
const garageRouteDoors = MAP_DOOR_DEFS.filter((door) => (
  new Set(door.rooms).has('garageentrance') && new Set(door.rooms).has('autogarage')
));
assert.deepEqual(garageRouteDoors.map((door) => door.id), ['d_upG']);
assert.equal(MAP_DOOR_DEFS.some((door) => door.id === 'd_gar'), false);
assert.equal(MAP_WALL_RUNS.flatMap((wall) => wall.gaps).some((gap) => gap.doorId === 'd_gar'), false);
assert.equal(MAP_DOOR_DEFS.some((door) => door.id === 'd_lab'), false,
  'the redundant second Juggernog-side entrance must stay removed');
assert.equal(MAP_WALL_RUNS.flatMap((wall) => wall.gaps).some((gap) => gap.doorId === 'd_lab'), false,
  'the removed Juggernog-side door must not leave a misleading wall opening');
assert.equal(MAP_DOOR_DEFS.some((door) => door.id === 'd_upA'), false,
  'the Juggernog-side cluster must expose only one paid door');
assert.equal(MAP_WALL_RUNS.flatMap((wall) => wall.gaps).some((gap) => gap.doorId === 'd_upA'), false,
  'the former duplicate must be a permanent passage, not a dead door gap');

// Activation first enters a charging phase. RECHARGING is reserved for the
// post-teleport cooldown and must never appear on first approach/use.
assert.equal(teleporterPromptState({ powerOn: false }), 'no-power');
assert.equal(teleporterPromptState({ powerOn: true }), 'ready');
assert.equal(teleporterPromptState({ powerOn: true, charging: true }), 'charging');
assert.equal(teleporterPromptState({ powerOn: true, cooldown: 18 }), 'recharging');
assert.match(mapSource, /charging: false, cooldown: 0/);

assert.equal(MAINFRAME_PLATFORM.sideDropOpen, true, 'mainframe platform sides must be traversable');
const oneWaySide = { y0: 0, h: 0.95, oneWayPlatformSide: true };
assert.equal(platformSideBlocksAtFeet(oneWaySide, 0.02), true,
  'platform fascia must block a player approaching from the base floor');
assert.equal(platformSideBlocksAtFeet(oneWaySide, 0.7), false,
  'platform fascia must release during a normal jump so the deck is mountable from its sides');
assert.equal(platformSideBlocksAtFeet(oneWaySide, 0.9), false,
  'platform fascia must permit an outward drop from the deck');
const middleStepSide = { y0: 0, h: 0.65, oneWayPlatformSide: true };
assert.equal(platformSideBlocksAtFeet(middleStepSide, 0.02), true,
  'middle step fascia must block a base-floor walk-through');
assert.equal(platformSideBlocksAtFeet(middleStepSide, 0.4), false,
  'middle step ledge must release during a deliberate jump');
assert.deepEqual(MAINFRAME_STEPS.map((step) => step.y), [0.6, 0.3],
  'spawn steps must provide real floor surfaces at the visual tier heights');
const topDeckSide = { y0: 0, h: 0.95, oneWayPlatformSide: true, oneWayDeckTop: 0.9 };
assert.equal(platformSideBlocksAtFeet(topDeckSide, 1.05, 0), true,
  'a ground-launched jump must not phase through the top platform fascia');
assert.equal(platformSideBlocksAtFeet(topDeckSide, 0.92, 0.9), false,
  'a player already on the deck must be able to leave over either side');
assert.match(mapSource, /oneWayPlatformSide: true/,
  'mainframe platform fascia must use the audited one-way collision tag');
assert.doesNotMatch(mapSource, /crate\(-7\.5, 23\.5/,
  'the random green spawn-platform box must stay removed');
assert.match(mapSource, /18\.5, -6, 19\.75, 0\.65/,
  'mainframe stair fascia must follow the middle step height');
assert.match(mapSource, /14, -6, 18\.5, 2\.2, MAINFRAME_PLATFORM\.y/,
  'top-deck side collision must remain tall enough to block lower-tier jump apexes');
assert.doesNotMatch(mapSource, /19\.75, -6, 20\.95, 0\.35/,
  'the lowest step must stay open from its front, sides, and diagonals');
assert.doesNotMatch(mapSource, /spawn outdoor lamp post|post\.position\.set\(-8, 2\.3, 15\.6\)/,
  'the obstructive freestanding spawn lamp must stay removed');
assert.match(mapSource, /fillText\(text,[\s\S]{0,100}maxTextWidth\)/,
  'wall signage must constrain copy so the last S in DER KOLOSS cannot clip');
assert.match(mapSource, /wallSign\('CREATED BY VESPER\.INC'/,
  'courtyard facade must carry the subtle Vesper creator mark');
assert.doesNotMatch(mapSource, /\[12\.6, 12\.4, 3\]/,
  'Speed Cola approach must not contain the old tire stack');
assert.doesNotMatch(mapSource, /crate\(8, 24|crate\(8\.7, 24|barrel\(8\.6, 15\.4/,
  'Pack-a-Punch/right-door lane must not restore its two boxes or doorway barrel');

const clearEntrance = auditKeepClearZone(MAINFRAME_EAST_ENTRY_KEEP_CLEAR, [
  { minX: 2, maxX: 4, minZ: 13, maxZ: 16, y0: 0, h: 2, prop: true },
]);
assert.equal(clearEntrance.ok, true);
const blockedEntrance = auditKeepClearZone(MAINFRAME_EAST_ENTRY_KEEP_CLEAR, [
  { minX: 7.5, maxX: 8.5, minZ: 14, maxZ: 15, y0: 0, h: 1, prop: true },
]);
assert.equal(blockedEntrance.ok, false, 'main entrance keep-clear audit must reject a prop in the doorway lane');
assert.match(mapSource, /auditKeepClearZone\(MAINFRAME_EAST_ENTRY_KEEP_CLEAR, colliders\)/,
  'generated map must enforce the east entrance keep-clear zone');

assert.equal(FACTORY_CATWALK.minX, FACTORY_CATWALK.stairLandingX,
  'factory deck must begin exactly where the catwalk stairs land');
const catwalkStairs = MAP_RAMPS.find((ramp) => ramp.id === 'catwalkStairs');
assert.equal(catwalkStairs.maxX, FACTORY_CATWALK.minX,
  'stair flight must end exactly at the cut-back deck edge');
assert.match(mapSource, /new THREE\.BoxGeometry\(cwWidth, 0\.12/,
  'catwalk deck must use the audited cut-back width rather than spanning over stairs');
assert.doesNotMatch(mapSource, /new THREE\.BoxGeometry\(24, 0\.12, 2\.2\)/,
  'full-width deck would reinstall the low ceiling above the stair flight');

// Approach sampling operates on runtime collider footprints and fails if an
// interactable has no legal standing point inside its use radius.
const approachFixture = auditInteractableApproaches({
  interactables: [{ id: 'clear', pos: { x: 0, y: 1.2, z: 0 }, radius: 2.2 }],
  colliders: [{ minX: -0.4, maxX: 0.4, minZ: -0.4, maxZ: 0.4, y0: 0, h: 2 }],
  roomAt: () => 'test',
  floorY: () => 0,
});
assert.equal(approachFixture.ok, true);
const blockedApproach = auditInteractableApproaches({
  interactables: [{ id: 'blocked', pos: { x: 0, y: 1.2, z: 0 }, radius: 2.2 }],
  colliders: [{ minX: -3, maxX: 3, minZ: -3, maxZ: 3, y0: 0, h: 2 }],
  roomAt: () => 'test',
  floorY: () => 0,
});
assert.equal(blockedApproach.ok, false, 'approach audit must reject collider-enclosed interactions');
assert.match(mapSource, /auditInteractableApproaches\(\{ interactables: interact, colliders, roomAt, floorY \}\)/,
  'the generated map must audit every runtime interactable against actual colliders');

assert.ok(PAP_ENERGY_VISUAL.ringSegments <= 24 && PAP_ENERGY_VISUAL.tubeSegments <= 6);
assert.ok(PAP_ENERGY_VISUAL.arcCount * PAP_ENERGY_VISUAL.arcPoints <= 24,
  'Pack-a-Punch energy visual must retain its small geometry budget');
const papEnvelope = papEnergyEnvelope();
assert.ok(papEnvelope.minX >= -PAP_ENERGY_VISUAL.aperture.halfWidth
  && papEnvelope.maxX <= PAP_ENERGY_VISUAL.aperture.halfWidth,
'Pack-a-Punch energy must fit horizontally inside the front aperture');
assert.ok(papEnvelope.minY >= PAP_ENERGY_VISUAL.centerY - PAP_ENERGY_VISUAL.aperture.halfHeight
  && papEnvelope.maxY <= PAP_ENERGY_VISUAL.centerY + PAP_ENERGY_VISUAL.aperture.halfHeight,
'Pack-a-Punch energy must fit vertically inside the front aperture');
assert.ok(papEnvelope.maxZ < PAP_ENERGY_VISUAL.aperture.frontZ,
  'Pack-a-Punch energy must remain behind the slot front plane');
assert.match(mapSource, /papEnergy\.position\.set\(0, PAP_ENERGY_VISUAL\.centerY, PAP_ENERGY_VISUAL\.centerZ\)/);
assert.match(mapSource, /papCore\.position\.z = PAP_ENERGY_VISUAL\.coreOffsetZ/);
assert.match(mapSource, /papEnergy\.rotation\.z = time/);
assert.match(mapSource, /papCoreMat\.emissiveIntensity/);
assert.doesNotMatch(mapSource, /EffectComposer|ShaderMaterial/,
  'Pack-a-Punch energy must not add post-processing or a custom shader');

const type100Buy = MAP_WALLBUYS.find((wallbuy) => wallbuy.weapon === 'type100');
assert.equal(type100Buy?.y, 2.9, 'Type 100 must remain reachable on the Chemical Testing floor');
assert.equal(type100Buy?.wallId, 'chem_south_upper');

// Simulate the all-doors-open runtime graph.
const routeEdges = [];
for (const door of MAP_DOOR_DEFS) {
  routeEdges.push({ from: door.rooms[0], to: door.rooms[1], id: door.id, kind: 'door' });
  routeEdges.push({ from: door.rooms[1], to: door.rooms[0], id: door.id, kind: 'door' });
}
for (const link of MAP_NAV_LINKS) routeEdges.push({ ...link, id: link.route, kind: link.stair ? 'stair' : 'route' });
const findDeclaredRoute = (start, goal) => {
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const room = queue.shift();
    if (room === goal) break;
    for (const edge of routeEdges) {
      if (edge.from !== room || prev.has(edge.to)) continue;
      prev.set(edge.to, { room, edge });
      queue.push(edge.to);
    }
  }
  if (!prev.has(goal)) return null;
  const path = [];
  for (let room = goal; room !== start;) {
    const step = prev.get(room);
    path.unshift(step.edge);
    room = step.room;
  }
  return path;
};

// Each named machine must exist on a real playable floor, and its room must be
// connected back to Mainframe. In particular B lives upstairs beside Type 100.
assert.deepEqual(MAP_TELEPORTERS.map((tele) => tele.id), ['teleA', 'teleB', 'teleC']);
assert.equal(new Set(MAP_TELEPORTERS.map((tele) => tele.id)).size, 3);
for (const tele of MAP_TELEPORTERS) {
  assert.equal(roomAt(tele.x, tele.z, tele.y), tele.room, `${tele.id} must sit in its declared playable room`);
  assert.ok(findDeclaredRoute(tele.room, 'mainframe'), `${tele.id} room must return to Mainframe`);
  assert.ok(tele.clearance >= 1.9, `${tele.id} must reserve a usable player pad`);
}
const teleB = MAP_TELEPORTERS.find((tele) => tele.id === 'teleB');
assert.deepEqual(teleB, {
  id: 'teleB', label: 'B', room: 'chemtesting', x: 17, y: 2.9, z: -30.5,
  clearance: 1.9, frameHeight: 2.5,
});
assert.equal(type100Buy?.y, teleB.y, 'Teleporter B and Type 100 must share the Chemical Testing floor');
const chemicalRoom = MAP_ROOMS.find((room) => room.id === 'chemtesting');
const teleBWallClearance = Math.min(
  teleB.x - chemicalRoom.rect.minX,
  chemicalRoom.rect.maxX - teleB.x,
  teleB.z - chemicalRoom.rect.minZ,
  chemicalRoom.rect.maxZ - teleB.z,
);
assert.ok(teleBWallClearance >= 7, 'Teleporter B must have generous circulation room on every side');
assert.ok(teleB.y + teleB.frameHeight < 5.75,
  'Teleporter B gantry must remain below the Chemical Testing ceiling underside');

const courtyardToBridge = findDeclaredRoute('courtyard', 'bridge');
assert.ok(courtyardToBridge, 'ground zombie must reach a bridge player');
assert.ok(courtyardToBridge.some((edge) => edge.kind === 'stair'), 'ground-to-bridge route must include a physical stair');

const hasEdge = (from, to, id) => routeEdges.some((edge) => edge.from === from && edge.to === to && edge.id === id);
for (const [from, to, id] of [
  ['mainframe', 'leftcorridor', 'd_mainL'],
  ['leftcorridor', 'upstairsa', 'labStairs'],
  ['upstairsa', 'bridge', 'd_bridgeW'],
  ['mainframe', 'garageentrance', 'd_mainR'],
  ['garageentrance', 'upstairsg', 'garageStairs'],
  ['upstairsg', 'bridge', 'd_bridgeE'],
]) assert.ok(hasEdge(from, to, id), `missing intentional bridge route ${from} -> ${to} via ${id}`);

for (const [from, to, id] of [
  ['leftcorridor', 'courtyard', 'd_pwrL'],
  ['garageentrance', 'courtyard', 'd_pwrR'],
]) assert.ok(hasEdge(from, to, id), `missing intentional courtyard entrance ${id}`);

// Spawn reachability is the reverse of directed path reachability. A balcony
// zombie can drop into the courtyard, but a courtyard zombie cannot climb that
// ledge when all courtyard doors are closed.
const isolatedDropLinks = [{ from: 'upstairsg', to: 'courtyard', drop: true }];
assert.deepEqual(
  [...roomsThatCanReachPlayers(['upstairsg'], [], isolatedDropLinks)],
  ['upstairsg'],
  'closed-door courtyard must not spawn enemies that cannot climb to a balcony survivor',
);
assert.deepEqual(
  [...roomsThatCanReachPlayers(['courtyard'], [], isolatedDropLinks)].sort(),
  ['courtyard', 'upstairsg'],
  'the balcony is a valid source room when its one-way drop reaches the courtyard survivor',
);
assert.ok(
  roomsThatCanReachPlayers(
    ['upstairsg'],
    [{ rooms: ['courtyard', 'garageentrance'] }],
    [
      ...isolatedDropLinks,
      { from: 'garageentrance', to: 'upstairsg', stair: true },
      { from: 'upstairsg', to: 'garageentrance', stair: true },
    ],
  ).has('courtyard'),
  'opening a bidirectional courtyard route must make its spawn rooms eligible again',
);

// A rise check must use the upper floor for both floor and room lookup. A
// candidate that only exists in the overlapping ground footprint is rejected.
const stackedRoomAt = (x, z, y) => {
  if (x >= -2 && x <= 2 && z >= -2 && z <= 2 && y >= 2) return 'upper';
  if (x >= -4 && x <= 4 && z >= -4 && z <= 4) return 'ground';
  return null;
};
const stackedFloorY = (x, z, currentY) => (
  x >= -2 && x <= 2 && z >= -2 && z <= 2 && currentY >= 2 ? 2.9 : 0
);
assert.deepEqual(
  elevationAwareRiseCandidate({
    target: { x: 0, y: 2.9, z: 0 },
    candidates: [{ x: 3, z: 0 }, { x: 1.5, z: 0 }],
    roomAt: stackedRoomAt,
    floorY: stackedFloorY,
  }),
  { x: 1.5, z: 0, y: 2.9, room: 'upper' },
  'upper-only survivor fallback must reject the underlying ground room',
);
assert.equal(
  elevationAwareRiseCandidate({
    target: { x: 0, y: 2.9, z: 0 },
    candidates: [{ x: 3, z: 0 }],
    roomAt: stackedRoomAt,
    floorY: stackedFloorY,
  }),
  null,
  'no valid upper candidate is safer than spawning an unreachable ground enemy',
);

// Prove structure checks fail on each regression class.
const zeroNormalWalls = structuredClone(MAP_WALL_RUNS);
zeroNormalWalls.flatMap((wall) => wall.gaps).find((gap) => gap.kind === 'window').in = 0;
const zeroNormalAudit = auditMapStructure({ walls: zeroNormalWalls });
assert.equal(zeroNormalAudit.ok, false, 'audit must reject sideways/zero-normal barriers');
assert.ok(zeroNormalAudit.issues.some((issue) => issue.includes('explicit ±1 inward normal')));

const missingDoorWalls = structuredClone(MAP_WALL_RUNS);
for (const wall of missingDoorWalls) wall.gaps = wall.gaps.filter((gap) => gap.doorId !== 'd_mainL');
const missingDoorAudit = auditMapStructure({ walls: missingDoorWalls });
assert.equal(missingDoorAudit.ok, false, 'audit must reject a door without a matching wall opening');
assert.ok(missingDoorAudit.issues.some((issue) => issue.includes('d_mainL must occupy exactly one wall opening')));

const windowMountedBuy = MAP_WALLBUYS.map((wb) => wb.weapon === 'kar98' ? { ...wb, z: 20 } : wb);
const windowBuyAudit = auditMapStructure({ wallbuys: windowMountedBuy });
assert.equal(windowBuyAudit.ok, false, 'audit must reject a wall buy mounted across a window');
assert.ok(windowBuyAudit.issues.some((issue) => issue.includes('wallbuy kar98 overlaps a window')));

const speed = MAP_PERKS.find((perk) => perk.id === 'speed');
assert.ok(speed, 'Speed Cola must be declared in audited layout data');
assert.equal(speed.z, 12.5, 'Speed Cola must stay on the solid panel beyond the garage window');
const blockedWindowPerks = MAP_PERKS.map((perk) => perk.id === 'speed' ? { ...perk, z: 10 } : perk);
const blockedWindowAudit = auditMapStructure({ perks: blockedWindowPerks });
assert.equal(blockedWindowAudit.ok, false, 'audit must reject a perk obstructing a barricade');
assert.ok(blockedWindowAudit.issues.some((issue) => issue.includes('window on garage_outer overlaps perk speed')));

const colliderBlockedWalls = [
  ...structuredClone(MAP_WALL_RUNS),
  { id: 'test_rebuild_blocker', x1: -4, z1: 24.2, x2: -4, z2: 25.3, h: 4.5, gaps: [] },
];
const colliderBlockedAudit = auditMapStructure({ walls: colliderBlockedWalls });
assert.equal(colliderBlockedAudit.ok, false, 'audit must reject wall collision in a barricade rebuild zone');
assert.ok(colliderBlockedAudit.issues.some((issue) => issue.includes('mainframe_north rebuild zone overlaps a wall collider')));

const untreatedDoors = MAP_DOOR_DEFS.map((door) => door.id === 'd_bridgeW' ? { ...door, visibilityTreatment: undefined } : door);
const untreatedDoorAudit = auditMapStructure({ doors: untreatedDoors });
assert.equal(untreatedDoorAudit.ok, false, 'audit must reject a purchasable door without visibility treatment');
assert.ok(untreatedDoorAudit.issues.some((issue) => issue.includes('d_bridgeW must use the framed-lit-cost visibility treatment')));

console.log(`Map integrity audit passed: ${audit.roomsChecked} rooms, ${structure.wallsChecked} wall runs, ${MAP_DOOR_DEFS.length} working doors, ${structure.windowsChecked} aligned barriers, ${MAP_NAV_LINKS.length} directed routes.`);
