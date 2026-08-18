// A weapon finish must never write a PBR property onto an unlit material.
//
// The bug this was written for: GOLD STANDARD, and Pack-a-Punching any red-dot
// weapon, turned the whole screen black. Not a shader failure and not a crash —
// the game object stayed alive, the loop kept running, the netcode kept
// ticking and the DOM HUD kept updating, which is why it was reported as "the
// screen just goes blank" and "everything froze".
//
// The chain:
//   * A weapon group is NOT uniformly MeshStandardMaterial. Every optic built
//     by redDot() carries two MeshBasicMaterial meshes — the reticle core and
//     its bloom halo — because a reticle is a projected light, not a lit
//     surface. That is 4 of the 31 weapons before Pack-a-Punch, more after,
//     since several weapons only grow an optic when they are upgraded.
//   * applyGoldCamo / applyDiamondCamo / applyPapLivingFinish traversed with
//     the guard `if (o.isMesh && o.material)` and unconditionally assigned
//     `o.material.emissive = new THREE.Color(...)`.
//   * three checks `if (material.emissive)` in refreshUniformsCommon and then
//     dereferences `uniforms.emissive.value`. The basic shader's uniform set
//     has no `emissive`, so the assignment turned into a TypeError thrown from
//     INSIDE renderer.render().
//   * That throw escaped the post chain between "bind the offscreen HDR target"
//     and "unbind it", so the renderer stayed bound to that target forever and
//     every later frame landed offscreen. One bad material cost the session,
//     not a frame.
//
// The property assignment is the root cause and the only thing worth guarding,
// because it is silent: it does not throw where it is written, it throws later,
// somewhere else, inside vendor code. So this check builds every weapon in
// every finish and asserts that no unlit material came out carrying a property
// only a lit material can render.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { THREE, loadGameModule } from './lib/headless-three.mjs';

const { WEAPONS, WeaponRig, buildViewmodel, buildPapDisplayWeapon, buildDisplayWeapon } =
  await loadGameModule('weapons.js');

// Properties whose uniforms exist only in the lit shaders. Writing any of them
// onto a MeshBasicMaterial is the defect.
const LIT_ONLY = ['emissive', 'emissiveMap', 'emissiveIntensity', 'metalness', 'roughness'];

/** Every violating mesh in a built weapon group. */
function violations(group, label) {
  const out = [];
  group.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.isMeshStandardMaterial) continue;
      const wrote = LIT_ONLY.filter((k) => m[k] !== undefined);
      if (wrote.length) out.push(`${label}: ${m.type} carries ${wrote.join(', ')}`);
    }
  });
  return out;
}

/** How many meshes a finish actually recoloured, so a no-op cannot pass as clean. */
function tinted(group, hex) {
  let n = 0;
  group.traverse((o) => {
    if (o.isMesh && o.material?.color?.getHexString?.() === hex) n++;
  });
  return n;
}

const ids = Object.keys(WEAPONS);
const failures = [];
let meshesChecked = 0;
let unlitSeen = 0;
let goldWeapons = 0;
let diamondWeapons = 0;

// ---------------------------------------------------------------------------
// 1. Every weapon, every finish, through the real WeaponRig
// ---------------------------------------------------------------------------
// equip() is what actually picks the finish: gold for a stock gun when
// alwaysGold is set, diamond for a Pack-a-Punched one, the living PaP camo
// otherwise. Driving the rig rather than the camo helpers keeps this honest
// about the selection logic as well as the assignment.
const rig = new WeaponRig(new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 10));

for (const id of ids) {
  for (const finish of ['stock', 'pap', 'gold', 'diamond']) {
    rig.alwaysGold = finish === 'gold' || finish === 'diamond';
    rig.diamondNext = false;
    const pap = finish === 'pap' || finish === 'diamond';
    // A throw here is its own failure: an unknown-id or missing-muzzle
    // regression takes the game down before the first frame.
    rig.equip(id, pap);
    const label = `${id}/${finish}`;
    failures.push(...violations(rig.current.group, label));
    rig.current.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      meshesChecked++;
      if (!o.material.isMeshStandardMaterial) unlitSeen++;
    });
    if (finish === 'gold' && tinted(rig.current.group, 'd4af37') > 0) goldWeapons++;
    if (finish === 'diamond' && tinted(rig.current.group, 'f4f6fa') > 0) diamondWeapons++;
  }
}

