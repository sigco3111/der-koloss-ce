// Reject geometry that puts two visible surfaces in exactly the same plane.
//
// Two coplanar, same-facing faces cannot be resolved by the depth buffer. Which
// one wins is decided per pixel, per frame, by floating-point rounding — so the
// seam between them crawls and sparkles as the camera moves. Players describe
// it as "random parts of the map flickering", and it is the single most common
// cause of that report in this project.
//
// `validate-wall-overlaps.mjs` catches the volume case: two wall RUNS occupying
// the same space. This file catches the harder one: surfaces that merely touch,
// with no overlapping volume at all, because three different modules each
// derived the same coordinate from the same number.
//
// Everything asserted here is data, so it can be checked without a GPU:
//   1. a doorway's opening, its jamb and its leaf must not share a plane;
//   2. an elevated wall run's brickwork must start below its authored y0;
//   3. the spawn-platform step nosings must stand proud of their treads.
// The second and third are read out of `js/map.js` as source, the way
// `audit-map-egress.mjs` already does, because the geometry there is emitted
// inside a DOM-dependent builder that CI cannot import.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOOR_FIT, MAP_DOOR_DEFS, MAP_WALL_RUNS, cappedWallRuns } from '../js/map-layout.js';

const EPS = 0.02;   // a plane separation below this is not a separation

// ---------------------------------------------------------------------------
// 1. Doorways
// ---------------------------------------------------------------------------
const {
  jambRebate, postWidth, postDepth, leafInset, wallThickness,
} = DOOR_FIT;

for (const key of ['jambRebate', 'postWidth', 'postDepth', 'leafInset', 'wallThickness']) {
  assert.ok(Number.isFinite(DOOR_FIT[key]), `DOOR_FIT.${key} must be a number`);
}

// The jamb has to reach PAST the brick cut face, not stop on it.
assert.ok(jambRebate >= EPS,
  `door jamb must rebate at least ${EPS}m into the opening so the wall's cut face is hidden behind it, got ${jambRebate}`);
// ...but not so far that it swallows the frame's own section.
assert.ok(jambRebate < postWidth,
  'door jamb rebate must be smaller than the post section, or the post has no purchase in the wall');
// The leaf must be narrower than the raw opening — flush, its edge sat on the
// brick cut plane — but still wide enough that the jamb covers that edge.
// Writing both bounds out: leafHalf = w/2 - leafInset/2 and the jamb's inner
// face is at w/2 - jambRebate, so 0 < leafInset/2 < jambRebate.
assert.ok(leafInset / 2 >= 0.01,
  `door leaf inset ${leafInset / 2}m per side is too small; its edge is still on the brick cut plane`);
assert.ok(leafInset / 2 < jambRebate,
  `door leaf inset (${leafInset / 2}m per side) must stay inside the jamb rebate (${jambRebate}m), or the leaf edge is exposed in the opening`);
// The jamb must stay inside the wall so its own faces are buried in brick.
assert.ok(postDepth < wallThickness - EPS,
  `door jamb depth ${postDepth} must sit inside the ${wallThickness}m wall`);

// Every authored door gap must be wide enough that two rebated jambs still
// leave a passable opening.
const doorGaps = new Map();
for (const run of MAP_WALL_RUNS) {
  for (const gap of run.gaps || []) {
    if (gap.kind !== 'door') continue;
    doorGaps.set(gap.doorId, gap.w);
  }
}
for (const door of MAP_DOOR_DEFS) {
  const gapW = doorGaps.get(door.id);
  assert.ok(gapW !== undefined, `${door.id} has no door gap in any wall run`);
  assert.equal(gapW, door.w || 1.9, `${door.id} wall gap and door width disagree`);
  const clear = gapW - 2 * jambRebate;
  assert.ok(clear >= 1.4, `${door.id} clear opening ${clear.toFixed(2)}m is too tight to walk through`);
}

