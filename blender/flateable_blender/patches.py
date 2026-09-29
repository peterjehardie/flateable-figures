# Patch retopology from strokes drawn on a surface (after Takayama et al. 2013).
#
# Strokes cut the surface into patches. Where strokes cross (or a stroke ends on another)
# is a node; the stroke pieces between nodes are the network's edges; each region bounded
# by edges is a patch. A patch's corners are the nodes where its border turns.
#
# Every edge gets a number of mesh segments. A quad-only patch needs an even number of
# segments round its border, and a four-sided patch is a clean grid only when opposite
# sides match, so the counts are chosen together: opposite sides of four-sided patches are
# tied into chains, parity is fixed by flipping chains along short paths between odd
# patches, and a local search trades segment length against irregular vertices.
#
# Each patch is then filled:
#   4 sides with matching opposite sides  -> a grid
#   3, 5 or 6 sides                        -> one centre point joined to a point on every side,
#                                             giving N grids round a pole of N edges
#   anything else                          -> corners are added on straight runs or dropped at
#                                             soft bends until one of the above fits
# Interior points are relaxed and projected back onto the surface; stroke vertices stay put.
#
# Pure numpy. The surface is reached only through project(points) -> (points, normals).

import math
from collections import defaultdict, deque

import numpy as np


# ---------------- polylines ----------------

def arclen(P):
    return np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])


def resample(P, step, closed=False):
    P = np.asarray(P, float)
    if closed:
        P = np.vstack([P, P[:1]])
    s = arclen(P)
    if s[-1] < 1e-9:
        return P[:1]
    n = max(2, int(round(s[-1] / step)) + 1)
    t = np.linspace(0.0, s[-1], n)
    out = np.stack([np.interp(t, s, P[:, k]) for k in range(3)], 1)
    return out[:-1] if closed else out


def resample_n(P, n):
    """n segments, equal arc length; returns n + 1 points including both ends."""
    s = arclen(P)
    t = np.linspace(0.0, s[-1], n + 1)
    return np.stack([np.interp(t, s, P[:, k]) for k in range(3)], 1)


def seg_seg(p1, q1, p2, q2):
    """Closest points of segments p1q1 and p2q2: (dist, s, t)."""
    d1, d2, r = q1 - p1, q2 - p2, p1 - p2
    a, e, f = d1 @ d1, d2 @ d2, d2 @ r
    if a < 1e-18 or e < 1e-18:
        return 1e9, 0.0, 0.0
    c, b = d1 @ r, d1 @ d2
    den = a * e - b * b
    s = min(max((b * f - c * e) / den, 0.0), 1.0) if den > 1e-18 else 0.0
    t = (b * s + f) / e
    if t < 0.0:
        t, s = 0.0, min(max(-c / a, 0.0), 1.0)
    elif t > 1.0:
        t, s = 1.0, min(max((b - c) / a, 0.0), 1.0)
    return float(np.linalg.norm(p1 + d1 * s - (p2 + d2 * t))), s, t


class UF:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


# ---------------- network ----------------

class Network:
    def __init__(self):
        self.nodes = []        # positions
        self.normals = []
        self.edges = []        # dict(a, b, pts, len, centre)
        self.notes = []


def prepare_strokes(strokes, project, step, mirror=False, tol=None):
    """strokes: list of (Nx3, closed). Resampled, projected; with mirror, cut to x >= 0."""
    tol = tol if tol is not None else step
    out = []
    for P, closed in strokes:
        P = np.asarray(P, float)
        if len(P) < 2:
            continue
        P = resample(P, step * 0.5, closed)
        P, _ = project(P)
        if mirror:
            keep = P[:, 0] >= -0.5 * tol
            if not keep.all():
                if closed and keep.any():
                    # rotate a cut loop so its kept runs do not wrap round the end
                    idx = np.flatnonzero(~keep)
                    P = np.roll(P, -idx[0], axis=0)
                    keep = np.roll(keep, -idx[0])
                runs, cur = [], []
                for p, k in zip(P, keep):
                    if k:
                        cur.append(p)
                    elif cur:
                        runs.append(np.array(cur))
                        cur = []
                if cur:
                    runs.append(np.array(cur))
                for r in runs:
                    if len(r) >= 3:
                        out.append((resample(r, step, False), False))
                continue
        R = resample(P, step, closed)
        if len(R) >= 3:
            out.append((R, closed))
    return out


