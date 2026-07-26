"""Post-encode true-peak conform.

Normalising the float buffer to -1 dBTP is not enough: the mp3 encoder can push
a decoded sample above where the float sat, and a stereo file's per-channel peak
is higher than the mono downmix the limiter was watching. This re-measures what
a browser will actually decode and trims until the ceiling really holds.
"""
import sys, os, glob, subprocess, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dsp import decode, encode, true_peak_db, limiter

CEILING = -1.0


def channels_of(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=channels',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    try:
        return int(r.stdout.strip().splitlines()[0])
    except Exception:
        return 1


def bitrate_of(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=bit_rate',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    try:
        return f"{max(48, round(int(r.stdout.strip()) / 1000)) }k"
    except Exception:
        return '96k'


def worst_peak(path, ch):
    x = decode(path, ch=ch)
    if ch == 1:
        return true_peak_db(x)
    return max(true_peak_db(x[0]), true_peak_db(x[1]), true_peak_db(x.mean(axis=0)))


def main(d):
    fixed = []
    for p in sorted(glob.glob(os.path.join(d, '*.mp3'))):
        ch = channels_of(p)
        tp = worst_peak(p, ch)
        if tp <= CEILING:
            continue
        br = bitrate_of(p)
        for _ in range(6):
            x = decode(p, ch=ch)
            x = limiter(x, CEILING - 0.8)
            x = x * 10 ** (min(0.0, (CEILING - 0.35) - tp) / 20)
            encode(x, p, bitrate=br, ch=ch)
            tp = worst_peak(p, ch)
            if tp <= CEILING:
                break
        fixed.append((os.path.basename(p), round(tp, 2)))
    print('conformed:', fixed)


if __name__ == '__main__':
    main(sys.argv[1])
