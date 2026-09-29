# Inflation: a front outline (drawn on the XZ plane) and a side outline (drawn on the YZ
# plane) become a closed, rounded body.
#
# Front: every inside point of the front outline is covered by the largest disc that fits
# the outline around it; the body's half-depth there is the height of the ball on that disc
# (the "union of inscribed balls"), so tubes come out round and blobs come out domed.
# Side: at each height the side outline gives the front-to-back extent. The front balloon is
# centred in it and stretched to its depth, then clipped by the side outline with a rounded
# intersection, so the side profile (belly, back, nose, heel) is kept.
#
# Pure numpy; no Blender calls here, so it can be tested outside Blender.

import numpy as np

BIG = 1e12


# ---------- 2D rasters ----------

def raster_lines(polys, x0, y0, h, nx, ny, radius=1):
    """Mark pixels under polylines. polys: list of (points Nx2, closed)."""
    img = np.zeros((ny, nx), bool)
    samples = []
    for pts, closed in polys:
        P = np.asarray(pts, float)
        if len(P) < 2:
            continue
        if closed:
            P = np.vstack([P, P[:1]])
        seg = P[1:] - P[:-1]
        n = np.maximum(2, np.ceil(np.linalg.norm(seg, axis=1) / (0.4 * h)).astype(int) + 1)
        for a, d, k in zip(P[:-1], seg, n):
            t = np.linspace(0.0, 1.0, k)[:, None]
            samples.append(a + d * t)
    if not samples:
        return img
    Q = np.vstack(samples)
    ix = np.round((Q[:, 0] - x0) / h).astype(int)
    iy = np.round((Q[:, 1] - y0) / h).astype(int)
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            if dx * dx + dy * dy > radius * radius:
                continue
            jx, jy = ix + dx, iy + dy
            ok = (jx >= 0) & (jx < nx) & (jy >= 0) & (jy < ny)
            img[jy[ok], jx[ok]] = True
    return img


def fill_inside(lines):
    """Pixels not reachable from the image border without crossing a line."""
    free = ~lines
    out = np.zeros_like(free)
    out[0, :] = free[0, :]
    out[-1, :] = free[-1, :]
    out[:, 0] |= free[:, 0]
    out[:, -1] |= free[:, -1]
    while True:
        prev = out
        for _ in range(16):
            g = out.copy()
            g[1:] |= out[:-1]
            g[:-1] |= out[1:]
            g[:, 1:] |= out[:, :-1]
            g[:, :-1] |= out[:, 1:]
            out = g & free
        if np.array_equal(out, prev):
            break
    return ~out


def _min_plus_rows(g, h):
    """out[r, p] = min_q g[r, q] + ((p - q) h)^2, brute force in row blocks."""
    n = g.shape[1]
    idx = np.arange(n)
    D = ((idx[:, None] - idx[None, :]) * h) ** 2
    out = np.empty_like(g)
    step = max(1, int(1.5e7 // (n * n)))
    for r in range(0, g.shape[0], step):
        blk = g[r:r + step]
        out[r:r + step] = (blk[:, None, :] + D[None, :, :]).min(axis=2)
    return out


def sep_transform(f, h, mode='min'):
    """Separable squared-distance transform of a function (Felzenszwalb & Huttenlocher).
    min: min_q f(q) + |p - q|^2      max: max_q f(q) - |p - q|^2"""
    s = 1.0 if mode == 'min' else -1.0
    g = s * f
    g = _min_plus_rows(g, h)
    g = _min_plus_rows(g.T.copy(), h).T
    return s * g


def distance_inside(mask, h):
    return np.sqrt(np.maximum(sep_transform(np.where(mask, BIG, 0.0), h, 'min'), 0.0))


def signed_distance(mask, h):
    din = distance_inside(mask, h)
    dout = distance_inside(~mask, h)
    return np.where(mask, din, -dout)


def ball_height(mask, h):
    """Half-thickness of the union of inscribed balls over a 2D region."""
    din = distance_inside(mask, h)
    hsq = sep_transform(np.where(mask, din * din, -BIG), h, 'max')
    return np.sqrt(np.maximum(hsq, 0.0))


def _runs(row):
    """(start, end) index pairs of True runs in a 1D bool array."""
    d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1) - 1))


def smooth_max(a, b, r):
    k = np.maximum(r - np.abs(a - b), 0.0) / r
    return np.maximum(a, b) + k * k * r * 0.25


# ---------- 3D field ----------

