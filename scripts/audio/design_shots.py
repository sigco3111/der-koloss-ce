"""Arsenal-wide gunshot pass.

Every shipped shot_*.mp3 was a single flattish burst of noise: several had up to
60 ms of leading silence before the shot, and most of the Pack-a-Punch variants
plateaued for half a second instead of decaying, so the loudest 10 ms of the
file sat well after the trigger pull.  Nothing cracked.

This runs each file through the same four-stage treatment, with per-class
parameters so a pistol still sounds nothing like a Browning:

  1. ALIGN     drop the pre-roll so the transient is on sample 0
  2. SHAPE     impose a two-stage decay envelope (attenuate-only, capped at
               18 dB) so the file peaks at the front and falls into a tail
  3. LAYER     add a designed transient on top of the recording -
                 crack  : bandpassed noise, sub-millisecond attack
                 body   : low-passed noise punch
                 drop   : pitched downward glide, the "thump" of the muzzle
                 sub    : the chest weight
                 slap   : one early reflection (the engine adds real reverb)
  4. MASTER    normalise on max-momentary loudness, true-peak ceiling

js/audio.js already layers a procedural sub thump, a mechanical clack, a reverb
tail and a shell casing on top of this at play time; these layers are sized to
sit under that, not to replace it.
"""
import numpy as np, sys, os, glob, json, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsp
from dsp import (SR, decode, encode, filt, env_ad, sweep, place, trim_head,
                 trim_tail, normalise, lufs_momentary_max, true_peak_db, block_env, smooth)

# Weapon-family loudness. Every gun is normalised to the same base target on a
# 200 ms K-weighted window, then offset by class so the ladder from SMG to
# rocket launcher is a deliberate 3.5 dB rather than an accident of generation.
TARGET_M = -17.5          # base target, LUFS on a 200 ms window
NORM_WIN = 0.20
CEILING = -1.0            # true-peak ceiling, dBTP
CLASS_OFFSET = {'smg': -1.0, 'carbine': -0.7, 'pistol': -0.5, 'ar': 0.0,
                'lmg': 0.4, 'bolt': 0.9, 'wonder': 0.9, 'shotgun': 1.4,
                'atr': 2.0, 'launcher': 2.5}

# crack_hz, crack_dec, body_hz, body_dec, drop_f0, drop_f1, sub, shape_tau, tail_lvl, tail_tau
CLASS = {
    'pistol':   dict(crack=3000, cdec=0.010, body=820, bdec=0.020, d0=205, d1=82,  sub=0.26, tau=0.045, tl=0.055, ttau=0.30),
    'smg':      dict(crack=3500, cdec=0.008, body=900, bdec=0.015, d0=215, d1=92,  sub=0.22, tau=0.034, tl=0.045, ttau=0.22),
    'carbine':  dict(crack=3200, cdec=0.010, body=860, bdec=0.018, d0=198, d1=86,  sub=0.28, tau=0.044, tl=0.052, ttau=0.30),
    'ar':       dict(crack=3000, cdec=0.011, body=790, bdec=0.021, d0=186, d1=78,  sub=0.32, tau=0.050, tl=0.060, ttau=0.35),
    'bolt':     dict(crack=2600, cdec=0.015, body=660, bdec=0.030, d0=166, d1=66,  sub=0.46, tau=0.078, tl=0.095, ttau=0.62),
    'lmg':      dict(crack=2400, cdec=0.013, body=610, bdec=0.027, d0=152, d1=61,  sub=0.50, tau=0.060, tl=0.075, ttau=0.45),
    'shotgun':  dict(crack=1900, cdec=0.019, body=505, bdec=0.040, d0=132, d1=53,  sub=0.56, tau=0.092, tl=0.105, ttau=0.55),
    'atr':      dict(crack=2100, cdec=0.021, body=455, bdec=0.050, d0=120, d1=46,  sub=0.76, tau=0.120, tl=0.130, ttau=0.90),
    'launcher': dict(crack=1500, cdec=0.030, body=400, bdec=0.070, d0=110, d1=40,  sub=0.82, tau=0.200, tl=0.165, ttau=1.00),
    'wonder':   dict(crack=3600, cdec=0.012, body=860, bdec=0.022, d0=200, d1=76,  sub=0.36, tau=0.070, tl=0.090, ttau=0.50),
}

