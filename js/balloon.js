// The balloon: a fixed-topology quad mesh inflated inside the visual hull.
// Each step: pressure pushes every vertex along its normal, surface tension pulls
// against curvature, relaxation evens out the quads along the surface, anchors keep
// edge loops on their stations, and the hull (front outline x side outline) holds
// every vertex inside the drawings.

import { PART_CLASS } from './cage.js';
import { clamp } from './util.js';

export class Balloon {
  constructor(mesh, ctx) {
    this.mesh = mesh;
    this.ctx = ctx; // { samplers, measure, H }
    const n = (this.n = mesh.nV);
    this.P = Float64Array.from(mesh.pos);
    this.N = new Float64Array(n * 3);
    this.D = new Float64Array(n * 3);
    // neighbours (CSR) from quad edges
    const Q = mesh.quads, nF = Q.length / 4;
    const sets = Array.from({ length: n }, () => new Set());
    for (let f = 0; f < nF; f++) for (let i = 0; i < 4; i++) {
      const a = Q[4 * f + i], b = Q[4 * f + ((i + 1) % 4)];
      sets[a].add(b); sets[b].add(a);
    }
    this.off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.off[i + 1] = this.off[i] + sets[i].size;
    this.nb = new Int32Array(this.off[n]);
    for (let i = 0; i < n; i++) { let k = this.off[i]; for (const j of sets[i]) this.nb[k++] = j; }
    // body class per vertex: trunk wins at junctions
    this.cls = new Int8Array(n).fill(-1);
    for (let f = 0; f < nF; f++) {
      const c = PART_CLASS[mesh.fpart[f]];
      for (let i = 0; i < 4; i++) {
        const v = Q[4 * f + i];
        if (c === 0 || this.cls[v] === -1) this.cls[v] = c;
      }
    }
    this.axis = Int8Array.from(mesh.anchorAxis);
    this.aval = Float64Array.from(mesh.anchorVal);
    this.pm = new Float64Array(n).fill(1); // per-vertex pressure multiplier (tags)
    this.tm = new Float64Array(n).fill(1); // per-vertex tension multiplier (tags)
    this.mirror = null;
    this.pins = [];
    this.lastMove = Infinity;
    this.iter = 0;
  }

  setModifiers(pm, tm, axis, aval) {
    this.pm = pm; this.tm = tm;
    if (axis) { this.axis = axis; this.aval = aval; }
  }

