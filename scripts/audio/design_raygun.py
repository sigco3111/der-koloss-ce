"""Ray Gun / Porter's X2 fire sound.

The shipped shot_raygun.mp3 was a 1.29 s buzz: 0.3 % of its energy below 200 Hz,
a spectral centroid of 1.5 kHz and an envelope that sat flat for 400 ms. It had
no discharge and no pitch signature - the two things that make a Ray Gun
recognisable the instant it fires. Running it through the general arsenal pass
would have been worse still: that pass builds a *gunpowder* transient, and a
Ray Gun is not a firearm.

So it is built from scratch as an energy weapon:

  1. ignition       bright 8 ms spit as the chamber lets go
  2. glide          THE signature. Detuned saw pair falling 2.2 kHz -> 260 Hz
                    through a resonant filter that tracks the pitch, so the
                    sweep sings rather than just descends.
  3. plasma bloom   band-passed noise whose centre falls with the glide - the
                    energy texture that replaces powder and gas
  4. body           250 -> 70 Hz drop: the bolt leaving the barrel
  5. sub            modest, matching SHOT_WEIGHT.shot_raygun = 0.35 in audio.js
  6. plasma decay   the wet, bubbly tail the gun is remembered for

Layers 6 and 7 used to be a bell and a tuned oscillator: three Q=26 resonators
ringing for ~350 ms, and an FM'd 430 Hz sine under them. Between them they held a
single locked pitch 40+ dB above the spectral floor across the whole 570 ms tail
- every other gun in the library peaks under 18 dB - so the Ray Gun did not
decay, it CHIMED, and at 181 rpm each shot re-struck the same note before the
previous one had faded. The tail is unpitched now: low-Q bands whose centres
drift apart as they fall, which keeps the bubbling texture and lands on no note.
"""
import numpy as np, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsp
from dsp import (SR, encode, filt, noise, env_ad, sweep, place, trim_tail,
                 normalise, lufs_momentary_max, true_peak_db)

HERE = os.path.dirname(os.path.abspath(__file__))


def _resonant_glide(n, f0, f1, q=6.0, kind='saw'):
    """Sweep run through a filter whose cutoff tracks it. Rendered in short
    blocks because a biquad's coefficients are fixed per block."""
    x = sweep(n, f0, f1, kind=kind)
    out = np.zeros(n)
    blk = int(0.004 * SR)
    t = np.arange(n) / SR
    T = max(n / SR, 1e-6)
    for s in range(0, n, blk):
        e = min(n, s + blk)
        frac = (s + (e - s) * 0.5) / SR / T
        cut = f0 * (max(f1, 1.0) / max(f0, 1.0)) ** frac * 2.4
        out[s:e] = filt(x[s:e], 'bp', max(90.0, min(cut, SR * 0.4)), q)
    return out