def build_field(front, side, h=0.006, mirror=True, round_r=0.02, pad=4):
    """front: list of (Nx2 [x, z], closed); side: list of (Nx2 [y, z], closed).
    Returns (G, origin, h) with G[k, j, i] at (x0 + i h, y0 + j h, z0 + k h); inside is G < 0."""
    fp = np.vstack([np.asarray(p, float) for p, _ in front])
    sp = np.vstack([np.asarray(p, float) for p, _ in side])
    xm = np.abs(fp[:, 0]).max() if mirror else None
    x0, x1 = (-xm, xm) if mirror else (fp[:, 0].min(), fp[:, 0].max())
    y0, y1 = sp[:, 0].min(), sp[:, 0].max()
    z0, z1 = min(fp[:, 1].min(), sp[:, 1].min()), max(fp[:, 1].max(), sp[:, 1].max())
    x0, y0, z0 = x0 - pad * h, y0 - pad * h, z0 - pad * h
    nx = int(np.ceil((x1 + pad * h - x0) / h)) + 1
    ny = int(np.ceil((y1 + pad * h - y0) / h)) + 1
    nz = int(np.ceil((z1 + pad * h - z0) / h)) + 1

    if mirror:
        # draw one half: strokes and their mirror images are filled together, and an open
        # stroke that stops near the centre line is carried onto it
        near = 0.04 * max(x1, 1e-6)
        polys = []
        for p, closed in front:
            P = np.asarray(p, float)
            if not closed and len(P) > 1:
                if abs(P[0, 0]) < near:
                    P = np.vstack([[0.0, P[0, 1]], P])
                if abs(P[-1, 0]) < near:
                    P = np.vstack([P, [0.0, P[-1, 1]]])
            polys.append((P, closed))
            polys.append((P * [-1.0, 1.0], closed))
        front = polys
    Fm = fill_inside(raster_lines(front, x0, z0, h, nx, nz))   # [z, x]
    Sm = fill_inside(raster_lines(side, y0, z0, h, ny, nz))    # [z, y]
    for name, m, strokes in (('front', Fm, front), ('side', Sm, side)):
        lines = raster_lines(strokes, x0 if name == 'front' else y0, z0, h, m.shape[1], m.shape[0])
        if (m & ~lines).sum() < 0.02 * m.sum() + 10:
            raise ValueError('the %s outline is not closed: its strokes enclose nothing' % name)

    hf = ball_height(Fm, h)
    dfo = distance_inside(~Fm, h)
    hs = np.where(Fm, hf, -dfo)                                 # signed front half-thickness
    S = signed_distance(Sm, h)                                   # side, positive inside

    ys = y0 + np.arange(ny) * h
    G = np.full((nz, ny, nx), 1.0, np.float32)
    for k in range(nz):
        runs = _runs(Sm[k])
        if not runs or not Fm[k].any():
            continue
        a, b = max(runs, key=lambda r: r[1] - r[0])
        c = y0 + 0.5 * (a + b) * h
        D = 0.5 * (b - a + 1) * h
        hmax = hf[k].max()
        if hmax <= 0:
            continue
        kz = D / hmax
        F = np.abs(ys - c)[:, None] - kz * hs[k][None, :]
        G[k] = smooth_max(F, -S[k][:, None], round_r)
    return G, np.array([x0, y0, z0]), h, {'front_mask': Fm, 'side_mask': Sm}


# ---------- surface extraction (surface nets: one vertex per cell, one quad per crossed edge) ----------

def surface_nets(G, origin, h):
    s = G < 0
    nz, ny, nx = G.shape
    cz, cy, cx = nz - 1, ny - 1, nx - 1
    acc = np.zeros((cz, cy, cx, 3))
    cnt = np.zeros((cz, cy, cx))

    def crossings(axis):
        a = [slice(None)] * 3
        b = [slice(None)] * 3
        a[axis] = slice(0, -1)
        b[axis] = slice(1, None)
        g0, g1 = G[tuple(a)], G[tuple(b)]
        m = (g0 < 0) != (g1 < 0)
        t = np.where(m, g0 / np.where(m, g0 - g1, 1.0), 0.0)
        return m, t

    # each grid edge along an axis touches up to 4 cells; add its crossing point to them
    for axis in range(3):
        m, t = crossings(axis)
        kk, jj, ii = np.nonzero(m)
        tt = t[kk, jj, ii]
        P = np.stack([ii, jj, kk], 1).astype(float)          # x, y, z grid coords
        P[:, 2 - axis] += tt                                   # axis 0=z, 1=y, 2=x in G
        others = [d for d in range(3) if d != axis]
        for o1 in (0, -1):
            for o2 in (0, -1):
                idx = [kk.copy(), jj.copy(), ii.copy()]
                idx[others[0]] += o1
                idx[others[1]] += o2
                ok = (idx[0] >= 0) & (idx[0] < cz) & (idx[1] >= 0) & (idx[1] < cy) & (idx[2] >= 0) & (idx[2] < cx)
                np.add.at(acc, (idx[0][ok], idx[1][ok], idx[2][ok]), P[ok])
                np.add.at(cnt, (idx[0][ok], idx[1][ok], idx[2][ok]), 1)

    has = cnt > 0
    vid = -np.ones((cz, cy, cx), np.int64)
    vid[has] = np.arange(has.sum())
    V = acc[has] / cnt[has][:, None]
    V = origin + V * h

    faces = []
    for axis in range(3):
        m, _ = crossings(axis)
        kk, jj, ii = np.nonzero(m)
        inside_first = s[kk, jj, ii]
        others = [d for d in range(3) if d != axis]
        quad = []
        for o1, o2 in ((0, 0), (-1, 0), (-1, -1), (0, -1)):
            idx = [kk.copy(), jj.copy(), ii.copy()]
            idx[others[0]] += o1
            idx[others[1]] += o2
            quad.append(idx)
        ok = np.ones(len(kk), bool)
        for idx in quad:
            ok &= (idx[0] >= 0) & (idx[0] < cz) & (idx[1] >= 0) & (idx[1] < cy) & (idx[2] >= 0) & (idx[2] < cx)
        Q = np.stack([vid[idx[0][ok], idx[1][ok], idx[2][ok]] for idx in quad], 1)
        flip = inside_first[ok]
        # axis order in G is (z, y, x); orientation depends on axis parity
        if axis == 1:
            flip = ~flip
        Q[flip] = Q[flip][:, ::-1]
        faces.append(Q)
    F = np.vstack(faces)
    F = F[(F >= 0).all(1)]
    return V, F
