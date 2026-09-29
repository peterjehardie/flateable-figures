// Fingers and toes for the detail pass: each digit of the mesh is matched to its own shape in a
// drawing and laid out along it (length, direction, width at each point), with a rounded
// thickness across that drawing's plane. Fingers: the hands are palm forward, drawn in the front
// view (x, y); their part of the front outline is the stretch beyond the wrists, and the thickness
// (z) is the hand's default profile. Toes: the feet in the top view (x, z), resting on the floor
// with the side view's height. During the body pass the digits are built from generic proportions
// and only fenced in by those drawings, so they stay slabs.
// A hand or foot drawn in one line is split into its digits at the notches between them; digits
// drawn as shapes of their own are taken whole.

import { maskContours } from './mask.js';

const DIGIT = /^(index|middle|ring|little|thumb|toe \d)[ .]/;
// place of a digit in its hand or foot: thumb to little finger, big toe to little toe
const RANK = { thumb: 0, index: 1, middle: 2, ring: 3, little: 4 };
const rankOf = (key) => (key.startsWith('toe') ? +key[4] - 1 : RANK[key.split(' ')[0]]);

// closed polyline at even spacing
function resample(loop, step) {
  const out = [], n = loop.length;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (; t < L; t += step) out.push([a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L]);
    t -= L;
  }
  return out;
}

// convex hull (monotone chain) as indices into pts
function hull(pts) {
  const s = pts.map((_, i) => i).sort((i, j) => pts[i][0] - pts[j][0] || pts[i][1] - pts[j][1]);
  const cr = (o, a, b) => (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const lo = [], up = [];
  for (const i of s) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], i) <= 0) lo.pop(); lo.push(i); }
  for (let k = s.length - 1; k >= 0; k--) { const i = s[k]; while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], i) <= 0) up.pop(); up.push(i); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// Notches of a closed outline (the valleys between digits): the deepest point of each pocket
// between the outline and its convex hull, searched again inside each pocket (a digit tip that
// falls short of the hull leaves two notches in one pocket). A notch is deep for the width of its
// pocket's mouth; wide shallow bays (the arch, the thenar) are not notches.
function notches(P, H) {
  const n = P.length, at = (i) => P[((i % n) + n) % n], found = [];
  const search = (i0, i1, closed) => {
    const idx = [];
    for (let i = i0; i <= i1; i++) idx.push(i);
    const h = hull(idx.map(at)).map((k) => idx[k]).sort((a, b) => a - b);
    const mouths = [];
    for (let k = 0; k + 1 < h.length; k++) mouths.push([h[k], h[k + 1]]);
    if (closed && h.length) mouths.push([h[h.length - 1], h[0] + n]);
    for (const [a, b] of mouths) {
      if (b - a < 3) continue;
      const A = at(a), B = at(b), dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz) || 1e-9;
      let best = -1, bd = 0;
      for (let i = a + 1; i < b; i++) { const p = at(i), d = Math.abs((p[0] - A[0]) * dz - (p[1] - A[1]) * dx) / L; if (d > bd) { bd = d; best = i; } }
      if (bd < 0.004 * H) continue;
      if (bd > 0.2 * L) found.push({ i: ((best % n) + n) % n, depth: bd });
      search(a, best, false);
      search(best, b, false);
    }
  };
  search(0, n - 1, true);
  // Digits that stop short of their neighbours' line hide their notches from the hulls (the
  // notch on the far side of a deeper one lies on the pocket's own hull). Those still show as
  // slots: from the bottom of a notch the line runs out on both sides close together, with the
  // outside between.
  const s = Math.max(2, Math.round((0.004 * H) / Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1])));
  const pinch = (i) => { const a = at(i - s), b = at(i + s); return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const arc = 2 * s * Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
  for (let i = 0; i < n; i++) {
    const w = pinch(i);
    if (w > 0.4 * arc || found.some((f) => Math.abs(((f.i - i + n / 2 + n) % n) - n / 2) < 3 * s)) continue;
    let low = true;
    for (let k = -s; k <= s && low; k++) if (k && pinch(i + k) < w) low = false;
    const a = at(i - s), b = at(i + s);
    if (low && !inside(P, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) found.push({ i, depth: 0 });
  }
  // rank by how far in from the outline's hull each notch lies
  const h = hull(P).map((k) => P[k]);
  for (const f of found) {
    const p = P[f.i];
    let d = Infinity;
    for (let k = 0; k < h.length; k++) {
      const A = h[k], B = h[(k + 1) % h.length], dx = B[0] - A[0], dz = B[1] - A[1], L2 = dx * dx + dz * dz || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dz) / L2));
      d = Math.min(d, Math.hypot(p[0] - A[0] - dx * t, p[1] - A[1] - dz * t));
    }
    f.depth = d;
  }
  return found;
}