def build_network(strokes, project, step, mirror=False, snap=None, centre_ids=()):
    """strokes: prepared (points, closed). Returns Network."""
    snap = snap if snap is not None else 2.5 * step
    xtol = 0.8 * step
    net = Network()
    S = [np.asarray(P, float) for P, _ in strokes]
    C = [c for _, c in strokes]
    nseg = [len(P) if c else len(P) - 1 for P, c in zip(S, C)]

    def seg(i, k):
        P = S[i]
        return P[k], P[(k + 1) % len(P)]

    # spatial hash of segments
    cell = max(snap, 2 * step)
    grid = defaultdict(list)
    for i, P in enumerate(S):
        for k in range(nseg[i]):
            a, b = seg(i, k)
            lo = np.floor((np.minimum(a, b) - snap) / cell).astype(int)
            hi = np.floor((np.maximum(a, b) + snap) / cell).astype(int)
            for x in range(lo[0], hi[0] + 1):
                for y in range(lo[1], hi[1] + 1):
                    for z in range(lo[2], hi[2] + 1):
                        grid[(x, y, z)].append((i, k))

    def near_segments(p):
        key = tuple(np.floor(p / cell).astype(int))
        return grid.get(key, ())

    # crossings between different strokes (and far-apart parts of one stroke)
    hits = defaultdict(list)                      # (i, j) -> [(si, sj, d)]
    seen = set()
    for key, segs in grid.items():
        for u in range(len(segs)):
            i, k = segs[u]
            for v in range(u + 1, len(segs)):
                j, m = segs[v]
                if i == j:
                    gap = abs(k - m)
                    if C[i]:
                        gap = min(gap, nseg[i] - gap)
                    if gap < 4:
                        continue
                pair = (i, k, j, m) if (i, k) < (j, m) else (j, m, i, k)
                if pair in seen:
                    continue
                seen.add(pair)
                a1, b1 = seg(pair[0], pair[1])
                a2, b2 = seg(pair[2], pair[3])
                d, s, t = seg_seg(a1, b1, a2, b2)
                if d < xtol:
                    hits[(pair[0], pair[2])].append((pair[1] + s, pair[3] + t, d))

    points = []                                  # (stroke, param)
    links = []                                   # pairs of point indices that are one node
    for (i, j), lst in hits.items():
        lst.sort()
        groups = []
        for si, sj, d in lst:
            if groups and abs(si - groups[-1][-1][0]) < 2.5:
                groups[-1].append((si, sj, d))
            else:
                groups.append([(si, sj, d)])
        for g in groups:
            si, sj, _ = min(g, key=lambda r: r[2])
            points.append((i, si))
            points.append((j, sj))
            links.append((len(points) - 2, len(points) - 1))

    def point_pos(i, s):
        P = S[i]
        k = int(math.floor(s))
        t = s - k
        if C[i]:
            return P[k % len(P)] * (1 - t) + P[(k + 1) % len(P)] * t
        k = min(k, len(P) - 2)
        t = s - k
        return P[k] * (1 - t) + P[k + 1] * t

    # stroke ends that stop near another stroke snap onto it
    for i, P in enumerate(S):
        if C[i]:
            continue
        for end in (0.0, float(len(P) - 1)):
            if any(pi == i and abs(ps - end) < snap / step for pi, ps in points):
                continue
            p = P[int(end)]
            best = None
            for j, m in near_segments(p):
                if j == i and (abs(m - end) < snap / step + 2):
                    continue
                a, b = seg(j, m)
                ab = b - a
                t = min(max(((p - a) @ ab) / max(ab @ ab, 1e-18), 0.0), 1.0)
                d = np.linalg.norm(a + ab * t - p)
                if d < snap and (best is None or d < best[0]):
                    best = (d, j, m + t)
            if best:
                _, j, sj = best
                if not C[j]:
                    if sj < 1.5:
                        sj = 0.0
                    elif sj > len(S[j]) - 2.5:
                        sj = float(len(S[j]) - 1)
                points.append((i, end))
                points.append((j, sj))
                links.append((len(points) - 2, len(points) - 1))

    # with mirroring, a stroke end at the centre plane belongs on the centre line
    if mirror and centre_ids:
        CP = [(j, S[j]) for j in centre_ids]
        for i, P in enumerate(S):
            if C[i] or i in centre_ids:
                continue
            for end in (0, len(P) - 1):
                p = P[end]
                if abs(p[0]) > 1.5 * step:
                    continue
                best = None
                for j, Q in CP:
                    d = np.linalg.norm(Q - p, axis=1)
                    k = int(d.argmin())
                    if best is None or d[k] < best[0]:
                        best = (d[k], j, float(k))
                if best and best[0] < 6 * step:
                    already = [q for q, (pi, ps) in enumerate(points) if pi == i and abs(ps - end) < 0.5]
                    points.append((i, float(end)))
                    points.append((best[1], best[2]))
                    links.append((len(points) - 2, len(points) - 1))
                    for q in already:
                        links.append((q, len(points) - 2))

    # closed strokes that touch nothing still need a node
    for i in range(len(S)):
        if C[i] and not any(pi == i for pi, _ in points):
            points.append((i, 0.0))

    uf = UF()
    for a, b in links:
        uf.union(a, b)
    for q in range(len(points)):
        uf.find(q)
    # points close together on one stroke are one node
    by_stroke = defaultdict(list)
    for q, (i, s) in enumerate(points):
        by_stroke[i].append((s, q))
    for i, lst in by_stroke.items():
        lst.sort()
        for (s1, q1), (s2, q2) in zip(lst, lst[1:]):
            if s2 - s1 < 1.6:
                uf.union(q1, q2)
        if C[i] and len(lst) > 1 and (lst[0][0] + nseg[i] - lst[-1][0]) < 1.6:
            uf.union(lst[0][1], lst[-1][1])
    # also merge nodes whose positions nearly coincide
    pos = np.array([point_pos(i, s) for i, s in points]) if points else np.zeros((0, 3))
    for a in range(len(points)):
        for b in range(a + 1, len(points)):
            if np.linalg.norm(pos[a] - pos[b]) < 0.9 * step:
                uf.union(a, b)

    roots = {}
    node_of = []
    for q in range(len(points)):
        r = uf.find(q)
        if r not in roots:
            roots[r] = len(roots)
        node_of.append(roots[r])
    NP = np.zeros((len(roots), 3))
    cnt = np.zeros(len(roots))
    for q, n in enumerate(node_of):
        NP[n] += pos[q]
        cnt[n] += 1
    NP /= np.maximum(cnt, 1)[:, None]
    NP, NN = project(NP) if len(NP) else (NP, NP)
    net.nodes, net.normals = list(NP), list(NN)

    # split strokes at their nodes
    centre_set = set(centre_ids)
    for i, P in enumerate(S):
        lst = sorted({(round(s, 6), node_of[q]) for q, (pi, s) in enumerate(points) if pi == i})
        # one entry per node along the stroke
        clean = []
        for s, n in lst:
            if clean and clean[-1][1] == n and abs(s - clean[-1][0]) < 2.0:
                continue
            clean.append((s, n))
        if not clean:
            continue
        pieces = []
        if C[i]:
            if len(clean) == 1:
                s, n = clean[0]
                pieces.append((s, s + nseg[i], n, n))
            else:
                for (s1, n1), (s2, n2) in zip(clean, clean[1:] + [(clean[0][0] + nseg[i], clean[0][1])]):
                    pieces.append((s1, s2, n1, n2))
        else:
            for (s1, n1), (s2, n2) in zip(clean, clean[1:]):
                pieces.append((s1, s2, n1, n2))
        for s1, s2, n1, n2 in pieces:
            ks = [k for k in range(int(math.floor(s1)) + 1, int(math.ceil(s2)))]
            inner = [S[i][k % len(S[i])] for k in ks] if C[i] else [S[i][k] for k in ks if 0 <= k < len(S[i])]
            pts = np.array([NP[n1]] + inner + [NP[n2]])
            L = arclen(pts)[-1]
            if L < 0.5 * step:
                continue
            net.edges.append({'a': n1, 'b': n2, 'pts': pts, 'len': L, 'centre': i in centre_set})

    _dedupe_edges(net, step)
    _prune(net)
    return net