// ---------------------------------------------------------------------------
// 2. The world-space display weapons (mystery box, Pack-a-Punch)
// ---------------------------------------------------------------------------
// buildPapDisplayWeapon runs the same living finish over a group the player
// sees in the WORLD pass, so a violation here blacks out the level rather than
// the viewmodel.
for (const id of ids) {
  failures.push(...violations(buildPapDisplayWeapon(id), `${id}/papDisplay`));
  failures.push(...violations(buildDisplayWeapon(id, true), `${id}/display+pap`));
  failures.push(...violations(buildViewmodel(id, true), `${id}/viewmodel+pap`));
}

// ---------------------------------------------------------------------------
// 3. The gloves are not part of the weapon
// ---------------------------------------------------------------------------
// equip() re-parents the hands INTO the weapon group, so a finish applied with
// a plain traverse gilds the player's hands too.
rig.alwaysGold = true;
rig.equip('acr', false);
let gildedGloves = 0;
rig.current.group.traverse((o) => {
  if (o.isMesh && o.userData?.isGlove && o.material?.color?.getHexString?.() === 'd4af37') gildedGloves++;
});
if (gildedGloves) failures.push(`GOLD STANDARD gilded ${gildedGloves} glove meshes — a camo belongs to the weapon, not the hands`);

// ---------------------------------------------------------------------------
// 4. An unknown weapon id must degrade, not throw
// ---------------------------------------------------------------------------
// A saved loadout and a host's cheat payload can both name a weapon this build
// does not have. getStats used to throw on the next property read, inside
// init(), before the first frame — another black screen.
for (const bogus of ['acr_v1_removed', '', 'nope']) {
  const vm = buildViewmodel(bogus, false);
  assert.ok(vm.userData.muzzle, `buildViewmodel('${bogus}') produced a weapon with no muzzle — equip() dereferences it`);
}

// ---------------------------------------------------------------------------
// 5. The guard is still wired into every mutation site
// ---------------------------------------------------------------------------
// The behavioural sweep above only sees materials that exist today. A new camo
// added with a bare `if (o.isMesh && o.material)` traverse would reintroduce
// the whole class, so pin the call sites too.
const src = readFileSync(new URL('../js/weapons.js', import.meta.url), 'utf8');
for (const fn of ['applyPapLivingFinish', 'applyGoldCamo', 'applyDiamondCamo']) {
  const body = src.slice(src.indexOf(fn + '('), src.indexOf(fn + '(') + 1400);
  if (!/wearsWeaponFinish\(/.test(body)) {
    failures.push(`${fn} no longer routes its traverse through wearsWeaponFinish()`);
  }
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`✗ weapon finishes: ${failures.length} violation(s)`);
  for (const f of failures.slice(0, 40)) console.error('   ' + f);
  process.exit(1);
}

// Report the counts, not just a pass. A sweep that silently built nothing —
// zero unlit materials seen, zero weapons gilded — would otherwise look
// identical to a clean run.
assert.ok(unlitSeen > 0, 'saw no unlit materials at all: the sweep is not reaching the reticles it exists to protect');
assert.ok(goldWeapons === ids.length, `gold finish reached ${goldWeapons}/${ids.length} weapons`);
assert.ok(diamondWeapons === ids.length, `diamond finish reached ${diamondWeapons}/${ids.length} weapons`);

console.log(`✓ weapon finishes: ${ids.length} weapons x 4 finishes + display models, `
  + `${meshesChecked} meshes checked, ${unlitSeen} unlit (reticle) materials left clean, `
  + `${goldWeapons} gilded, ${diamondWeapons} diamonded, unknown ids degrade to a real model`);
