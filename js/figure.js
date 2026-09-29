// Figure generator: idealized reference drawings after Loomis's proportion charts.
// Outlines are authored in head units (1 head = the height of the head; y down from the
// top of the head, x from the centre line, z forward). Adult male and female are drawn
// directly; the age presets are the male figure remapped through its landmark heights
// (chin, shoulder, nipple, navel, crotch, knee, ankle, sole) with narrower bodies.
// Output: a document with three views — T-pose front, left-facing side, and a top view
// of the hands and feet — with roles already assigned.

import { createDoc, newPath, prepareImported } from './doc.js';

const U = 200; // document units per head
// Raised whenever the reference drawings change, so saved sessions holding an older copy of a
// reference figure are refreshed (2: hands and feet drawn as one outline each).
export const FIGURE_VERSION = 2;

// ---------- authored outlines (head units) ----------
// Point: [x, y] or [x, y, 'c'] for a corner. Region tags drive the age remapping.
const MALE = {
  heads: 8,
  // front view, right half (the figure's left side), from the top of the head round to the crotch
  frontHead: [[0, 0], [0.2, 0.025], [0.31, 0.12], [0.355, 0.3], [0.358, 0.45], [0.368, 0.52], [0.358, 0.6], [0.335, 0.68], [0.315, 0.77], [0.28, 0.86]],
  frontNeck: [[0.255, 0.97], [0.255, 1.12], [0.285, 1.22], [0.37, 1.28]],
  frontShoulder: [[0.58, 1.32], [0.8, 1.345], [1.0, 1.36]],
  // T-pose arm as (x, top, bottom) stations; the tip is closed with a rounded end
  arm: [[1.18, 1.37, null], [1.4, 1.41, 1.87], [1.65, 1.43, 1.85], [1.9, 1.46, 1.81], [2.12, 1.48, 1.78], [2.3, 1.49, 1.78],
    [2.52, 1.46, 1.82], [2.8, 1.49, 1.79], [3.18, 1.53, 1.73], [3.3, 1.545, 1.72], [3.55, 1.55, 1.71], [3.8, 1.565, 1.70], [3.97, 1.59, 1.68]],
  armTip: [4.03, 1.635],
  armpit: [0.96, 1.96, 'c'],
  frontTorso: [[0.9, 2.05], [0.885, 2.3], [0.845, 2.52], [0.78, 2.72], [0.725, 2.9], [0.71, 3.05], [0.73, 3.22], [0.765, 3.42], [0.795, 3.65], [0.808, 3.88], [0.8, 4.05]],
  frontLegOuter: [[0.78, 4.35], [0.72, 4.75], [0.63, 5.2], [0.555, 5.6], [0.525, 5.85], [0.52, 6.02], [0.565, 6.3], [0.56, 6.55], [0.49, 6.95], [0.41, 7.3], [0.365, 7.58], [0.375, 7.66], [0.4, 7.8], [0.47, 7.93], [0.48, 8.0, 'c']],
  frontLegInner: [[0.1, 8.0, 'c'], [0.1, 7.9], [0.155, 7.72], [0.17, 7.6], [0.155, 7.5], [0.14, 7.2], [0.115, 6.75], [0.11, 6.45], [0.125, 6.1], [0.105, 5.86], [0.088, 5.62], [0.085, 5.3], [0.1, 4.95], [0.085, 4.55], [0.045, 4.2], [0, 4.03, 'c']],
  // side view (facing left): z forward
  sideFront: [[0.05, 0], [0.28, 0.07], [0.39, 0.2], [0.43, 0.38], [0.44, 0.44], [0.415, 0.48], [0.47, 0.56], [0.53, 0.63, 'c'], [0.45, 0.67], [0.465, 0.73], [0.44, 0.78], [0.45, 0.84], [0.42, 0.93], [0.33, 0.99], [0.17, 1.04], [0.19, 1.14], [0.22, 1.27],
    [0.3, 1.36], [0.44, 1.52], [0.52, 1.8], [0.5, 2.0], [0.45, 2.12], [0.44, 2.4], [0.41, 2.7], [0.405, 3.0], [0.42, 3.3], [0.39, 3.6], [0.32, 3.85], [0.3, 4.02],
    [0.37, 4.35], [0.36, 4.85], [0.3, 5.4], [0.315, 5.72], [0.25, 5.98], [0.225, 6.3], [0.19, 6.9], [0.165, 7.45], [0.2, 7.62], [0.35, 7.76], [0.62, 7.88], [0.85, 7.95], [0.88, 8.0, 'c']],
  sideBack: [[-0.25, 8.0, 'c'], [-0.3, 7.9], [-0.27, 7.72], [-0.18, 7.52], [-0.2, 7.25], [-0.31, 6.85], [-0.42, 6.42], [-0.37, 6.1], [-0.28, 5.87], [-0.37, 5.45], [-0.45, 4.85], [-0.47, 4.3],
    [-0.555, 3.92], [-0.5, 3.55], [-0.385, 3.28], [-0.33, 3.0], [-0.39, 2.6], [-0.47, 2.12], [-0.46, 1.72], [-0.36, 1.42], [-0.25, 1.2], [-0.28, 1.0], [-0.44, 0.72], [-0.48, 0.45], [-0.41, 0.2], [-0.22, 0.04]],
  armSection: { z: -0.04, y: 1.63, rz: 0.25, ry: 0.22 },
  // top view: the size of the foot relative to the adult male's (hands follow the arm)
  foot: 1,
  landmarks: [0, 1, 1.33, 2, 3, 4, 6, 7.6, 8],
  armX: [1.0, 2.3, 3.18, 4.03],
  heightM: 1.83,
  features: 'male',
};

