// Fingers and toes for the detail pass: each digit of the mesh is matched to its own shape in the
// top view and laid out along it (length, direction, width at each point), with a rounded
// thickness from the front view (fingers) or the side view (toes). During the body pass the digits
// are built from generic proportions and only fenced in by the top view, so they stay slabs.

const DIGIT = /^(index|middle|ring|little|thumb|toe \d)[ .]/;

export function buildDigits(doc, frame, measure, mesh) {
  if (!measure.hasTop) return null;
  const H = measure.H, n = mesh.nV, pos = mesh.pos, Q = mesh.quads;
  // top-view shapes, world (x, z)
  const shapes = [];
  for (const p of doc.paths) {
    if (p.view !== 'top' || p.role !== 'line' || !p.closed || p.pts.length < 4) continue;
    const pts = p.pts.map(([xd, yd]) => frame.tw(xd, yd));
    let cx = 0, cz = 0, A = 0;
    for (let i = 0; i < pts.length; i++) { const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length]; A += x0 * z1 - x1 * z0; cx += x0; cz += z0; }
    cx /= pts.length; cz /= pts.length;
    // long axis (principal direction)
    let sxx = 0, szz = 0, sxz = 0;
    for (const [x, z] of pts) { sxx += (x - cx) ** 2; szz += (z - cz) ** 2; sxz += (x - cx) * (z - cz); }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz), ux = Math.cos(ang), uz = Math.sin(ang);
    let s0 = Infinity, s1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const [x, z] of pts) { const s = (x - cx) * ux + (z - cz) * uz, w = -(x - cx) * uz + (z - cz) * ux; s0 = Math.min(s0, s); s1 = Math.max(s1, s); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
    shapes.push({ pts, cx, cz, ux, uz, s0, s1, area: Math.abs(A) / 2, elong: (s1 - s0) / Math.max(1e-6, w1 - w0) });
  }
  if (!shapes.length) return null;
  const maxA = Math.max(...shapes.map((s) => s.area));
  const cands = shapes.filter((s) => s.area < 0.3 * maxA && s.elong > 1.4);
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
    digits.push({ key, toe: key.startsWith('toe'), side: key.slice(-1), verts, first, loops, B, d, sTip, sLast, mid: [(B[0] + E[0]) / 2, (B[2] + E[2]) / 2] });
  }
  // match digits to shapes: nearest first, each shape used once
  const pairs = [];
  for (const g of digits) for (const s of cands) pairs.push([Math.hypot(g.mid[0] - s.cx, g.mid[1] - s.cz), g, s]);
  pairs.sort((a, b) => a[0] - b[0]);
  const usedG = new Set(), usedS = new Set();
  for (const [dist, g, s] of pairs) {
    if (usedG.has(g) || usedS.has(s) || dist > 0.08 * H) continue;
    usedG.add(g); usedS.add(s); g.shape = s;
  }

  const target = new Float64Array(3 * n).fill(NaN);
  const list = [];
  let matched = 0;
  for (const g of digits) {
    const sh = g.shape;
    if (!sh) continue;
    matched++;
    // orient the drawn axis from base (the end nearer the digit's first loop) to tip
    let ux = sh.ux, uz = sh.uz;
    const sB = (g.B[0] - sh.cx) * ux + (g.B[2] - sh.cz) * uz;
    if (Math.abs(sB - sh.s1) < Math.abs(sB - sh.s0)) { ux = -ux; uz = -uz; }
    const sBase = ux === sh.ux ? sh.s0 : -sh.s1, sEnd = ux === sh.ux ? sh.s1 : -sh.s0; // in the oriented frame
    const L = sEnd - sBase;
    // the digit's first loop sits a little way along from the drawn base
    const a0 = sBase + 0.28 * L;
    // the cage's frame for the digit: axis d, across (horizontal, perpendicular), up
    const ew0 = [-g.d[2], 0, g.d[0]], el = Math.hypot(...ew0) || 1;
    const ew = ew0.map((x) => x / el);
    const et = [g.d[1] * ew[2] - g.d[2] * ew[1], g.d[2] * ew[0] - g.d[0] * ew[2], g.d[0] * ew[1] - g.d[1] * ew[0]];
    const up = et[1] < 0 ? -1 : 1;
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
    for (const v of g.verts) {
      const sc = Math.max(0, (pos[3 * v] - g.B[0]) * g.d[0] + (pos[3 * v + 1] - g.B[1]) * g.d[1] + (pos[3 * v + 2] - g.B[2]) * g.d[2]);
      const rg = ringAt(sc);
      const o = [pos[3 * v] - rg.c[0], pos[3 * v + 1] - rg.c[1], pos[3 * v + 2] - rg.c[2]];
      const ow = (o[0] * ew[0] + o[1] * ew[1] + o[2] * ew[2]) / rg.rw, ot = up * (o[0] * et[0] + o[1] * et[1] + o[2] * et[2]) / rg.rt;
      // along the drawn axis: the tube up to the last loop stretches to fill the drawn length; the tip keeps a round end of
      // the drawn half width
      const sCap = sEnd - rEnd;
      const s = sc <= g.sLast ? a0 + (g.sLast > 0 ? sc / g.sLast : 0) * (sCap - a0) : sCap + ((sc - g.sLast) / Math.max(1e-6, g.sTip - g.sLast)) * rEnd * 0.9;
      const cut = widthAt(oriented, Math.min(s, sEnd - rEnd)) || [-0.004 * H, 0.004 * H];
      const wc = (cut[0] + cut[1]) / 2, hw = Math.max(0.002 * H, (cut[1] - cut[0]) / 2 * 0.92);
      const x = sh.cx + s * ux - wc * uz, z = sh.cz + s * uz + wc * ux;
      // thickness and height: fingers from the front view at that point, toes resting on the floor
      let cy, ht;
      if (g.toe) {
        const col = measure.samplers.sideCol(z).filter(([lo]) => lo < 0.06 * H);
        const hFoot = col.length ? col[0][1] : 0.02 * H;
        ht = Math.min(0.8 * hw, Math.max(0.003 * H, hFoot / 2));
        cy = ht + 0.001 * H;
      } else {
        const arm = measure.armAt(g.side === 'L' ? 1 : -1, x);
        ht = Math.min(0.85 * hw, Math.max(0.003 * H, arm.ry * 0.9));
        cy = arm.cy;
      }
      // across the drawn width; the offset keeps its direction (sign of across matches the cage's)
      const across = [-uz * Math.sign(ew[0] * -uz + ew[2] * ux || 1), ux * Math.sign(ew[0] * -uz + ew[2] * ux || 1)];
      const r = Math.hypot(ow, ot);
      const k = r > 1 ? 1 / r : 1; // points just outside the first loop's box: keep on the ellipse
      target[3 * v] = x + across[0] * ow * k * hw;
      target[3 * v + 1] = cy + ot * k * ht;
      target[3 * v + 2] = z + across[1] * ow * k * hw;
      list.push(v);
    }
  }
  return { verts: Int32Array.from(list), target, digits: digits.length, matched };
}
