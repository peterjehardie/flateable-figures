// Topology that follows the drawn features.
//
// Every feature stroke (Features layer: front, back, side) is laid onto the inflated surface from
// its own view, which gives a curve in space. Then a chain of the mesh's own edges is chosen to
// carry it:
// - a closed stroke gets the edge loop round the faces inside it;
// - an open stroke gets the cheapest edge path between its ends, where an edge costs more the
//   further it strays from the curve.
// Those vertices are given targets along the curve (spaced by arc length), and a short pass pulls
// them there while the rest of the surface relaxes round them. Edges then run along the drawing;
// the report says how closely.

// ---------------- surface lookup from a view ----------------
// Triangles of the surface facing a view, bucketed on that view's plane; a query returns the
// visible surface point under a 2D position (the nearest to the viewer).
function viewHits(sim, view, far, frame) {
  const P = sim.P, Q = sim.mesh.quads, nF = Q.length / 4;
  // plane coordinates (u, v) and depth toward the viewer
  const sd = frame.S.dir;
  const U = view === 'side' ? (i) => P[3 * i + 2] : (i) => P[3 * i];
  const V = (i) => P[3 * i + 1];
  const D = view === 'side' ? (i) => sd * P[3 * i] : (i) => (far ? -1 : 1) * P[3 * i + 2];
  const tris = [];
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let f = 0; f < nF; f++) {
    const q = [Q[4 * f], Q[4 * f + 1], Q[4 * f + 2], Q[4 * f + 3]];
    for (const [a, b, c] of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      const ua = U(a), va = V(a), ub = U(b), vb = V(b), uc = U(c), vc = V(c);
      const area = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
      if (Math.abs(area) < 1e-12) continue;
      tris.push({ a, b, c, f, ua, va, ub, vb, uc, vc, area });
      u0 = Math.min(u0, ua, ub, uc); u1 = Math.max(u1, ua, ub, uc); v0 = Math.min(v0, va, vb, vc); v1 = Math.max(v1, va, vb, vc);
    }
  }
  const cs = Math.max((u1 - u0) / 400, (v1 - v0) / 400, 1e-4);
  const nu = Math.ceil((u1 - u0) / cs) + 1, nv = Math.ceil((v1 - v0) / cs) + 1;
  const grid = new Map();
  tris.forEach((t, k) => {
    const i0 = Math.floor((Math.min(t.ua, t.ub, t.uc) - u0) / cs), i1 = Math.floor((Math.max(t.ua, t.ub, t.uc) - u0) / cs);
    const j0 = Math.floor((Math.min(t.va, t.vb, t.vc) - v0) / cs), j1 = Math.floor((Math.max(t.va, t.vb, t.vc) - v0) / cs);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const key = j * nu + i; let arr = grid.get(key); if (!arr) grid.set(key, (arr = [])); arr.push(k); }
  });
  return (u, v) => {
    const arr = grid.get(Math.floor((v - v0) / cs) * nu + Math.floor((u - u0) / cs));
    if (!arr) return null;
    let best = null, bd = -Infinity;
    for (const k of arr) {
      const t = tris[k];
      const w1 = ((t.ub - u) * (t.vc - v) - (t.uc - u) * (t.vb - v)) / t.area;
      const w2 = ((t.uc - u) * (t.va - v) - (t.ua - u) * (t.vc - v)) / t.area;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
      const d = w1 * D(t.a) + w2 * D(t.b) + w3 * D(t.c);
      if (d > bd) { bd = d; best = { p: [0, 1, 2].map((c) => w1 * P[3 * t.a + c] + w2 * P[3 * t.b + c] + w3 * P[3 * t.c + c]), f: t.f }; }
    }
    return best;
  };
}

