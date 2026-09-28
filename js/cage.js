// The cage: a coarse, all-quad human base mesh whose edge loops sit on the stations.
// It is built once per topology setting; inflation only moves its vertices.
//
// Layout (N = vertices around every ring, a multiple of 8; a = N/4):
// - trunk: a tube of rings from crotch to crown, closed by an a x a grid cap.
// - arm holes: an a x a block of faces removed from each side of the chest,
//   between the armpit ring and the shoulder ring. The hole's border has 4a = N
//   vertices, so the arm tube starts on it directly.
// - hips: the bottom trunk ring plus a chain of N/2-1 crotch vertices running
//   front to back splits the bottom into two N-vertex openings, one per leg.
// - hands, feet, head: a x a grid caps.
// Poles (vertices with 3 or 5 edges) therefore sit at the armpit/shoulder corners,
// at both ends of the crotch chain, and at the cap corners.

export const PARTS = [
  { name: 'pelvis', color: '#7c8db5' }, { name: 'abdomen', color: '#93a8c9' }, { name: 'chest', color: '#6f86b0' },
  { name: 'neck', color: '#b2a0c9' }, { name: 'head', color: '#c4a9d6' },
  { name: 'upper arm L', color: '#79b39a' }, { name: 'forearm L', color: '#94c7ae' }, { name: 'hand L', color: '#b5dcc6' },
  { name: 'upper arm R', color: '#79b39a' }, { name: 'forearm R', color: '#94c7ae' }, { name: 'hand R', color: '#b5dcc6' },
  { name: 'thigh L', color: '#d0a47a' }, { name: 'shin L', color: '#ddb993' }, { name: 'foot L', color: '#e9d0b3' },
  { name: 'thigh R', color: '#d0a47a' }, { name: 'shin R', color: '#ddb993' }, { name: 'foot R', color: '#e9d0b3' },
];
// body class per part, used for per-limb hull constraints: 0 trunk, 1 arm L, 2 arm R, 3 leg L, 4 leg R
export const PART_CLASS = [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];

// Place ring positions along one axis between stations, with optional joint bands
// (extra loops just either side of a joint, where the mesh will bend).
// Radius of curvature of the ellipse (a sin t, b cos t) at t. Wide, shallow sections need
// tight curves at their sides to reach the outline; a single radius per ring rounds them off
// short of it (the waist and hips were under-filled that way).
function rho(a, b, t, mean) {
  const c = Math.cos(t), s = Math.sin(t);
  const r = Math.pow(a * a * c * c + b * b * s * s, 1.5) / Math.max(a * b, 1e-12);
  return Math.min(Math.max(r, 0.2 * mean), 3 * mean);
}

function ringStations(stops, counts, jointOn, deltaFn) {
  const out = [{ v: stops[0].v, name: stops[0].name }];
  for (let i = 1; i < stops.length; i++) {
    const A = out[out.length - 1].v;
    const S = stops[i];
    const band = jointOn && S.joint ? deltaFn(stops[i - 1].v, S.v, stops[i + 1] ? stops[i + 1].v : S.v) : 0;
    const dir = Math.sign(S.v - A) || 1;
    const end = S.v - dir * band;
    const n = counts[i - 1];
    for (let q = 1; q <= n; q++) out.push({ v: A + ((end - A) * q) / (n + 1) });
    if (band) out.push({ v: end, name: S.name + ' band' });
    out.push({ v: S.v, name: S.name, station: true });
    if (band) out.push({ v: S.v + dir * band, name: S.name + ' band' });
  }
  return out;
}

