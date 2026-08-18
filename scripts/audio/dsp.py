"""Minimal DSP toolkit for the Der Riese audio pass (numpy only, no scipy)."""
import subprocess, numpy as np, math, os

SR = 48000

# ---------------------------------------------------------------- io --------
def decode(path, sr=SR, ch=1):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', str(ch),
                        '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True)
    x = np.frombuffer(p.stdout, dtype=np.float32).astype(np.float64)
    return x.reshape(-1, ch).T if ch > 1 else x

def encode(x, path, sr=SR, bitrate='96k', ch=1):
    if x.ndim == 1:
        raw = x.astype(np.float32).tobytes(); nch = 1
    else:
        raw = x.T.astype(np.float32).tobytes(); nch = x.shape[0]
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(sr),
           '-ac', str(nch), '-i', '-', '-c:a', 'libmp3lame', '-b:a', bitrate,
           '-ac', str(ch), path]
    subprocess.run(cmd, input=raw, check=True, capture_output=True)

# ------------------------------------------------------------ filters -------
try:
    from scipy.signal import lfilter as _lfilter
except Exception:                                        # pragma: no cover
    _lfilter = None

def _biquad(x, b, a):
    """Direct-form-II transposed biquad."""
    if _lfilter is not None:
        return _lfilter(np.asarray(b), np.asarray(a), x)
    y = np.empty_like(x)
    z1 = z2 = 0.0
    b0, b1, b2 = b; a1, a2 = a[1], a[2]
    for i in range(x.shape[0]):
        xi = x[i]
        yi = b0 * xi + z1
        z1 = b1 * xi - a1 * yi + z2
        z2 = b2 * xi - a2 * yi
        y[i] = yi
    return y

def _rbj(kind, f0, Q, sr=SR, gain_db=0.0):
    w = 2 * math.pi * f0 / sr
    cw, sw = math.cos(w), math.sin(w)
    alpha = sw / (2 * Q)
    if kind == 'lp':
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == 'hp':
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == 'bp':
        b = [alpha, 0, -alpha]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == 'peak':
        A = 10 ** (gain_db / 40)
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    else:
        raise ValueError(kind)
    n = a[0]
    return [v / n for v in b], [1.0, a[1] / n, a[2] / n]

def filt(x, kind, f0, Q=0.707, sr=SR, gain_db=0.0, order=1):
    b, a = _rbj(kind, min(f0, sr * 0.45), Q, sr, gain_db)
    for _ in range(order):
        x = _biquad(x, b, a)
    return x

# ---------------------------------------------------------- generators ------
_rng = np.random.default_rng(20250725)

def noise(n):
    return _rng.standard_normal(n)

def env_ad(n, attack, decay, sr=SR, curve=2.4):
    """Attack/exponential-decay envelope."""
    t = np.arange(n) / sr
    a = np.clip(t / max(attack, 1e-6), 0, 1)
    d = np.exp(-t / max(decay, 1e-6) * curve)
    return a * d

def sweep(n, f0, f1, sr=SR, kind='sine'):
    t = np.arange(n) / sr
    T = max(n / sr, 1e-6)
    # exponential frequency glide
    f = f0 * (max(f1, 1.0) / max(f0, 1.0)) ** (t / T)
    ph = 2 * np.pi * np.cumsum(f) / sr
    if kind == 'sine':
        return np.sin(ph)
    if kind == 'tri':
        return 2 / np.pi * np.arcsin(np.sin(ph))
    if kind == 'saw':
        return 2 * (ph / (2 * np.pi) % 1.0) - 1
    return np.sign(np.sin(ph))

def place(dst, src, at_sec, gain=1.0, sr=SR):
    i = int(at_sec * sr)
    n = min(len(src), len(dst) - i)
    if n > 0:
        dst[i:i + n] += src[:n] * gain
    return dst

