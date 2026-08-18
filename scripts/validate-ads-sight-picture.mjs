// When you aim, you must be able to SEE the sight.
//
// This is checked by tracing rays out of the eye through the real aimed pose,
// because every previous version of this check measured heights instead — and
// heights are not what a sight picture is made of. Occlusion is angular. A
// receiver top five millimetres under the aim line clears it comfortably on
// paper and still swallows a front post that is half a metre further away.
//
// Three defects this was written for, all of which shipped on most of the
// roster:
//
// 1. Every open notch put its FLOOR on the aim line instead of its shoulders.
//    Since the eye sits on that same line, the floor projected to exactly the
//    centre of the screen — and so did the tip of the front post, which is the
//    one thing you have to see. The post landed precisely at the lower edge of
//    the window, hidden behind the notch floor, and aiming the Type 100, the
//    M1911, the Kar98k, the Thompson, the Ray Gun or the DG-2 showed a wall of
//    rear sight across the middle of the screen with no front sight at all.
//
// 2. The ADS pose held all 31 weapons out at arm's length. Nobody aims a rifle
//    at arm's length: the rear sight ended up half a metre from the eye, far
//    too small to aim with, and the buttstock — which belongs behind your cheek
//    — sat 4-10cm off the lens filling the bottom third of the frame.
//
// 3. Optic-equipped weapons still drew a rear iron behind the glass, and its
//    protective ears stand above their own aiming reference, so they rose into
//    the window and covered the bottom of the dot.
//
// The check reproduces the real pose: build the weapon, hand it to a real
// WeaponRig, film it through the real viewmodel lens, and look down the barrel
// of the actual projection the player gets.
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { THREE, loadGameModule, repoRoot } from './lib/headless-three.mjs';

const { WEAPONS, buildViewmodel, WeaponRig } = await loadGameModule('weapons.js');

