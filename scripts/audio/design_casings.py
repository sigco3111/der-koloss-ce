"""Shell casings, and the M1 Garand's en-bloc clip ping.

The bug this was written for: every gunshot in the game was followed 320-520 ms
later by a chime. Two separate causes, both tonal.

1. The casing takes rang two narrow bandpasses (Q 34 and Q 40) at 3.9-6.4 kHz
   for 260 ms per bounce, with three or four bounces spread EVENLY over 0.85 s.
   Measured on the shipped files: casing_concrete1 put 54 % of its energy into a
   single twelfth-octave band at 14 kHz and took 875 ms to fall 40 dB. Two long,
   narrow, near-harmonic (1 : 1.63) resonances is the recipe for a struck bell,
   and delayed behind the shot it landed in the gap where nothing masked it.

2. rel_ping.mp3 — the empty-magazine ping — was 70 % of its energy inside ONE
   twelfth-octave band at 6588 Hz with a 645 ms decay. That is a sine bell, not
   a piece of sheet steel, and js/audio.js played it behind the last round of
   every weapon in the game including the Wunderwaffe DG-2.

What a case actually does when it lands: a hard broadband contact transient
carrying most of the energy, a couple of SHORT resonances at deliberately
non-integer ratios so no pitch can form, and a bounce train whose level and
whose interval both decay geometrically (a coefficient of restitution) so it
ends in a fast rattle instead of an even, musical pulse.

Each resonance here is narrowband NOISE — noise through a moderate-Q bandpass,
shaped by its own envelope — not a decaying oscillator. That is what keeps the
spectrum from collapsing onto a single bin: the envelope sets the decay and the
Q sets the bandwidth, so a 20 ms ring can still be 200 Hz wide.

Mirrors js/audio/synth.js, which renders the identical recipes at runtime as the
fallback for any file that fails to fetch or decode.

    python3 scripts/audio/design_casings.py assets/audio
"""
import sys, os, math
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import (SR, filt, env_ad, place, encode, normalise, trim_tail,
                 lufs_momentary_max, true_peak_db)

# A dry, short clatter simply measures quieter on a 200 ms window than the
# 850 ms bell it replaces did at the same peak, so the family target moves down
# with it: at -26 LUFS these would have to be limited by 5 dB, which is exactly
# the crest-crushing that made the old takes sound sustained. js/audio.js makes
# the level back up at play time, and js/audio/synth.js renders its fallback to
# the matching peak.
CASING_TARGET = -31.0
FOLEY_TARGET = -21.0      # normalise_library.FAMILY['foley']
CEILING = -1.0
NORM_WIN = 0.20

# kind -> body frequency, inharmonic partial ratios, ring time, bounce count,
# first gap, restitution, low-thud level, contact brightness
KINDS = {
    # .45 ACP / 9x19 / .30 Carbine: small, thin-walled, bright, dies fast
    'pistol': dict(f0=3050, ratios=[1.0, 1.57, 2.29], ring=0.019, n=5, t0=0.058, e=0.62, low=0.00, hp=2200),
    # 7.92x57 / .30-06 / 5.45x39: longer and heavier, so lower and a touch fuller
    'rifle':  dict(f0=2000, ratios=[1.0, 1.63, 2.41], ring=0.024, n=5, t0=0.072, e=0.64, low=0.12, hp=1900),
    # 12-gauge hull: a plastic tube with a brass head. It thuds and stops.
    'shell':  dict(f0=2450, ratios=[1.0, 1.71],       ring=0.011, n=3, t0=0.086, e=0.55, low=0.40, hp=1500),
    # belt gun: the case AND its disintegrating link, so more contacts, brighter
    'link':   dict(f0=3850, ratios=[1.0, 1.49, 2.17], ring=0.015, n=6, t0=0.047, e=0.60, low=0.00, hp=2600),
}
DETUNE = [0.94, 1.0, 1.07]          # per-variant size within the kind