// The prop that builds the jamb has to read those numbers rather than repeat
// them. It used to hardcode a 0.22 post at HW + 0.11, which is precisely the
// arrangement that lands the post's inner face on the brick cut plane.
const doorSource = await readFile(new URL('../js/props/door.js', import.meta.url), 'utf8');
assert.match(doorSource, /import \{ DOOR_FIT \} from '\.\.\/map-layout\.js';/,
  'js/props/door.js must take its fit from DOOR_FIT, not from repeated literals');
assert.match(doorSource, /const inner = HW - REB;/,
  'the jamb post must be positioned from the rebate');
assert.match(doorSource, /const LW = w - DOOR_FIT\.leafInset;/,
  'the door leaf must be inset from the raw opening width');
assert.doesNotMatch(doorSource, /k\.box\('iron', 0\.22, 3\.16, 0\.34, x, 1\.55, 0\)/,
  'the old flush jamb post is back; it z-fights the wall down both sides of every doorway');

// ---------------------------------------------------------------------------
// 2 & 3. Source-level invariants in the map builder
// ---------------------------------------------------------------------------
const mapSource = await readFile(new URL('../js/map.js', import.meta.url), 'utf8');

// The wall builder must sink an elevated run below its authored y0. Flush, an
// upper run's base plane coincided with the ground run's top AND with the deck
// slab's top — up to 16 metres of three-way coplanar surface per room.
assert.match(mapSource, /const skirt = y0 > 0 \? [0-9.]+ : 0;/,
  'wallRun() must drop an elevated run below its authored y0 (the `skirt`), or upper walls z-fight the deck they stand on');
const skirt = Number(mapSource.match(/const skirt = y0 > 0 \? ([0-9.]+) : 0;/)[1]);
assert.ok(skirt >= EPS, `wall skirt ${skirt} is too small to separate the planes`);
assert.match(mapSource, /pushBox\(solidGeos\[mat\], cx, y0 - skirt \+ \(h \+ skirt - cap\) \/ 2, cz, bw, h \+ skirt - cap, bd\)/,
  'the solid wall segment must actually use the skirt and the cap drop');
// The collider must NOT move with it: gameplay is authored against y0.
assert.match(mapSource, /colliders\.push\(\{ minX: cx - bw \/ 2, maxX: cx \+ bw \/ 2, minZ: cz - bd \/ 2, maxZ: cz \+ bd \/ 2, y0, h \}\)/,
  'the wall skirt is a visual offset only; its collider must still start at y0');

// Spawn-platform step nosings stand proud of the tread. Flush, their top face
// and the concrete tread's top face were one plane, 12m wide, on all three
// steps — the first thing a player sees at spawn.
const nosing = mapSource.match(/pushBox\(solidGeos\.plate, 0, ny - ([0-9.]+), nz, 12, ([0-9.]+), 0\.16\);/);
assert.ok(nosing, 'the spawn-platform step nosings must still be emitted');
const proud = Number(nosing[2]) / 2 - Number(nosing[1]);
assert.ok(proud >= 0.002,
  `step nosings must stand at least 2mm proud of the tread, got ${(proud * 1000).toFixed(1)}mm — flush, they z-fight into a hard line across all three steps`);
assert.ok(proud <= 0.02, `step nosings ${(proud * 1000).toFixed(0)}mm proud is a trip hazard, not a nosing`);

// A run with another run standing on it sinks its own cap, because inside an
// elevated DOOR OPENING the upper run is absent below the lintel and the joint
// is exposed right across the threshold. That was the residual z-fight on the
// Lab Balcony's bridge doorway.
const capped = cappedWallRuns(MAP_WALL_RUNS);
assert.ok(capped.size >= 6,
  `expected the stacked wall runs to be detected as capped, got ${capped.size}`);
for (const id of ['left_alley_ground', 'right_alley_ground', 'chem_east_ground', 'courtyard_north']) {
  assert.ok(capped.has(id), `${id} has a run standing on it and must be treated as capped`);
}
assert.match(mapSource, /const cap = capped \? [0-9.]+ : 0;/,
  'wallRun() must sink the cap of a run that another run stands on');