def build(pap=False):
    dur = 1.25 if pap else 1.00
    n = int(dur * SR)
    out = np.zeros(n)
    g0 = 1500 if pap else 2200          # glide start
    g1 = 170 if pap else 260            # glide end
    gt = 0.150 if pap else 0.115        # glide time

    # -- 1. ignition ---------------------------------------------------------
    ig = filt(noise(int(0.012 * SR)), 'bp', 5200, 0.7, order=2)
    ig *= env_ad(len(ig), 0.0002, 0.0035, curve=2.8)
    place(out, ig, 0.0, 0.75)

    # -- 2. glide ------------------------------------------------------------
    gn = int(gt * SR)
    glide = _resonant_glide(gn, g0, g1, q=7.0, kind='saw')
    glide += 0.55 * _resonant_glide(gn, g0 * 1.007, g1 * 1.007, q=6.0, kind='saw')
    glide += 0.28 * _resonant_glide(gn, g0 * 2.0, g1 * 2.0, q=9.0, kind='square')
    glide *= env_ad(gn, 0.0008, gt * 0.42, curve=1.7)
    glide /= max(np.abs(glide).max(), 1e-9)
    place(out, glide, 0.0006, 1.0)

    # -- 3. plasma bloom -----------------------------------------------------
    bn = int(0.20 * SR)
    src = noise(bn)
    bloom = np.zeros(bn)
    blk = int(0.004 * SR)
    for s in range(0, bn, blk):
        e = min(bn, s + blk)
        frac = (s / SR) / 0.16
        cut = 6000 * (700 / 6000) ** min(1.0, frac)
        bloom[s:e] = filt(src[s:e], 'bp', max(150.0, cut), 1.1)
    bloom *= env_ad(bn, 0.0009, 0.030, curve=2.2)
    place(out, bloom, 0.0004, 0.62)

    # -- 4. body -------------------------------------------------------------
    dn = int(0.20 * SR)
    body = sweep(dn, 250 if not pap else 215, 70 if not pap else 58, kind='tri')
    body *= env_ad(dn, 0.0015, 0.028, curve=2.0)
    place(out, body, 0.0012, 0.70)

    # -- 5. sub --------------------------------------------------------------
    sn = int(0.34 * SR)
    sub = sweep(sn, 62 if not pap else 55, 30 if not pap else 26)
    sub *= env_ad(sn, 0.004, 0.060, curve=2.0)
    place(out, sub, 0.002, 0.40 if not pap else 0.55)

    # -- 6. plasma decay -----------------------------------------------------
    # Three noise bands, Q ~1.6 so each is nearly an octave wide and cannot ring
    # a pitch, sliding DOWN by different ratios so they spread apart as they go
    # and never settle into an interval. The old bell lived here.
    bands = [(1150, 0.42, 2.30, 0.30), (1820, 0.33, 3.10, 0.20), (2680, 0.25, 4.20, 0.13)]
    if pap:
        bands = [(860, 0.58, 2.10, 0.34), (1360, 0.46, 2.80, 0.24), (2040, 0.34, 3.70, 0.16)]
    for f0, dec, ratio, lvl in bands:
        rn = int((dec + 0.06) * SR)
        src = noise(rn)
        band = np.zeros(rn)
        blk = int(0.005 * SR)
        for s in range(0, rn, blk):
            e = min(rn, s + blk)
            frac = (s + (e - s) * 0.5) / rn
            band[s:e] = filt(src[s:e], 'bp', max(110.0, f0 / ratio ** frac), 1.6, order=1)
        band /= max(np.abs(band).max(), 1e-9)
        band *= env_ad(rn, 0.0015, dec * 0.42, curve=1.8)
        place(out, band, 0.001, lvl)

    # -- 7. bubble tail ------------------------------------------------------
    # The wet character the warble was there for, made of noise instead of a
    # tone: a wide low band chopped by an irregular tremolo, so it gurgles.
    wn = int((0.55 if not pap else 0.75) * SR)
    t = np.arange(wn) / SR
    bubble = filt(noise(wn), 'bp', 420 if not pap else 330, 1.1, order=2)
    bubble *= 0.55 + 0.45 * np.sin(2 * np.pi * 27 * t) * np.sin(2 * np.pi * 6.3 * t + 0.7)
    bubble /= max(np.abs(bubble).max(), 1e-9)
    bubble *= env_ad(wn, 0.010, 0.17 if not pap else 0.24, curve=1.5)
    place(out, bubble, 0.012, 0.26)

    if pap:
        # Porter's X2 fires twice: a second, deeper report right behind the first
        second = out[:int(0.30 * SR)].copy()
        second = filt(second, 'lp', 2600, 0.7, order=2)
        place(out, second, 0.085, 0.42)

    # -- glue ----------------------------------------------------------------
    slap = filt(out[:int(0.22 * SR)].copy(), 'lp', 2200, 0.7, order=2)
    place(out, slap, 0.034, 0.14)
    out = filt(out, 'hp', 32, 0.7)
    out = filt(out, 'peak', 1400, 1.1, gain_db=2.0)      # the glide's home register
    out = trim_tail(out, thresh_db=-62, min_sec=0.90 if not pap else 1.15)
    # same ladder as the rest of the arsenal (design_shots.CLASS_OFFSET['wonder'])
    out = normalise(out, target_lufs_m=-17.5 + 0.9 + (0.4 if pap else 0.0),
                    ceiling_db=-1.0, win=0.20, max_drive_db=7.0)
    return out


if __name__ == '__main__':
    outdir = sys.argv[1] if len(sys.argv) > 1 else HERE
    for pap in (False, True):
        dsp._rng = np.random.default_rng(0x5A7 + int(pap))
        y = build(pap)
        name = 'shot_raygun_pap' if pap else 'shot_raygun'
        p = os.path.join(outdir, name + '.mp3')
        encode(y, p, bitrate='112k', ch=1)
        e = np.array([np.sqrt(np.mean(y[i * 480:(i + 1) * 480] ** 2)) for i in range(len(y) // 480)])
        print(f"{name}: dur={len(y)/SR:.2f}s M200={lufs_momentary_max(y, win=0.2):.2f} "
              f"TP={true_peak_db(y):.2f} peak_t={np.argmax(e)*0.01:.3f}s size={os.path.getsize(p)}")
        db = 20 * np.log10(np.maximum(e / e.max(), 1e-6))
        print('   ', ' '.join(f'{v:.0f}' for v in db[:45]))