// ---------------------------------------------------------------------------
// The lens, read out of game.js so the two cannot drift apart
// ---------------------------------------------------------------------------
const gameSrc = await readFile(join(repoRoot, 'js', 'game.js'), 'utf8');
const num = (re, what) => {
  const m = gameSrc.match(re);
  assert.ok(m, `validate-ads-sight-picture: could not read ${what} out of js/game.js`);
  return Number(m[1]);
};
const VIEWMODEL_FOV = num(/const VIEWMODEL_FOV = ([\d.]+)/, 'VIEWMODEL_FOV');
const VIEWMODEL_REF_FOV = num(/const VIEWMODEL_REF_FOV = ([\d.]+)/, 'VIEWMODEL_REF_FOV');
const VIEWMODEL_PRESENCE = num(/const VIEWMODEL_PRESENCE = ([\d.]+)/, 'VIEWMODEL_PRESENCE');
const VIEWMODEL_PIVOT_Z = num(/const VIEWMODEL_PIVOT_Z = ([\d.]+)/, 'VIEWMODEL_PIVOT_Z');
const VIEW_NEAR = num(/this\.viewCamera = new THREE\.PerspectiveCamera\(VIEWMODEL_FOV, innerWidth \/ innerHeight, ([\d.]+)/, 'the viewmodel near plane');
const ADS_FOV_PULL = num(/const wantFov = VIEWMODEL_FOV \* \(1 - ads \* ([\d.]+)\)/, 'the ADS FOV pull-in');

const halfTan = (f) => Math.tan(f * Math.PI / 360);
const K = (halfTan(VIEWMODEL_FOV) / halfTan(VIEWMODEL_REF_FOV)) * VIEWMODEL_PRESENCE;
const VM_Z = -(1 - K) * VIEWMODEL_PIVOT_Z;
// Half the aimed frame, at one metre. Screen positions below are all fractions
// of this, so 1.0 is the top of the frame and 0 is the aim axis.
const TAN = halfTan(VIEWMODEL_FOV * (1 - ADS_FOV_PULL));
// Widest aspect a player might be on. Wider means more of the weapon counts as
// on screen, which is the strict direction for every check here.
const ASPECT = 21 / 9;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
// Nothing on screen may come nearer the lens than this. The near plane is at
// 12mm, so anything inside that is drawn sliced open — but long before a weapon
// is sliced it is just a foreshortened close-up of its own backside.
const FACE_CLEAR = 0.026;
// How much of the frame the weapon may fill, and how much of the UPPER half.
// The upper half is where the target is; aiming is pointless if the gun is in
// front of it. Held out at arm's length the buttstocks put a third of the frame
// under gun, and the Panzerschreck's tube covered 62% of the sky.
const FRAME_COVER = 0.30;
const SKY_COVER = 0.08;
// The clear channel over the sight: from the aim axis up to here, dead centre,
// has to be open to the target. A tenth of the half-frame is a zombie's head
// above a chest shot at about ten metres — enough to catch a carry handle or a
// receiver standing over the aim line, which is the failure this is for, while
// leaving room for a Panzerschreck to look through the window in its own blast
// shield the way one is actually fired.
const SKY_BAND = 0.10;
const SKY_HALF_W = 0.02;
// The optic's clear aperture: the redDot() part is built at r = 0.019 with glass
// at 0.9r, and that whole disc has to be see-through.
const OPTIC_R = 0.019 * 0.9 * K;
// Parts allowed to be in the sight picture, because they ARE the sight picture.
const SIGHT_PARTS = new Set(['reddot', 'scope', 'sight', 'sight_f', 'sight_r', 'sight_base']);

const failures = [];
const summary = [];

/** Which registered part a mesh belongs to. */
function partOf(o) {
  for (let p = o; p; p = p.parent) if (p.userData?.partKey) return p.userData.partKey;
  return '(unregistered)';
}

/** Fully aimed pose, produced by the real rig against the real lens. */
function aimedRig(id, pap) {
  const camera = new THREE.PerspectiveCamera(VIEWMODEL_FOV, ASPECT, VIEW_NEAR, 8);
  const rig = new WeaponRig(camera);
  const vmRoot = new THREE.Group();
  vmRoot.scale.setScalar(K);
  vmRoot.position.z = VM_Z;
  camera.add(vmRoot);
  vmRoot.add(rig.root);
  rig.setViewLens(K, vmRoot.position.z);
  rig.equip(id, pap);
  for (const [k, node] of Object.entries(rig.current.group.userData.parts || {})) {
    if (node?.traverse) node.traverse((o) => { o.userData.partKey ??= k; });
  }
  // Converge every damped pose channel on "standing still, fully aimed".
  const opts = { ads: true, moving: false, sprinting: false, sliding: false, mouseX: 0, mouseY: 0 };
  for (let i = 0; i < 240; i++) rig.update(1 / 60, opts);
  assert.ok(rig.adsT > 0.999, `${id}: ADS blend did not converge`);
  camera.updateMatrixWorld(true);
  return rig;
}

for (const id of Object.keys(WEAPONS)) {
  for (const pap of [false, true]) {
    const label = `${id}${pap ? ' (PaP)' : ''}`;
    const rig = aimedRig(id, pap);
    const g = rig.current.group;
    // The knife and the cymbal monkey have no sights and nothing to aim: right
    // mouse does not shoulder them, so there is no sight picture to grade.
    if (!['sight_f', 'sight_r', 'sight', 'reddot', 'scope'].some((k) => g.userData.parts?.[k]?.visible)) continue;

    // Everything the eye can hit, and a ray to hit it with.
    const meshes = [];
    g.traverse((o) => {
      if (!o.isMesh) return;
      for (let p = o; p; p = p.parent) if (!p.visible) return;
      // Glazing is not an obstruction. A Panzerschreck's blast shield carries a
      // window and a red dot has two elements; you aim through all of them.
      const m = o.material;
      if (m && m.transparent && (m.opacity ?? 1) <= 0.6) return;
      meshes.push(o);
    });
    const rc = new THREE.Raycaster();
    rc.near = VIEW_NEAR;
    rc.far = 20;
    const eye = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const shoot = () => {
      rc.set(eye, dir.normalize());
      const hit = rc.intersectObjects(meshes, false)[0];
      return hit ? { part: partOf(hit.object), d: hit.distance } : null;
    };
    /** First thing the eye meets at a screen position, in fractions of the frame. */
    const look = (sx, sy) => (dir.set(sx * TAN * ASPECT, sy * TAN, -1), shoot());
    /** ...and looking straight AT a point, which is how a sight is used. */
    const lookAt = (p) => (dir.copy(p), shoot());

    // What you aim WITH: an optic's reticle, or the tip of the front post.
    let reticle = null;
    g.traverse((o) => {
      if (!o.userData?.reticle) return;
      let vis = true;
      for (let p = o; p; p = p.parent) if (!p.visible) vis = false;
      if (vis) reticle = new THREE.Vector3().setFromMatrixPosition(o.userData.reticle.matrixWorld);
    });
    // The blade, not the assembly: a hood stands a centimetre above its own post
    // and a protective ring nine millimetres, both of them on the centreline, so
    // neither the box around the whole front sight nor the highest thing in it
    // is the part you aim with. The blade is the one whose tip sits ON the aim
    // line, because that is what being the aiming reference means.
    const parts = g.userData.parts || {};
    let post = null;
    if (!reticle && !parts.scope?.visible && parts.sight_f?.visible) {
      const b = new THREE.Box3();
      parts.sight_f.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        b.setFromObject(o);
        if (b.isEmpty() || Math.abs(b.min.x + b.max.x) / 2 > 0.003 * K) return;
        if (b.max.y > 0.001 || (post && b.max.y < post.top)) return;
        post = { top: b.max.y, bottom: b.min.y, z: (b.min.z + b.max.z) / 2 };
      });
    }

    // ---- 1. the whole frame ------------------------------------------------
    const W = 96, H = 54;
    let cover = 0, sky = 0, nearest = Infinity, nearPart = '', sliced = null;
    for (let r = 0; r < H; r++) {
      const sy = 1 - (r + 0.5) / H * 2;
      for (let c = 0; c < W; c++) {
        const hit = look((c + 0.5) / W * 2 - 1, sy);
        if (!hit) continue;
        cover++;
        if (sy > 0) sky++;
        if (hit.d < nearest) { nearest = hit.d; nearPart = hit.part; }
        if (hit.d < VIEW_NEAR + 0.0005 && (!sliced || hit.d < sliced.d)) sliced = hit;
      }
    }
    if (sliced) {
      failures.push(`${label}: '${sliced.part}' reaches the near plane on screen — it is drawn sliced open`);
    } else if (nearest < FACE_CLEAR) {
      failures.push(`${label}: '${nearPart}' is ${(nearest * 100).toFixed(1)}cm off the lens and on screen — ` +
        `aiming must not put the eye inside the weapon (${(FACE_CLEAR * 100).toFixed(1)}cm clear)`);
    }
    if (cover / (W * H) > FRAME_COVER) {
      failures.push(`${label}: the weapon fills ${(cover / (W * H) * 100).toFixed(0)}% of the aimed frame ` +
        `(${(FRAME_COVER * 100).toFixed(0)}% allowed)`);
    }
    if (sky / (W * H / 2) > SKY_COVER) {
      failures.push(`${label}: the weapon fills ${(sky / (W * H / 2) * 100).toFixed(0)}% of the sky above the ` +
        `aim line (${(SKY_COVER * 100).toFixed(0)}% allowed) — that is where the thing you are aiming at is`);
    }

    // ---- 2. a clear line to the target -------------------------------------
    // Straight up the middle from the aim axis. Anything standing here is
    // between the sight and whatever the sight is pointed at.
    let blockedSky = null;
    for (let i = 1; i <= 12 && !blockedSky; i++) {
      const sy = SKY_BAND * (i / 12);
      for (const sx of [-SKY_HALF_W, 0, SKY_HALF_W]) {
        const hit = look(sx, sy);
        if (hit && !SIGHT_PARTS.has(hit.part)) { blockedSky = { hit, sy }; break; }
      }
    }
    if (blockedSky) {
      failures.push(`${label}: '${blockedSky.hit.part}' stands ${(blockedSky.sy * 100).toFixed(0)}% of the ` +
        'frame above the aim line, dead centre — it is between the sight and the target');
    }

    // ---- 3. you can see what you aim with ----------------------------------
    if (reticle) {
      const off = Math.hypot(reticle.x, reticle.y);
      if (off > 0.0015) {
        failures.push(`${label}: the reticle sits ${(off * 1000).toFixed(1)}mm off the optical axis — ` +
          'a red dot has to land where the shot goes');
      }
      // Every ray through the glass has to reach the reticle or the sky beyond
      // it. Nothing solid may stand in the window.
      const dRet = -reticle.z;
      let inGlass = null;
      for (let i = 0; i <= 8 && !inGlass; i++) {
        for (let a = 0; a < 12; a++) {
          const rr = OPTIC_R * (i / 8) * 0.98, th = a * Math.PI / 6;
          const hit = lookAt(new THREE.Vector3(Math.cos(th) * rr, Math.sin(th) * rr, -dRet));
          if (hit && !SIGHT_PARTS.has(hit.part) && hit.d < dRet) { inGlass = hit; break; }
        }
      }
      if (inGlass) {
        failures.push(`${label}: '${inGlass.part}' stands inside the optic's window ` +
          `${(inGlass.d * 100).toFixed(1)}cm from the eye — you cannot see the whole dot`);
      }
    } else if (post) {
      // Look down the blade's own silhouette. The TOP of it is what a shooter
      // lines up, and it is the part a notch cut level with the aim line hides
      // completely — so the top third has to come back as blade, every sample.
      // Only the top third: a peep ring is supposed to crop the rest, and a
      // post standing proud of its own aperture would be the odd one out.
      const d = -post.z;
      const top = (post.top / d) / TAN, bottom = (post.bottom / d) / TAN;
      const at = (f) => look(0, top + (bottom - top) * f);
      let hidden = null;
      for (const f of [1 / 8, 2 / 8, 3 / 8]) {
        const hit = at(f);
        if (hit?.part !== 'sight_f') { hidden = { f, hit }; break; }
      }
      if (hidden) {
        failures.push(`${label}: the top of the front post is not visible from the eye — ` +
          `${(hidden.f * 100).toFixed(0)}% of the way down the blade the eye meets ` +
          `${hidden.hit ? `'${hidden.hit.part}' at ${(hidden.hit.d * 100).toFixed(1)}cm` : 'nothing at all'} ` +
          'instead. A rear notch has to be cut BELOW the aim line for the post to stand in it');
      }
    }

    if (!pap) {
      summary.push(`${id.padEnd(14)} depth ${rig.adsDepth(rig.current).toFixed(3).padStart(6)}  ` +
        `${reticle ? 'optic' : 'post '} at ${((reticle ? -reticle.z : -(post?.z ?? 0)) * 100).toFixed(1).padStart(5)}cm  ` +
        `frame ${(cover / (W * H) * 100).toFixed(0).padStart(3)}%  sky ${(sky / (W * H / 2) * 100).toFixed(0).padStart(2)}%  ` +
        `nearest ${(nearest * 100).toFixed(1).padStart(5)}cm ${nearPart}`);
    }
  }
}

// Every weapon that carries an optic must show its whole window: no iron leaf
// left standing behind the glass.
for (const id of Object.keys(WEAPONS)) {
  for (const pap of [false, true]) {
    const parts = buildViewmodel(id, pap).userData.parts;
    if (!parts.reddot?.visible) continue;
    for (const k of ['sight_r', 'sight_base']) {
      if (parts[k]?.visible) failures.push(`${id}${pap ? ' (PaP)' : ''}: '${k}' is still drawn behind the optic`);
    }
  }
}

if (failures.length) {
  console.error('ADS sight picture FAILED\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${failures.length} problem(s)\n`);
  console.error(summary.join('\n'));
  process.exit(1);
}
console.log(`ADS sight picture OK — ${Object.keys(WEAPONS).length} weapons, stock and PaP`);
console.log(summary.join('\n'));