const FEMALE = {
  heads: 8,
  frontHead: [[0, 0], [0.2, 0.025], [0.305, 0.12], [0.345, 0.3], [0.348, 0.45], [0.356, 0.52], [0.346, 0.6], [0.322, 0.68], [0.296, 0.77], [0.25, 0.87]],
  frontNeck: [[0.21, 0.98], [0.21, 1.13], [0.24, 1.22], [0.32, 1.285]],
  frontShoulder: [[0.52, 1.325], [0.72, 1.35], [0.9, 1.375]],
  arm: [[1.05, 1.39, null], [1.3, 1.44, 1.84], [1.6, 1.46, 1.82], [1.9, 1.49, 1.79], [2.1, 1.5, 1.77], [2.25, 1.51, 1.77],
    [2.47, 1.49, 1.8], [2.75, 1.51, 1.78], [3.1, 1.55, 1.72], [3.22, 1.56, 1.715], [3.45, 1.565, 1.705], [3.7, 1.575, 1.695], [3.86, 1.595, 1.68]],
  armTip: [3.92, 1.635],
  armpit: [0.86, 1.98, 'c'],
  frontTorso: [[0.8, 2.08], [0.8, 2.3], [0.72, 2.55], [0.58, 2.78], [0.52, 2.92], [0.57, 3.15], [0.72, 3.45], [0.84, 3.75], [0.87, 3.95], [0.86, 4.12]],
  frontLegOuter: [[0.82, 4.4], [0.72, 4.85], [0.6, 5.3], [0.5, 5.7], [0.46, 5.95], [0.465, 6.1], [0.5, 6.35], [0.49, 6.6], [0.42, 7.0], [0.34, 7.35], [0.3, 7.6], [0.31, 7.68], [0.34, 7.82], [0.4, 7.93], [0.41, 8.0, 'c']],
  frontLegInner: [[0.1, 8.0, 'c'], [0.1, 7.9], [0.14, 7.72], [0.155, 7.6], [0.14, 7.48], [0.125, 7.2], [0.1, 6.75], [0.095, 6.45], [0.11, 6.1], [0.095, 5.86], [0.082, 5.62], [0.078, 5.3], [0.07, 4.9], [0.05, 4.55], [0.025, 4.25], [0, 4.12, 'c']],
  sideFront: [[0.05, 0], [0.27, 0.07], [0.37, 0.2], [0.41, 0.38], [0.415, 0.44], [0.395, 0.48], [0.44, 0.56], [0.5, 0.62, 'c'], [0.425, 0.665], [0.445, 0.72], [0.42, 0.77], [0.43, 0.83], [0.39, 0.93], [0.3, 0.99], [0.15, 1.04], [0.16, 1.15], [0.19, 1.28],
    [0.28, 1.38], [0.36, 1.62], [0.46, 1.88], [0.6, 2.1], [0.61, 2.17], [0.52, 2.33], [0.38, 2.42], [0.34, 2.65], [0.32, 2.9], [0.37, 3.2], [0.38, 3.5], [0.31, 3.85], [0.27, 4.08],
    [0.35, 4.4], [0.34, 4.9], [0.27, 5.45], [0.285, 5.75], [0.22, 6.0], [0.2, 6.3], [0.165, 6.9], [0.14, 7.45], [0.17, 7.62], [0.3, 7.76], [0.55, 7.88], [0.76, 7.95], [0.79, 8.0, 'c']],
  sideBack: [[-0.22, 8.0, 'c'], [-0.26, 7.9], [-0.23, 7.72], [-0.16, 7.52], [-0.18, 7.25], [-0.27, 6.85], [-0.36, 6.45], [-0.32, 6.12], [-0.25, 5.9], [-0.33, 5.45], [-0.42, 4.85], [-0.46, 4.35],
    [-0.6, 3.95], [-0.56, 3.6], [-0.4, 3.3], [-0.26, 2.95], [-0.3, 2.6], [-0.4, 2.15], [-0.4, 1.75], [-0.32, 1.45], [-0.22, 1.22], [-0.25, 1.0], [-0.42, 0.72], [-0.46, 0.45], [-0.39, 0.2], [-0.21, 0.04]],
  armSection: { z: -0.04, y: 1.635, rz: 0.21, ry: 0.19 },
  foot: 0.9,
  landmarks: [0, 1, 1.35, 2.17, 3.17, 4.12, 6.02, 7.6, 8],
  armX: [0.9, 2.25, 3.1, 3.92],
  heightM: 1.73,
  features: 'female',
};