function inside(P, [x, z]) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

// A shape along its own axis (ux, uz) from (cx, cz): extent s0..s1, area.
function axisShape(pts, cx, cz, ux, uz, cut) {
  let s0 = Infinity, s1 = -Infinity, w0 = Infinity, w1 = -Infinity, A = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i], [x1, z1] = pts[(i + 1) % pts.length];
    A += x * z1 - x1 * z;
    const s = (x - cx) * ux + (z - cz) * uz, w = -(x - cx) * uz + (z - cz) * ux;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
  }
  return { pts, cx, cz, ux, uz, s0, s1, area: Math.abs(A) / 2, elong: (s1 - s0) / Math.max(1e-6, w1 - w0), cut };
}

// A digit drawn as a closed shape of its own: its long axis is the principal direction.
function pcaShape(pts) {
  let cx = 0, cz = 0;
  for (const [x, z] of pts) { cx += x; cz += z; }
  cx /= pts.length; cz /= pts.length;
  let sxx = 0, szz = 0, sxz = 0;
  for (const [x, z] of pts) { sxx += (x - cx) ** 2; szz += (z - cz) ** 2; sxz += (x - cx) * (z - cz); }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  return axisShape(pts, cx, cz, Math.cos(ang), Math.sin(ang), false);
}

// Split one outline (a hand or a foot drawn in one line) into up to k digits, in order along it.
// Between two notches lies a digit. The longest stretch between notches is the rest of the hand
// or foot; the digits at either end of it (thumb and little finger, big and little toe) have a
// notch on one side only: going on round the tip, the line comes closest to that notch again
// right across from it. Each digit is cut off square to its axis at the shallower of its two
// sides and comes out oriented base -> tip.
function splitDigits(P, k, H) {
  const n = P.length, at = (i) => P[((i % n) + n) % n];
  const ns = notches(P, H).sort((a, b) => b.depth - a.depth).slice(0, k - 1).map((x) => x.i).sort((a, b) => a - b);
  const m = ns.length;
  if (!m) return null;
  let rest = 0, restLen = -1;
  for (let j = 0; j < m; j++) { const len = (ns[(j + 1) % m] - ns[j] + n) % n || n; if (len > restLen) { restLen = len; rest = j; } }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  // the digit on the stretch i0..i1 (unwrapped indices, the tip in between)
  const cut = (i0, i1) => {
    let M = [(at(i0)[0] + at(i1)[0]) / 2, (at(i0)[1] + at(i1)[1]) / 2], u = null, iA = i0, iB = i1;
    for (let it = 0; it < 4; it++) {
      // tip: farthest from the base's middle, then (once there is an axis) farthest along it
      let iT = i0, best = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const p = at(i), v = u ? (p[0] - M[0]) * u[0] + (p[1] - M[1]) * u[1] : dist(p, M);
        if (v > best) { best = v; iT = i; }
      }
      const T = at(iT), L = dist(T, M) || 1e-9;
      u = [(T[0] - M[0]) / L, (T[1] - M[1]) / L];
      const pr = (i) => (at(i)[0] - M[0]) * u[0] + (at(i)[1] - M[1]) * u[1];
      const sb = Math.max(pr(i0), pr(i1));
      for (iA = i0; iA < iT && pr(iA) < sb; iA++);
      for (iB = i1; iB > iT && pr(iB) < sb; iB--);
      M = [(at(iA)[0] + at(iB)[0]) / 2, (at(iA)[1] + at(iB)[1]) / 2];
    }
    const pts = [];
    for (let i = iA; i <= iB; i++) pts.push(at(i));
    return pts.length > 5 ? axisShape(pts, M[0], M[1], u[0], u[1], true) : null;
  };
  // an end digit: from its notch out round the tip, then back to the point nearest the notch
  const end = (iv, dir) => {
    const V = at(iv);
    let dmax = 0, dmin = Infinity, wS = -1;
    for (let s = 1; s < restLen / 2; s++) {
      const d = dist(at(iv + dir * s), V);
      if (wS < 0) {
        if (d > dmax) dmax = d;
        else if (d < 0.9 * dmax && dmax > 0.004 * H) { wS = s; dmin = d; }
      } else if (d < dmin) { dmin = d; wS = s; } else if (d > dmin + 0.1 * dmax) break;
    }
    if (wS < 0) return null;
    return dir > 0 ? cut(iv, iv + wS) : cut(iv - wS, iv);
  };
  const vA = ns[rest], vB = ns[(rest + 1) % m];
  const out = [end(vB, -1)];
  for (let j = 1; j < m; j++) { const a = ns[(rest + j) % m]; let b = ns[(rest + j + 1) % m]; if (b <= a) b += n; out.push(cut(a, b)); }
  out.push(end(vA, 1));
  return out.every(Boolean) ? out : null;
}