  computeNormals() {
    const P = this.P, Nn = this.N, Q = this.mesh.quads;
    Nn.fill(0);
    for (let f = 0; f < Q.length; f += 4) {
      const a = Q[f], b = Q[f + 1], c = Q[f + 2], d = Q[f + 3];
      const ux = P[3 * c] - P[3 * a], uy = P[3 * c + 1] - P[3 * a + 1], uz = P[3 * c + 2] - P[3 * a + 2];
      const vx = P[3 * d] - P[3 * b], vy = P[3 * d + 1] - P[3 * b + 1], vz = P[3 * d + 2] - P[3 * b + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c, d]) { Nn[3 * v] += nx; Nn[3 * v + 1] += ny; Nn[3 * v + 2] += nz; }
    }
    for (let i = 0; i < this.n; i++) {
      const L = Math.hypot(Nn[3 * i], Nn[3 * i + 1], Nn[3 * i + 2]) || 1;
      Nn[3 * i] /= L; Nn[3 * i + 1] /= L; Nn[3 * i + 2] /= L;
    }
  }

  step(prm) {
    const { P, N: Nn, D, off, nb, n } = this;
    const H = this.ctx.H;
    const rref = this.mesh.rref;
    this.computeNormals();
    const stepLen = 0.0022 * H;
    if (!this.prev) this.prev = new Float64Array(3 * n);
    this.prev.set(P);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0, e2 = 0;
      const k0 = off[i], k1 = off[i + 1], cnt = k1 - k0;
      const px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
      for (let k = k0; k < k1; k++) {
        const j = nb[k];
        const dx = P[3 * j] - px, dy = P[3 * j + 1] - py, dz = P[3 * j + 2] - pz;
        sx += dx; sy += dy; sz += dz; e2 += dx * dx + dy * dy + dz * dz;
      }
      sx /= cnt; sy /= cnt; sz /= cnt; e2 /= cnt;
      const nx = Nn[3 * i], ny = Nn[3 * i + 1], nz = Nn[3 * i + 2];
      const ln = sx * nx + sy * ny + sz * nz;
      const tx = sx - ln * nx, ty = sy - ln * ny, tz = sz - ln * nz;
      // Rubber, not soap film: tension is umbrella smoothing along the normal (beta * L.n),
      // which pulls harder the more the surface is stretched, so inflation is stable.
      // Pressure is scaled by e^2 / (2 r) so a free sphere settles near r = rref * T / P.
      // (A true mean-curvature tension with constant pressure behaves like a soap bubble:
      // anything smaller than its target radius collapses.)
      const B = 0.8;
      let f = prm.pressure * this.pm[i] * B * e2 / (2 * rref[i]) + prm.tension * this.tm[i] * B * ln;
      const lim = Math.min(0.3 * Math.sqrt(e2), stepLen);
      f = clamp(f, -lim, lim);
      let dx = f * nx + prm.relax * tx, dy = f * ny + prm.relax * ty, dz = f * nz + prm.relax * tz;
      const ax = this.axis[i];
      if (ax >= 0 && prm.anchor > 0) {
        const cur = ax === 0 ? px : py;
        const pull = prm.anchor * (this.aval[i] - cur);
        if (ax === 0) dx += pull; else dy += pull;
      }
      D[3 * i] = dx; D[3 * i + 1] = dy; D[3 * i + 2] = dz;
    }
    for (let i = 0; i < 3 * n; i++) P[i] += D[i];
    if (prm.constrain) { this.constrain(prm); this.constrain(prm); }
    if (prm.symmetry && this.mirror) this.symmetrize();
    for (const pin of this.pins) {
      const i = pin.v;
      for (let c = 0; c < 3; c++) P[3 * i + c] += 0.5 * (pin.p[c] - P[3 * i + c]);
    }
    // net movement after the hull has pushed back: what "settled" is judged on
    let moved = 0;
    for (let i = 0; i < 3 * n; i++) moved += Math.abs(P[i] - this.prev[i]);
    this.lastMove = moved / n / H;
    this.iter++;
  }

  constrain(prm) {
    const { P, n, cls } = this;
    const smp = this.ctx.samplers, M = this.ctx.measure;
    const sec = M.section;
    for (let i = 0; i < n; i++) {
      let x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
      const c = cls[i];
      // front outline holds (x, y)
      const fr = smp.front(x, y);
      if (fr.d > 0) { x -= fr.d * fr.gx; y -= fr.d * fr.gy; }
      // side outline holds (z, y); arms use their own cross-section
      if (c === 1 || c === 2) {
        const sign = c === 1 ? 1 : -1;
        const a = M.armAt(sign, x);
        if (sec) {
          const [zlo, zhi] = M.armDepthLimits(sign, a, y);
          if (z < zlo) z = zlo; else if (z > zhi) z = zhi;
        } else {
          const cz = a.cz;
          const lim = a.ry * prm.armDepth;
          if (z > cz + lim) z = cz + lim; else if (z < cz - lim) z = cz - lim;
        }
      } else {
        const sd = smp.side(z, y);
        if (sd.d > 0) { z -= sd.d * sd.gz; y -= sd.d * sd.gy; }
        if (c === 3 && x < 0) x = 0;
        if (c === 4 && x > 0) x = 0;
      }
      if (y < 0) y = 0;
      P[3 * i] = x; P[3 * i + 1] = y; P[3 * i + 2] = z;
    }
  }

  symmetrize() {
    const { P, mirror, n } = this;
    for (let i = 0; i < n; i++) {
      const j = mirror[i];
      if (j < 0 || j < i) continue;
      if (j === i) { P[3 * i] = 0; continue; }
      const x = (P[3 * i] - P[3 * j]) / 2, y = (P[3 * i + 1] + P[3 * j + 1]) / 2, z = (P[3 * i + 2] + P[3 * j + 2]) / 2;
      P[3 * i] = x; P[3 * i + 1] = y; P[3 * i + 2] = z;
      P[3 * j] = -x; P[3 * j + 1] = y; P[3 * j + 2] = z;
    }
  }
}

// Mirror pairs from symmetric reference positions (nearest neighbour of the reflection).
export function mirrorMap(pos, n, tol) {
  const cell = tol * 4;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) {
    const k = key(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(i);
  }
  const m = new Int32Array(n).fill(-1);
  let misses = 0;
  for (let i = 0; i < n; i++) {
    const x = -pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1, bd = tol * tol;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const arr = grid.get(`${cx + a},${cy + b},${cz + c}`);
      if (!arr) continue;
      for (const j of arr) {
        const d = (pos[3 * j] - x) ** 2 + (pos[3 * j + 1] - y) ** 2 + (pos[3 * j + 2] - z) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
    }
    m[i] = best;
    if (best < 0) misses++;
  }
  // make the map symmetric
  for (let i = 0; i < n; i++) if (m[i] >= 0 && m[m[i]] !== i) m[i] = -1;
  return { map: m, misses };
}
