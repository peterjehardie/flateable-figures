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
    // hands and feet (1 = hand, 2 = foot): also held by the top view when there is one
    this.ext = new Int8Array(n);
    for (let f = 0; f < nF; f++) {
      const part = mesh.fpart[f];
      const e = part === 7 || part === 10 ? 1 : part === 13 || part === 16 ? 2 : 0;
      if (e) for (let i = 0; i < 4; i++) this.ext[Q[4 * f + i]] = e;
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

  // Detail pass: only `face.region` moves (the rest is held), in smaller steps, and the face is
  // pulled onto its relief (depth over the rounded head) and its loops onto the drawn shapes.
  startDetail(face) {
    const P = this.P, n = this.n;
    // the face was only carried along so far: lay it out on the face it is aiming for
    if (face.inner && face.layout) for (const v of face.inner) { const p = face.layout(v); P[3 * v] = p[0]; P[3 * v + 1] = p[1]; P[3 * v + 2] = p[2]; }
    const inR = new Uint8Array(n);
    for (const v of face.region) inR[v] = 1;
    const lt = new Float64Array(2 * n).fill(NaN);
    for (const L of face.loopTargets) {
      let cx = 0, cy = 0;
      for (const v of L.verts) { cx += P[3 * v]; cy += P[3 * v + 1]; }
      cx /= L.verts.length; cy /= L.verts.length;
      const ang = L.shape.map(([x, y]) => Math.atan2(y - L.cy, x - L.cx));
      for (const v of L.verts) {
        const a = Math.atan2(P[3 * v + 1] - cy, P[3 * v] - cx);
        let best = 0, bd = Infinity;
        for (let k = 0; k < ang.length; k++) { let d = Math.abs(ang[k] - a); if (d > Math.PI) d = 2 * Math.PI - d; if (d < bd) { bd = d; best = k; } }
        lt[2 * v] = L.shape[best][0]; lt[2 * v + 1] = L.shape[best][1];
      }
    }
    this.detail = { face, inR, lt, hold: Float64Array.from(P), iter: 0 };
    this.lastMove = Infinity;
  }

  stopDetail() { this.detail = null; }

  // Points carried along during the body pass: each step their movement is filled in from their
  // neighbours' (a smooth blend of how the surrounding loop moves), so small quads keep their shape.
  setCarried(verts) {
    this.carried = verts && verts.length ? verts : null;
    this.carriedMask = null;
    if (this.carried) { this.carriedMask = new Uint8Array(this.n); for (const v of verts) this.carriedMask[v] = 1; this.Dfill = new Float64Array(3 * this.n); }
  }

  // how much of a head vertex is "face": 1 in the middle of the front, easing to 0 at its sides
  faceWeight(x, y, z) {
    const pr = this.ctx.measure.profileAt('trunk', y);
    if (z <= pr[2]) return 0;
    const u = Math.abs(x - pr[0]) / pr[1];
    return u < 0.55 ? 1 : u < 0.9 ? 0.5 + 0.5 * Math.cos(((u - 0.55) / 0.35) * Math.PI) : 0;
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
    const det = this.detail;
    const stepLen = 0.0022 * H;
    if (!this.prev) { this.prev = new Float64Array(3 * n); this.Lap = new Float64Array(3 * n); this.E2 = new Float64Array(n); }
    this.prev.set(P);
    const Lap = this.Lap, E2 = this.E2;
    // pass 1: umbrella Laplacian per vertex
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0, e2 = 0, emin = Infinity;
      const k0 = off[i], k1 = off[i + 1], cnt = k1 - k0;
      const px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
      for (let k = k0; k < k1; k++) {
        const j = nb[k];
        const dx = P[3 * j] - px, dy = P[3 * j + 1] - py, dz = P[3 * j + 2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        sx += dx; sy += dy; sz += dz; e2 += d2;
        if (d2 < emin) emin = d2;
      }
      // Pressure scale: on long thin tubes (fingers) the loops are far apart but the edges round
      // the tube are short, and only those set the curvature. The mean edge overpressured fingers
      // ~16x; the shorter of (mean, 2 x shortest) keeps the torso as it was and fingers intact.
      Lap[3 * i] = sx / cnt; Lap[3 * i + 1] = sy / cnt; Lap[3 * i + 2] = sz / cnt; E2[i] = Math.min(e2 / cnt, 2 * emin);
    }
    const fair = prm.fair ?? 0.03;
    const B = 0.8;
    // Pressure, as a push per vertex along its normal. Body: a steady push that fades out as the
    // vertex reaches its rounded profile ("inflate until it matches"). Hands and feet: a gentle
    // push balanced against tension (they are built close to shape, gaps of a few mm).
    if (!this.PD || this.PD.length !== n) { this.PD = new Float64Array(n); this.PD2 = new Float64Array(n); }
    let PD = this.PD, PD2 = this.PD2;
    for (let i = 0; i < n; i++) {
      if (this.ext[i]) { PD[i] = Math.min(0.5 * prm.pressure * this.pm[i] * B * E2[i] / (2 * rref[i]), 0.12 * stepLen); continue; }
      const sp = this.profileS(P[3 * i], P[3 * i + 1], P[3 * i + 2], this.cls[i], prm);
      const reach = sp < 0 ? 1 : sp < 0.95 ? 1 : sp < 0.995 ? (0.995 - sp) / 0.045 : 0;
      PD[i] = prm.pressure * this.pm[i] * stepLen * reach;
      // detail pass: pressure still holds the head out (without it, tension draws the face in
      // from the sides), but stops where a face point already stands at or past its relief
      if (det && det.inR[i]) {
        const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
        const w = this.faceWeight(x, y, z);
        if (w > 0 && z > det.face.baseZ(x, y) + det.face.relief(x, y)) PD[i] *= 1 - w;
      }
    }
    // Smooth the push over neighbours so neighbouring vertices move together: small quads (eye and
    // mouth loops, finger webs) travel with their surroundings instead of being overrun and folded.
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < n; i++) {
        let a = 0;
        for (let k = off[i]; k < off[i + 1]; k++) a += PD[nb[k]];
        PD2[i] = 0.5 * PD[i] + (0.5 * a) / (off[i + 1] - off[i]);
      }
      const t = PD; PD = PD2; PD2 = t;
    }
    for (let i = 0; i < n; i++) {
      const k0 = off[i], k1 = off[i + 1], cnt = k1 - k0;
      const px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
      const sx = Lap[3 * i], sy = Lap[3 * i + 1], sz = Lap[3 * i + 2], e2 = E2[i];
      // fairing: Laplacian of the Laplacian damps row-to-row zig-zags (ripples on stretched
      // quads) while leaving the large-scale shape alone
      let bx = -sx, by = -sy, bz = -sz;
      for (let k = k0; k < k1; k++) { const j = nb[k]; bx += Lap[3 * j] / cnt; by += Lap[3 * j + 1] / cnt; bz += Lap[3 * j + 2] / cnt; }
      const nx = Nn[3 * i], ny = Nn[3 * i + 1], nz = Nn[3 * i + 2];
      const ln = sx * nx + sy * ny + sz * nz;
      const tx = sx - ln * nx, ty = sy - ln * ny, tz = sz - ln * nz;
      // Rubber, not soap film: tension is umbrella smoothing along the normal (beta * L.n),
      // which pulls harder the more the surface is stretched, so inflation is stable.
      // Pressure is scaled by e^2 / (2 r) so a free sphere settles near r = rref * T / P.
      // (A true mean-curvature tension with constant pressure behaves like a soap bubble:
      // anything smaller than its target radius collapses.)
      // tension: umbrella smoothing along the normal (rubber-like, stable); the rounding itself
      // comes from the rounded-profile constraint
      const ext = this.ext[i];
      const tl = 0.3 * Math.sqrt(e2);
      const ten = clamp(prm.tension * this.tm[i] * B * ln * (ext ? 0.5 : 1), -tl, tl);
      const f = ext ? clamp(PD[i] + ten, -0.12 * stepLen, 0.12 * stepLen) : clamp(PD[i] + ten, -stepLen, stepLen);
      const bn = -fair * (bx * nx + by * ny + bz * nz);
      let dx = (f + bn) * nx + prm.relax * tx, dy = (f + bn) * ny + prm.relax * ty, dz = (f + bn) * nz + prm.relax * tz;
      const ax = this.axis[i];
      if (ax >= 0 && prm.anchor > 0) {
        const cur = ax === 0 ? px : ax === 1 ? py : pz;
        const pull = prm.anchor * (this.aval[i] - cur);
        if (ax === 0) dx += pull; else if (ax === 1) dy += pull; else dz += pull;
      }
      if (det && det.inR[i]) {
        const fc = det.face;
        // the face (front of the head) is pulled to its relief; eye and mouth loops to their shapes
        const w = this.faceWeight(px, py, pz);
        if (w > 0) dz += 0.2 * w * (fc.baseZ(px, py) + fc.relief(px, py) - pz);
        const tx0 = det.lt[2 * i];
        if (tx0 === tx0) { dx += 0.2 * (tx0 - px); dy += 0.2 * (det.lt[2 * i + 1] - py); }
        // finer steps: every force scaled alike, so the balance (what it settles on) is unchanged
        dx *= 0.4; dy *= 0.4; dz *= 0.4;
      }
      D[3 * i] = dx; D[3 * i + 1] = dy; D[3 * i + 2] = dz;
    }
    if (this.carried && !det) {
      const cm = this.carriedMask, Df = this.Dfill;
      for (let it = 0; it < 40; it++) for (const i of this.carried) {
        let sx = 0, sy = 0, sz = 0;
        const k0 = off[i], k1 = off[i + 1];
        for (let k = k0; k < k1; k++) { const j = nb[k], S = cm[j] ? Df : D; sx += S[3 * j]; sy += S[3 * j + 1]; sz += S[3 * j + 2]; }
        const c = k1 - k0;
        Df[3 * i] = sx / c; Df[3 * i + 1] = sy / c; Df[3 * i + 2] = sz / c;
      }
      for (const i of this.carried) { D[3 * i] = Df[3 * i]; D[3 * i + 1] = Df[3 * i + 1]; D[3 * i + 2] = Df[3 * i + 2]; }
    }
    for (let i = 0; i < 3 * n; i++) P[i] += D[i];
    if (prm.constrain) { this.constrain(prm); this.constrain(prm); }
    if (prm.symmetry && this.mirror) this.symmetrize();
    for (const pin of this.pins) {
      const i = pin.v;
      for (let c = 0; c < 3; c++) P[3 * i + c] += 0.5 * (pin.p[c] - P[3 * i + c]);
    }
    if (det) { for (let i = 0; i < n; i++) if (!det.inR[i]) { P[3 * i] = det.hold[3 * i]; P[3 * i + 1] = det.hold[3 * i + 1]; P[3 * i + 2] = det.hold[3 * i + 2]; } det.iter++; }
    // net movement after the hull has pushed back: what "settled" is judged on
    // judged on the body: toe tips resting on the floor keep a harmless shimmer
    // (in the detail pass: on the part being worked)
    let moved = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (det ? !det.inR[i] : this.ext[i]) continue;
      moved += Math.abs(P[3 * i] - this.prev[3 * i]) + Math.abs(P[3 * i + 1] - this.prev[3 * i + 1]) + Math.abs(P[3 * i + 2] - this.prev[3 * i + 2]);
      cnt++;
    }
    this.lastMove = moved / Math.max(cnt, 1) / H;
    this.iter++;
  }

  // Where a point sits relative to its rounded profile: < 1 inside, 1 on it; -1 when there is none.
  profileS(x, y, z, c, prm) {
    const pe = prm.profile;
    if (!pe) return -1;
    const M = this.ctx.measure;
    let pr, u, v;
    if (c === 1 || c === 2) { pr = M.profileAt(c === 1 ? 'arm1' : 'arm-1', x); u = (y - pr[0]) / pr[1]; v = (z - pr[2]) / pr[3]; }
    else { pr = M.profileAt(c === 3 ? 1 : c === 4 ? -1 : 'trunk', y); u = (x - pr[0]) / pr[1]; v = (z - pr[2]) / pr[3]; }
    const q = Math.pow(Math.pow(Math.abs(u), pe) + Math.pow(Math.abs(v), pe), 1 / pe);
    return isFinite(q) ? q : -1;
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
      const topHeld = this.ext[i] && M.hasTop;
      if (topHeld) {
        // plan view of hands and feet holds (x, z)
        const t = smp.top(x, z);
        if (t.d > 0) { x -= t.d * t.gx; z -= t.d * t.gz; }
      }
      if (c === 1 || c === 2) {
        const sign = c === 1 ? 1 : -1;
        const a = M.armAt(sign, x);
        if (this.ext[i] === 1) {
          // hand depth comes from the top view when there is one; never from the arm's cross-section
        } else if (sec) {
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
      // rounded profile (superellipse of exponent prm.profile inside the drawings' box)
      const pe = prm.profile;
      if (pe && !this.ext[i] && !(this.detail && this.detail.inR[i])) {
        let pr, u, v;
        if (c === 1 || c === 2) {
          pr = M.profileAt(c === 1 ? 'arm1' : 'arm-1', x);
          u = (y - pr[0]) / pr[1]; v = (z - pr[2]) / pr[3];
        } else {
          pr = M.profileAt(c === 3 ? 1 : c === 4 ? -1 : 'trunk', y);
          u = (x - pr[0]) / pr[1]; v = (z - pr[2]) / pr[3];
        }
        const s = Math.pow(Math.pow(Math.abs(u), pe) + Math.pow(Math.abs(v), pe), 1 / pe);
        if (s > 1 && isFinite(s)) {
          if (c === 1 || c === 2) { y = pr[0] + (y - pr[0]) / s; z = pr[2] + (z - pr[2]) / s; }
          else { x = pr[0] + (x - pr[0]) / s; z = pr[2] + (z - pr[2]) / s; }
        }
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
