"""Loudness pass over everything in assets/audio that is not a gunshot.

Before this ran, the library spanned 33.5 dB of max-momentary loudness and
eleven files exceeded 0 dBTP.  Each family below gets one target, chosen so the
mix ladder is deliberate: blasts on top, weapons just under them, then voices,
foley, UI, ambience.

`js/audio.js` still owns the *mix* (bus gains, ducking, distance rolloff, reverb
sends, the limiter).  This only makes the raw material consistent so those
controls act on a predictable input.
"""
import numpy as np, sys, os, glob, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import (SR, decode, encode, normalise, lufs_momentary_max,
                 lufs_integrated, true_peak_db)

NORM_WIN = 0.20           # window one-shots are normalised on
CEILING = -1.0            # true-peak ceiling for every asset, dBTP

# family -> (target LUFS, use_integrated, stereo, bitrate)
FAMILY = {
    'blast':    (-15.5, False, False, '96k'),
    'impact':   (-22.0, False, False, '80k'),
    'casing':   (-26.0, False, False, '64k'),
    'foley':    (-21.0, False, False, '80k'),
    'step':     (-25.0, False, False, '64k'),
    'zvoice':   (-19.0, False, False, '96k'),
    'pvoice':   (-19.0, False, False, '96k'),
    'announce': (-17.0, False, False, '96k'),
    'ui':       (-20.0, False, False, '96k'),
    # The hit confirmation is not a UI one-shot: it fires on every bullet that
    # connects, several times a second, so it has to sit far enough under the
    # gun that a sustained burst does not turn into a tick track.
    'tick':     (-26.0, False, False, '64k'),
    'stinger':  (-17.5, False, True,  '112k'),
    'music':    (-20.0, True,  True,  '128k'),
    'amb':      (-23.0, False, False, '96k'),
    'ambloop':  (-23.0, True,  True,  '112k'),
    'song':     (-18.0, True,  True,  '128k'),
}

BLAST = {'explosion', 'explosion_tail', 'sub_impact', 'grenade', 'monkey_cymbal', 'trap'}
ANNOUNCE = {'ann_dogs', 'ann_double', 'ann_insta', 'ann_maxammo', 'ann_nuke',
            'nuke', 'maxammo', 'double', 'insta'}
STINGER = {'stinger_round_start', 'stinger_round_end', 'round_start', 'round_end', 'gameover'}
MUSIC = {'menu_music', 'music_box', 'perk_jug', 'perk_speed', 'perk_dtap', 'perk_qr'}
ZVOICE_PREFIX = ('groan', 'snarl', 'zdeath', 'dog_')
PVOICE_PREFIX = ('vox_', 'hurt')
PVOICE = {'revive', 'drink', 'belch', 'count_go', 'count_tick'}
FOLEY_PREFIX = ('rel_', 'bolt_', 'inspect_', 'foley_', 'reload_', 'board_')
FOLEY = {'dry', 'melee', 'knuckles'}


def family(stem):
    if stem == 'hitmarker':
        return 'tick'
    if stem == 'beauty-of-annihilation':
        return 'song'
    if stem == 'ambience':
        return 'ambloop'
    if stem.startswith('amb_'):
        return 'amb'
    if stem in BLAST:
        return 'blast'
    if stem in ANNOUNCE:
        return 'announce'
    if stem in STINGER:
        return 'stinger'
    if stem in MUSIC:
        return 'music'
    if stem.startswith(('impact_', 'ricochet', 'whizby')):
        return 'impact'
    if stem.startswith('casing_'):
        return 'casing'
    if stem.startswith('step'):
        return 'step'
    if stem.startswith(ZVOICE_PREFIX):
        return 'zvoice'
    if stem.startswith(PVOICE_PREFIX) or stem in PVOICE:
        return 'pvoice'
    if stem.startswith(FOLEY_PREFIX) or stem in FOLEY:
        return 'foley'
    return 'ui'


def run(src, outdir):
    os.makedirs(outdir, exist_ok=True)
    rep = []
    for path in sorted(glob.glob(os.path.join(src, '*.mp3'))):
        stem = os.path.splitext(os.path.basename(path))[0]
        if stem.startswith('shot_'):
            continue
        fam = family(stem)
        tgt, use_i, stereo, br = FAMILY[fam]
        ch = 2 if stereo else 1
        x = decode(path, ch=ch)
        if x.size < 64:
            continue
        before_m = lufs_momentary_max(x, win=NORM_WIN)
        y = normalise(x, target_lufs_i=tgt if use_i else None,
                      target_lufs_m=None if use_i else tgt,
                      ceiling_db=CEILING, win=NORM_WIN,
                      max_drive_db=3.0 if use_i else 6.0)
        dst = os.path.join(outdir, stem + '.mp3')
        encode(y, dst, bitrate=br, ch=ch)
        z = decode(dst, ch=ch)
        rep.append(dict(file=stem, fam=fam, before_M=round(before_m, 2),
                        M=round(lufs_momentary_max(z, win=NORM_WIN), 2),
                        I=round(lufs_integrated(z), 2),
                        tp=round(true_peak_db(z) if ch == 1 else
                                 max(true_peak_db(z[c]) for c in range(ch)), 2),
                        bytes=os.path.getsize(dst),
                        was=os.path.getsize(path)))
        print('.', end='', flush=True)
    print()
    json.dump(rep, open(os.path.join(outdir, '_lib.json'), 'w'), indent=1)
    return rep


if __name__ == '__main__':
    rep = run(sys.argv[1], sys.argv[2])
    import collections
    g = collections.defaultdict(list)
    for r in rep:
        g[r['fam']].append(r)
    for k in sorted(g):
        Ms = [r['M'] for r in g[k]]
        print(f"{k:9s} n={len(g[k]):3d}  M {min(Ms):7.2f}..{max(Ms):7.2f} (spread {max(Ms)-min(Ms):4.2f})  "
              f"maxTP {max(r['tp'] for r in g[k]):6.2f}")
    print(f"total bytes {sum(r['bytes'] for r in rep)} (was {sum(r['was'] for r in rep)})")