const capDrop = Number(mapSource.match(/const cap = capped \? ([0-9.]+) : 0;/)[1]);
assert.ok(capDrop >= EPS, `capped-run drop ${capDrop} is too small to separate the planes`);
assert.match(mapSource, /wallRun\(wall\.x1, wall\.z1, wall\.x2, wall\.z2, wall\.h, wall\.gaps, wall\.mat \|\| 'wall', wall\.y0 \|\| 0, cappedRuns\.has\(wall\.id\)\)/,
  'the wall-run loop must pass the capped flag through');

// Ceiling slabs ABUT, never overlap. Two soffits in one plane is the worst
// case of all — the soffit is the face you look straight up at — and the
// animal lab against the generator room was 11.8m2 of it directly over a
// doorway. Every `ceil(...)` call takes literal arguments, so the whole
// arrangement can be checked here without a renderer.
const ceilCalls = [...mapSource.matchAll(/^\s*ceil\((-?[\d.]+), (-?[\d.]+), ([\d.]+), ([\d.]+), (\w+)/gm)]
  .map((m) => ({
    cx: Number(m[1]), cz: Number(m[2]), w: Number(m[3]), d: Number(m[4]), y: m[5],
  }));
assert.ok(ceilCalls.length >= 12, `expected the map's ceiling slabs, found ${ceilCalls.length}`);
const overlaps = [];
for (let i = 0; i < ceilCalls.length; i++) {
  for (let j = i + 1; j < ceilCalls.length; j++) {
    const a = ceilCalls[i], b = ceilCalls[j];
    if (a.y !== b.y) continue;                       // different heights cannot fight
    const dx = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
    const dz = Math.min(a.cz + a.d / 2, b.cz + b.d / 2) - Math.max(a.cz - a.d / 2, b.cz - b.d / 2);
    if (dx > 0.001 && dz > 0.001) {
      overlaps.push(`(${a.cx},${a.cz}) x (${b.cx},${b.cz}) at y=${a.y}: ${(dx * dz).toFixed(2)}m2`);
    }
  }
}
assert.deepEqual(overlaps, [],
  `ceiling slabs at the same height must abut, not overlap — an overlap puts two soffits in one plane:\n  ${overlaps.join('\n  ')}`);

// The brick normal map has to be band-limited before the Sobel, or its
// one-texel mortar cliffs alias into crawling bright dashes at every glancing
// angle no matter what the sampler does.
assert.match(mapSource, /const hd = boxBlur\(h\.getImageData\(0, 0, S, S\)\.data, S, ([0-9]+)\);/,
  'the brick height field must be blurred before the height->normal Sobel');
const blur = Number(mapSource.match(/const hd = boxBlur\(h\.getImageData\(0, 0, S, S\)\.data, S, ([0-9]+)\);/)[1]);
assert.ok(blur >= 2, `brick height blur radius ${blur} is too small to band-limit a 3px mortar joint`);

// Generated canvas textures on world surfaces need anisotropy; the loaded CC0
// sets get 16 in assets.js and the code-drawn brick used to get the default 1.
assert.match(mapSource, /for \(const t of \[map, normalMap\]\) \{ t\.wrapS = t\.wrapT = THREE\.RepeatWrapping; t\.anisotropy = 16; \}/,
  'the generated brick colour and normal maps must set anisotropy');

// ---------------------------------------------------------------------------
// 4. The material stack must keep its normal-map level of detail
// ---------------------------------------------------------------------------
const matSource = await readFile(new URL('../js/render/Materials.js', import.meta.url), 'utf8');
// The filter body is written ONCE and injected by both the map's merged
// materials and the props' hero materials. A duplicated GLSL patch drifts, so
// the invariant is that there is exactly one copy of each of these lines.
assert.match(matSource, /float nfFootprint = max\(length\(dFdx\(\$\{pos\}\)\), length\(dFdy\(\$\{pos\}\)\)\);/,
  'Materials.js must measure the world-space pixel footprint for normal-map LOD');
assert.match(matSource, /\$\{shade\} = normalize\(mix\(\$\{geo\}, \$\{shade\}, nfKeep\)\);/,
  'Materials.js must fade the perturbed normal toward the geometric normal');
assert.equal((matSource.match(/nfFootprint = max\(/g) || []).length, 1,
  'the normal-map LOD footprint must be computed in exactly one place');
// enhanceMaterial drives it in WORLD space, off the varyings the detail stack
// already carries; applyNormalFilter drives it in VIEW space, which is rigid
// and so measures the same metres without paying for extra varyings.
assert.match(matSource, /pos: 'vWorldPosD', geo: 'wn', shade: 'nW'/,
  'enhanceMaterial must drive the filter from the world position and normal');
assert.match(matSource, /pos: 'vViewPosition',[\s\S]{0,200}geo: 'nonPerturbedNormal',[\s\S]{0,80}shade: 'normal',/,
  'applyNormalFilter must drive the filter from the view position and three’s unperturbed normal');
// The specular-AA widening must be driven by a LOCAL AVERAGE. A previous
// version used length(nW - wn), a per-pixel high-frequency quantity, which
// moved the aliasing from the normal into the roughness and measured WORSE
// than doing nothing.
assert.doesNotMatch(matSource, /float lost = length\(nW - wn\)/,
  'specular-AA roughness must not be driven by the instantaneous normal perturbation');
assert.match(matSource, /float nfVar = 0\.5 \* \(dot\(nfDx, nfDx\) \+ dot\(nfDy, nfDy\)\);/,
  'specular-AA roughness must come from the screen-space derivative of the normal');
// Injecting different shader source through a closure defeats three's default
// program cache key (onBeforeCompile.toString()), which would silently hand
// one material another's compiled program.
assert.equal((matSource.match(/customProgramCacheKey = \(\) =>/g) || []).length, 2,
  'both material patches must key the program cache on the source they inject');

// The hero props must get the same filtering. This was the gap: 2cm glossy
// rivets and flanges on the door jambs had no geometric specular AA at all,
// because the filter only ever reached the map's merged materials.
const propSource = await readFile(new URL('../js/props/materials.js', import.meta.url), 'utf8');
assert.match(propSource, /import \{ applyNormalFilter \} from '\.\.\/render\/Materials\.js';/,
  'props/materials.js must import the shared normal filter');
assert.match(propSource, /subtractGeometric: true/,
  'prop materials must not double-count the part seams three already widens');
assert.match(propSource, /t\.anisotropy = 16;/,
  'prop textures must set anisotropy like the map textures do');
assert.match(propSource, /t\.minFilter = THREE\.LinearMipmapLinearFilter;/,
  'prop textures must be trilinear-filtered');
// The largest single win at the bridge doorway, and the same rule the brick
// already follows: a height field drawn as one- and two-pixel rectangles must
// be blurred before its Sobel, or the normal map swings most of a right angle
// between adjacent texels and no filtering downstream can band-limit it.
//
// The invariant, not the wording: (a) the Sobel actually applies the radius it
// is handed, (b) it refuses to run without one, (c) every generator names a
// radius from the BLUR table rather than inheriting a default, and (d) that
// table gives each generator its OWN number. A single shared radius is the bug
// this replaced — it has to be big enough for cast iron's 1-texel sand grain
// and small enough for the plank generator's 1.5-texel woodgrain at once, and
// no number is both.
assert.match(propSource, /const src = blur > 0 \? boxBlur\(raw, S, H, blur\) : null;/,
  'normalFromHeight must actually apply the blur it accepts');
assert.match(propSource, /function normalFromHeight\(hCanvas, strength, blur\)/,
  'normalFromHeight must take an explicit blur radius, with no default to inherit');
assert.match(propSource, /if \(!\(blur >= 0\)\) throw new Error/,
  'normalFromHeight must refuse to Sobel a height field with no blur radius');

const blurTable = propSource.match(/^const BLUR = \{$([\s\S]*?)^\};$/m);
assert.ok(blurTable, 'props/materials.js must declare a BLUR table of per-generator radii');
const radii = Object.fromEntries(
  [...blurTable[1].matchAll(/^\s{2}(\w+): (\d+),$/gm)].map(([, k, v]) => [k, Number(v)]));
// The call sites, not the declaration: every generator hands its height canvas
// to the Sobel, so `normalFromHeight(hgt, ...)` finds each one exactly once.
const sobelCalls = [...propSource.matchAll(/normalFromHeight\(hgt,[^)]*\)/g)].map((m) => m[0]);
assert.ok(sobelCalls.length >= 4,
  `expected every prop generator to Sobel a height field, found ${sobelCalls.length}`);
for (const call of sobelCalls) {
  const named = call.match(/BLUR\.(\w+)\s*$/) || call.match(/BLUR\.(\w+)/);
  assert.ok(named && named[1] in radii,
    `every height->normal Sobel must name a radius from the BLUR table: ${call}`);
}
assert.equal(new Set(sobelCalls.map((c) => c.match(/BLUR\.(\w+)/)[1])).size, sobelCalls.length,
  'each generator must name its own BLUR entry, not share one with another generator');
assert.ok(new Set(Object.values(radii)).size > 1,
  `the BLUR radii are all ${Object.values(radii)[0]} — a shared radius cannot band-limit `
  + "cast iron's 1-texel grain without erasing the plank generator's 1.5-texel woodgrain");
// The two ends of that spread, so a later edit cannot quietly collapse it. The
// plank ceiling is the fidelity side: n = 2r+1 = 5 would crush a 1.5-texel
// grain stroke to 30% and merge the two walls of a 4-texel board gap.
assert.ok(radii.castIron > radii.plank,
  'cast iron (1-texel sand grain, 21% coverage) must be blurred harder than the planks');
assert.ok(radii.plank <= 1,
  `plank blur radius ${radii.plank} would sand the woodgrain off the crates`);
for (const [file, count] of [['door.js', 1], ['packAPunch.js', 1], ['perkMachine.js', 1], ['mysteryBox.js', 1]]) {
  const src = await readFile(new URL(`../js/props/${file}`, import.meta.url), 'utf8');
  assert.equal((src.match(/propMaterial\(\{[\s\S]{0,120}normalMap:/g) || []).length, count,
    `${file} must build its normal-mapped material through propMaterial`);
}

// ---------------------------------------------------------------------------
// 5. The shadow box's edge ramp is used consistently
// ---------------------------------------------------------------------------
// The surface shader gets its ramp from a patch into three's ShaderChunk; the
// volumetric raymarch samples the same shadow map itself and needs the same
// number. If the two disagree the shafts and the ground under them fade at
// different rates, which is MORE visible than the hard edge either replaces.
const fadeSource = await readFile(new URL('../js/render/ShadowEdgeFade.js', import.meta.url), 'utf8');
assert.match(fadeSource, /export const SHADOW_EDGE_FADE = [0-9.]+;/,
  'ShadowEdgeFade.js must export the ramp width');
assert.match(fadeSource, /shadowEdgeT/, 'the chunk patch must still emit the edge ramp');
const sunSource = await readFile(new URL('../js/render/SunShadow.js', import.meta.url), 'utf8');
assert.match(sunSource, /installShadowEdgeFade\(\);/,
  'SunShadow.js must install the edge fade at module load, before any material compiles');
const postSource = await readFile(new URL('../js/render/PostFX.js', import.meta.url), 'utf8');
assert.match(postSource, /uShadowEdgeFade: \{ value: SHADOW_EDGE_FADE \}/,
  'the volumetric pass must take its edge ramp from the same constant, not a literal');
const shaderSource = await readFile(new URL('../js/render/shaders.js', import.meta.url), 'utf8');
assert.match(shaderSource, /1\.0 - smoothstep\(1\.0 - uShadowEdgeFade, 1\.0, max\(e\.x, e\.y\)\)/,
  'sunVisibility() in the raymarch must apply the same edge ramp');

console.log(`coplanar surfaces OK (${MAP_DOOR_DEFS.length} doorways, ${MAP_WALL_RUNS.length} wall runs, ${capped.size} capped, ${ceilCalls.length} ceiling slabs abutting, skirt ${skirt}m, nosing ${(proud * 1000).toFixed(0)}mm proud)`);