function resample(pts, closed, step) {
  const src = closed ? [...pts, pts[0]] : pts, out = [src[0]];
  let carry = 0;
  for (let i = 0; i < src.length - 1; i++) {
    const [x0, y0] = src[i], [x1, y1] = src[i + 1], L = Math.hypot(x1 - x0, y1 - y0);
    let s = step - carry;
    while (s <= L) { out.push([x0 + ((x1 - x0) * s) / L, y0 + ((y1 - y0) * s) / L]); s += step; }
    carry = L - (s - step);
  }
  if (!closed) out.push(src[src.length - 1]);
  return out;
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function arcLengths(pts, closed) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist3(pts[i - 1], pts[i]));
  if (closed) s.push(s[s.length - 1] + dist3(pts[pts.length - 1], pts[0]));
  return s;
}
function pointAt(pts, s, closed, t) {
  const L = s[s.length - 1], x = ((t % 1) + 1) % 1 * L;
  let i = 1;
  while (i < s.length - 1 && s[i] < x) i++;
  const a = pts[i - 1], b = pts[i % pts.length], u = (x - s[i - 1]) / Math.max(1e-12, s[i] - s[i - 1]);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
function nearestOnCurve(pts, p) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / L2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1], p[2] - a[2] - t * ab[2]));
  }
  return best;
}