export function buildCage(M, P) {
  const N = P.N, a = N / 4, m = N / 2 - 1;
  const H = M.H, W = M.W, s0 = P.shrink;
  const pos = [], anchorAxis = [], anchorVal = [], rref = [];
  const quads = [], fpart = [];
  const loops = [];
  const addV = (x, y, z, axis, val, r) => { pos.push(x, y, z); anchorAxis.push(axis); anchorVal.push(val); rref.push(r); return pos.length / 3 - 1; };
  const quad = (q0, q1, q2, q3, part) => { quads.push(q0, q1, q2, q3); fpart.push(part); };
  const P3 = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  const delta = (prev, s, next) => Math.min(0.028 * H, 0.3 * Math.abs(s - prev), 0.3 * Math.abs(next - s) || Infinity);

  const cap = (ring, offset, center, dir, part) => {
    const n = ring.length, A = n / 4;
    const grid = new Array((A + 1) * (A + 1));
    for (let k = 0; k < n; k++) {
      const p = (k - offset + n) % n;
      let u, v;
      if (p < A) { u = p; v = 0; } else if (p < 2 * A) { u = A; v = p - A; } else if (p < 3 * A) { u = 3 * A - p; v = A; } else { u = 0; v = 4 * A - p; }
      grid[v * (A + 1) + u] = ring[k];
    }
    const G = (u, v) => grid[v * (A + 1) + u];
    let cx = 0, cy = 0, cz = 0, rr = 0;
    for (const i of ring) { const p = P3(i); cx += p[0]; cy += p[1]; cz += p[2]; rr += rref[i]; }
    cx /= n; cy /= n; cz /= n; rr /= n;
    const bul = (center[0] - cx) * dir[0] + (center[1] - cy) * dir[1] + (center[2] - cz) * dir[2];
    for (let v = 1; v < A; v++) for (let u = 1; u < A; u++) {
      const s = u / A, t = v / A;
      const L = P3(G(0, v)), R = P3(G(A, v)), B = P3(G(u, 0)), T = P3(G(u, A));
      const C00 = P3(G(0, 0)), C10 = P3(G(A, 0)), C01 = P3(G(0, A)), C11 = P3(G(A, A));
      const p = [0, 1, 2].map((c) => (1 - s) * L[c] + s * R[c] + (1 - t) * B[c] + t * T[c]
        - ((1 - s) * (1 - t) * C00[c] + s * (1 - t) * C10[c] + (1 - s) * t * C01[c] + s * t * C11[c])
        + dir[c] * Math.max(bul, 0) * s0 * Math.sin(Math.PI * s) * Math.sin(Math.PI * t) * 1.2);
      grid[v * (A + 1) + u] = addV(p[0], p[1], p[2], -1, 0, rr);
    }
    for (let v = 0; v < A; v++) for (let u = 0; u < A; u++) quad(G(u, v), G(u + 1, v), G(u + 1, v + 1), G(u, v + 1), part);
  };

  // ---------------- trunk ----------------
  const k = P.rings;
  const yBottom = W.crotch + 0.012 * H;
  const crown = W.chin + 0.8 * (H - W.chin);
  const tStops = [
    { v: yBottom, name: 'crotch' }, { v: W.hip, name: 'hip' }, { v: W.waist, name: 'waist' }, { v: W.armpit, name: 'armpit' },
    { v: W.shoulder, name: 'shoulder' }, { v: W.neck, name: 'neck' }, { v: W.chin, name: 'chin' }, { v: crown, name: 'crown' },
  ];
  const tCounts = [k, k, k, a - 1, Math.max(0, k - 1), 0, P.headRings];
  const trunkYs = ringStations(tStops, tCounts, false, delta);
  const jA = trunkYs.findIndex((r) => r.name === 'armpit' && r.station);
  const partOfY = (y) => (y < W.hip ? 0 : y < W.armpit ? 1 : y < W.shoulder ? 2 : y < W.chin ? 3 : 4);
  const T = trunkYs.map(({ v: y }) => {
    const sec = M.trunk(y);
    const r = (sec.rx + sec.rz) / 2;
    const ring = [];
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N;
      ring.push(addV(sec.cx + s0 * sec.rx * Math.sin(th), y, sec.cz + s0 * sec.rz * Math.cos(th), 1, y, rho(sec.rx, sec.rz, th, r)));
    }
    return ring;
  });
  const cL0 = N / 4 - a / 2, cL1 = N / 4 + a / 2, cR0 = (3 * N) / 4 - a / 2, cR1 = (3 * N) / 4 + a / 2;
  for (let j = 0; j < T.length - 1; j++) {
    const part = partOfY((trunkYs[j].v + trunkYs[j + 1].v) / 2);
    for (let i = 0; i < N; i++) {
      if (j >= jA && j < jA + a && ((i >= cL0 && i < cL1) || (i >= cR0 && i < cR1))) continue;
      const i2 = (i + 1) % N;
      quad(T[j][i], T[j][i2], T[j + 1][i2], T[j + 1][i], part);
    }
  }
  trunkYs.forEach((r, j) => {
    if (j > jA && j < jA + a) return;
    loops.push({ name: r.name || 'trunk ' + j, verts: T[j].slice(), station: !!r.station, axis: 1 });
  });
  {
    const top = T[T.length - 1];
    const sec = M.trunk(crown);
    cap(top, a / 2, [sec.cx, H, sec.cz], [0, 1, 0], 4);
  }

  // ---------------- legs ----------------
  const F0 = T[0][0], B0 = T[0][N / 2];
  const chain = [];
  for (let q = 1; q <= m; q++) {
    const t = q / (m + 1);
    const pf = P3(F0), pb = P3(B0);
    chain.push(addV(0, W.crotch, pf[2] + (pb[2] - pf[2]) * t, 1, W.crotch, rref[F0]));
  }
  const legLoop = {
    1: [...T[0].slice(0, N / 2 + 1), ...chain.slice().reverse()],
    [-1]: [...T[0].slice(N / 2), T[0][0], ...chain],
  };
  const lStops = [
    { v: W.crotch - Math.min(0.04 * H, 0.2 * (W.crotch - W.knee)), name: 'upper thigh' }, { v: W.knee, name: 'knee', joint: true },
    { v: W.ankle, name: 'ankle', joint: false }, { v: 0.014 * H, name: 'sole' },
  ];
  const legYs = ringStations(lStops, [k, k + 1, P.footRings], P.jointLoops, delta);
  for (const sign of [1, -1]) {
    const side = sign > 0 ? 'L' : 'R';
    const pbase = sign > 0 ? 11 : 14;
    let expX = sign * M.trunk(W.crotch + 0.02 * H).rx * 0.5;
    const rings = [legLoop[sign]];
    const ringY = [W.crotch];
    for (const { v: y } of legYs) {
      const sec = M.leg(sign, y, expX);
      expX = sec.cx;
      const r = (sec.rx + sec.rz) / 2;
      const ring = [];
      for (let q = 0; q < N; q++) {
        const psi = (sign > 0 ? 0 : Math.PI) + (2 * Math.PI * q) / N;
        ring.push(addV(sec.cx + s0 * sec.rx * Math.sin(psi), y, sec.cz + s0 * sec.rz * Math.cos(psi), 1, y, rho(sec.rx, sec.rz, psi, r)));
      }
      rings.push(ring);
      ringY.push(y);
    }
    for (let j = 0; j < rings.length - 1; j++) {
      const ym = (ringY[j] + ringY[j + 1]) / 2;
      const part = pbase + (ym > W.knee ? 0 : ym > W.ankle ? 1 : 2);
      for (let q = 0; q < N; q++) {
        const q2 = (q + 1) % N;
        quad(rings[j][q], rings[j][q2], rings[j + 1][q2], rings[j + 1][q], part);
      }
    }
    legYs.forEach((r, j) => loops.push({ name: (r.name || 'leg ' + j) + ' ' + side, verts: rings[j + 1].slice(), station: !!r.station, axis: 1 }));
    const last = rings[rings.length - 1];
    const sole = M.leg(sign, 0.004 * H, expX);
    cap(last, a / 2, [sole.cx, 0, sole.cz], [0, -1, 0], pbase + 2);
  }

  // ---------------- arms ----------------
  const hole = (c0, c1) => {
    const L = [];
    for (let i = c0; i <= c1; i++) L.push(T[jA][i]);
    for (let j = jA + 1; j <= jA + a - 1; j++) L.push(T[j][c1]);
    for (let i = c1; i >= c0; i--) L.push(T[jA + a][i]);
    for (let j = jA + a - 1; j >= jA + 1; j--) L.push(T[j][c0]);
    return L;
  };
  const aStops = [
    { v: W.shoulderX * 1.15, name: 'upper arm' }, { v: W.elbowX, name: 'elbow', joint: true },
    { v: W.wristX, name: 'wrist', joint: true }, { v: W.tipX - 0.022 * H, name: 'fingers' },
  ];
  const armXs = ringStations(aStops, [k, k, P.handRings], P.jointLoops, delta);
  for (const sign of [1, -1]) {
    const side = sign > 0 ? 'L' : 'R';
    const pbase = sign > 0 ? 5 : 8;
    const rings = [sign > 0 ? hole(cL0, cL1) : hole(cR0, cR1)];
    const ringX = [W.shoulderX];
    for (const { v: x } of armXs) {
      const sec = M.arm(sign, x);
      const r = (sec.ry + sec.rz) / 2;
      const ring = [];
      for (let q = 0; q < N; q++) {
        const w = (2 * Math.PI * (q - a / 2)) / N;
        const y = sec.cy - s0 * sec.ry * Math.cos(w);
        const z = sec.cz - sign * s0 * sec.rz * Math.sin(w);
        ring.push(addV(sign * x, y, z, 0, sign * x, rho(sec.rz, sec.ry, w, r)));
      }
      rings.push(ring);
      ringX.push(x);
    }
    for (let j = 0; j < rings.length - 1; j++) {
      const xm = (ringX[j] + ringX[j + 1]) / 2;
      const part = pbase + (xm < W.elbowX ? 0 : xm < W.wristX ? 1 : 2);
      for (let q = 0; q < N; q++) {
        const q2 = (q + 1) % N;
        quad(rings[j][q], rings[j][q2], rings[j + 1][q2], rings[j + 1][q], part);
      }
    }
    armXs.forEach((r, j) => loops.push({ name: (r.name || 'arm ' + j) + ' ' + side, verts: rings[j + 1].slice(), station: !!r.station, axis: 0 }));
    const tip = M.arm(sign, W.tipX);
    cap(rings[rings.length - 1], 0, [sign * W.tipX, tip.cy, tip.cz], [sign, 0, 0], pbase + 2);
  }

  // ---------------- compact, orient ----------------
  const nAll = pos.length / 3;
  const used = new Uint8Array(nAll);
  for (const q of quads) used[q] = 1;
  const remap = new Int32Array(nAll).fill(-1);
  let nV = 0;
  for (let i = 0; i < nAll; i++) if (used[i]) remap[i] = nV++;
  const out = {
    nV,
    pos: new Float64Array(nV * 3), anchorAxis: new Int8Array(nV), anchorVal: new Float64Array(nV), rref: new Float64Array(nV),
    quads: new Int32Array(quads.length), fpart: new Uint8Array(fpart),
  };
  for (let i = 0; i < nAll; i++) {
    const j = remap[i];
    if (j < 0) continue;
    out.pos.set(pos.slice(3 * i, 3 * i + 3), 3 * j);
    out.anchorAxis[j] = anchorAxis[i]; out.anchorVal[j] = anchorVal[i]; out.rref[j] = rref[i];
  }
  for (let i = 0; i < quads.length; i++) out.quads[i] = remap[quads[i]];
  out.loops = loops.map((l) => ({ ...l, verts: l.verts.map((v) => remap[v]) }));
  orient(out);
  out.check = checkManifold(out);
  return out;
}

