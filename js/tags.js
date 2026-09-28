// Tags: named vertex sets. They come from three places and are always recomputed
// from positions, never stored by vertex number, so they survive any topology change:
//  - feature paths in the drawings, projected onto the surface that faces that view
//  - paint dabs placed on the 3D surface
//  - the cage itself (parts, station loops) — see cage.js
// Groups can also change the balloon locally (pressure, tension) and can pull the
// nearest edge loop onto an open feature line (topology following a drawn feature).

import { pointInPolygon, distToPolyline, bboxOf } from './util.js';

export function computeTags(doc, frame, sim, opts) {
  const n = sim.n, P = sim.P, Nn = sim.N;
  const groups = {};
  const band = opts.band; // doc units
  for (const name of Object.keys(doc.groups)) groups[name] = new Uint8Array(n);
  for (const p of doc.paths) {
    if (p.role !== 'feature' || !groups[p.group] || (p.view !== 'front' && p.view !== 'side')) continue;
    const g = groups[p.group];
    const front = p.view === 'front';
    const facing = p.side || (front ? 'near' : 'both');
    const bb = bboxOf(p.pts);
    const pad = band;
    const closed = p.closed && p.pts.length > 2;
    for (let i = 0; i < n; i++) {
      const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
      let xd, yd, nd;
      if (front) { [xd, yd] = frame.fd(x, y); nd = Nn[3 * i + 2]; }
      else { [xd, yd] = frame.sd(z, y); nd = Nn[3 * i] * frame.S.dir; }
      if (xd < bb.x0 - pad || xd > bb.x1 + pad || yd < bb.y0 - pad || yd > bb.y1 + pad) continue;
      if (facing === 'near' && nd < 0.1) continue;
      if (facing === 'far' && nd > -0.1) continue;
      const hit = closed ? pointInPolygon(xd, yd, p.pts) || distToPolyline(xd, yd, p.pts, true) < band * 0.5 : distToPolyline(xd, yd, p.pts, false) < band;
      if (hit) g[i] = 1;
    }
  }
  for (const d of doc.paint) {
    const g = groups[d.group];
    if (!g) continue;
    const r2 = d.r * d.r;
    for (let i = 0; i < n; i++) {
      const dx = P[3 * i] - d.p[0], dy = P[3 * i + 1] - d.p[1], dz = P[3 * i + 2] - d.p[2];
      if (dx * dx + dy * dy + dz * dz < r2) g[i] = d.erase ? 0 : 1;
    }
  }
  return groups;
}

// Per-vertex balloon multipliers and loop-pull anchors from the tag groups.
export function tagModifiers(doc, frame, sim, groups) {
  const n = sim.n;
  const pm = new Float64Array(n).fill(1), tm = new Float64Array(n).fill(1);
  for (const [name, g] of Object.entries(groups)) {
    const s = doc.groups[name];
    if (!s || (s.pressure === 1 && s.tension === 1)) continue;
    for (let i = 0; i < n; i++) if (g[i]) { pm[i] *= s.pressure; tm[i] *= s.tension; }
  }
  const axis = Int8Array.from(sim.mesh.anchorAxis);
  const aval = Float64Array.from(sim.mesh.anchorVal);
  const pulled = [];
  const loops = sim.mesh.loops.filter((l) => l.axis === 1);
  for (const p of doc.paths) {
    if (p.role !== 'feature' || p.closed || !doc.groups[p.group] || !doc.groups[p.group].loop) continue;
    if (p.view !== 'front' && p.view !== 'side') continue;
    const front = p.view === 'front';
    // the line in world coordinates: (u, y) with u = x (front) or z (side)
    const pts = p.pts.map(([xd, yd]) => (front ? frame.fw(xd, yd) : frame.sw(xd, yd))).sort((a, b) => a[0] - b[0]);
    const u0 = pts[0][0], u1 = pts[pts.length - 1][0];
    const ymean = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    const yAt = (u) => {
      for (let k = 1; k < pts.length; k++) if (u <= pts[k][0]) {
        const t = (u - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0] || 1);
        return pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t;
      }
      return pts[pts.length - 1][1];
    };
    // nearest horizontal loop that actually spans the line
    let best = null, bd = Infinity;
    for (const l of loops) {
      let ly = 0, lo = Infinity, hi = -Infinity;
      for (const v of l.verts) { ly += sim.P[3 * v + 1]; const u = sim.P[3 * v + (front ? 0 : 2)]; lo = Math.min(lo, u); hi = Math.max(hi, u); }
      ly /= l.verts.length;
      const overlap = Math.min(hi, u1) - Math.max(lo, u0);
      if (overlap < 0.5 * (u1 - u0)) continue;
      const d = Math.abs(ly - ymean);
      if (d < bd) { bd = d; best = l; }
    }
    if (!best) continue;
    pulled.push(best);
    for (const v of best.verts) {
      const u = sim.P[3 * v + (front ? 0 : 2)];
      const nd = front ? sim.N[3 * v + 2] : sim.N[3 * v] * frame.S.dir;
      if (u < u0 || u > u1 || (front && nd < 0)) continue;
      axis[v] = 1; aval[v] = yAt(u);
    }
  }
  return { pm, tm, axis, aval, pulled };
}