// ---------------- plan: curves and the edges that will carry them ----------------
export function planConform(doc, frame, sim, symmetric = true) {
  const P = sim.P, n = sim.n, Q = sim.mesh.quads, nF = Q.length / 4, H = frame.H;
  // neighbours and the typical edge length
  const nb = Array.from({ length: n }, () => new Set());
  for (let f = 0; f < nF; f++) for (let i = 0; i < 4; i++) { const a = Q[4 * f + i], b = Q[4 * f + ((i + 1) % 4)]; nb[a].add(b); nb[b].add(a); }
  const el = [];
  for (let i = 0; i < n; i += 7) for (const j of nb[i]) el.push(Math.hypot(P[3 * i] - P[3 * j], P[3 * i + 1] - P[3 * j + 1], P[3 * i + 2] - P[3 * j + 2]));
  el.sort((a, b) => a - b);
  const h = el[el.length >> 1] || 0.01 * H;
  // parts that carry their own detail: the head (face pass), hands and feet (digit pass)
  const fpart = sim.mesh.fpart;
  const skipFace = (f) => fpart[f] === 4 || fpart[f] === 7 || fpart[f] === 10 || fpart[f] === 13 || fpart[f] === 16;
  const lookups = {};
  const hitFor = (view, far) => (lookups[view + far] ||= viewHits(sim, view, far, frame));
  const faceNormal = (f) => {
    const [a, b, c, d] = [Q[4 * f], Q[4 * f + 1], Q[4 * f + 2], Q[4 * f + 3]];
    const ux = P[3 * c] - P[3 * a], uy = P[3 * c + 1] - P[3 * a + 1], uz = P[3 * c + 2] - P[3 * a + 2];
    const vx = P[3 * d] - P[3 * b], vy = P[3 * d + 1] - P[3 * b + 1], vz = P[3 * d + 2] - P[3 * b + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const target = new Float64Array(3 * n).fill(NaN);
  const taken = new Uint8Array(n);
  const plans = [], skipped = [];

  // With left-right symmetry on, a stroke and its mirror image must be carried by mirror-image
  // edges (the balloon keeps the two sides mirrored, and two separately chosen paths would be
  // dragged into a zigzag). So each front/back stroke is planned on the figure's left side
  // (+x; a stroke drawn on the right is mirrored over first, and a mirrored twin is skipped),
  // then its chain and curve are mirrored to the other side.
  const mirrorV = symmetric && sim.mirror ? sim.mirror : null;
  const seenTwin = new Set();
  doc.paths.forEach((p, idx) => {
    if (p.role !== 'feature' || (p.view !== 'front' && p.view !== 'side') || p.pts.length < 2) return;
    const view = p.view, far = view === 'front' && p.side === 'far';
    const toWorld = view === 'front' ? (q) => frame.fw(q[0], q[1]) : (q) => frame.sw(q[0], q[1]);
    let w2 = p.pts.map(toWorld);
    let mirrorIt = false;
    if (mirrorV && view === 'front') {
      if (p.twin != null && seenTwin.has(p.twin)) return; // its twin is planned and mirrored
      seenTwin.add(p.id);
      const mx = w2.reduce((a, q) => a + q[0], 0) / w2.length;
      const crosses = Math.min(...w2.map((q) => q[0])) < -0.005 * H && Math.max(...w2.map((q) => q[0])) > 0.005 * H;
      if (!crosses) { if (mx < 0) w2 = w2.map(([x, y]) => [-x, y]); mirrorIt = true; }
    }
    const closed = !!p.closed;
    const hit = hitFor(view, far);
    // lay the stroke on the surface
    const samples = resample(w2, closed, 0.4 * h);
    const curve = [], faces = [];
    for (const [u, v] of samples) { const r = hit(u, v); if (r) { curve.push(r.p); faces.push(r.f); } }
    if (curve.length < 3 || curve.length < 0.6 * samples.length) { skipped.push({ idx, why: 'off the surface' }); return; }
    const own = faces.filter((f) => !skipFace(f)).length;
    if (own < 0.7 * faces.length) { skipped.push({ idx, why: 'on the head, hands or feet (they have their own pass)' }); return; }
    // which way the surface must face to belong to this stroke's view
    const dir = view === 'side' ? [frame.S.dir, 0, 0] : [0, 0, far ? -1 : 1];
    const facing = (f) => { const nn = faceNormal(f); return nn[0] * dir[0] + nn[1] * dir[1] + nn[2] * dir[2] > 0; };
    let chain = null;
    if (closed) {
      // faces inside the stroke (as seen from its view), largest connected piece; its border
      const inside = new Set();
      const poly = w2;
      const pip = (u, v) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ui, vi] = poly[i], [uj, vj] = poly[j]; if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) c = !c; } return c; };
      for (let f = 0; f < nF; f++) {
        if (skipFace(f) || !facing(f)) continue;
        let cu = 0, cv = 0;
        for (let k = 0; k < 4; k++) { const v = Q[4 * f + k]; cu += view === 'side' ? P[3 * v + 2] : P[3 * v]; cv += P[3 * v + 1]; }
        if (pip(cu / 4, cv / 4)) inside.add(f);
      }
      // keep the visible layer: the face under each inside point must be the one hit from the view
      const vis = new Set(faces);
      const eKey = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
      const edgeFaces = new Map();
      for (const f of inside) for (let k = 0; k < 4; k++) { const e = eKey(Q[4 * f + k], Q[4 * f + ((k + 1) % 4)]); const arr = edgeFaces.get(e) || []; arr.push(f); edgeFaces.set(e, arr); }
      // connected pieces
      const seen = new Set();
      let bestPiece = null;
      for (const f0 of inside) {
        if (seen.has(f0)) continue;
        const piece = [], st = [f0];
        seen.add(f0);
        while (st.length) {
          const f = st.pop(); piece.push(f);
          for (let k = 0; k < 4; k++) for (const g of edgeFaces.get(eKey(Q[4 * f + k], Q[4 * f + ((k + 1) % 4)]))) if (!seen.has(g)) { seen.add(g); st.push(g); }
        }
        const touches = piece.some((f) => vis.has(f)) ? 1 : 0;
        if (!bestPiece || touches > bestPiece.t || (touches === bestPiece.t && piece.length > bestPiece.p.length)) bestPiece = { p: piece, t: touches };
      }
      if (!bestPiece || bestPiece.p.length < 1) { skipped.push({ idx, why: 'too small for the mesh' }); return; }
      const pieceSet = new Set(bestPiece.p);
      // border edges, directed, then walked into the longest cycle
      const next = new Map();
      for (const f of pieceSet) for (let k = 0; k < 4; k++) {
        const a = Q[4 * f + k], b = Q[4 * f + ((k + 1) % 4)];
        if (edgeFaces.get(eKey(a, b)).filter((g) => pieceSet.has(g)).length === 1) next.set(a, b);
      }
      let cyc = null;
      const used = new Set();
      for (const s of next.keys()) {
        if (used.has(s)) continue;
        const c = [];
        let v = s;
        while (v !== undefined && !used.has(v)) { used.add(v); c.push(v); v = next.get(v); }
        if (!cyc || c.length > cyc.length) cyc = c;
      }
      chain = cyc;
    } else {
      // cheapest edge path between the stroke's ends, kept near the curve
      const nearestVert = (pt) => { let b = -1, bd = Infinity; for (let i = 0; i < n; i++) { if (sim.ext[i]) continue; const d = (P[3 * i] - pt[0]) ** 2 + (P[3 * i + 1] - pt[1]) ** 2 + (P[3 * i + 2] - pt[2]) ** 2; if (d < bd) { bd = d; b = i; } } return b; };
      const s0 = nearestVert(curve[0]), s1 = nearestVert(curve[curve.length - 1]);
      if (s0 < 0 || s1 < 0 || s0 === s1) { skipped.push({ idx, why: 'too short for the mesh' }); return; }
      // only vertices near the curve take part
      const band = new Map();
      for (let i = 0; i < n; i++) {
        if (sim.ext[i]) continue;
        const pt = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
        const d = nearestOnCurve(curve, pt);
        if (d < 4 * h) band.set(i, d);
      }
      band.set(s0, 0); band.set(s1, 0);
      const dist = new Map([[s0, 0]]), prev = new Map(), done = new Set();
      const heap = [[0, s0]];
      while (heap.length) {
        let bi = 0;
        for (let k = 1; k < heap.length; k++) if (heap[k][0] < heap[bi][0]) bi = k;
        const [d0, v] = heap.splice(bi, 1)[0];
        if (done.has(v)) continue;
        done.add(v);
        if (v === s1) break;
        for (const w of nb[v]) {
          if (!band.has(w) || done.has(w)) continue;
          const len = Math.hypot(P[3 * v] - P[3 * w], P[3 * v + 1] - P[3 * w + 1], P[3 * v + 2] - P[3 * w + 2]);
          const off = (band.get(v) + band.get(w)) / 2 / h;
          const nd = d0 + len * (1 + 4 * off * off);
          if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, v); heap.push([nd, w]); }
        }
      }
      if (!prev.has(s1)) { skipped.push({ idx, why: 'no edge path found' }); return; }
      const path = [s1];
      while (path[path.length - 1] !== s0) path.push(prev.get(path[path.length - 1]));
      chain = path.reverse();
    }
    if (!chain || chain.length < 3) { skipped.push({ idx, why: 'too small for the mesh' }); return; }
    // targets along the curve by arc length (closed: aligned at the nearest point, either way round)
    const cs = arcLengths(curve, closed);
    const vpos = chain.map((v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
    const vs = arcLengths(vpos, closed);
    const Lc = vs[vs.length - 1];
    let assign = null;
    if (closed) {
      let best = Infinity;
      const ref = vpos[0];
      let k0 = 0, bd = Infinity;
      curve.forEach((c, k) => { const d = dist3(c, ref); if (d < bd) { bd = d; k0 = k; } });
      const t0 = cs[k0] / cs[cs.length - 1];
      for (const sgn of [1, -1]) {
        const tg = chain.map((_, i) => pointAt(curve, cs, true, t0 + (sgn * vs[i]) / Lc));
        const err = tg.reduce((a, t, i) => a + dist3(t, vpos[i]), 0);
        if (err < best) { best = err; assign = tg; }
      }
    } else assign = chain.map((_, i) => pointAt(curve, cs, false, Math.min(0.999999, vs[i] / Lc)));
    const put = (ch, tg) => ch.forEach((v, i) => { if (taken[v]) return; taken[v] = 1; target[3 * v] = tg[i][0]; target[3 * v + 1] = tg[i][1]; target[3 * v + 2] = tg[i][2]; });
    put(chain, assign);
    plans.push({ idx, name: `${p.group || 'feature'} ${plans.length + 1}`, group: p.group, closed, chain, curve });
    if (mirrorIt) {
      const mc = chain.map((v) => mirrorV[v]);
      if (mc.every((v) => v >= 0) && mc.some((v, i) => v !== chain[i])) {
        put(mc, assign.map(([x, y, z]) => [-x, y, z]));
        plans.push({ idx, name: `${p.group || 'feature'} ${plans.length + 1}`, group: p.group, closed, chain: mc, curve: curve.map(([x, y, z]) => [-x, y, z]) });
      }
    }
  });
  return { plans, skipped, target, h };
}

// how closely each chosen edge chain now follows its curve (metres)
export function conformReport(sim, plan) {
  const P = sim.P;
  const rows = plan.plans.map((pl) => {
    const ds = pl.chain.map((v) => nearestOnCurve(pl.closed ? [...pl.curve, pl.curve[0]] : pl.curve, [P[3 * v], P[3 * v + 1], P[3 * v + 2]]));
    return { name: pl.name, mean: ds.reduce((a, b) => a + b, 0) / ds.length, max: Math.max(...ds), verts: pl.chain.length };
  });
  const all = rows.flatMap((r) => [r.mean]);
  return { rows, followed: rows.length, skipped: plan.skipped.length, mean: all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0, max: rows.length ? Math.max(...rows.map((r) => r.max)) : 0 };
}