function edgeFaces(quads) {
  const map = new Map();
  const nF = quads.length / 4;
  for (let f = 0; f < nF; f++) for (let i = 0; i < 4; i++) {
    const a = quads[4 * f + i], b = quads[4 * f + ((i + 1) % 4)];
    const key = a < b ? a * 2097152 + b : b * 2097152 + a;
    let e = map.get(key);
    if (!e) { e = []; map.set(key, e); }
    e.push(f);
  }
  return map;
}

// Make face windings consistent, then point normals outward (positive volume).
function orient(mesh) {
  const Q = mesh.quads, nF = Q.length / 4;
  const ef = edgeFaces(Q);
  const done = new Uint8Array(nF);
  const dirOf = (f, a, b) => {
    for (let i = 0; i < 4; i++) {
      if (Q[4 * f + i] === a && Q[4 * f + ((i + 1) % 4)] === b) return 1;
      if (Q[4 * f + i] === b && Q[4 * f + ((i + 1) % 4)] === a) return -1;
    }
    return 0;
  };
  const flip = (f) => { const t = Q[4 * f + 1]; Q[4 * f + 1] = Q[4 * f + 3]; Q[4 * f + 3] = t; };
  for (let s = 0; s < nF; s++) {
    if (done[s]) continue;
    done[s] = 1;
    const queue = [s];
    while (queue.length) {
      const f = queue.pop();
      for (let i = 0; i < 4; i++) {
        const a = Q[4 * f + i], b = Q[4 * f + ((i + 1) % 4)];
        const key = a < b ? a * 2097152 + b : b * 2097152 + a;
        for (const g of ef.get(key)) {
          if (g === f || done[g]) continue;
          if (dirOf(g, a, b) === 1) flip(g);
          done[g] = 1;
          queue.push(g);
        }
      }
    }
  }
  const p = mesh.pos;
  let vol = 0;
  const tri = (i, j, k) => {
    const ax = p[3 * i], ay = p[3 * i + 1], az = p[3 * i + 2];
    const bx = p[3 * j], by = p[3 * j + 1], bz = p[3 * j + 2];
    const cx = p[3 * k], cy = p[3 * k + 1], cz = p[3 * k + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  };
  for (let f = 0; f < nF; f++) { tri(Q[4 * f], Q[4 * f + 1], Q[4 * f + 2]); tri(Q[4 * f], Q[4 * f + 2], Q[4 * f + 3]); }
  if (vol < 0) for (let f = 0; f < nF; f++) flip(f);
}

export function checkManifold(mesh) {
  const ef = edgeFaces(mesh.quads);
  let bad = 0;
  for (const fs of ef.values()) if (fs.length !== 2) bad++;
  const val = new Int32Array(mesh.nV);
  for (const key of ef.keys()) { val[Math.floor(key / 2097152)]++; val[key % 2097152]++; }
  let poles3 = 0, poles5 = 0, polesOther = 0;
  for (let i = 0; i < mesh.nV; i++) { if (val[i] === 3) poles3++; else if (val[i] === 5) poles5++; else if (val[i] !== 4) polesOther++; }
  return { edges: ef.size, badEdges: bad, poles3, poles5, polesOther, faces: mesh.quads.length / 4, verts: mesh.nV, valence: val };
}
