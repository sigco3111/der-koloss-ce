"""Wunderwaffe DG-2 / DG-3 JZ fire sound.

The shipped shot_dg2.mp3 was a flat 1.8 s bed of electrical fizz: its loudest
10 ms block sat 140 ms in, it had 5.8 % of its energy below 200 Hz, and it never
decayed.  Nothing about it read as a discharge.

This rebuilds it as what the weapon actually is - a capacitor bank dumping into
an arc - out of six aligned layers:

  1. ignition click     the contactor closing, 2 ms
  2. crack              the discharge itself: bandpassed noise with a sub-1 ms
                        attack, plus a fast 7 kHz -> 800 Hz zap sweep
  3. body punch         900 Hz-and-under noise + a 170 -> 65 Hz drop, 110 ms
  4. sub                 72 -> 34 Hz, 300 ms: the chest weight the old file had none of
  5. arc tail           ElevenLabs high-voltage crackle, high-passed and
                        amplitude-fluttered so it spits rather than hisses
  6. capacitor whine    2.4 kHz -> 380 Hz resonant glide, the "high voltage" cue
"""
import numpy as np, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import (SR, decode, encode, filt, noise, env_ad, sweep, place,
                 trim_head, trim_tail, normalise, lufs_momentary_max, true_peak_db)

HERE = os.path.dirname(os.path.abspath(__file__))
# ElevenLabs raw material, committed under source/ so the DG-2 is reproducible.
ARC_SRC = os.path.join(HERE, 'source', 'arc_crackle.mp3')   # sustained arc texture
ARC_SRC2 = os.path.join(HERE, 'source', 'arc_spark.mp3')    # snappier spark burst


def arc_texture(dur, seed_shift=0.0, hp=900):
    """High-voltage crackle, high-passed and fluttered so it spits."""
    n = int(dur * SR)
    src = decode(ARC_SRC)
    off = int(seed_shift * SR)
    if len(src) < n + off:
        src = np.tile(src, int(np.ceil((n + off) / max(len(src), 1))) + 1)
    a = src[off:off + n].copy()
    a = filt(a, 'hp', hp, 0.7, order=2)
    # irregular amplitude flutter: arcs spit, they do not hiss
    fl = np.abs(filt(noise(n), 'lp', 45, 0.7, order=2))
    fl = fl / (fl.max() + 1e-9)
    a *= 0.45 + 0.85 * fl
    return a