// Age presets after Loomis's chart: head count, landmark heights, width factors.
export const PRESETS = {
  'male': { label: 'Adult male · 8 heads', base: MALE },
  'female': { label: 'Adult female · 8 heads', base: FEMALE },
  'age15': { label: '15 years · 7½ heads', base: MALE, marks: [0, 1, 1.3, 1.95, 2.88, 3.78, 5.63, 7.12, 7.5], body: 0.88, limb: 0.85, tip: 3.75, heightM: 1.71 },
  'age10': { label: '10 years · 7 heads', base: MALE, marks: [0, 1, 1.28, 1.9, 2.75, 3.5, 5.2, 6.64, 7], body: 0.8, limb: 0.78, tip: 3.5, heightM: 1.33, belly: 1.05 },
  'age5': { label: '5 years · 6 heads', base: MALE, marks: [0, 1, 1.25, 1.82, 2.55, 3.0, 4.42, 5.68, 6], body: 0.72, limb: 0.74, tip: 3.0, heightM: 1.07, belly: 1.15 },
  'age3': { label: '3 years · 5 heads', base: MALE, marks: [0, 1, 1.22, 1.72, 2.3, 2.62, 3.68, 4.74, 5], body: 0.66, limb: 0.72, tip: 2.5, heightM: 0.83, belly: 1.22 },
  'age1': { label: '1 year · 4 heads', base: MALE, marks: [0, 1, 1.18, 1.58, 2.08, 2.3, 2.98, 3.78, 4], body: 0.62, limb: 0.74, tip: 2.02, heightM: 0.61, belly: 1.3 },
};