def contact(k, metal, det, rng, dur=0.14):
    """One bounce: a broadband hit plus two or three short, inharmonic rings."""
    n = int(SR * dur)
    nz = rng.standard_normal(n)
    out = np.zeros(n)

    # The transient is the loudest thing here — a case landing is mostly noise.
    # Band-limited, though: unfiltered white noise puts the spectral centroid up
    # at 8 kHz and the result hisses instead of clinking. Brass on concrete is a
    # 2-6 kHz clatter with a fast top end, not a cymbal.
    trans = filt(filt(nz, 'hp', 3000 if metal else k['hp'], Q=0.7),
                 'lp', 10500 if metal else 8000, Q=0.7)
    out += trans * env_ad(n, 0.00012, 0.0016, curve=3.0) * 0.62
    out += filt(rng.standard_normal(n), 'bp', 2500 if metal else 1450, Q=0.7) * env_ad(n, 0.0002, 0.0042, curve=2.6) * 0.30
    if k['low'] > 0:
        out += filt(rng.standard_normal(n), 'lp', 540, Q=0.7, order=2) * env_ad(n, 0.0004, 0.0090, curve=2.4) * k['low']

    ring = k['ring'] * (1.35 if metal else 1.0)
    for j, r in enumerate(k['ratios']):
        f = k['f0'] * r * det * rng.uniform(0.96, 1.05)
        q = 11.0 - j * 2.5
        band = filt(rng.standard_normal(n), 'bp', min(f, SR * 0.45), Q=q, order=2)
        band /= max(np.abs(band).max(), 1e-9)
        out += band * env_ad(n, 0.0003, ring / (1 + j * 0.7), curve=2.4) * (0.17 / (1 + j * 1.2))
    if metal:
        # steel grating answers each contact with a very short, dull plate note
        band = filt(rng.standard_normal(n), 'bp', 640 * det * rng.uniform(0.9, 1.12), Q=9, order=2)
        band /= max(np.abs(band).max(), 1e-9)
        out += band * env_ad(n, 0.0006, 0.016, curve=2.4) * 0.07
    return out


def casing(kind, metal, variant, seed):
    k = KINDS[kind]
    rng = np.random.default_rng(seed)
    det = DETUNE[variant]
    total = int(SR * 0.55)
    out = np.zeros(total)
    t, gap, g = 0.0, k['t0'] * rng.uniform(0.92, 1.08), 1.0
    for _ in range(k['n']):
        place(out, contact(k, metal, det, rng), t, gain=g)
        t += gap
        gap *= k['e']          # bounces get CLOSER together
        g *= 0.52              # and quieter
    return trim_tail(out, thresh_db=-60, min_sec=0.16, fade_ms=8)


def clip_ping(seed=90210):
    """The en-bloc clip leaving an M1 Garand: struck sheet steel, then a landing.

    Kept recognisable — it is a ping, it is meant to ring — but built from four
    inharmonic narrowband-noise modes rather than one sine, so it reads as a
    piece of metal rather than a note.
    """
    rng = np.random.default_rng(seed)
    total = int(SR * 0.62)
    out = np.zeros(total)

    def strike(dur, lvl, modes, decays, qs, bright):
        n = int(SR * dur)
        y = filt(rng.standard_normal(n), 'hp', bright, Q=0.7) * env_ad(n, 0.00012, 0.0020, curve=3.0) * 0.30
        y += filt(rng.standard_normal(n), 'bp', 1700, Q=0.8) * env_ad(n, 0.0003, 0.0060, curve=2.6) * 0.16
        for f, d, q in zip(modes, decays, qs):
            band = filt(rng.standard_normal(n), 'bp', f * rng.uniform(0.985, 1.015), Q=q, order=2)
            band /= max(np.abs(band).max(), 1e-9)
            y += band * env_ad(n, 0.0006, d, curve=2.4) * lvl.pop(0)
        return y

    # ratios 1 : 1.478 : 1.947 : 2.614 — none of them a musical interval
    modes = [2280.0, 3370.0, 4440.0, 5960.0]
    out = place(out, strike(0.42, [0.40, 0.29, 0.20, 0.12], modes,
                            [0.070, 0.052, 0.038, 0.026], [21, 18, 15, 13], 3600), 0.0, 1.0)
    # the clip hitting the floor a moment later
    out = place(out, strike(0.22, [0.23, 0.15, 0.11, 0.06], [m * 1.03 for m in modes],
                            [0.030, 0.022, 0.016, 0.012], [18, 16, 14, 12], 3200), 0.128, 0.55)
    return trim_tail(out, thresh_db=-60, min_sec=0.28, fade_ms=12)


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    rows = []
    seed = 424242
    for kind in KINDS:
        for surface in ('concrete', 'metal'):
            for v in range(3):
                seed += 7919
                y = casing(kind, surface == 'metal', v, seed)
                y = normalise(y, target_lufs_m=CASING_TARGET, ceiling_db=CEILING,
                              win=NORM_WIN, max_drive_db=6.0)
                stem = f'casing_{kind}_{surface}{v + 1}'
                encode(y, os.path.join(outdir, stem + '.mp3'), bitrate='64k', ch=1)
                rows.append((stem, len(y) / SR, lufs_momentary_max(y, win=NORM_WIN), true_peak_db(y)))
                print('.', end='', flush=True)

    y = normalise(clip_ping(), target_lufs_m=FOLEY_TARGET, ceiling_db=CEILING,
                  win=NORM_WIN, max_drive_db=6.0)
    encode(y, os.path.join(outdir, 'rel_ping.mp3'), bitrate='80k', ch=1)
    rows.append(('rel_ping', len(y) / SR, lufs_momentary_max(y, win=NORM_WIN), true_peak_db(y)))
    print()
    for stem, dur, m, tp in rows:
        print(f'{stem:26s} {dur:5.3f}s  M {m:7.2f}  TP {tp:6.2f}')


if __name__ == '__main__':
    main(sys.argv[1])