def build(pap=False):
    dur = 1.65 if pap else 1.20
    n = int(dur * SR)
    out = np.zeros(n)

    # -- 1. ignition click ---------------------------------------------------
    clk = filt(noise(int(0.004 * SR)), 'hp', 3800, 0.8, order=2)
    clk *= env_ad(len(clk), 0.00005, 0.0012, curve=3.0)
    place(out, clk, 0.0, 0.55)

    # -- 2. crack ------------------------------------------------------------
    cn = int(0.10 * SR)
    crack = filt(noise(cn), 'bp', 3400 if not pap else 2900, 0.55, order=2)
    crack += 0.6 * filt(noise(cn), 'bp', 7200, 0.8, order=1)
    crack *= env_ad(cn, 0.0004, 0.017 if not pap else 0.022, curve=2.6)
    place(out, crack, 0.0, 1.0)

    zn = int(0.045 * SR)
    zap = sweep(zn, 7000 if not pap else 6200, 800 if not pap else 620, kind='saw')
    zap = filt(zap, 'lp', 6500, 0.9)
    zap *= env_ad(zn, 0.0003, 0.010, curve=2.2)
    place(out, zap, 0.0005, 0.42)

    # -- 3. body punch -------------------------------------------------------
    bn = int(0.22 * SR)
    body = filt(noise(bn), 'lp', 900, 0.8, order=2)
    body *= env_ad(bn, 0.0012, 0.030, curve=2.2)
    place(out, body, 0.0008, 0.85)
    dn = int(0.16 * SR)
    drop = sweep(dn, 175 if not pap else 150, 62 if not pap else 52, kind='tri')
    drop *= env_ad(dn, 0.0015, 0.038, curve=2.0)
    place(out, drop, 0.0012, 0.80)

    # -- 4. sub --------------------------------------------------------------
    sn = int(0.42 * SR)
    sub = sweep(sn, 74 if not pap else 66, 34 if not pap else 29)
    sub *= env_ad(sn, 0.004, 0.085, curve=2.0)
    place(out, sub, 0.002, 0.88 if not pap else 1.05)

    # -- 4b. bank dump -------------------------------------------------------
    # The surge behind the crack: a low-mid swell that keeps rising for ~35 ms
    # before it lets go. This is what makes the shot read as *stored energy*
    # being released rather than a spark.
    un = int(0.32 * SR)
    surge = filt(noise(un), 'bp', 420 if not pap else 350, 0.9, order=2)
    st = np.arange(un) / SR
    surge *= np.clip(st / 0.035, 0, 1) * np.exp(-np.maximum(0, st - 0.035) / 0.075)
    place(out, surge, 0.0015, 0.70 if not pap else 0.85)

    # -- 5. arc tail ---------------------------------------------------------
    tail_len = dur - 0.02
    arc = arc_texture(tail_len, seed_shift=0.10 if not pap else 0.45)
    t = np.arange(len(arc)) / SR
    # fast ignition, then a two-stage decay: the arc collapses, then ionised air
    aenv = np.clip(t / 0.003, 0, 1) * (0.85 * np.exp(-t / (0.13 if not pap else 0.20))
                                       + 0.30 * np.exp(-t / (0.45 if not pap else 0.62)))
    place(out, arc * aenv, 0.004, 1.15 if not pap else 1.25)

    # a couple of secondary strikes: the bank is not done after one arc
    strikes = ([(0.048, 0.50), (0.104, 0.34), (0.181, 0.24), (0.28, 0.17)] if not pap else
               [(0.042, 0.62), (0.098, 0.46), (0.168, 0.36), (0.26, 0.28), (0.39, 0.21), (0.55, 0.16)])
    burst = decode(ARC_SRC2)
    for at, g in strikes:
        sl = int(0.09 * SR)
        st = int((0.02 + at) * SR) % max(1, len(burst) - sl)
        s = burst[st:st + sl].copy()
        s = filt(s, 'hp', 1500, 0.7, order=2)
        s *= env_ad(len(s), 0.0006, 0.014, curve=2.4)
        place(out, s, at, g)
        # each strike gets a little body so it lands rather than ticks
        bs = int(0.06 * SR)
        b = filt(noise(bs), 'lp', 700, 0.8, order=2) * env_ad(bs, 0.001, 0.012)
        place(out, b, at, g * 0.45)

    # -- 6. capacitor discharge ----------------------------------------------
    # The "high voltage" cue. This was a bare sine glide 2.4 kHz -> 380 Hz with
    # its octave on top, which reads on a spectrogram as a clean falling line and
    # in the ear as a descending whistle — a chime on a weapon that should only
    # ever crack and spit. Same falling gesture, made of band-passed noise at
    # Q 1.2, so it swoops without carrying a pitch.
    wn = int(0.34 * SR)
    src = noise(wn)
    whine = np.zeros(wn)
    blk = int(0.005 * SR)
    for s in range(0, wn, blk):
        e = min(wn, s + blk)
        frac = (s + (e - s) * 0.5) / wn
        whine[s:e] = filt(src[s:e], 'bp', 2400 * (380 / 2400) ** frac, 1.2, order=2)
    whine /= max(np.abs(whine).max(), 1e-9)
    whine *= env_ad(wn, 0.006, 0.075, curve=1.6)
    place(out, whine, 0.006, 0.16)

    # -- glue ----------------------------------------------------------------
    # slap: the muzzle bloom off the nearest hard surface (the engine adds the
    # real convolution reverb on top; this is only the first reflection)
    slap = filt(out[:int(0.25 * SR)].copy(), 'lp', 2600, 0.7, order=2)
    place(out, slap, 0.036, 0.16)

    out = filt(out, 'hp', 28, 0.7)                    # no DC / infrasonic waste
    out = filt(out, 'peak', 3200, 1.0, gain_db=2.0)   # presence for the crack
    out = trim_tail(out, thresh_db=-64, min_sec=1.15 if not pap else 1.55)
    # same ladder the rest of the arsenal is on (design_shots.CLASS_OFFSET['wonder'])
    out = normalise(out, target_lufs_m=-17.5 + 0.9 + (0.4 if pap else 0.0),
                    ceiling_db=-1.0, win=0.20, max_drive_db=7.0)
    return out


if __name__ == '__main__':
    outdir = sys.argv[1] if len(sys.argv) > 1 else HERE
    for pap in (False, True):
        y = build(pap)
        name = 'shot_dg2_pap' if pap else 'shot_dg2'
        p = os.path.join(outdir, name + '.mp3')
        encode(y, p, bitrate='112k', ch=1)
        e = np.array([np.sqrt(np.mean(y[i * 480:(i + 1) * 480] ** 2)) for i in range(len(y) // 480)])
        print(f"{name}: dur={len(y)/SR:.2f}s M={lufs_momentary_max(y):.2f} TP={true_peak_db(y):.2f} "
              f"peak_t={np.argmax(e)*0.01:.3f}s size={os.path.getsize(p)}")
        db = 20 * np.log10(np.maximum(e / e.max(), 1e-6))
        print('   ', ' '.join(f'{v:.0f}' for v in db[:50]))