WEAPON_CLASS = {
    'pistol': 'pistol', 'magnum': 'pistol',
    'mp40': 'smg', 'thompson': 'smg', 'type100': 'smg', 'ppsh': 'smg',
    'ump45': 'smg', 'ak74u': 'smg', 'smg': 'smg',
    'm1a1': 'carbine',
    'stg44': 'ar', 'fg42': 'ar', 'gewehr43': 'ar', 'm1garand': 'ar', 'acr': 'ar',
    'famas': 'ar', 'galil': 'ar', 'commando': 'ar', 'rifle': 'ar',
    'kar98': 'bolt', 'mosin': 'bolt', 'springfield': 'bolt', 'sniper': 'bolt',
    'bar': 'lmg', 'mg42': 'lmg', 'browning': 'lmg', 'lmg': 'lmg',
    'dbshotgun': 'shotgun', 'trench': 'shotgun', 'shotgun': 'shotgun',
    'ptrs41': 'atr',
    'panzerschreck': 'launcher', 'rocket': 'launcher',
    'raygun': 'wonder', 'dg2': 'wonder',
}
# Longest sensible tail per class; anything past this is dead weight in a
# browser download and gets replaced by the engine's convolution reverb anyway.
MAX_DUR = {'smg': 0.70, 'carbine': 0.75, 'pistol': 0.85, 'ar': 0.95, 'lmg': 0.95,
           'wonder': 1.30, 'bolt': 1.45, 'shotgun': 1.30, 'atr': 1.75, 'launcher': 1.90}


def classify(stem):
    base = stem[len('shot_'):]
    pap = base.endswith('_pap')
    if pap:
        base = base[:-4]
    return WEAPON_CLASS.get(base, 'ar'), pap, base


def shape(x, tau, tail_lvl, tail_tau, max_cut_db=18.0):
    """Attenuate-only envelope discipline: force a front-loaded decay onto a
    file that plateaus, without ever boosting (which would just raise noise)."""
    e, m = block_env(x, 0.005)
    if e.max() <= 0:
        return x
    head = e[:max(1, int(0.03 / 0.005))].max()
    ref = max(head, e.max() * 0.35)
    t = np.arange(len(e)) * 0.005
    target = np.exp(-t / tau) + tail_lvl * np.exp(-t / tail_tau)
    g = np.minimum(1.0, target / np.maximum(e / ref, 1e-6))
    g = np.maximum(g, 10 ** (-max_cut_db / 20))
    g = smooth(g, 4)
    gs = np.interp(np.arange(len(x)), np.arange(len(g)) * m + m * 0.5, g,
                   left=g[0], right=g[-1])
    return x * gs