# -------------------------------------------------------------- utils -------
def block_env(x, blk=0.005, sr=SR):
    m = max(1, int(sr * blk)); nb = max(1, len(x) // m)
    return np.array([math.sqrt(float(np.mean(x[i * m:(i + 1) * m] ** 2)) + 1e-20)
                     for i in range(nb)]), m

def smooth(v, k):
    if k < 2:
        return v
    w = np.hanning(k * 2 + 1); w /= w.sum()
    return np.convolve(np.pad(v, k, mode='edge'), w, mode='same')[k:-k]

def trim_head(x, thresh_db=-42, sr=SR, pre_ms=1.0):
    """Drop pre-roll so the transient lands on sample 0 (short fade-in, no click)."""
    e, m = block_env(x, 0.002, sr)
    pk = e.max()
    if pk <= 0:
        return x
    thr = pk * (10 ** (thresh_db / 20))
    idx = int(np.argmax(e > thr))
    start = max(0, idx * m - int(sr * pre_ms / 1000))
    y = x[start:].copy()
    f = int(sr * 0.0008)
    if len(y) > f:
        y[:f] *= np.linspace(0, 1, f)
    return y

def trim_tail(x, thresh_db=-58, sr=SR, min_sec=0.25, fade_ms=25):
    e, m = block_env(x, 0.01, sr)
    pk = e.max()
    thr = pk * (10 ** (thresh_db / 20))
    above = np.nonzero(e > thr)[0]
    end = (above[-1] + 2) * m if len(above) else len(x)
    end = int(max(end, sr * min_sec))
    y = x[:min(end, len(x))].copy()
    f = min(len(y), int(sr * fade_ms / 1000))
    if f > 4:
        y[-f:] *= np.linspace(1, 0, f)
    return y

# ---------------------------------------------- loudness (BS.1770 K-weight) --
def _k_coeffs(sr):
    f0 = 1681.974450955533; G = 3.999843853973347; Q = 0.7071752369554196
    K = math.tan(math.pi * f0 / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a1 = [1.0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    f0 = 38.13547087602444; Q = 0.5003270373238773
    K = math.tan(math.pi * f0 / sr); d = 1 + K / Q + K * K
    b2 = [1.0, -2.0, 1.0]
    a2 = [1.0, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d]
    return b1, a1, b2, a2

def kweight(x, sr=SR):
    b1, a1, b2, a2 = _k_coeffs(sr)
    return _biquad(_biquad(x, b1, a1), b2, a2)

def _mean_power(x, sr=SR):
    """BS.1770 channel sum: L and R each carry weight 1.0, so a stereo pair with
    decorrelated channels measures as loud as it actually plays. Averaging the
    two into a mono downmix first (which is what a naive implementation does)
    cancels their difference signal and under-reads by up to 3 dB."""
    a = np.asarray(x, dtype=np.float64)
    if a.ndim == 1:
        y = kweight(a, sr)
        return y * y
    tot = None
    for ch in range(a.shape[0]):
        y = kweight(a[ch], sr)
        tot = y * y if tot is None else tot + y * y
    return tot


def lufs_momentary_max(x, sr=SR, win=0.4):
    """Loudest K-weighted window of `win` seconds.

    `win=0.4` is the EBU R128 momentary window and is what we report.  Short
    one-shots are *normalised* on a 0.2 s window instead: with a 400 ms window a
    0.34 s SMG crack is measured mostly against its own silence, which would
    force it 4 dB hotter than the family to compensate."""
    p = _mean_power(x, sr)
    W = int(win * sr); H = max(1, int(0.02 * sr))
    if len(p) < W:
        p = np.concatenate([p, np.zeros(W - len(p))])
    cs = np.concatenate([[0.0], np.cumsum(p)])
    n = (len(p) - W) // H + 1
    best = max(((cs[i * H + W] - cs[i * H]) / W) for i in range(max(1, n)))
    return -0.691 + 10 * math.log10(max(best, 1e-12))

def lufs_integrated(x, sr=SR):
    p = _mean_power(x, sr)
    return -0.691 + 10 * math.log10(max(float(np.mean(p)), 1e-12))

def true_peak_db(x, sr=SR, os=4):
    """4x-oversampled peak via zero-stuffed FFT interpolation."""
    a = np.asarray(x, dtype=np.float64)
    if a.ndim > 1:
        a = a.reshape(-1)
    n = len(a)
    if n == 0:
        return -99.0
    N = 1 << (int(math.ceil(math.log2(max(n, 2)))))
    buf = np.zeros(N); buf[:n] = a
    F = np.fft.rfft(buf)
    F2 = np.zeros(N * os // 2 + 1, dtype=complex)
    F2[:len(F)] = F
    up = np.fft.irfft(F2, N * os) * os
    return 20 * math.log10(max(float(np.abs(up).max()), 1e-9))

def limiter(x, ceiling_db=-1.0, lookahead_ms=1.5, release_ms=80, sr=SR):
    """Look-ahead peak limiter. Transparent below the ceiling, so anything that
    already fits comes out untouched."""
    a = np.asarray(x, dtype=np.float64)
    mono = a if a.ndim == 1 else np.abs(a).max(axis=0)
    c = 10 ** (ceiling_db / 20)
    s = np.abs(mono)
    if s.max() <= c:
        return a
    need = np.minimum(1.0, c / np.maximum(s, 1e-12))
    la = max(1, int(sr * lookahead_ms / 1000))
    # sliding-window minimum over the look-ahead: gain starts falling before the peak
    m = need.copy()
    step = 1
    while step < la:
        m[:-step] = np.minimum(m[:-step], m[step:])
        step *= 2
    # attack: hann-smooth the reduction so it does not click
    w = np.hanning(la * 2 + 1); w /= w.sum()
    m = np.convolve(np.pad(m, la, mode='edge'), w, mode='same')[la:-la]
    m = np.minimum(m, need)
    # release: one-pole upward smoothing
    coef = math.exp(-1.0 / max(1.0, sr * release_ms / 1000))
    g = np.empty_like(m); prev = m[0]
    for i in range(len(m)):
        v = m[i]
        prev = v if v < prev else v + (prev - v) * coef
        g[i] = prev
    g = np.minimum(g, need)
    return a * g if a.ndim == 1 else a * g[None, :]

# retained for callers that want the cheap version
soft_limit = limiter

def normalise(x, target_lufs_m=None, target_lufs_i=None, ceiling_db=-1.0, sr=SR,
              max_drive_db=6.0, win=0.4):
    """Gain to a loudness target, then guarantee the true-peak ceiling.

    One-shots are normalised on max-momentary loudness (a 400 ms K-weighted
    window) rather than integrated loudness: integrated punishes a gunshot for
    having a tail, which is exactly the wrong incentive."""
    a = np.asarray(x, dtype=np.float64)
    cur = lufs_integrated(a, sr) if target_lufs_i is not None else lufs_momentary_max(a, sr, win)
    tgt = target_lufs_i if target_lufs_i is not None else target_lufs_m
    pre = 10 ** ((tgt - cur) / 20)

    def peak(y):
        if y.ndim == 1:
            return true_peak_db(y, sr)
        return max(true_peak_db(y[c], sr) for c in range(y.shape[0]))

    def master(g):
        y = a * g
        if peak(y) > ceiling_db:
            y = limiter(y, ceiling_db - 0.6, sr=sr)
            tp = peak(y)
            if tp > ceiling_db:
                y = y * 10 ** ((ceiling_db - tp) / 20)
        return y

    # Drive the limiter until the measured loudness lands on target. Capped at
    # `max_drive_db` of extra gain so nothing gets crushed to hit a number.
    best = master(pre)
    for _ in range(10):
        m = (lufs_integrated(best, sr) if target_lufs_i is not None
             else lufs_momentary_max(best, sr, win))
        err = tgt - m
        if abs(err) < 0.2:
            break
        nxt = pre * 10 ** (min(err, 3.0) / 20)
        if 20 * math.log10(nxt / (10 ** ((tgt - cur) / 20))) > max_drive_db:
            break
        pre = nxt
        best = master(pre)
    return best