def _dedupe_edges(net, step):
    keep = []
    for e in net.edges:
        dup = False
        for f in keep:
            if {e['a'], e['b']} == {f['a'], f['b']} and abs(e['len'] - f['len']) < step:
                m1 = e['pts'][len(e['pts']) // 2]
                m2 = f['pts'][len(f['pts']) // 2]
                if np.linalg.norm(m1 - m2) < 1.5 * step:
                    dup = True
                    f['centre'] = f['centre'] or e['centre']
                    break
        if not dup:
            keep.append(e)
    net.edges = keep


def _prune(net):
    """Drop edges hanging off a node that has nothing else (stroke tails past a crossing)."""
    while True:
        deg = defaultdict(int)
        for e in net.edges:
            deg[e['a']] += 1
            deg[e['b']] += 1
        keep = [e for e in net.edges if deg[e['a']] > 1 and deg[e['b']] > 1]
        if len(keep) == len(net.edges):
            break
        net.edges = keep


# ---------------- faces ----------------

def _frame(n):
    n = n / max(np.linalg.norm(n), 1e-12)
    a = np.array([1.0, 0, 0]) if abs(n[0]) < 0.9 else np.array([0, 1.0, 0])
    t1 = np.cross(n, a)
    t1 /= np.linalg.norm(t1)
    return t1, np.cross(n, t1), n


def half_pts(net, h):
    e = net.edges[h >> 1]
    return e['pts'] if h % 2 == 0 else e['pts'][::-1]


def origin(net, h):
    e = net.edges[h >> 1]
    return e['a'] if h % 2 == 0 else e['b']


def leave_dir(net, h, v, step):
    """Direction a half-edge leaves its origin, in the node's tangent plane."""
    P = half_pts(net, h)
    s = arclen(P)
    target = min(2.0 * step, 0.35 * s[-1])
    k = int(np.searchsorted(s, target))
    k = min(max(k, 1), len(P) - 1)
    d = P[k] - P[0]
    n = net.normals[v]
    d = d - n * (d @ n) / max(n @ n, 1e-12)
    return d / max(np.linalg.norm(d), 1e-12)


def smooth_node_normals(net, project, step):
    """A node's normal, averaged over the surface a little way along each of its edges, so a
    node in a crease (under the chin, in the armpit) still orders its edges sensibly."""
    samples = defaultdict(list)
    for h in range(2 * len(net.edges)):
        P = half_pts(net, h)
        s = arclen(P)
        k = min(max(int(np.searchsorted(s, 1.5 * step)), 1), len(P) - 1)
        samples[origin(net, h)].append(P[k])
    for v, pts in samples.items():
        _, N = project(np.array(pts))
        n = N.sum(0) + np.asarray(net.normals[v])
        net.normals[v] = n / max(np.linalg.norm(n), 1e-12)


def trace_faces(net, step):
    nh = 2 * len(net.edges)
    out = defaultdict(list)
    ang = {}
    for h in range(nh):
        v = origin(net, h)
        t1, t2, _ = _frame(net.normals[v])
        d = leave_dir(net, h, v, step)
        ang[h] = math.atan2(d @ t2, d @ t1)
        out[v].append(h)
    for v in out:
        out[v].sort(key=lambda h: ang[h])
    pos = {h: out[origin(net, h)].index(h) for h in range(nh)}

    def nxt(h):
        tw = h ^ 1
        L = out[origin(net, tw)]
        return L[(pos[tw] - 1) % len(L)]

    seen = [False] * nh
    faces = []
    for h0 in range(nh):
        if seen[h0]:
            continue
        cyc, h = [], h0
        while not seen[h] and len(cyc) <= nh:
            seen[h] = True
            cyc.append(h)
            h = nxt(h)
        faces.append(cyc)
    return faces, ang


def face_info(net, cyc, step, corner_max=150.0):
    """Corners, orientation and size of a traced face."""
    corners = []
    for k, h in enumerate(cyc):
        hin = cyc[k - 1]
        v = origin(net, h)
        t1, t2, _ = _frame(net.normals[v])
        dout = leave_dir(net, h, v, step)
        dback = leave_dir(net, hin ^ 1, v, step)
        a_out = math.atan2(dout @ t2, dout @ t1)
        a_back = math.atan2(dback @ t2, dback @ t1)
        theta = math.degrees((a_back - a_out) % (2 * math.pi))
        corners.append((theta < corner_max, theta))
    P = np.vstack([half_pts(net, h)[:-1] for h in cyc])
    A = 0.5 * np.cross(P, np.roll(P, -1, axis=0)).sum(0)
    nrm = np.mean([net.normals[origin(net, h)] for h in cyc], axis=0)
    length = sum(net.edges[h >> 1]['len'] for h in cyc)
    return {'corners': corners, 'area_sign': float(A @ nrm), 'area': float(np.linalg.norm(A)), 'len': length, 'pts': P}


# ---------------- patterns ----------------

def _solve_spokes(l):
    """l_i = s_{i-1} + s_{i+1}; integer s >= 1 or None."""
    N = len(l)
    if N == 3:
        s = [(l[1] + l[2] - l[0]), (l[0] + l[2] - l[1]), (l[0] + l[1] - l[2])]
        if any(x % 2 for x in s):
            return None
        s = [x // 2 for x in s]
        # s0 opposite l0: l0 = s2 + s1 -> fits the i-1/i+1 rule
        return s if min(s) >= 1 else None
    if N == 5:
        M = np.zeros((5, 5))
        for i in range(5):
            M[i, (i - 1) % 5] = 1
            M[i, (i + 1) % 5] = 1
        s = np.linalg.solve(M, np.array(l, float))
        r = np.round(s)
        if np.abs(s - r).max() > 1e-6 or r.min() < 1:
            return None
        return [int(x) for x in r]
    if N == 6:
        s = [0] * 6
        for off in (0, 1):
            a, b, c = l[off], l[off + 2], l[off + 4]
            # l[off] = s[off-1] + s[off+1], l[off+2] = s[off+1] + s[off+3], l[off+4] = s[off+3] + s[off+5]
            x1 = a + b - c
            x3 = b + c - a
            x5 = a + c - b
            if x1 % 2 or x3 % 2 or x5 % 2:
                return None
            s[(off + 1) % 6], s[(off + 3) % 6], s[(off + 5) % 6] = x1 // 2, x3 // 2, x5 // 2
        return s if min(s) >= 1 else None
    return None


def fit_pattern(C, L):
    """C: sorted corner slots, L: border length. Returns (kind, C, data, irregular) or None."""
    N = len(C)
    if N < 3 or N > 6:
        return None
    l = [((C[(i + 1) % N] - C[i]) % L) or L for i in range(N)]
    if N == 4:
        if l[0] == l[2] and l[1] == l[3]:
            return ('grid', C, l, 0)
        return None
    s = _solve_spokes(l)
    if s is None:
        return None
    return ('star', C, s, 1 if N in (3, 5) else 2)


def best_patterns(real, L, bend=None, limit=4000, soft=None):
    """Search corner sets near the drawn corners. real: corner slots; soft: the same slots
    ordered softest bend first (dropped first when a patch has more than six corners).
    Returns (cost, [patterns])."""
    real = sorted(set(real))
    base_why, base_cost = (), 0
    if len(real) > 6:
        order = [c for c in (soft or real) if c in real]
        gone = order[:len(real) - 6]
        real = [c for c in real if c not in gone]
        base_why = tuple(('drop', g) for g in gone)
        base_cost = len(gone)
    cands = []

    def consider(C, extra, why):
        p = fit_pattern(sorted(C), L)
        if p:
            cands.append((p[3] + extra + base_cost, base_why + tuple(why), p))

    consider(real, 0, ())
    if len(real) >= 4:
        for r in real:
            consider([c for c in real if c != r], 1, (('drop', r),))
    free = [s for s in range(L) if s not in real]
    if len(real) >= 2:
        for s in free:
            consider(real + [s], 1, (('add', s),))
    if not cands or min(c[0] for c in cands) > 1:
        if len(real) >= 4:
            for r in real:
                rest = [c for c in real if c != r]
                for s in free:
                    consider(rest + [s], 2, (('drop', r), ('add', s)))
        if len(real) <= 3:
            n = 0
            for a in range(len(free)):
                for b in range(a + 1, len(free)):
                    consider(real + [free[a], free[b]], 2, (('add', free[a]), ('add', free[b])))
                    n += 1
                    if n > limit:
                        break
                if n > limit:
                    break
        if len(real) <= 1:
            base = real[0] if real else 0
            for a in range(1, L // 2):
                C = [base, base + a, base + L // 2, base + L // 2 + a]
                if L % 2 == 0:
                    consider([c % L for c in C], 4 - len(real), (('ring', a),))
    if not cands:
        return None, []
    best = min(c[0] for c in cands)
    return best, [c for c in cands if c[0] == best]


# ---------------- counts ----------------

class Layout:
    def __init__(self, net, faces, fill, step, target):
        self.net, self.faces, self.fill, self.step, self.target = net, faces, fill, step, target


def solve_counts(net, faces, fillable, target_len, iters=40):
    """faces: list of dict(cyc, corner_flags). Returns per-edge counts and per-face pattern cost."""
    E = len(net.edges)
    t = np.array([max(e['len'] / target_len, 0.5) for e in net.edges])
    uf = UF()
    for e in range(E):
        uf.find(e)

    def sides(f):
        cyc, cf = f['cyc'], f['cflags']
        ks = [k for k, c in enumerate(cf) if c]
        if not ks:
            return None
        out = []
        for a, b in zip(ks, ks[1:] + [ks[0] + len(cyc)]):
            out.append([cyc[k % len(cyc)] >> 1 for k in range(a, b)])
        return out

    for fi in fillable:
        sd = sides(faces[fi])
        if sd and len(sd) == 4 and all(len(x) == 1 for x in sd):
            uf.union(sd[0][0], sd[2][0])
            uf.union(sd[1][0], sd[3][0])
    chain = [uf.find(e) for e in range(E)]
    members = defaultdict(list)
    for e, c in enumerate(chain):
        members[c].append(e)
    val = {c: max(1, int(round(float(np.mean(t[m]))))) for c, m in members.items()}

    def counts():
        return np.array([val[chain[e]] for e in range(E)])

    # which chains touch which faces an odd number of times
    mult = [defaultdict(int) for _ in faces]
    for fi, f in enumerate(faces):
        for h in f['cyc']:
            mult[fi][chain[h >> 1]] += 1
    fill_set = set(fillable)
    odd_faces = defaultdict(list)
    for fi, m in enumerate(mult):
        for c, k in m.items():
            if k % 2:
                odd_faces[c].append(fi)

    def parity(fi, n):
        return sum(n[h >> 1] for h in faces[fi]['cyc']) % 2

    def flip(c):
        m = float(np.mean(t[members[c]]))
        v = val[c]
        if v <= 1:
            val[c] = 2
        else:
            val[c] = v + 1 if (v + 1 - m) ** 2 < (v - 1 - m) ** 2 else v - 1

    SINK = -1
    for _ in range(4 * len(faces) + 10):
        n = counts()
        odd = [fi for fi in fillable if parity(fi, n)]
        if not odd:
            break
        start = odd[0]
        oddset = set(odd)
        prev = {start: None}
        dq = deque([start])
        goal = None
        while dq:
            f = dq.popleft()
            if f != start and (f in oddset or f == SINK):
                goal = f
                break
            if f == SINK:
                continue
            for c in mult[f]:
                if mult[f][c] % 2 == 0:
                    continue
                for g in odd_faces[c]:
                    g2 = g if g in fill_set else SINK
                    if g2 not in prev:
                        prev[g2] = (f, c)
                        dq.append(g2)
                if sum(1 for g in odd_faces[c] if g in fill_set) % 2 == 1 and SINK not in prev:
                    prev[SINK] = (f, c)
                    dq.append(SINK)
        if goal is None:
            faces[start]['bad'] = 'odd number of segments round it and no neighbour to trade with'
            fill_set.discard(start)
            fillable = [f for f in fillable if f != start]
            continue
        g = goal
        while prev[g] is not None:
            f, c = prev[g]
            flip(c)
            g = f

    # local search: +-2 per chain keeps every parity
    cache = {}

    def face_cost(fi, n):
        f = faces[fi]
        key = (fi, tuple(n[h >> 1] for h in f['cyc']))
        if key in cache:
            return cache[key]
        slots, real, ang = 0, [], {}
        for k, h in enumerate(f['cyc']):
            if f['cflags'][k]:
                real.append(slots)
                ang[slots] = f['angles'][k]
            slots += n[h >> 1]
        soft = sorted(real, key=lambda c: -ang[c])
        cost, _ = best_patterns(real, slots, limit=600, soft=soft)
        r = 50.0 if cost is None else float(cost)
        cache[key] = r
        return r

    faces_of_chain = defaultdict(set)
    for fi in fillable:
        for h in faces[fi]['cyc']:
            faces_of_chain[chain[h >> 1]].add(fi)

    def chain_len_cost(c, v):
        return float(sum((v - t[e]) ** 2 / max(t[e], 1.0) for e in members[c])) * 0.25

    for _ in range(iters):
        changed = False
        for c in list(members):
            n = counts()
            fs = faces_of_chain[c]
            base = chain_len_cost(c, val[c]) + sum(face_cost(fi, n) for fi in fs)
            best = (base, 0)
            for dv in (-2, 2, -4, 4):
                v2 = val[c] + dv
                if v2 < 1:
                    continue
                old = val[c]
                val[c] = v2
                n2 = counts()
                cst = chain_len_cost(c, v2) + sum(face_cost(fi, n2) for fi in fs)
                val[c] = old
                if cst < best[0] - 1e-9:
                    best = (cst, dv)
            if best[1]:
                val[c] += best[1]
                changed = True
        if not changed:
            break
    return counts(), fillable


# ---------------- fill ----------------

def coons(B, T, Lc, Rc):
    """B[u], T[u] (u=0..a), Lc[v], Rc[v] (v=0..b) -> interior points [(u, v, p)]."""
    a, b = len(B) - 1, len(Lc) - 1
    out = []
    for u in range(1, a):
        su = u / a
        for v in range(1, b):
            sv = v / b
            p = ((1 - sv) * B[u] + sv * T[u] + (1 - su) * Lc[v] + su * Rc[v]
                 - ((1 - su) * (1 - sv) * B[0] + su * (1 - sv) * B[a] + (1 - su) * sv * T[0] + su * sv * T[a]))
            out.append((u, v, p))
    return out


def retopo(strokes, project, target_len=0.03, mirror=False, centre=None, corner_max=150.0, relax=30):
    """strokes: list of (Nx3, closed) on the surface. centre: optional list of centre-line
    polylines (used with mirror). Returns dict(V, F, report)."""
    step = target_len / 3.0
    prepared = prepare_strokes(strokes, project, step, mirror)
    centre_ids = []
    if mirror and centre:
        for P, closed in centre:
            R = resample(np.asarray(P, float), step, closed)
            R, _ = project(R)
            R[:, 0] = 0.0
            centre_ids.append(len(prepared))
            prepared.append((R, closed))
    net = build_network(prepared, project, step, mirror, centre_ids=centre_ids)
    report = {'strokes': len(prepared), 'nodes': len(net.nodes), 'edges': len(net.edges)}
    if not net.edges:
        report['error'] = 'no closed regions: strokes must cross or end on each other'
        return {'V': np.zeros((0, 3)), 'F': [], 'report': report}

    smooth_node_normals(net, project, step)
    cycles, _ = trace_faces(net, step)
    total_len = sum(e['len'] for e in net.edges)
    faces, fillable, skipped = [], [], []
    for cyc in cycles:
        info = face_info(net, cyc, step, corner_max)
        f = {'cyc': cyc, 'cflags': [c for c, _ in info['corners']], 'angles': [a for _, a in info['corners']], 'info': info}
        fi = len(faces)
        faces.append(f)
        why = None
        if all(net.edges[h >> 1]['centre'] for h in cyc):
            why = 'the centre line only'
        elif mirror:
            # which side is the face on: step to the left of its longest edge
            h = max(cyc, key=lambda q: net.edges[q >> 1]['len'])
            P = half_pts(net, h)
            k = len(P) // 2
            d = P[min(k + 1, len(P) - 1)] - P[max(k - 1, 0)]
            nv = project(P[k:k + 1])[1][0]
            left = np.cross(nv, d)
            q = P[k] + left / max(np.linalg.norm(left), 1e-12) * step
            if q[0] < -0.25 * step:
                why = 'the mirrored half'
        if why:
            skipped.append((fi, why))
        else:
            fillable.append(fi)
        if globals().get('_debug') and why == 'the mirrored half':
            for h in cyc:
                e = net.edges[h >> 1]
                if not e['centre']:
                    print('   leak edge', h >> 1, 'from', np.round(net.nodes[e['a']], 3), 'to', np.round(net.nodes[e['b']], 3), 'len %.3f' % e['len'])
        if globals().get('_debug'):
            c = info['pts'].mean(0)
            print('face %3d  corners %d/%d  sign %+.4f len %.2f  at (%.2f %.2f %.2f)  %s' % (fi, sum(f['cflags']), len(cyc), info['area_sign'], info['len'], c[0], c[1], c[2], why or 'fill'))

    # Strokes not joined to the main network: their outer border is a hole in some other
    # patch, not a patch of its own (filling it would duplicate the inside the other way round).
    comp = UF()
    for e in net.edges:
        comp.union(e['a'], e['b'])
    size = defaultdict(float)
    for e in net.edges:
        size[comp.find(e['a'])] += e['len']
    main = max(size, key=size.get)
    islands = defaultdict(list)
    for fi in fillable:
        c = comp.find(net.edges[faces[fi]['cyc'][0] >> 1]['a'])
        if c != main:
            islands[c].append(fi)
    for c, fs in islands.items():
        outer = min(fs, key=lambda q: faces[q]['info']['area_sign'])
        fillable.remove(outer)
        p0 = faces[outer]['info']['pts'].mean(0)
        skipped.append((outer, 'strokes near (%.2f, %.2f, %.2f) touch no other stroke' % tuple(p0)))

    # Every traced region is a real piece of the surface. When the strokes cover only part of
    # it, one region is the leftover rest: the longest border, running the wrong way round.
    if fillable:
        big = max(fillable, key=lambda q: faces[q]['info']['len'])
        fb = faces[big]['info']
        if fb['len'] > 0.4 * total_len or (fb['area_sign'] < 0 and fb['len'] >= 2 * np.median([faces[q]['info']['len'] for q in fillable])):
            fillable.remove(big)
            skipped.append((big, 'the rest of the surface (not closed off by strokes)'))
    for fi in list(fillable):
        nc = sum(faces[fi]['cflags'])
        if nc > 12:
            fillable.remove(fi)
            skipped.append((fi, 'a patch with %d corners: draw a line across it' % nc))

    n, fillable = solve_counts(net, faces, fillable, target_len)
    for fi, f in enumerate(faces):
        if f.get('bad'):
            skipped.append((fi, f['bad']))

    # vertices: nodes, then edge interiors
    V = [np.array(p) for p in net.nodes]
    fixed = set(range(len(V)))
    centre_v = set()
    edge_ids = []
    for ei, e in enumerate(net.edges):
        P = resample_n(e['pts'], int(n[ei]))
        ids = [e['a']]
        for p in P[1:-1]:
            ids.append(len(V))
            V.append(p)
            fixed.add(ids[-1])
        ids.append(e['b'])
        edge_ids.append(ids)
        if e['centre']:
            centre_v.update(ids)
    F = []
    stats = {'grid': 0, 'star': 0, 'added corners': 0, 'dropped corners': 0}
    face_patch = []
    used_corners = set()          # border vertices already made a corner by a neighbouring patch
    patch_ranges = []             # first face of each filled patch
    for fi in fillable:
        f = faces[fi]
        slots, real, ang = [], [], {}
        for k, h in enumerate(f['cyc']):
            ids = edge_ids[h >> 1] if h % 2 == 0 else edge_ids[h >> 1][::-1]
            if f['cflags'][k]:
                real.append(len(slots))
                ang[len(slots)] = f['angles'][k]
            slots.extend(ids[:-1])
        L = len(slots)
        pos = np.array([V[i] for i in slots])
        bend = np.zeros(L)
        for s in range(L):
            d1 = pos[s] - pos[s - 1]
            d2 = pos[(s + 1) % L] - pos[s]
            c = d1 @ d2 / max(np.linalg.norm(d1) * np.linalg.norm(d2), 1e-12)
            bend[s] = math.degrees(math.acos(min(max(c, -1.0), 1.0)))
        cost, pats = best_patterns(real, L, soft=sorted(real, key=lambda c: -ang[c]))
        if not pats:
            skipped.append((fi, 'no quad layout fits side counts ' + str(_side_counts(real, L)) + ': move a stroke or change the density'))
            continue

        def rank(c):
            _, why, p = c
            r = 0.0
            for w in why:
                if w[0] == 'add':
                    r += (180.0 - bend[w[1]]) / 180.0          # prefer bends
                    if slots[w[1]] in used_corners:
                        r += 20.0                              # both sides cornered: a 2-edge point
                elif w[0] == 'drop':
                    r += bend[w[1]] / 90.0                       # prefer soft corners
            C = p[1]
            N = len(C)
            ls = [((C[(i + 1) % N] - C[i]) % L) or L for i in range(N)]
            geo = [np.linalg.norm(V[slots[C[(i + 1) % N]]] - V[slots[C[i]]]) for i in range(N)]
            dens = [g / max(l_, 1) for g, l_ in zip(geo, ls)]
            r += 0.5 * (max(dens) / max(min(dens), 1e-9) - 1.0)
            return r

        # try the best-ranked layouts; keep the first whose quads do not fold over
        order = sorted(pats, key=rank)[:6]
        best = None
        for attempt, cand in enumerate(order + [None]):
            if cand is None:
                if best is None:
                    break
                cand = best[1]
            nV0, nF0 = len(V), len(F)
            _, why, pat = cand
            kind, C, data, _ = pat
            _build_patch(kind, C, data, slots, L, V, F)
            if attempt == len(order):
                break
            Q = np.asarray(F[nF0:])
            Vn = np.asarray(V)
            n4 = np.cross(Vn[Q[:, 2]] - Vn[Q[:, 0]], Vn[Q[:, 3]] - Vn[Q[:, 1]])
            _, sn = project(Vn[Q].mean(1))
            d = np.einsum('ij,ij->i', n4, sn)
            folds = int(min((d < 0).sum(), (d > 0).sum()))
            if folds == 0:
                break
            if best is None or folds < best[0]:
                best = (folds, cand)
            del V[nV0:]
            del F[nF0:]
        else:
            pass
        if len(F) == nF0:
            skipped.append((fi, 'no layout without folds'))
            continue
        if best is not None and attempt == len(order):
            stats['folded quads'] = stats.get('folded quads', 0) + best[0]
        patch_ranges.append(nF0)
        face_patch.append(fi)
        stats['grid' if kind == 'grid' else 'star'] += 1
        for c in C:
            used_corners.add(slots[c % L])
        for w in why:
            if w[0] == 'add':
                stats['added corners'] += 1
            elif w[0] == 'drop':
                stats['dropped corners'] += 1

    V = np.array(V)
    if len(F):
        # a patch traced the wrong way round (a flipped normal at one of its corners) faces
        # inward: compare with the surface and turn it round
        Fa = np.asarray(F)
        C4 = V[Fa].mean(1)
        n4 = np.cross(V[Fa[:, 2]] - V[Fa[:, 0]], V[Fa[:, 3]] - V[Fa[:, 1]])
        _, sn = project(C4)
        dots = np.einsum('ij,ij->i', n4, sn)
        bounds = patch_ranges + [len(F)]
        flipped = 0
        for a, b in zip(bounds[:-1], bounds[1:]):
            if globals().get('_debug') and b > a and (dots[a:b] < 0).mean() > 0.2:
                print('patch faces %d-%d inward %.0f%% centre %s' % (a, b, 100 * (dots[a:b] < 0).mean(), C4[a:b].mean(0).round(2)))
            if b > a and dots[a:b].sum() < 0:
                for k in range(a, b):
                    F[k] = F[k][::-1]
                flipped += 1
        stats['patches turned round'] = flipped
        used = np.zeros(len(V), bool)
        used[np.asarray(F).ravel()] = True
        remap = -np.ones(len(V), int)
        remap[used] = np.arange(used.sum())
        V = V[used]
        F = [tuple(remap[list(q)]) for q in F]
        fixed = {int(remap[i]) for i in fixed if used[i]}
        centre_v = {int(remap[i]) for i in centre_v if used[i]}
        V = _relax(V, F, fixed, project, relax)
    if mirror:
        for i in centre_v:
            V[i, 0] = 0.0
    if len(F):
        Fa = np.asarray(F)
        n4 = np.cross(V[Fa[:, 2]] - V[Fa[:, 0]], V[Fa[:, 3]] - V[Fa[:, 1]])
        _, sn = project(V[Fa].mean(1))
        stats['folded quads'] = int((np.einsum('ij,ij->i', n4, sn) < 0).sum())
    report.update(stats)
    report['patches'] = len(fillable)
    report['filled'] = len(face_patch)
    report['skipped'] = [why for _, why in skipped if why not in ('the mirrored half', 'the centre line only')]
    report['quads'] = len(F)
    report['irregular'] = _irregular(F, len(V))
    return {'V': V, 'F': F, 'report': report, 'net': net, 'counts': n}


def _build_patch(kind, C, data, slots, L, V, F):
    sl = lambda k: slots[k % L]
    if kind == 'grid':
        a, b = data[0], data[1]
        c0, c1, c2, c3 = C
        G = [[None] * (b + 1) for _ in range(a + 1)]
        for u in range(a + 1):
            G[u][0] = sl(c0 + u)
            G[u][b] = sl(c2 + (a - u))
        for v in range(b + 1):
            G[a][v] = sl(c1 + v)
            G[0][v] = sl(c3 + (b - v))
        _fill_grid(G, V, F)
        return
    s = data
    N = len(C)
    split = [C[i] + s[(i - 1) % N] for i in range(N)]
    ctr_p = np.mean([V[sl(x)] for x in split], axis=0)
    ctr = len(V)
    V.append(ctr_p)
    spokes = []
    for i in range(N):
        q = V[sl(split[i])]
        ids = [ctr]
        for k in range(1, s[i]):
            ids.append(len(V))
            V.append(ctr_p + (q - ctr_p) * (k / s[i]))
        ids.append(sl(split[i]))
        spokes.append(ids)
    for i in range(N):
        a, b = s[(i + 1) % N], s[i]
        G = [[None] * (b + 1) for _ in range(a + 1)]
        for u in range(a + 1):
            G[u][0] = sl(split[i] + u)
            G[u][b] = spokes[(i + 1) % N][u]
        for v in range(b + 1):
            G[a][v] = sl(C[(i + 1) % N] + v)
            G[0][v] = spokes[i][b - v]
        _fill_grid(G, V, F)


def _side_counts(real, L):
    if not real:
        return [L]
    return [((real[(i + 1) % len(real)] - real[i]) % L) or L for i in range(len(real))]


def _fill_grid(G, V, F):
    a, b = len(G) - 1, len(G[0]) - 1
    B = [V[G[u][0]] for u in range(a + 1)]
    T = [V[G[u][b]] for u in range(a + 1)]
    Lc = [V[G[0][v]] for v in range(b + 1)]
    Rc = [V[G[a][v]] for v in range(b + 1)]
    for u, v, p in coons(B, T, Lc, Rc):
        G[u][v] = len(V)
        V.append(p)
    for u in range(a):
        for v in range(b):
            F.append((G[u][v], G[u + 1][v], G[u + 1][v + 1], G[u][v + 1]))


def _relax(V, F, fixed, project, iters):
    F = np.asarray(F)
    nV = len(V)
    free = np.ones(nV, bool)
    free[list(fixed)] = False
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 3]], F[:, [3, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    deg = np.bincount(e.ravel(), minlength=nV).astype(float)
    V = V.copy()
    V[free], _ = project(V[free])
    for _ in range(iters):
        acc = np.zeros_like(V)
        np.add.at(acc, e[:, 0], V[e[:, 1]])
        np.add.at(acc, e[:, 1], V[e[:, 0]])
        avg = acc / np.maximum(deg, 1)[:, None]
        V[free] = V[free] + 0.6 * (avg[free] - V[free])
        V[free], _ = project(V[free])
    return V


def _irregular(F, nV):
    if not len(F):
        return {}
    F = np.asarray(F)
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 3]], F[:, [3, 0]]])
    es = np.sort(e, axis=1)
    uniq, cnt = np.unique(es, axis=0, return_counts=True)
    boundary = set(uniq[cnt == 1].ravel().tolist())
    deg = np.bincount(uniq.ravel(), minlength=nV)
    out = defaultdict(int)
    for v in range(nV):
        if deg[v] and v not in boundary and deg[v] != 4:
            out[int(deg[v])] += 1
    return dict(out)