def build(path, outdir, report):
    stem = os.path.splitext(os.path.basename(path))[0]
    cls, pap, base = classify(stem)
    P = dict(CLASS[cls])
    if pap:
        # Pack-a-Punch: same gun, more of everything and a longer tail
        P['crack'] *= 0.90; P['body'] *= 0.90
        P['d0'] *= 0.88; P['d1'] *= 0.86
        P['sub'] *= 1.30; P['tau'] *= 1.25; P['ttau'] *= 1.55; P['tl'] *= 1.35

    rng = np.random.default_rng(int(hashlib.sha1(stem.encode()).hexdigest()[:8], 16))
    dsp._rng = rng                                    # per-file noise, never identical
    jit = lambda v, a: v * float(rng.uniform(1 - a, 1 + a))

    x = decode(path)
    if len(x) < 64:
        return None
    src_dur = len(x) / SR

    # 1. align -------------------------------------------------------------
    x = trim_head(x, thresh_db=-40, pre_ms=0.8)

    # 2. shape -------------------------------------------------------------
    x = shape(x, jit(P['tau'], 0.10), P['tl'], P['ttau'])
    x /= max(np.abs(x).max(), 1e-9)

    maxd = MAX_DUR[cls] * (1.45 if pap else 1.0)
    n = int(min(maxd, max(len(x) / SR, 0.35)) * SR)
    out = np.zeros(n)
    out[:min(n, len(x))] += x[:n] * 0.80

    # 3. layer -------------------------------------------------------------
    cn = int(0.09 * SR)
    crack = filt(dsp.noise(cn), 'bp', jit(P['crack'], 0.12), 0.6, order=2)
    crack += 0.5 * filt(dsp.noise(cn), 'bp', jit(P['crack'] * 2.1, 0.10), 0.9, order=1)
    crack *= env_ad(cn, 0.00035, jit(P['cdec'], 0.15), curve=2.6)
    place(out, crack, 0.0, 0.72)

    bn = int(0.30 * SR)
    body = filt(dsp.noise(bn), 'lp', jit(P['body'], 0.10), 0.8, order=2)
    body *= env_ad(bn, 0.0012, jit(P['bdec'], 0.15), curve=2.2)
    place(out, body, 0.0008, 0.66)

    dn = int(0.24 * SR)
    drop = sweep(dn, jit(P['d0'], 0.07), jit(P['d1'], 0.07), kind='tri')
    drop *= env_ad(dn, 0.0015, P['bdec'] * 1.5, curve=2.0)
    place(out, drop, 0.0012, 0.55)

    if P['sub'] > 0.01:
        sn = int(0.40 * SR)
        sub = sweep(sn, jit(78, 0.08), jit(36, 0.08))
        sub *= env_ad(sn, 0.004, 0.070, curve=2.0)
        place(out, sub, 0.002, P['sub'] * 0.55)

    # one early reflection so the shot has a room around it even before the
    # engine's convolver adds the zone tail
    slap = filt(out[:int(0.22 * SR)].copy(), 'lp', 2400, 0.7, order=2)
    place(out, slap, 0.030 + float(rng.uniform(0, 0.012)), 0.13)

    # 4. master ------------------------------------------------------------
    out = filt(out, 'hp', 30, 0.7)
    out = filt(out, 'peak', 3000, 1.0, gain_db=1.5)
    out = trim_tail(out, thresh_db=-60, min_sec=0.30)
    out = normalise(out, target_lufs_m=TARGET_M + CLASS_OFFSET[cls] + (0.4 if pap else 0.0),
                    ceiling_db=CEILING, win=NORM_WIN, max_drive_db=7.0)

    br = '112k' if cls in ('bolt', 'atr', 'launcher', 'wonder', 'shotgun') else '96k'
    dst = os.path.join(outdir, stem + '.mp3')
    encode(out, dst, bitrate=br, ch=1)
    e, _ = block_env(out, 0.01)
    report.append(dict(file=stem, cls=cls, pap=pap, src_dur=round(src_dur, 3),
                       dur=round(len(out) / SR, 3), M=round(lufs_momentary_max(out), 2),
                       tp=round(true_peak_db(out), 2), peak_t=round(float(np.argmax(e)) * 0.01, 3),
                       bytes=os.path.getsize(dst)))
    return dst


if __name__ == '__main__':
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    rep = []
    files = sorted(glob.glob(os.path.join(src, 'shot_*.mp3')))
    for f in files:
        stem = os.path.splitext(os.path.basename(f))[0]
        # The two wonder weapons are not firearms and get purpose-built
        # designs (design_dg2.py, design_raygun.py) instead of a powder
        # transient bolted onto a buzz.
        if stem in ('shot_dg2', 'shot_dg2_pap', 'shot_raygun', 'shot_raygun_pap'):
            continue
        build(f, outdir, rep)
    json.dump(rep, open(os.path.join(outdir, '_shots.json'), 'w'), indent=1)
    Ms = [r['M'] for r in rep]
    print(f"{len(rep)} shots  M {min(Ms):.2f}..{max(Ms):.2f} (spread {max(Ms)-min(Ms):.2f})  "
          f"maxTP {max(r['tp'] for r in rep):.2f}  late={sum(1 for r in rep if r['peak_t']>0.03)}  "
          f"bytes {sum(r['bytes'] for r in rep)}")
