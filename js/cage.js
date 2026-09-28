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
  // only tighten: flat fronts keep the ring's mean radius, or pressure there gets too weak to
  // resist the pull of the crotch chain (that dented the lower belly)
  return Math.min(Math.max(r, 0.2 * mean), mean);
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

  const setP = (i, p) => { pos[3 * i] = p[0]; pos[3 * i + 1] = p[1]; pos[3 * i + 2] = p[2]; };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const faceIds = []; // trunk face index by [ring row][column], for the face insets

  // Border of an a x a block of faces cut from a stack of rings (columns wrap around).
  const holeLoop = (R, j0, c0, A, n) => {
    const col = (c) => ((c % n) + n) % n;
    const L = [];
    for (let t = 0; t <= A; t++) L.push(R[j0][col(c0 + t)]);
    for (let j = j0 + 1; j <= j0 + A - 1; j++) L.push(R[j][col(c0 + A)]);
    for (let t = A; t >= 0; t--) L.push(R[j0 + A][col(c0 + t)]);
    for (let j = j0 + A - 1; j >= j0 + 1; j--) L.push(R[j][col(c0)]);
    return L;
  };
  const inBlock = (j, i, j0, c0, A, n) => j >= j0 && j < j0 + A && ((((i - c0) % n) + n) % n) < A;

  // Widen a ring: each listed edge of the small ring becomes three edges of the new ring
  // (a "1-to-3" unit: two poles, all quads). Read the other way it is the classic
  // 3-to-1 reduction used to bring finger loops down to the wrist.
  const expandStrip = (small, units, part) => {
    const n = small.length, big = [], inner = [];
    const nv = () => addV(0, 0, 0, -1, 0, rref[small[0]]);
    big.push(nv());
    for (let e = 0; e < n; e++) {
      const s0 = small[e], s1 = small[(e + 1) % n];
      const last = e === n - 1;
      const b0 = big[big.length - 1];
      if (units.has(e)) {
        const b1 = nv(), b2 = nv();
        big.push(b1, b2);
        const b3 = last ? big[0] : nv();
        if (!last) big.push(b3);
        const v1 = nv(), v2 = nv();
        inner.push([v1, s0, s1, b1, 1 / 3], [v2, s0, s1, b2, 2 / 3]);
        quad(s0, v1, b1, b0, part); quad(v1, v2, b2, b1, part); quad(v2, s1, b3, b2, part); quad(s0, s1, v2, v1, part);
      } else {
        const b1 = last ? big[0] : nv();
        if (!last) big.push(b1);
        quad(s0, s1, b1, b0, part);
      }
    }
    const finish = () => { for (const [v, s0, s1, b, t] of inner) setP(v, lerp3(lerp3(P3(s0), P3(s1), t), P3(b), 0.5)); };
    return { big, finish };
  };
  // `count` units spread along edges [start, start + len); flip = mirror the pattern within that
  // run, so a right hand (walked the other way round) gets the left hand's exact mirror image
  const unitsOn = (start, len, count, flip = false) => {
    const set = new Set();
    for (let i = 0; i < count; i++) {
      const o = Math.min(len - 1, Math.floor(((i + 0.5) * len) / count));
      set.add(start + (flip ? len - 1 - o : o));
    }
    return set;
  };

  // A tube grown from a border loop along a path: every ring keeps the loop's vertex order,
  // each vertex placed on an ellipse (ra along 'up', rb across) around the path.
  const tubeFromLoop = (loop, path, part, opts = {}) => {
    const n = loop.length;
    let c0 = [0, 0, 0];
    for (const v of loop) { const p = P3(v); c0 = [c0[0] + p[0] / n, c0[1] + p[1] / n, c0[2] + p[2] / n]; }
    const offs = loop.map((v) => { const p = P3(v); return [p[0] - c0[0], p[1] - c0[1], p[2] - c0[2]]; });
    let prev = loop;
    const rings = [];
    for (let k = 0; k < path.length; k++) {
      const { c, d, ra, rb } = path[k];
      const up0 = opts.up || [0, 1, 0];
      let e1 = [up0[0] - d[0] * (up0[0] * d[0] + up0[1] * d[1] + up0[2] * d[2]), up0[1] - d[1] * (up0[0] * d[0] + up0[1] * d[1] + up0[2] * d[2]), up0[2] - d[2] * (up0[0] * d[0] + up0[1] * d[1] + up0[2] * d[2])];
      const l1 = Math.hypot(...e1) || 1; e1 = e1.map((x) => x / l1);
      const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
      const ring = offs.map((o) => {
        const od = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
        const q = [o[0] - od * d[0], o[1] - od * d[1], o[2] - od * d[2]];
        const u1 = q[0] * e1[0] + q[1] * e1[1] + q[2] * e1[2], u2 = q[0] * e2[0] + q[1] * e2[1] + q[2] * e2[2];
        const L = Math.hypot(u1, u2) || 1, cu = u1 / L, su = u2 / L;
        const r = 1 / Math.sqrt((cu / ra) ** 2 + (su / rb) ** 2);
        const t = Math.atan2(su, cu);
        const p = [c[0] + (e1[0] * cu + e2[0] * su) * r, c[1] + (e1[1] * cu + e2[1] * su) * r, c[2] + (e1[2] * cu + e2[2] * su) * r];
        const ax = opts.axis ?? -1;
        return addV(p[0], p[1], p[2], ax, ax >= 0 ? c[ax] : 0, rho(rb, ra, t, (ra + rb) / 2));
      });
      for (let i = 0; i < n; i++) quad(prev[i], prev[(i + 1) % n], ring[(i + 1) % n], ring[i], part);
      rings.push(ring);
      prev = ring;
    }
    if (opts.cap !== false) {
      const last = path[path.length - 1];
      const tip = opts.tip || [last.c[0] + last.d[0] * last.rb, last.c[1] + last.d[1] * last.rb, last.c[2] + last.d[2] * last.rb];
      cap(prev, 0, tip, last.d, part);
    }
    return rings;
  };
  const pathBetween = (a, b, count, raFn, rbFn, from = 0, to = 1) => {
    const d0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(...d0) || 1, d = d0.map((x) => x / L);
    return Array.from({ length: count }, (_, i) => {
      const t = from + ((to - from) * (i + 1)) / count;
      return { c: lerp3(a, b, t), d, ra: raFn(t), rb: rbFn(t) };
    });
  };

  // Inset a block of faces: a new loop of quads runs round its border (loops round eyes,
  // mouth, the face). Face ids stay valid; the block's faces move onto the new inner vertices.
  const inset = (fids, amount, part, name) => {
    const cnt = new Map();
    const key = (a, b) => (a < b ? a * 2097152 + b : b * 2097152 + a);
    for (const f of fids) for (let i = 0; i < 4; i++) { const k2 = key(quads[4 * f + i], quads[4 * f + ((i + 1) % 4)]); cnt.set(k2, (cnt.get(k2) || 0) + 1); }
    let cx = 0, cy = 0, cz = 0, nn = 0;
    for (const f of fids) for (let i = 0; i < 4; i++) { const p = P3(quads[4 * f + i]); cx += p[0]; cy += p[1]; cz += p[2]; nn++; }
    const cen = [cx / nn, cy / nn, cz / nn];
    const border = new Map();
    const edges = [];
    for (const f of fids) for (let i = 0; i < 4; i++) {
      const a0 = quads[4 * f + i], b0 = quads[4 * f + ((i + 1) % 4)];
      if (cnt.get(key(a0, b0)) === 1) edges.push([a0, b0]);
    }
    const inner = (v) => {
      if (!border.has(v)) border.set(v, addV(...lerp3(P3(v), cen, amount), -1, 0, rref[v]));
      return border.get(v);
    };
    for (const [a0, b0] of edges) { inner(a0); inner(b0); }
    for (const f of fids) for (let i = 0; i < 4; i++) { const v = quads[4 * f + i]; if (border.has(v)) quads[4 * f + i] = border.get(v); }
    const quadOf = new Map();
    for (const [a0, b0] of edges) { quadOf.set(a0, quads.length / 4); quad(a0, b0, border.get(b0), border.get(a0), part); }
    // the new loop, in order round the border, starting at a corner of the block (a border vertex
    // on a single face of it)
    const inBlock = new Map();
    for (const f of fids) for (let i = 0; i < 4; i++) { const w = quads[4 * f + i]; inBlock.set(w, (inBlock.get(w) || 0) + 1); }
    const next = new Map(edges.map(([a0, b0]) => [a0, b0]));
    const start = (edges.find(([a0]) => inBlock.get(border.get(a0)) === 1) || edges[0])[0];
    const ring = [], outer = [], ringQuads = [];
    let v = start;
    for (let g = 0; g < edges.length && v !== undefined; g++) { ring.push(border.get(v)); outer.push(v); ringQuads.push(quadOf.get(v)); v = next.get(v); if (v === start) break; }
    if (name) loops.push({ name, verts: ring, station: true, axis: -1 });
    ring.outer = outer; ring.quads = ringQuads;
    return ring;
  };

  // Twice the density inside an inset loop: every face inside is split in four, and the loop's own
  // ring of quads makes the step between densities, two quads into three with no new vertices
  // (a 5-pole outside, a 3-pole inside). All quads, still one closed mesh.
  const refineInside = (ring, seedFaces) => {
    const n = ring.length;
    if (n % 2) return;
    const key = (a, b) => (a < b ? a * 2097152 + b : b * 2097152 + a);
    const ringQ = new Set(ring.quads);
    // faces inside the loop: flood from the seeds across shared edges, stopping at the ring
    const eFaces = new Map();
    for (let f = 0; f < quads.length / 4; f++) for (let i = 0; i < 4; i++) {
      const k2 = key(quads[4 * f + i], quads[4 * f + ((i + 1) % 4)]);
      let arr = eFaces.get(k2); if (!arr) { arr = []; eFaces.set(k2, arr); } arr.push(f);
    }
    const inside = new Set(), stack = [...seedFaces];
    while (stack.length) {
      const f = stack.pop();
      if (inside.has(f) || ringQ.has(f)) continue;
      inside.add(f);
      for (let i = 0; i < 4; i++) for (const g of eFaces.get(key(quads[4 * f + i], quads[4 * f + ((i + 1) % 4)]))) if (!inside.has(g) && !ringQ.has(g)) stack.push(g);
    }
    const mid = new Map();
    const midOf = (a, b) => {
      const k2 = key(a, b);
      if (!mid.has(k2)) { const pa = P3(a), pb = P3(b); mid.set(k2, addV((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2, -1, 0, (rref[a] + rref[b]) / 2)); }
      return mid.get(k2);
    };
    for (const f of inside) {
      const [a0, b0, c0, d0] = quads.slice(4 * f, 4 * f + 4), part = fpart[f];
      const pa = P3(a0), pb = P3(b0), pc = P3(c0), pd = P3(d0);
      const C = addV((pa[0] + pb[0] + pc[0] + pd[0]) / 4, (pa[1] + pb[1] + pc[1] + pd[1]) / 4, (pa[2] + pb[2] + pc[2] + pd[2]) / 4, -1, 0, (rref[a0] + rref[b0] + rref[c0] + rref[d0]) / 4);
      const ab = midOf(a0, b0), bc = midOf(b0, c0), cd = midOf(c0, d0), da = midOf(d0, a0);
      quads.splice(4 * f, 4, a0, ab, C, da);
      quad(ab, b0, bc, C, part); quad(C, bc, c0, cd, part); quad(da, C, cd, d0, part);
    }
    // the ring: pairs of quads (o0 o1 i1 i0)(o1 o2 i2 i1) -> (o0 o1 m1 i0)(o1 o2 i2 m2)(o1 m2 i1 m1)
    for (let k = 0; k < n; k += 2) {
      const i0 = ring[k], i1 = ring[k + 1], i2 = ring[(k + 2) % n];
      const o0 = ring.outer[k], o1 = ring.outer[k + 1], o2 = ring.outer[(k + 2) % n];
      const m1 = mid.get(key(i0, i1)), m2 = mid.get(key(i1, i2));
      if (m1 === undefined || m2 === undefined) continue;
      const q1 = ring.quads[k], q2 = ring.quads[k + 1], part = fpart[q1];
      quads.splice(4 * q1, 4, o0, o1, m1, i0);
      quads.splice(4 * q2, 4, o1, o2, i2, m2);
      quad(o1, m2, i1, m1, part);
    }
    // loops through the refined area pick up the new midpoints
    for (const L of loops) {
      const out = [];
      for (let i = 0; i < L.verts.length; i++) {
        const a0 = L.verts[i], b0 = L.verts[(i + 1) % L.verts.length];
        out.push(a0);
        const m = mid.get(key(a0, b0));
        if (m !== undefined) out.push(m);
      }
      L.verts = out;
    }
  };

  // ---------------- trunk ----------------
  const k = P.rings;
  const yBottom = W.crotch + 0.012 * H;
  const crown = W.chin + 0.8 * (H - W.chin);
  const tStops = [
    { v: yBottom, name: 'crotch' }, { v: W.hip, name: 'hip' }, { v: W.waist, name: 'waist' }, { v: W.armpit, name: 'armpit' },
    { v: W.shoulder, name: 'shoulder' }, { v: W.neck, name: 'neck' }, { v: W.chin, name: 'chin' }, { v: crown, name: 'crown' },
  ];
  const tCounts = [k, k, k, a - 1, Math.max(0, k - 1), 0, P.face ? 0 : P.headRings];
  let trunkYs = ringStations(tStops, tCounts, false, delta);
  // face: head rings at Loomis face heights (fractions of chin -> top of head)
  const FACE = { mouthLo: 1, mouthHi: 2, eyeLo: 4, eyeHi: 5, faceLo: 0, faceHi: 6 };
  let headRow0 = -1;
  if (P.face) {
    trunkYs = trunkYs.filter((r) => r.name !== 'crown');
    headRow0 = trunkYs.length - 1; // the chin ring
    const hh = H - W.chin;
    const names = ['mouth low', 'mouth high', 'nose', 'eye low', 'eye high', 'brow', 'crown'];
    [0.13, 0.27, 0.37, 0.46, 0.57, 0.68, 0.8].forEach((f, i) => trunkYs.push({ v: W.chin + f * hh, name: names[i], station: i === 3 }));
  }
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
    faceIds[j] = [];
    for (let i = 0; i < N; i++) {
      if (j >= jA && j < jA + a && ((i >= cL0 && i < cL1) || (i >= cR0 && i < cR1))) continue;
      const i2 = (i + 1) % N;
      faceIds[j][i] = fpart.length;
      quad(T[j][i], T[j][i2], T[j + 1][i2], T[j + 1][i], part);
    }
  }
  if (P.face && headRow0 >= 0) {
    // front faces: nf per side of the centre line
    const nf = Math.max(1, N / 8);
    const front = (sideSign) => Array.from({ length: nf }, (_, q) => (sideSign > 0 ? q : N - 1 - q));
    const rowsFace = [];
    for (let r = FACE.faceLo; r < FACE.faceHi; r++) rowsFace.push(headRow0 + r);
    const block = [];
    // one extra column each side, so eyes and mouth sit inside the face loop
    const wide = (sg) => Array.from({ length: nf + 1 }, (_, q) => (sg > 0 ? q : N - 1 - q));
    for (const j of rowsFace) for (const i of [...wide(1), ...wide(-1)]) block.push(faceIds[j][i]);
    const faceRing = inset(block, 0.12, 4, 'face');
    // eyes need a face of their own each side with the nose bridge between (16+ round)
    if (N >= 16) for (const sg of [1, -1]) {
      const eye = [faceIds[headRow0 + FACE.eyeLo][front(sg)[nf - 1]]];
      inset(eye, 0.3, 4, 'eye ' + (sg > 0 ? 'L' : 'R'));
      inset(eye, 0.35, 4, 'eyelid ' + (sg > 0 ? 'L' : 'R'));
    }
    const mouth = [faceIds[headRow0 + FACE.mouthLo][0], faceIds[headRow0 + FACE.mouthLo][N - 1]];
    inset(mouth, 0.25, 4, 'mouth');
    inset(mouth, 0.35, 4, 'lips');
    if (P.faceRefine) refineInside(faceRing, block);
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
  const digits = P.digits !== false;
  const lStops = [
    { v: W.crotch - Math.min(0.04 * H, 0.2 * (W.crotch - W.knee)), name: 'upper thigh' }, { v: W.knee, name: 'knee', joint: true },
    { v: W.ankle, name: 'ankle', joint: false }, { v: 0.014 * H, name: 'sole' },
  ];
  // with a foot, the rings under the ankle are exactly a rows: the foot grows from an a x a block
  const legYs = ringStations(lStops, [k, k + 1, digits ? a - 1 : P.footRings], P.jointLoops, delta);
  const jAnk = 1 + legYs.findIndex((r) => r.name === 'ankle');
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
    // the front block (toward +z) under the ankle is where the foot leaves the leg
    const fc0 = sign > 0 ? N - a / 2 : N / 2 - a / 2;
    for (let j = 0; j < rings.length - 1; j++) {
      const ym = (ringY[j] + ringY[j + 1]) / 2;
      const part = pbase + (ym > W.knee ? 0 : ym > W.ankle ? 1 : 2);
      for (let q = 0; q < N; q++) {
        if (digits && inBlock(j, q, jAnk, fc0, a, N)) continue;
        const q2 = (q + 1) % N;
        quad(rings[j][q], rings[j][q2], rings[j + 1][q2], rings[j + 1][q], part);
      }
    }
    legYs.forEach((r, j) => loops.push({ name: (r.name || 'leg ' + j) + ' ' + side, verts: rings[j + 1].slice(), station: !!r.station, axis: 1 }));
    const last = rings[rings.length - 1];
    const sole = M.leg(sign, 0.004 * H, expX);
    cap(last, a / 2, [sole.cx, 0, sole.cz], [0, -1, 0], pbase + 2);
    if (digits) buildFoot(sign, holeLoop(rings, jAnk, fc0, a, N), pbase + 2, side, expX);
  }

  function buildFoot(sign, loop, part, side, legX) {
    const F = M.foot(sign, legX);
    const mm = N / 8;
    let c = [0, 0, 0];
    for (const v of loop) { const p = P3(v); c = [c[0] + p[0] / loop.length, c[1] + p[1] / loop.length, c[2] + p[2] / loop.length]; }
    const zBall = F.zToe - 0.27 * F.len;
    const nR = Math.max(1, P.footRings);
    const path = [];
    for (let i = 1; i <= nR; i++) {
      const t = i / nR, z = c[2] + (zBall - c[2]) * t;
      const f = F.at(z);
      path.push({ c: [f.cx, f.h * 0.5, z], d: [0, 0, 1], ra: Math.max(f.h * 0.5 * Math.max(s0, 0.6), 0.004 * H), rb: Math.max(f.w * 0.5 * Math.max(s0, 0.6), 0.004 * H) });
    }
    const fr = tubeFromLoop(loop, path, part, { cap: false, axis: -1 });
    fr.forEach((r, i) => loops.push({ name: 'foot ' + (i + 1) + ' ' + side, verts: r.slice(), station: false, axis: -1 }));
    // widen for the toes in two stages, so no two 1-to-3 units touch (that would make 6-edge poles).
    // The loop starts on the instep, runs down the far side, back along the sole, up the near side.
    const lastRing = fr[fr.length - 1];
    const q2 = 2 * mm;
    const zMid = zBall + 0.025 * F.len;
    const fMid = F.at(zMid);
    // the loop starts on the hole's first column, which lies toward smaller x on both legs
    // (inner side of the left leg, outer side of the right): fixed by construction, not measured
    const cdir0 = 1;
    const footWalk = (f, z, counts) => {
      // corners in (across, up): start on the instep at the loop's first side
      const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
      const pts = [];
      for (let sd = 0; sd < 4; sd++) {
        const A0 = corners[sd], A1 = corners[(sd + 1) % 4];
        for (let t = 0; t < counts[sd]; t++) {
          const u = t / counts[sd];
          const au = A0[0] + (A1[0] - A0[0]) * u, av = A0[1] + (A1[1] - A0[1]) * u;
          pts.push([f.cx + cdir0 * au * f.w * 0.46, 0.012 * H + ((av + 1) / 2) * Math.max(f.h - 0.012 * H, 0.01 * H) * 0.9, z]);
        }
      }
      return pts;
    };
    const ffl = sign < 0;
    const exA = expandStrip(lastRing, new Set([...unitsOn(0, q2, mm, ffl), ...unitsOn(2 * q2, q2, mm, ffl)]), part);
    footWalk(fMid, zMid, [4 * mm, 2 * mm, 4 * mm, 2 * mm]).forEach((p, i) => setP(exA.big[i], p));
    exA.finish();
    // no anchors along the foot: once the hull settles the foot a little shorter, anchors fight it
    const ex = expandStrip(exA.big, new Set([...unitsOn(0, 4 * mm, mm, ffl), ...unitsOn(6 * mm, 4 * mm, mm, ffl)]), part);
    const C = 6 * mm, R2 = 2 * mm, big = ex.big;
    // end grid: r = 0 sole, r = R2 instep; c = 0 on the loop's first side
    const G = new Array((C + 1) * (R2 + 1));
    let idx = 0;
    for (let cc = 0; cc <= C; cc++) G[R2 * (C + 1) + cc] = big[idx++];
    for (let rr = R2 - 1; rr >= 0; rr--) G[rr * (C + 1) + C] = big[idx++];
    for (let cc = C - 1; cc >= 0; cc--) G[cc] = big[idx++];
    for (let rr = 1; rr < R2; rr++) G[rr * (C + 1)] = big[idx++];
    const zEnd = zBall + 0.05 * F.len;
    const fEnd = F.at(zEnd);
    const cdir = 1; // c = 0 at smaller x
    const gx = (cc) => fEnd.cx + cdir * (-0.5 + cc / C) * fEnd.w * 0.95;
    const gy = (rr) => 0.012 * H + (rr / R2) * Math.max(fEnd.h - 0.012 * H, 0.01 * H) * 0.9;
    for (let rr = 0; rr <= R2; rr++) for (let cc = 0; cc <= C; cc++) {
      const i = rr * (C + 1) + cc;
      if (G[i] === undefined) G[i] = addV(0, 0, 0, -1, 0, rref[big[0]]);
      setP(G[i], [gx(cc), gy(rr), zEnd]);
    }
    ex.finish();
    // toe blocks sit in the sole-side row; the big toe is on the inner side (toward x = 0)
    const innerAtC0 = sign > 0;
    const order = innerAtC0 ? [0, 1, 2, 3, 4, 5] : [5, 4, 3, 2, 1, 0]; // block index from the inner side
    const toeOfBlock = new Map([[order[0], 0], [order[2], 1], [order[3], 2], [order[4], 3], [order[5], 4]]);
    const Gv = (cc, rr) => G[rr * (C + 1) + cc];
    for (let rr = 0; rr < R2; rr++) for (let cc = 0; cc < C; cc++) {
      const blk = Math.floor(cc / mm);
      if (rr < mm && toeOfBlock.has(blk)) continue;
      quad(Gv(cc, rr), Gv(cc + 1, rr), Gv(cc + 1, rr + 1), Gv(cc, rr + 1), part);
    }
    const TOE_LEN = [0.23, 0.2, 0.18, 0.16, 0.13], TOE_R = [0.07, 0.048, 0.045, 0.042, 0.038];
    for (const [blk, t] of toeOfBlock) {
      const L = [];
      for (let cc = blk * mm; cc <= (blk + 1) * mm; cc++) L.push(Gv(cc, 0));
      for (let rr = 1; rr <= mm; rr++) L.push(Gv((blk + 1) * mm, rr));
      for (let cc = (blk + 1) * mm - 1; cc >= blk * mm; cc--) L.push(Gv(cc, mm));
      for (let rr = mm - 1; rr >= 1; rr--) L.push(Gv(blk * mm, rr));
      let bc = [0, 0, 0];
      for (const v of L) { const p = P3(v); bc = [bc[0] + p[0] / L.length, bc[1] + p[1] / L.length, bc[2] + p[2] / L.length]; }
      const len = TOE_LEN[t] * F.len, rr0 = TOE_R[t] * F.len;
      const tip = [bc[0] + (t === 0 ? 0 : -sign * 0.01 * t * F.len), bc[1] - 0.2 * rr0, F.zToe - (0.02 + 0.035 * t) * F.len];
      const nT = Math.max(1, P.toeRings);
      const tp = pathBetween(bc, tip, nT + 1, (u) => rr0 * (1 - 0.25 * u), (u) => rr0 * (1 - 0.2 * u) * (t === 0 ? 1.2 : 1), 0.15, 0.85).slice(0, nT);
      const tr = tubeFromLoop(L, tp, part, { axis: -1, tip });
      tr.forEach((r, i) => loops.push({ name: 'toe ' + (t + 1) + '.' + (i + 1) + ' ' + side, verts: r.slice(), station: false, axis: -1 }));
    }
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
  const aStops = digits
    ? [{ v: W.shoulderX * 1.15, name: 'upper arm' }, { v: W.elbowX, name: 'elbow', joint: true }, { v: W.wristX, name: 'wrist', joint: true }]
    : [{ v: W.shoulderX * 1.15, name: 'upper arm' }, { v: W.elbowX, name: 'elbow', joint: true }, { v: W.wristX, name: 'wrist', joint: true }, { v: W.tipX - 0.022 * H, name: 'fingers' }];
  const aCounts = digits ? [k, k] : [k, k, P.handRings];
  const armXs = ringStations(aStops, aCounts, P.jointLoops, delta);
  if (digits && P.jointLoops) armXs.pop(); // keep the wrist ring itself as the last ring before the hand
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
    if (digits) buildHand(sign, rings[rings.length - 1], ringX[ringX.length - 1], pbase + 2, side);
    else {
      const tip = M.arm(sign, W.tipX);
      cap(rings[rings.length - 1], 0, [sign * W.tipX, tip.cy, tip.cz], [sign, 0, 0], pbase + 2);
    }
  }

  function buildHand(sign, wrist, xw, part, side) {
    const mm = N / 8;
    const L = W.tipX - xw;
    const xk = xw + 0.45 * L; // knuckles
    const nP = mm + 2; // palm rings K0..Km (12m round), then the knuckle ring K(m+1) (18m round)
    const K = [];
    // palm ring: flat rounded rectangle walked [palm, side, back of hand, side], starting where
    // the wrist ring starts (palm side, the wrist ring's q = 0 corner)
    const walk = (x, counts) => {
      const sec = M.arm(sign, x);
      const hy = Math.max(sec.ry, 0.004 * H) * Math.max(s0, 0.75), hz = Math.max(sec.rz, 0.006 * H) * Math.max(s0, 0.75);
      const pts = [];
      const corners = [[1, -1], [-1, -1], [-1, 1], [1, 1]]; // (across, up): across +1 = the wrist ring's start side
      for (let sd = 0; sd < 4; sd++) {
        const A0 = corners[sd], A1 = corners[(sd + 1) % 4];
        for (let t = 0; t < counts[sd]; t++) {
          const u = t / counts[sd];
          let au = A0[0] + (A1[0] - A0[0]) * u, av = A0[1] + (A1[1] - A0[1]) * u;
          const l = Math.hypot(au, av) || 1; // round the corners a little
          au = au * 0.7 + (au / l) * 0.3 * Math.SQRT2 * 0.72; av = av * 0.7 + (av / l) * 0.3 * Math.SQRT2 * 0.72;
          pts.push([sign * x, sec.cy + av * hy, sec.cz + sign * au * hz]);
        }
      }
      return pts;
    };
    // stage 1 (wrist -> palm): one 1-to-3 unit per m edges on the palm and on the back of the hand
    const fl = sign < 0;
    const ex = expandStrip(wrist, new Set([...unitsOn(0, 2 * mm, mm, fl), ...unitsOn(4 * mm, 2 * mm, mm, fl)]), part);
    const x0 = xw + 0.12 * L;
    walk(x0, [4 * mm, 2 * mm, 4 * mm, 2 * mm]).forEach((p, i) => setP(ex.big[i], p));
    ex.finish();
    K.push(ex.big);
    for (const i of ex.big) { anchorAxis[i] = 0; anchorVal[i] = sign * x0; }
    const xAt = (j) => x0 + ((xk - x0) * j) / (nP - 1);
    for (let j = 1; j < nP - 1; j++) K.push(walk(xAt(j), [4 * mm, 2 * mm, 4 * mm, 2 * mm]).map((p) => addV(p[0], p[1], p[2], 0, p[0], rref[wrist[0]] * 0.6)));
    const n12 = 12 * mm;
    // thumb block: on the physical front (+z) side, the palm-side half, first m rows
    const thumbC0 = sign > 0 ? 11 * mm : 4 * mm;
    for (let j = 0; j < nP - 2; j++) {
      for (let q = 0; q < n12; q++) {
        if (inBlock(j, q, 0, thumbC0, mm, n12)) continue;
        quad(K[j][q], K[j][(q + 1) % n12], K[j + 1][(q + 1) % n12], K[j + 1][q], part);
      }
    }
    // stage 2 (palm -> knuckles): 2m units on the palm side, m on the back, never side by side
    const ex2 = expandStrip(K[nP - 2], new Set([...unitsOn(0, 4 * mm, 2 * mm, fl), ...unitsOn(6 * mm, 4 * mm, mm, fl)]), part);
    // the widened ring is [8m, 2m, 6m, 2m] round; the knuckle grid wants [7m, 2m, 7m, 2m], so the
    // grid starts m/2 along: the shift is shared by both corners and the hands stay mirror images
    const n18 = 18 * mm, off = Math.floor(mm / 2);
    walk(xk, [7 * mm, 2 * mm, 7 * mm, 2 * mm]).forEach((p, i) => setP(ex2.big[(i + off) % n18], p));
    ex2.finish();
    for (const i of ex2.big) { anchorAxis[i] = 0; anchorVal[i] = sign * xk; }
    K.push(ex2.big);
    K.forEach((r, i) => loops.push({ name: 'palm ' + i + ' ' + side, verts: r.slice(), station: i === nP - 1, axis: 0 }));
    // knuckle end grid 7m x 2m: finger, web, finger, web, finger, web, finger along the palm-side row;
    // the back-of-hand row roofs the knuckles
    const C = 7 * mm, R2 = 2 * mm, KL = K[nP - 1].map((_, i, arr) => arr[(i + off) % n18]);
    const G = new Array((C + 1) * (R2 + 1));
    let idx = 0;
    for (let cc = 0; cc <= C; cc++) G[cc] = KL[idx++];
    for (let rr = 1; rr <= R2; rr++) G[rr * (C + 1) + C] = KL[idx++];
    for (let cc = C - 1; cc >= 0; cc--) G[R2 * (C + 1) + cc] = KL[idx++];
    for (let rr = R2 - 1; rr >= 1; rr--) G[rr * (C + 1)] = KL[idx++];
    const Gv = (cc, rr) => G[rr * (C + 1) + cc];
    for (let rr = 1; rr < R2; rr++) for (let cc = 1; cc < C; cc++) {
      const pa = P3(Gv(cc, 0)), pb = P3(Gv(cc, R2));
      G[rr * (C + 1) + cc] = addV(...lerp3(pa, pb, rr / R2).map((v, ci) => (ci === 0 ? v + sign * 0.004 * H : v)), 0, sign * xk, rref[KL[0]]);
    }
    const isFinger = (blk) => blk % 2 === 0;
    for (let rr = 0; rr < R2; rr++) for (let cc = 0; cc < C; cc++) {
      if (rr < mm && isFinger(Math.floor(cc / mm))) continue; // finger bases
      quad(Gv(cc, rr), Gv(cc + 1, rr), Gv(cc + 1, rr + 1), Gv(cc, rr + 1), part);
    }
    // c = 0 is the wrist ring's start side: +z (index finger) for the left hand, -z (little finger) for the right
    const FL = [0.52, 0.56, 0.53, 0.42], FW = [0.105, 0.11, 0.1, 0.085], SPREAD = [0.035, 0.01, -0.012, -0.04];
    const nF = Math.max(1, P.fingerRings);
    for (let fb = 0; fb < 4; fb++) {
      const b = 2 * fb; // finger blocks are the even ones
      const f = sign > 0 ? fb : 3 - fb; // 0 index ... 3 little
      const Lp = [];
      for (let cc = b * mm; cc <= (b + 1) * mm; cc++) Lp.push(Gv(cc, 0));
      for (let rr = 1; rr <= mm; rr++) Lp.push(Gv((b + 1) * mm, rr));
      for (let cc = (b + 1) * mm - 1; cc >= b * mm; cc--) Lp.push(Gv(cc, mm));
      for (let rr = mm - 1; rr >= 1; rr--) Lp.push(Gv(b * mm, rr));
      let bc = [0, 0, 0];
      for (const v of Lp) { const p = P3(v); bc = [bc[0] + p[0] / Lp.length, bc[1] + p[1] / Lp.length, bc[2] + p[2] / Lp.length]; }
      const len = FL[f] * L, wr = FW[f] * L * 0.5;
      const tip = [sign * (Math.abs(bc[0]) + len), bc[1], bc[2] + SPREAD[f] * L];
      const hand = M.arm(sign, Math.abs(bc[0]));
      const th = Math.min(hand.ry * 0.85, wr * 0.95);
      const fp = pathBetween(bc, tip, nF + 1, (u) => th * (1 - 0.3 * u), (u) => wr * (1 - 0.25 * u), 0.12, 0.88).slice(0, nF);
      const fr = tubeFromLoop(Lp, fp, part, { axis: 0, tip });
      fr.forEach((r, i) => loops.push({ name: ['index', 'middle', 'ring', 'little'][f] + ' ' + (i + 1) + ' ' + side, verts: r.slice(), station: i > 0, axis: 0 }));
    }
    // thumb: forward, outward and a little toward the palm
    const tl = holeLoop(K, 0, thumbC0, mm, n12);
    let tc = [0, 0, 0];
    for (const v of tl) { const p = P3(v); tc = [tc[0] + p[0] / tl.length, tc[1] + p[1] / tl.length, tc[2] + p[2] / tl.length]; }
    const tdir = [sign * 0.55, -0.22, 0.8], tn = Math.hypot(...tdir);
    const tlen = 0.42 * L;
    const ttip = [tc[0] + (tdir[0] / tn) * tlen, tc[1] + (tdir[1] / tn) * tlen, tc[2] + (tdir[2] / tn) * tlen];
    const tw = 0.06 * L;
    const tp = pathBetween(tc, ttip, nF + 1, (u) => tw * (1 - 0.25 * u), (u) => tw * 1.1 * (1 - 0.2 * u), 0.15, 0.88).slice(0, nF);
    const trs = tubeFromLoop(tl, tp, part, { axis: -1, tip: ttip, up: [0, 1, 0] });
    trs.forEach((r, i) => loops.push({ name: 'thumb ' + (i + 1) + ' ' + side, verts: r.slice(), station: i > 0, axis: -1 }));
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
  const edgeSet = new Set();
  for (let f = 0; f < out.quads.length / 4; f++) for (let i = 0; i < 4; i++) {
    const a0 = out.quads[4 * f + i], b0 = out.quads[4 * f + ((i + 1) % 4)];
    edgeSet.add(a0 < b0 ? a0 * 2097152 + b0 : b0 * 2097152 + a0);
  }
  out.loops = loops.map((l) => ({ ...l, verts: l.verts.map((v) => remap[v]) })).filter((l) => l.verts.every((v, i) => {
    const w = l.verts[(i + 1) % l.verts.length];
    return v >= 0 && w >= 0 && edgeSet.has(v < w ? v * 2097152 + w : w * 2097152 + v);
  }));
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
