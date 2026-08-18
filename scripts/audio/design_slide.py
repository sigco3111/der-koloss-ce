"""The slide scuff — foley_slide.mp3.

Sliding used to borrow a footstep: `audio.play('step')` at the entry and a
second, pitched-down step on the way out. A step is an impact, and a slide is
five metres of continuous friction, so the motion had a beginning and no middle.

The raw ElevenLabs takes are committed under source/ so this is reproducible.
Neither ships as-is: both put their loudest moment around 0.6 s, which is the
same defect the mix-1 pass had to re-cut out of forty-two gunshots. A slide
starts with the drop and gets quieter from there — the take is raw material for
the texture, not for the shape.

  entry scuff   boot and hip taking the floor, the first ~130 ms and the
                loudest point of the file, so the sound has a front
  grit bed      the sustained scrape, enveloped by the ACTUAL deceleration the
                player runs (see below) rather than a drawn curve
  dust tail     what is left once you have stopped moving fast enough to grind
                anything, gone by the time the slide is

build() lays the bed down first and the scuff second, because the scuff is
levelled against the bed rather than to an absolute gain.

The bed also gets duller as it goes. Grain noise is velocity-dependent: a boot
scrubbing at 8 m/s excites the whole spectrum, one at 3 m/s only rumbles, so a
flat filter over the whole slide reads as a tape loop rather than a body losing
speed. The cutoff glides 7 kHz -> 1.6 kHz across the file.

The amplitude envelope is derived, not eyeballed. js/player.js damps a slide
with a RAMPING friction, `slideFriction = 0.5 + slideT * 0.9`, integrated as
dv/dt = -f(t) v, so

    v(t) = v0 * exp(-(0.5 t + 0.45 t^2))

and scrape loudness tracks contact velocity. That is the curve below. Change
the friction constants in player.js and this sound stops matching the motion.

Everything sits above 120 Hz: the low shelf belongs to explosions and the sub
bus, and a slide that thumps down there fights them for no benefit.
"""
import numpy as np, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsp
from dsp import (SR, decode, encode, filt, noise, place, trim_head,
                 normalise, lufs_momentary_max, true_peak_db)

HERE = os.path.dirname(os.path.abspath(__file__))
# ElevenLabs raw material, committed under source/ so the slide is reproducible.
GRIT_SRC = os.path.join(HERE, 'source', 'slide_grit.mp3')    # sustained scrape bed
SCUFF_SRC = os.path.join(HERE, 'source', 'slide_scuff.mp3')  # leather/cloth scuff

DUR = 1.05          # js/player.js ends a slide at slideT > 1.05
FRICTION_A = 0.5    # `slideFriction = 0.5 + slideT * 0.9`
FRICTION_B = 0.9
# Granular friction noise does not scale linearly with contact speed — power
# goes roughly as v^2, so amplitude goes as v^1.8. Driving the bed with plain
# v left the first 600 ms flat to within 3 dB, which reads as a held loop that
# then gets cut off rather than a body running out of momentum.
GRAIN_EXP = 1.8
# How far the entry scuff sits above the bed's opening level, linear. The
# transient is levelled against the bed rather than set absolutely so that
# re-rolling either source take cannot move the peak off sample 0.
SCUFF_OVER_BED = 1.7


def velocity(t):
    """Contact speed over the slide, normalised to 1.0 at entry."""
    return np.exp(-(FRICTION_A * t + FRICTION_B / 2 * t * t))


def _rms(x):
    return float(np.sqrt(np.mean(x ** 2)))


def _loop(x, n, xf=0.06):
    """Extend a take to n samples by crossfade-looping it onto itself. A hard
    wrap ticks and a reversed copy audibly runs the grit backwards; a 60 ms
    equal-power crossfade does neither."""
    f = int(xf * SR)
    if len(x) >= n:
        return x[:n].copy()
    out = x.copy()
    while len(out) < n:
        a, b = out, x
        xf_t = np.linspace(0, np.pi / 2, f)
        head = a[-f:] * np.cos(xf_t) + b[:f] * np.sin(xf_t)
        out = np.concatenate([a[:-f], head, b[f:]])
    return out[:n]


def _flatten(x, blk=0.05, floor_db=-24):
    """Divide out a take's own slow envelope so it carries texture and nothing
    else. The source take swells through its middle; without this, that swell
    lands at 120 ms and becomes the peak of the file, which is precisely the
    defect the whole mastering pass exists to remove."""
    e, m = dsp.block_env(x, blk)
    e = dsp.smooth(e, 3)
    g = e.max() / np.maximum(e, e.max() * 10 ** (floor_db / 20))
    g = np.interp(np.arange(len(x)), np.arange(len(g)) * m + m / 2, g)
    return x * g