// ---------- geometry helpers ----------
function catmull(pts, closed, perSeg = 10) {
  const n = pts.length, out = [];
  const P = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = p1[2] ? p1 : [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = p2[2] ? p2 : [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg, u = 1 - t;
      out.push([u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
        u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1]]);
    }
  }
  if (!closed) out.push(pts[n - 1].slice(0, 2));
  return out;
}

// one side of a drawn outline round a finger or toe: up one side from the base (centre b, at the
// web), round the tip, back down the other side. d: unit direction; widths w0 at the base, w1 at
// the tip; a slight swelling at the finger joints. Walked with the -n side first (n = d turned
// toward +v), or the +n side with flip.
function digit(b, d, len, w0, w1, flip = false, joints = !flip) {
  const n = [-d[1], d[0]], s0 = flip ? 1 : -1, r1 = w1 / 2, L = len - r1;
  const bump = (t) => (joints ? 0.022 * w0 * (Math.exp(-(((t - 0.36) / 0.1) ** 2)) + 0.7 * Math.exp(-(((t - 0.74) / 0.08) ** 2))) : 0);
  const side = (t, s) => { const w = (w0 + (w1 - w0) * t) / 2 + bump(t) / 2; return [b[0] + d[0] * L * t + s * n[0] * w, b[1] + d[1] * L * t + s * n[1] * w]; };
  const T = [0, 0.2, 0.36, 0.55, 0.74, 0.9, 1];
  const out = T.map((t) => side(t, s0));
  const c = [b[0] + d[0] * L, b[1] + d[1] * L];
  for (let k = 1; k < 6; k++) {
    const th = (Math.PI * k) / 6;
    out.push([c[0] + r1 * (Math.cos(th) * s0 * n[0] + Math.sin(th) * d[0]), c[1] + r1 * (Math.cos(th) * s0 * n[1] + Math.sin(th) * d[1])]);
  }
  for (let i = T.length - 1; i >= 0; i--) out.push(side(T[i], -s0));
  return out;
}

// neighbouring digits (specs: base, angle, length, widths) in one line, each pair joined by a
// small rounded web a little behind their bases
function digitRow(specs, web, flip = false) {
  const out = [];
  specs.forEach(([b, a, len, w0, w1], i) => {
    const d = [Math.cos(a), Math.sin(a)], pts = digit(b, d, len, w0, w1, flip);
    if (i) {
      const p = out[out.length - 1], q = pts[0], a0 = specs[i - 1][1], da = [(Math.cos(a0) + d[0]) / 2, (Math.sin(a0) + d[1]) / 2];
      out.push([(p[0] + q[0]) / 2 - web * da[0], (p[1] + q[1]) / 2 - web * da[1]]);
    }
    out.push(...pts);
  });
  return out;
}

function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0] + (x - xs[0]) * ((ys[1] - ys[0]) / (xs[1] - xs[0]));
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1]);
  const k = xs.length - 1;
  return ys[k] + (x - xs[k]) * ((ys[k] - ys[k - 1]) / (xs[k] - xs[k - 1]));
}