// Each digit lies in one drawing's plane: world axes [along 1, along 2, thickness]. The shapes
// below keep their plane coordinates as (x, z) in the names (cx, cz, ux, uz), whichever plane.
const PLANE = { top: [0, 2, 1], front: [0, 1, 2] };

export function buildDigits(doc, frame, measure, mesh) {
  const H = measure.H, W = measure.W, n = mesh.nV, pos = mesh.pos, Q = mesh.quads;
  // outlines, world coordinates in their plane: the edge of each mask, whatever strokes drew it.
  // Top view (x, z): the feet. Front view (x, y): the hands, the stretch of the front outline
  // beyond each wrist (closed across the wrist).
  const outlines = [];
  if (measure.topMask) for (const l of maskContours(measure.topMask)) outlines.push({ plane: 'top', P: resample(l.map(([xd, yd]) => frame.tw(xd, yd)), 0.001 * H) });
  if (measure.frontMask) for (const l of maskContours(measure.frontMask)) {
    const P = l.map(([xd, yd]) => frame.fw(xd, yd)), m = P.length;
    for (const sign of [1, -1]) {
      const out = (i) => sign * P[i][0] > W.wristX, i0 = P.findIndex((_, i) => !out(i));
      if (i0 < 0) continue;
      let run = [], best = [];
      for (let k = 1; k <= m; k++) {
        const i = (i0 + k) % m;
        if (out(i)) run.push(P[i]);
        else { if (run.length > best.length) best = run; run = []; }
      }
      if (best.length) outlines.push({ plane: 'front', P: resample(best, 0.001 * H) });
    }
  }
  for (let i = outlines.length - 1; i >= 0; i--) if (outlines[i].P.length <= 12) outlines.splice(i, 1);
  if (!outlines.length) return null;
  // width of a shape across its axis at s (polygon cut by the perpendicular line)
  const widthAt = (sh, s) => {
    let lo = Infinity, hi = -Infinity;
    const P = sh.pts;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const sa = (a[0] - sh.cx) * sh.ux + (a[1] - sh.cz) * sh.uz, sb = (b[0] - sh.cx) * sh.ux + (b[1] - sh.cz) * sh.uz;
      if ((sa - s) * (sb - s) > 0 || sa === sb) continue;
      const t = (s - sa) / (sb - sa);
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const w = -(x - sh.cx) * sh.uz + (z - sh.cz) * sh.ux;
      lo = Math.min(lo, w); hi = Math.max(hi, w);
    }
    return hi > lo ? [lo, hi] : null;
  };

  // digits of the mesh: their loops in order, grouped by name and side
  const groups = new Map();
  for (const l of mesh.loops || []) {
    const m = DIGIT.exec(l.name);
    if (!m) continue;
    const side = l.name.slice(-1);
    const key = m[1] + ' ' + side;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const nbs = Array.from({ length: n }, () => []);
  for (let f = 0; f < Q.length / 4; f++) for (let i = 0; i < 4; i++) { const u = Q[4 * f + i], w = Q[4 * f + ((i + 1) % 4)]; nbs[u].push(w); nbs[w].push(u); }
  const cen = (verts) => { let x = 0, y = 0, z = 0; for (const v of verts) { x += pos[3 * v]; y += pos[3 * v + 1]; z += pos[3 * v + 2]; } return [x / verts.length, y / verts.length, z / verts.length]; };

  const digits = [];
  for (const [key, loops] of groups) {
    const num = (l) => +(/(\d+) [LR]$/.exec(l.name) || [0, 0])[1];
    loops.sort((a, b) => num(a) - num(b));
    const first = loops[0];
    // the digit: its first loop and everything beyond it. From the first loop, the side toward the
    // tip is a small piece of mesh; the other side is the whole body.
    const seen = new Uint8Array(n);
    for (const v of first.verts) seen[v] = 2;
    let distal = null;
    for (const v0 of first.verts) for (const s0 of nbs[v0]) {
      if (seen[s0]) continue;
      const got = [], stack = [s0];
      while (stack.length) {
        const v = stack.pop();
        if (seen[v]) continue;
        seen[v] = 1; got.push(v);
        for (const w of nbs[v]) if (!seen[w]) stack.push(w);
      }
      if (!distal || got.length < distal.length) distal = got;
    }
    if (distal && distal.length > 800) distal = null; // not a digit after all
    if (!distal) continue;
    const verts = [...first.verts, ...distal];
    const B = cen(first.verts), E = cen(distal);
    let d = [E[0] - B[0], E[1] - B[1], E[2] - B[2]];
    const dl = Math.hypot(...d) || 1; d = d.map((x) => x / dl);
    let sTip = 0;
    for (const v of verts) sTip = Math.max(sTip, (pos[3 * v] - B[0]) * d[0] + (pos[3 * v + 1] - B[1]) * d[1] + (pos[3 * v + 2] - B[2]) * d[2]);
    // where the tube ends and the rounded tip begins (the last loop)
    const lastC = cen(loops[loops.length - 1].verts);
    const sLast = (lastC[0] - B[0]) * d[0] + (lastC[1] - B[1]) * d[1] + (lastC[2] - B[2]) * d[2];
    const toe = key.startsWith('toe'), plane = toe ? 'top' : 'front', [a0, a1] = PLANE[plane];
    digits.push({ key, toe, plane, side: key.slice(-1), verts, first, loops, B, d, sTip, sLast, mid: [(B[a0] + E[a0]) / 2, (B[a1] + E[a1]) / 2] });
  }

  // each digit goes with the outline nearest its middle; an outline holding several digits is
  // split into as many, and they are matched in order (thumb first or last, whichever fits)
  const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
  const byOutline = outlines.map(() => []);
  for (const g of digits) {
    let bi = -1, bd = Infinity;
    outlines.forEach(({ plane, P }, i) => { if (plane === g.plane) for (let k = 0; k < P.length; k += 4) { const e = dist2(P[k], g.mid); if (e < bd) { bd = e; bi = i; } } });
    if (bi >= 0) byOutline[bi].push(g);
  }
  const pool = []; // shapes for the digits left over: split pieces and outlines that are a digit on their own
  const maxA = {};
  for (const { plane, P } of outlines) maxA[plane] = Math.max(maxA[plane] || 0, pcaShape(P).area);
  let split = 0;
  outlines.forEach(({ plane, P }, i) => {
    const gs = byOutline[i].sort((a, b) => rankOf(a.key) - rankOf(b.key));
    const parts = gs.length > 1 ? splitDigits(P, gs.length, H) : null;
    if (parts && parts.length === gs.length) {
      const ctr = (s) => [s.cx + s.ux * (s.s0 + s.s1) / 2, s.cz + s.uz * (s.s0 + s.s1) / 2];
      let fw = 0, bw = 0;
      gs.forEach((g, k) => { fw += Math.sqrt(dist2(g.mid, ctr(parts[k]))); bw += Math.sqrt(dist2(g.mid, ctr(parts[parts.length - 1 - k]))); });
      gs.forEach((g, k) => { g.shape = parts[fw <= bw ? k : parts.length - 1 - k]; });
      split += gs.length;
      return;
    }
    if (parts) pool.push(...parts.map((s) => ({ ...s, plane })));
    else { const s = pcaShape(P); if (s.area < 0.3 * maxA[plane] && s.elong > 1.4) pool.push({ ...s, plane }); }
  });
  // the rest: nearest first (in the digit's own drawing), each shape used once
  const pairs = [];
  for (const g of digits) if (!g.shape) for (const s of pool) if (s.plane === g.plane) pairs.push([Math.hypot(g.mid[0] - (s.cx + s.ux * (s.s0 + s.s1) / 2), g.mid[1] - (s.cz + s.uz * (s.s0 + s.s1) / 2)), g, s]);
  pairs.sort((a, b) => a[0] - b[0]);
  const usedS = new Set();
  for (const [dist, g, s] of pairs) {
    if (g.shape || usedS.has(s) || dist > 0.08 * H) continue;
    usedS.add(s); g.shape = s;
  }

  const target = new Float64Array(3 * n).fill(NaN);
  const list = [];
  let matched = 0;
  for (const g of digits) {
    const sh = g.shape;
    if (!sh) continue;
    matched++;
    const [a0x, a1x, nx] = PLANE[g.plane];
    // orient the drawn axis from base (the end nearer the digit's first loop) to tip; pieces cut
    // from an outline already are
    let ux = sh.ux, uz = sh.uz;
    const sB = (g.B[a0x] - sh.cx) * ux + (g.B[a1x] - sh.cz) * uz;
    if (!sh.cut && Math.abs(sB - sh.s1) < Math.abs(sB - sh.s0)) { ux = -ux; uz = -uz; }
    const sBase = ux === sh.ux ? sh.s0 : -sh.s1, sEnd = ux === sh.ux ? sh.s1 : -sh.s0; // in the oriented frame
    const L = sEnd - sBase;
    // the digit's first loop sits a little way along from the drawn base (a shape of its own
    // reaches back into the palm; a piece cut from the outline starts at the web)
    const a0 = sBase + (sh.cut ? -0.15 : 0.28) * L;
    // the cage's frame for the digit: axis d, across (in the drawing's plane, perpendicular), and
    // through (the thickness, out of that plane)
    const ew0 = [0, 0, 0];
    ew0[a0x] = -g.d[a1x]; ew0[a1x] = g.d[a0x];
    const el = Math.hypot(...ew0) || 1;
    const ew = ew0.map((x) => x / el);
    const et = [g.d[1] * ew[2] - g.d[2] * ew[1], g.d[2] * ew[0] - g.d[0] * ew[2], g.d[0] * ew[1] - g.d[1] * ew[0]];
    const up = et[nx] < 0 ? -1 : 1;
    // each loop's place along the digit, its centre and size in that frame: every point's offset is
    // measured from the centre and against the size of the loops either side of it (the cage tapers)
    const rings = g.loops.map((l) => {
      const c = cen(l.verts);
      let rw = 0, rt = 0;
      for (const v of l.verts) {
        const o = [pos[3 * v] - c[0], pos[3 * v + 1] - c[1], pos[3 * v + 2] - c[2]];
        rw = Math.max(rw, Math.abs(o[0] * ew[0] + o[1] * ew[1] + o[2] * ew[2]));
        rt = Math.max(rt, Math.abs(o[0] * et[0] + o[1] * et[1] + o[2] * et[2]));
      }
      return { s: (c[0] - g.B[0]) * g.d[0] + (c[1] - g.B[1]) * g.d[1] + (c[2] - g.B[2]) * g.d[2], c, rw: rw || 1e-3, rt: rt || 1e-3 };
    });
    const ringAt = (sc) => {
      if (sc <= rings[0].s) return rings[0];
      for (let k = 1; k < rings.length; k++) if (sc <= rings[k].s) {
        const A = rings[k - 1], Bq = rings[k], t = (sc - A.s) / (Bq.s - A.s || 1);
        return { c: A.c.map((x, i) => x + (Bq.c[i] - x) * t), rw: A.rw + (Bq.rw - A.rw) * t, rt: A.rt + (Bq.rt - A.rt) * t };
      }
      return rings[rings.length - 1];
    };
    const oriented = { ...sh, ux, uz, cx: sh.cx, cz: sh.cz };
    // the tip's rounding comes from the mesh's own end cap: sample the drawn width short of the
    // drawn end by about the digit's half width, or the tip is rounded twice and turns pointed
    const mid = widthAt(oriented, (a0 + sEnd) / 2);
    const rEnd = mid ? (mid[1] - mid[0]) / 2 : 0.01 * H;
    // the drawn width is read from a little past the base: fingers drawn with open gaps between
    // them start at the rounded bottom of a web, where the cut across the piece is too narrow
    const sW = sBase + (g.toe ? 0.01 : 0.1) * L;
    for (const v of g.verts) {
      const sc = Math.max(0, (pos[3 * v] - g.B[0]) * g.d[0] + (pos[3 * v + 1] - g.B[1]) * g.d[1] + (pos[3 * v + 2] - g.B[2]) * g.d[2]);
      const rg = ringAt(sc);
      const o = [pos[3 * v] - rg.c[0], pos[3 * v + 1] - rg.c[1], pos[3 * v + 2] - rg.c[2]];
      const ow = (o[0] * ew[0] + o[1] * ew[1] + o[2] * ew[2]) / rg.rw, ot = up * (o[0] * et[0] + o[1] * et[1] + o[2] * et[2]) / rg.rt;
      // along the drawn axis: the tube up to the last loop stretches to fill the drawn length; the tip keeps a round end of
      // the drawn half width
      const sCap = sEnd - rEnd;
      const s = sc <= g.sLast ? a0 + (g.sLast > 0 ? sc / g.sLast : 0) * (sCap - a0) : sCap + ((sc - g.sLast) / Math.max(1e-6, g.sTip - g.sLast)) * rEnd * 0.9;
      const cut = widthAt(oriented, Math.max(sW, Math.min(s, sEnd - rEnd))) || [-0.004 * H, 0.004 * H];
      const wc = (cut[0] + cut[1]) / 2, hw = Math.max(0.002 * H, (cut[1] - cut[0]) / 2 * 0.92);
      const p0 = sh.cx + s * ux - wc * uz, p1 = sh.cz + s * uz + wc * ux; // in the drawing's plane
      // thickness, and the centre across it: toes resting on the floor, with the side view's height;
      // fingers with the hand's thickness there, centred in it; the thumb at the depth the cage
      // gives it (it stands a little in front of the palm)
      let cn, ht;
      if (g.toe) {
        const col = measure.samplers.sideCol(p1).filter(([lo]) => lo < 0.06 * H);
        const hFoot = col.length ? col[0][1] : 0.02 * H;
        ht = Math.min(0.8 * hw, Math.max(0.003 * H, hFoot / 2));
        cn = ht + 0.001 * H;
      } else {
        const hand = measure.arm(g.side === 'L' ? 1 : -1, p0);
        ht = Math.min(0.85 * hw, Math.max(0.003 * H, hand.rz * 0.9));
        cn = g.key.startsWith('thumb') ? rg.c[nx] : hand.cz;
      }
      // across the drawn width; the offset keeps its direction (sign of across matches the cage's)
      const sg = Math.sign(ew[a0x] * -uz + ew[a1x] * ux || 1), across = [-uz * sg, ux * sg];
      const r = Math.hypot(ow, ot);
      const k = r > 1 ? 1 / r : 1; // points just outside the first loop's box: keep on the ellipse
      target[3 * v + a0x] = p0 + across[0] * ow * k * hw;
      target[3 * v + a1x] = p1 + across[1] * ow * k * hw;
      target[3 * v + nx] = cn + ot * k * ht;
      list.push(v);
    }
  }
  return { verts: Int32Array.from(list), target, digits: digits.length, matched, split };
}