def _glide_lp(x, f0, f1, q=0.707):
    """Low-pass whose cutoff falls across the buffer. Rendered in short blocks
    because a biquad's coefficients are fixed for the block they run on."""
    out = np.zeros(len(x))
    blk = int(0.008 * SR)
    for i in range(0, len(x), blk):
        seg = x[i:i + blk]
        u = i / max(len(x) - 1, 1)
        f = f0 * (f1 / f0) ** u
        # a short overlap either side keeps the block seams from ticking
        pad = min(i, 256)
        y = filt(x[i - pad:i + len(seg)], 'lp', f, q, order=2)[pad:]
        out[i:i + len(seg)] = y[:len(seg)]
    return out


def build():
    n = int(DUR * SR)
    t = np.arange(n) / SR
    v = velocity(t)
    out = np.zeros(n)

    # -- grit bed ------------------------------------------------------------
    # Take the sustained middle of the scrape, never its head or its tail: the
    # head is the take's own onset (it would fight the scuff) and the tail is
    # the take fading out, which _flatten cannot lift back without also lifting
    # its noise floor — that left an audible cliff at 0.8 s.
    grit = decode(GRIT_SRC)
    grit = _loop(grit[int(0.30 * SR):int(1.10 * SR)], n)
    grit = filt(grit, 'hp', 120, 0.7, order=2)
    grit = _flatten(grit)
    grit = _glide_lp(grit, 7000, 1600)
    # 12 ms of ramp so the bed slides in under the scuff instead of starting
    # alongside it and doubling the attack.
    bed = grit * (v ** GRAIN_EXP) * np.clip(t / 0.012, 0, 1)
    bed *= 0.55 / (_rms(bed[:int(0.10 * SR)]) + 1e-9)   # bed opens at a known level
    place(out, bed, 0.0, 1.0)

    # -- entry scuff ---------------------------------------------------------
    # The front of the leather take, hard-enveloped so only the initial contact
    # survives. Levelled AGAINST the bed rather than to an absolute gain: this
    # is the file's peak by construction, whatever the source takes happen to
    # measure, so the transient can never drift off the front again.
    scuff = trim_head(decode(SCUFF_SRC), thresh_db=-38)
    scuff = scuff[:int(0.22 * SR)]
    sn = len(scuff)
    st = np.arange(sn) / SR
    scuff = scuff * np.clip(st / 0.0015, 0, 1) * np.exp(-st / 0.065)
    scuff = filt(scuff, 'hp', 190, 0.7, order=2)
    scuff = filt(scuff, 'peak', 2600, 1.0, gain_db=3.0)   # the leather crack
    scuff *= SCUFF_OVER_BED * 0.55 / (_rms(scuff[:int(0.02 * SR)]) + 1e-9)
    place(out, scuff, 0.0, 1.0)

    # -- dust tail -----------------------------------------------------------
    # Band-passed noise on a STEEPER velocity curve than the bed, so it clears
    # out ahead of it. It is what stops the last third from sounding like the
    # bed simply faded: real grit keeps ticking after the scrape has gone quiet.
    dust = filt(noise(n), 'bp', 2400, 0.6, order=2) * (v ** (GRAIN_EXP + 1.2))
    # Granularity is irregular. A fixed-rate tremolo reads as a buzz, so the
    # flutter is smoothed noise at roughly 25 Hz instead of a sine.
    dust *= 0.5 + 0.9 * np.clip(dsp.smooth(np.abs(noise(n)), int(SR / 25 / 2)), 0, 1.2)
    place(out, dust, 0.0, 0.085)

    # -- glue ----------------------------------------------------------------
    out = filt(out, 'hp', 120, 0.7, order=2)
    out = filt(out, 'peak', 420, 0.9, gain_db=-2.5)    # box out of the low mids
    # A slide is over at 1.05 s. The tail must not outlive the motion, so the
    # last 180 ms is faded rather than trimmed on a threshold.
    fade = int(0.18 * SR)
    out[-fade:] *= np.linspace(1, 0, fade) ** 1.6
    # normalise_library.py's `foley` target, applied here so the file lands on
    # the ladder before the library pass ever sees it.
    out = normalise(out, target_lufs_m=-21.0, ceiling_db=-1.0, win=0.20,
                    max_drive_db=6.0)
    return out


if __name__ == '__main__':
    outdir = sys.argv[1] if len(sys.argv) > 1 else HERE
    dsp._rng = np.random.default_rng(0x5117)
    y = build()
    p = os.path.join(outdir, 'foley_slide.mp3')
    encode(y, p, bitrate='80k', ch=1)
    e = np.array([np.sqrt(np.mean(y[i * 480:(i + 1) * 480] ** 2)) for i in range(len(y) // 480)])
    print(f"foley_slide: dur={len(y)/SR:.2f}s M200={lufs_momentary_max(y, win=0.2):.2f} "
          f"TP={true_peak_db(y):.2f} peak_t={np.argmax(e)*0.01:.3f}s size={os.path.getsize(p)}")
    db = 20 * np.log10(np.maximum(e / e.max(), 1e-6))
    print('   ', ' '.join(f'{v:.0f}' for v in db))