// ---------- build ----------
export function buildFigure(key) {
  const pr = PRESETS[key] || PRESETS.male;
  const B = pr.base;
  const marks = pr.marks || B.landmarks;
  const n = marks[marks.length - 1];
  const body = pr.body || 1, limb = pr.limb || 1, belly = pr.belly || 1;
  const tip = pr.tip || B.armTip[0];
  const Y = (y) => interp(B.landmarks, marks, y);
  // body widths: narrower bodies for children, a rounder belly (no waist) for the youngest
  const bodyX = (x, y) => {
    const w = y > 2.3 && y < 3.4 ? 1 + (belly - 1) * Math.sin(((y - 2.3) / 1.1) * Math.PI) : 1;
    return x * body * w;
  };
  const armX = (x) => (x <= B.armX[0] ? x * body : B.armX[0] * body + ((x - B.armX[0]) * (tip - B.armX[0] * body)) / (B.armX[3] - B.armX[0]));
  const armCY = B.armSection.y;
  const armY = (y) => Y(armCY) + (y - armCY) * limb;

  // front outline, right half
  const half = [];
  for (const p of B.frontHead) half.push([p[0], p[1], p[2]]);
  for (const p of B.frontNeck) half.push([p[0] * (0.6 + 0.4 * body), Y(p[1]), p[2]]);
  for (const p of B.frontShoulder) half.push([bodyX(p[0], p[1]), Y(p[1]), p[2]]);
  const arm = B.arm;
  for (const [x, top] of arm) half.push([armX(x), armY(top)]);
  half.push([armX(B.armTip[0]) - 0.02, armY(B.armTip[1]) - 0.035 * limb]);
  half.push([armX(B.armTip[0]), armY(B.armTip[1])]);
  half.push([armX(B.armTip[0]) - 0.025, armY(B.armTip[1]) + 0.035 * limb]);
  for (let i = arm.length - 1; i >= 1; i--) half.push([armX(arm[i][0]), armY(arm[i][2])]);
  half.push([bodyX(B.armpit[0], B.armpit[1]), Y(B.armpit[1]), 'c']);
  for (const p of B.frontTorso) half.push([bodyX(p[0], p[1]), Y(p[1]), p[2]]);
  for (const p of B.frontLegOuter) half.push([p[0] * body, Y(p[1]), p[2]]);
  for (const p of B.frontLegInner) half.push([p[0] * body, Y(p[1]), p[2]]);
  const front = [...half, ...half.slice(1, -1).reverse().map((p) => [-p[0], p[1], p[2]])];

  // side outline (z forward); head keeps its size, the body narrows
  const sideZ = (z, y) => (y < 1.0 ? z : z * body * (y > 2.3 && y < 3.4 && z > 0 ? 1 + (belly - 1) * Math.sin(((y - 2.3) / 1.1) * Math.PI) : 1));
  const side = [...B.sideFront, ...B.sideBack].map((p) => [sideZ(p[0], p[1]), Y(p[1]), p[2]]);
  const sec = B.armSection;

  // top view: each hand and each foot is one continuous outline, as an artist draws it. The line
  // runs up and down every finger and toe, with a narrow notch between neighbours (open toward
  // the tips) so each digit keeps its own space to inflate into; the detail pass splits the
  // outline into digits at those notches (digits.js).
  const xw = armX(B.armX[2]), xt = armX(B.armX[3]), Lh = xt - xw;
  const hz = sec.z * body;
  // hand in its own frame: u from the wrist to the middle fingertip, v across toward the thumb
  // (forward, +z); both in hand lengths. The wrist keeps the forearm's width.
  const H_ = (u, v, c) => [xw + u * Lh, hz + v * Lh, c];
  const wu = (0.14 * limb) / Lh, wr = (0.13 * limb) / Lh;
  const hand = [[0, -wu, 'c'], [0.16, -0.5 * wu - 0.11], [0.33, -0.224], [0.47, -0.218], [0.53, -0.205]];
  // fingers little -> index: base centre (at the web), angle (toward the thumb), web-to-tip length, width at base and tip
  hand.push(...digitRow([[[0.565, -0.1585], -0.1, 0.3, 0.084, 0.07], [[0.59, -0.062], -0.04, 0.38, 0.097, 0.082],
    [[0.6, 0.0445], 0, 0.4, 0.104, 0.088], [[0.585, 0.1525], 0.05, 0.37, 0.1, 0.085]], 0.006));
  // index side of the palm, the web to the thumb, the thumb (seen from its side), the thenar, the wrist
  hand.push([0.52, 0.212], [0.44, 0.226]);
  hand.push(...digit([0.3, 0.285], [0.78, 0.625], 0.25, 0.15, 0.108, false, false));
  hand.push([0.13, 0.29], [0, wr, 'c']);
  const handPts = hand.map(([u, v, c]) => H_(u, v, c));
  // left foot: x out (lateral), z forward. Heel, the outer edge, five toes from the little one in,
  // the ball and the inner edge with a shallow arch. Toes are laid out as (z, x): along, across.
  const fb = body * (B.foot || 1);
  const foot = [[0.37, -0.262], [0.405, -0.19], [0.43, 0.0], [0.462, 0.2], [0.5, 0.4], [0.516, 0.53]];
  // toes little -> big: base centre (z, x at the web), angle (lateral), web-to-tip length, width at base and tip
  const toes = digitRow([[[0.645, 0.487], 0.03, 0.075, 0.062, 0.058], [[0.685, 0.418], 0.05, 0.09, 0.064, 0.06], [[0.715, 0.346], 0.03, 0.11, 0.068, 0.064],
    [[0.735, 0.27], 0.01, 0.125, 0.072, 0.068], [[0.73, 0.163], -0.02, 0.15, 0.13, 0.122]], 0.008, true);
  foot.push(...toes.map(([z, x]) => [x, z]));
  foot.push([0.095, 0.6], [0.09, 0.48], [0.105, 0.3], [0.13, 0.1], [0.14, -0.05], [0.148, -0.19], [0.2, -0.272], [0.28, -0.292]);
  const footPts = foot.map(([x, z]) => [x * fb, z * fb]);

  // ---- to document coordinates ----
  const FX = 900, SX = FX + (tip + 0.9) * U + 0.8 * U, H = n * U, TZ = H + 1.9 * U;
  const doc = createDoc();
  const P = (pts, closed, opts) => doc.paths.push(newPath(pts, { closed, ...opts }));
  const ell = (cx, cy, rx, ry) => Array.from({ length: 20 }, (_, i) => [cx + rx * Math.cos((i / 20) * 2 * Math.PI), cy + ry * Math.sin((i / 20) * 2 * Math.PI)]);
  const toFront = (pts) => pts.map(([x, y, c]) => [FX + x * U, y * U, c]);
  P(catmull(toFront(front), true).map((p) => p.slice(0, 2)), true, { role: 'line', view: 'front' });
  P(catmull(side.map(([z, y, c]) => [SX - z * U, y * U, c]), true), true, { role: 'line', view: 'side' });
  const secPts = [];
  for (let i = 0; i < 32; i++) {
    const t = (i / 32) * Math.PI * 2;
    secPts.push([SX - (sec.z * body + sec.rz * limb * Math.cos(t)) * U, Y(sec.y) * U + sec.ry * limb * Math.sin(t) * U]);
  }
  P(secPts, true, { role: 'section', view: 'side', color: '#0e7d89', part: 'arm' });
  const plan = (pts, s) => catmull(pts.map(([x, z, c]) => [FX + s * x * U, TZ + z * U, c]), true, 6);
  for (const s of [1, -1]) {
    P(plan(handPts, s), true, { role: 'line', view: 'top' });
    P(plan(footPts, s), true, { role: 'line', view: 'top' });
  }
  // face features in the front view and the profile (head units stay the same at every age)
  const faceCol = '#b0587a', fopt = { role: 'feature', color: faceCol, group: 'face' };
  const hx = (x) => FX + x * U, hy = (y) => y * U;
  for (const s of [1, -1]) {
    P(ell(hx(s * 0.13), hy(0.5), 0.065 * U, 0.027 * U), true, { ...fopt, view: 'front' });
    P(catmull([[hx(s * 0.05), hy(0.44)], [hx(s * 0.13), hy(0.415)], [hx(s * 0.21), hy(0.43)]], false), false, { ...fopt, view: 'front' });
  }
  P(catmull([[hx(-0.06), hy(0.7)], [hx(0), hy(0.725)], [hx(0.06), hy(0.7)]], false), false, { ...fopt, view: 'front' });
  P(catmull([[hx(-0.1), hy(0.8)], [hx(-0.04), hy(0.81)], [hx(0), hy(0.805)], [hx(0.04), hy(0.81)], [hx(0.1), hy(0.8)]], false), false, { ...fopt, view: 'front' });
  const sx = (z) => SX - z * U;
  P(ell(sx(0.37), hy(0.5), 0.035 * U, 0.024 * U), true, { ...fopt, view: 'side' });
  P(catmull([[sx(0.3), hy(0.43)], [sx(0.38), hy(0.415)], [sx(0.43), hy(0.43)]], false), false, { ...fopt, view: 'side' });
  P(ell(sx(-0.1), hy(0.57), 0.07 * U, 0.12 * U), true, { ...fopt, view: 'side' });
  P(catmull([[sx(0.38), hy(0.81)], [sx(0.44), hy(0.8)]], false), false, { ...fopt, view: 'side' });
  // centre lines
  P([[FX, 0.1 * U], [FX, H - 0.05 * U]], false, { role: 'axis', view: 'front', color: '#d9822b' });
  // a few feature marks to show tags
  const kneeY = Y(5.85) * U, kneeX = 0.3 * body * U;
  for (const s of [1, -1]) P(ell(FX + s * kneeX, kneeY, 0.1 * body * U, 0.14 * U * (marks[6] - marks[5]) / 2), true, { role: 'feature', view: 'front', color: '#d9463b', group: 'kneecaps' });
  if (B.features === 'male') {
    for (const s of [1, -1]) P(catmull([[FX + s * 0.62 * U, Y(1.85) * U], [FX + s * 0.36 * U, Y(2.08) * U], [FX + s * 0.05 * U, Y(2.02) * U]].map((p) => [FX + (p[0] - FX) * body, p[1]]), false), false, { role: 'feature', view: 'front', color: '#2f9fd0', group: 'pectoral line' });
  } else {
    for (const s of [1, -1]) P(ell(FX + s * 0.33 * U, Y(2.08) * U, 0.24 * U, 0.2 * U), false, { role: 'feature', view: 'front', color: '#2f9fd0', group: 'breasts' });
  }
  P(catmull([[-0.72, 3.4], [-0.35, 3.75], [0, 3.95], [0.35, 3.75], [0.72, 3.4]].map(([x, y]) => [FX + bodyX(x, y) * U, Y(y) * U]), false), false, { role: 'feature', view: 'front', color: '#5a52c9', group: 'belt line' });
  P(ell(SX - 0.26 * body * U, kneeY, 0.07 * U, 0.12 * U), true, { role: 'feature', view: 'side', color: '#d9463b', group: 'kneecaps' });
  // proportion guides in head units, across front and side
  for (let k = 0; k <= Math.ceil(n); k++) {
    const y = Math.min(k, n) * U;
    P([[FX - (tip + 0.3) * U, y], [SX + 0.9 * U, y]], false, { role: 'guide', view: 'both', color: '#9aa1ab' });
    if (k >= n) break;
  }
  doc.heightM = pr.heightM || B.heightM;
  doc.canon = n;
  doc.splitX = (FX + (tip + 0.2) * U + SX - 0.9 * U) / 2;
  doc.splitY = H + 0.6 * U;
  doc.views.side.facing = 'left';
  doc.views.side.manual = { facing: true };
  doc.views.top = { axisX: FX, axisZ: TZ, manual: { axisX: true, axisZ: true } };
  doc.groups = {};
  prepareImported(doc, { keepRoles: true });
  for (const g of Object.values(doc.groups)) g.loop = false;
  doc.figureKey = key;
  doc.figureVersion = FIGURE_VERSION;
  return doc;
}
