// Calibration (drawing units -> metres), proportion canons, and "stations":
// named heights shared by both views (chin, armpit, waist, crotch, knee ...) plus
// arm stations along x in the front view. Stations are the features that tie the
// front drawing to the side drawing and place the cage's edge loops.

import { maskBBox, rowSpans, colSpans, sdGrad } from './mask.js';
import { clamp } from './util.js';

export const HEIGHT_STATIONS = ['ankle', 'knee', 'crotch', 'hip', 'waist', 'armpit', 'shoulder', 'neck', 'chin'];
export const ARM_STATIONS = ['shoulderX', 'elbowX', 'wristX', 'tipX'];
export const STATION_LABEL = {
  ankle: 'Ankle', knee: 'Knee', crotch: 'Crotch', hip: 'Hip', waist: 'Waist', armpit: 'Armpit', shoulder: 'Shoulder', neck: 'Neck', chin: 'Chin',
  shoulderX: 'Shoulder joint', elbowX: 'Elbow', wristX: 'Wrist', tipX: 'Fingertip',
};

// Positions in head units from the top of the head, for an 8-head figure.
const CANON8 = { chin: 1, neck: 1.3, shoulder: 1.45, armpit: 2.05, waist: 3.0, hip: 3.45, crotch: 4.0, knee: 5.85, ankle: 7.65 };

export function canonStations(n) {
  const st = {};
  for (const k of HEIGHT_STATIONS) {
    const pos8 = CANON8[k];
    const pos = pos8 <= 1 ? pos8 : 1 + ((pos8 - 1) * (n - 1)) / 7;
    st[k] = 1 - pos / n;
  }
  Object.assign(st, { shoulderX: 0.1, elbowX: 0.27, wristX: 0.405, tipX: 0.5 });
  return st;
}

// ---------- frame: document <-> world ----------
export class Frame {
  constructor(doc) {
    this.H = doc.heightM;
    const f = doc.views.front, s = doc.views.side;
    this.F = { s: this.H / Math.max(1e-6, f.floor - f.top), ax: f.axis, fl: f.floor };
    this.S = { s: this.H / Math.max(1e-6, s.floor - s.top), ax: s.axis, fl: s.floor, dir: s.facing === 'right' ? -1 : 1 };
    const t = doc.views.top || { axisX: f.axis, axisZ: 0 };
    this.T = { s: this.F.s, ax: t.axisX, az: t.axisZ }; // top view shares the front view's scale
  }
  // top view: world (x, z), front of the body toward the bottom of the page
  tw(xd, yd) { return [(xd - this.T.ax) * this.T.s, (yd - this.T.az) * this.T.s]; }
  td(x, z) { return [x / this.T.s + this.T.ax, z / this.T.s + this.T.az]; }
  // front view: world (x, y)
  fw(xd, yd) { return [(xd - this.F.ax) * this.F.s, (this.F.fl - yd) * this.F.s]; }
  fd(x, y) { return [x / this.F.s + this.F.ax, this.F.fl - y / this.F.s]; }
  // side view: world (z, y)
  sw(xd, yd) { return [this.S.dir * (this.S.ax - xd) * this.S.s, (this.S.fl - yd) * this.S.s]; }
  sd(z, y) { return [this.S.ax - (this.S.dir * z) / this.S.s, this.S.fl - y / this.S.s]; }
  // world y from normalised station height t, and back, per view in doc units
  yDoc(view, t) { const v = view === 'front' ? this.F : this.S; return v.fl - (t * this.H) / v.s; }
  tFromDoc(view, yd) { const v = view === 'front' ? this.F : this.S; return ((v.fl - yd) * v.s) / this.H; }
}

// World-space samplers on the view masks.
export function makeSamplers(frame, masks) {
  const F = frame.F, S = frame.S;
  return {
    front(x, y) {
      if (!masks.front) return { d: -1, gx: 0, gy: 0 };
      const [xd, yd] = frame.fd(x, y);
      const r = sdGrad(masks.front, xd, yd);
      return { d: r.d * F.s, gx: r.gx, gy: -r.gy };
    },
    side(z, y) {
      if (!masks.side) return { d: -1, gz: 0, gy: 0 };
      const [xd, yd] = frame.sd(z, y);
      const r = sdGrad(masks.side, xd, yd);
      return { d: r.d * S.s, gz: -S.dir * r.gx, gy: -r.gy };
    },
    top(x, z) {
      const [xd, yd] = frame.td(x, z);
      const r = sdGrad(masks.top, xd, yd);
      return { d: r.d * frame.T.s, gx: r.gx, gz: r.gy };
    },
    topCol(x) {
      if (!masks.top) return [];
      const xd = x / frame.T.s + frame.T.ax;
      return colSpans(masks.top, xd).map(([a, b]) => [(a - frame.T.az) * frame.T.s, (b - frame.T.az) * frame.T.s]);
    },
    section(z, y) {
      const m = masks.section;
      const [xd, yd] = frame.sd(z, y);
      const r = sdGrad(m, xd, yd);
      return { d: r.d * S.s, gz: -S.dir * r.gx, gy: -r.gy };
    },
    frontRow(y) {
      if (!masks.front) return [];
      const yd = F.fl - y / F.s;
      return rowSpans(masks.front, yd).map(([a, b]) => [(a - F.ax) * F.s, (b - F.ax) * F.s]);
    },
    frontCol(x) {
      if (!masks.front) return [];
      const xd = x / F.s + F.ax;
      return colSpans(masks.front, xd).map(([a, b]) => [(F.fl - b) * F.s, (F.fl - a) * F.s]);
    },
    sideRow(y) {
      if (!masks.side) return [];
      const yd = S.fl - y / S.s;
      return rowSpans(masks.side, yd).map(([a, b]) => {
        const z0 = S.dir * (S.ax - a) * S.s, z1 = S.dir * (S.ax - b) * S.s;
        return z0 < z1 ? [z0, z1] : [z1, z0];
      });
    },
  };
}

// ---------- automatic calibration from the masks ----------
export function autoCalibrate(doc, masks) {
  const f = doc.views.front, s = doc.views.side;
  if (!doc.views.top) doc.views.top = { axisX: f.axis, axisZ: 0, manual: {} };
  const tv = doc.views.top;
  if (masks.front) {
    const bb = maskBBox(masks.front);
    if (bb) {
      if (!f.manual.top) f.top = bb.y0;
      if (!f.manual.floor) f.floor = bb.y1;
      if (!f.manual.axis) {
        const axisPath = doc.paths.find((p) => p.view === 'front' && p.role === 'axis');
        if (axisPath) f.axis = axisPath.pts.reduce((a, p) => a + p[0], 0) / axisPath.pts.length;
        else f.axis = symmetryAxis(masks.front, bb);
      }
    }
  }
  if (masks.side) {
    const bb = maskBBox(masks.side);
    if (bb) {
      if (!s.manual.top) s.top = bb.y0;
      if (!s.manual.floor) s.floor = bb.y1;
      const Hd = bb.y1 - bb.y0;
      // facing: the foot sticks out toward the front
      if (!s.manual.facing) {
        const mid = (y) => { const sp = rowSpans(masks.side, y); if (!sp.length) return null; return (sp[0][0] + sp[sp.length - 1][1]) / 2; };
        const foot = mid(bb.y1 - Hd * 0.015), shin = mid(bb.y1 - Hd * 0.2);
        if (foot != null && shin != null) s.facing = foot < shin ? 'left' : 'right';
      }
      if (!s.manual.axis) {
        let acc = 0, n = 0;
        for (let t = 0.52; t <= 0.8; t += 0.02) {
          const sp = rowSpans(masks.side, bb.y1 - Hd * t);
          if (sp.length) { acc += (sp[0][0] + sp[sp.length - 1][1]) / 2; n++; }
        }
        if (n) s.axis = acc / n;
      }
    }
  }
  if (!tv.manual.axisX) tv.axisX = f.axis;
  // top view depth origin: line the feet up with the foot seen in the side view
  if (masks.top && masks.side && !tv.manual.axisZ) {
    const tb = maskBBox(masks.top), sb = maskBBox(masks.side);
    if (tb && sb) {
      const sp = rowSpans(masks.side, sb.y1 - (sb.y1 - sb.y0) * 0.01);
      const feetRows = [];
      for (let y = tb.y0; y <= tb.y1; y += masks.top.cell) {
        const r = rowSpans(masks.top, y).filter(([a, b]) => Math.abs((a + b) / 2 - tv.axisX) < (f.floor - f.top) * 0.12);
        if (r.length) feetRows.push(y);
      }
      if (sp.length && feetRows.length) {
        const sS = doc.heightM / (s.floor - s.top), sF = doc.heightM / (f.floor - f.top);
        const dir = s.facing === 'right' ? -1 : 1;
        const za = dir * (s.axis - sp[0][0]) * sS, zb = dir * (s.axis - sp[sp.length - 1][1]) * sS;
        const zc = (za + zb) / 2;
        const yc = (feetRows[0] + feetRows[feetRows.length - 1]) / 2;
        tv.axisZ = yc - zc / sF;
      }
    }
  }
}

function symmetryAxis(m, bb) {
  const Hd = bb.y1 - bb.y0;
  const cx = (bb.x0 + bb.x1) / 2;
  let acc = 0, n = 0;
  for (let t = 0.55; t <= 0.7; t += 0.01) {
    const sp = rowSpans(m, bb.y1 - Hd * t);
    const s = sp.find(([a, b]) => a <= cx && b >= cx) || sp[0];
    if (s) { acc += (s[0] + s[1]) / 2; n++; }
  }
  return n ? acc / n : cx;
}

// ---------- automatic stations from the front outline ----------
export function autoStations(doc, masks, frame) {
  const st = canonStations(doc.canon);
  if (!masks.front) return st;
  const smp = makeSamplers(frame, masks);
  const H = frame.H;
  const width = (y) => {
    const sp = smp.frontRow(y);
    const s = sp.find(([a, b]) => a <= 0 && b >= 0);
    return s ? s : null;
  };
  const step = H / 400;
  // crotch: first height (going up) where the centre line is inside the figure
  let crotch = null;
  for (let y = H * 0.25; y < H * 0.75; y += step) if (width(y)) { crotch = y; break; }
  if (crotch == null) return st;
  st.crotch = crotch / H;
  // trunk reference width just above the crotch
  const ws = [];
  for (let y = crotch + 0.05 * H; y < crotch + 0.15 * H; y += step) { const s = width(y); if (s) ws.push(s[1] - s[0]); }
  ws.sort((a, b) => a - b);
  const w0 = ws[Math.floor(ws.length / 2)] || 0.3 * H;
  let armpit = null, armTop = null;
  for (let y = crotch + 0.05 * H; y < H * 0.97; y += step) {
    const s = width(y);
    const w = s ? s[1] - s[0] : 0;
    if (w > 2.2 * w0) { if (armpit == null) armpit = y - step; armTop = y; }
    else if (armpit != null && w < 1.6 * w0) break;
  }
  if (armpit != null) {
    st.armpit = armpit / H;
    st.shoulder = Math.min(armTop / H + 0.004, 0.95);
    // arm reach
    let tip = 0;
    for (let y = armpit; y <= armTop; y += step) {
      const s = width(y);
      if (s) tip = Math.max(tip, (s[1] - s[0]) / 2);
    }
    const below = width(armpit - 0.03 * H);
    const sx = below ? (below[1] - below[0]) / 2 : 0.1 * H;
    st.shoulderX = sx / H;
    st.tipX = tip / H;
    st.elbowX = (sx + 0.4 * (tip - sx)) / H;
    st.wristX = (sx + 0.745 * (tip - sx)) / H;
  }
  // neck: narrowest point above the shoulders; chin: where the head widens again
  const yS = st.shoulder * H;
  let neck = null, nw = Infinity, headW = 0;
  for (let y = yS + step; y < H * 0.985; y += step) {
    const s = width(y); if (!s) continue;
    const w = s[1] - s[0];
    if (y < yS + 0.12 * H && w < nw) { nw = w; neck = y; }
  }
  if (neck != null) {
    for (let y = neck; y < H * 0.99; y += step) { const s = width(y); if (s) headW = Math.max(headW, s[1] - s[0]); }
    st.neck = neck / H;
    for (let y = neck; y < H * 0.99; y += step) {
      const s = width(y);
      if (s && s[1] - s[0] >= 0.62 * headW) { st.chin = y / H; break; }
    }
  }
  // waist: narrowest between crotch and armpit
  let waist = null, ww = Infinity;
  const yA = st.armpit * H;
  for (let y = crotch + 0.06 * H; y < yA - 0.05 * H; y += step) {
    const s = width(y); if (!s) continue;
    if (s[1] - s[0] < ww) { ww = s[1] - s[0]; waist = y; }
  }
  if (waist != null) st.waist = waist / H;
  st.hip = (st.crotch + st.waist) / 2;
  st.knee = st.crotch * 0.54;
  st.ankle = 0.045;
  return sanitizeStations(st);
}

export function sanitizeStations(st) {
  const order = ['ankle', 'knee', 'crotch', 'hip', 'waist', 'armpit', 'shoulder', 'neck', 'chin'];
  const gap = 0.012;
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    st[k] = clamp(st[k], 0.01 + i * gap, 0.99 - (order.length - i) * gap);
    if (i && st[k] < st[order[i - 1]] + gap) st[k] = st[order[i - 1]] + gap;
  }
  const ax = ['shoulderX', 'elbowX', 'wristX', 'tipX'];
  for (let i = 1; i < ax.length; i++) if (st[ax[i]] < st[ax[i - 1]] + 0.01) st[ax[i]] = st[ax[i - 1]] + 0.01;
  return st;
}

// ---------- measurement of cross-sections for the cage ----------
export function makeMeasure(doc, masks, frame) {
  const H = frame.H;
  const st = doc.stations;
  const smp = makeSamplers(frame, masks);
  const W = {};
  for (const k of HEIGHT_STATIONS) W[k] = st[k] * H;
  W.top = H; W.sole = 0;
  for (const k of ARM_STATIONS) W[k] = st[k] * H;
  const sideSpan = (y) => {
    const sp = smp.sideRow(y);
    if (!sp.length) return null;
    return [Math.min(...sp.map((s) => s[0])), Math.max(...sp.map((s) => s[1]))];
  };
  const nearestRow = (fn, y, dir) => {
    for (let k = 0; k < 60; k++) { const r = fn(y + dir * k * H * 0.004); if (r) return r; }
    return null;
  };
  const trunk = (y) => {
    const toward = y > W.chin ? -1 : 1;
    const f = nearestRow((yy) => {
      const sp = smp.frontRow(yy);
      if (!sp.length) return null;
      let s = sp.find(([a, b]) => a <= 0 && b >= 0);
      if (!s) s = sp.reduce((p, c) => (Math.abs((c[0] + c[1]) / 2) < Math.abs((p[0] + p[1]) / 2) ? c : p));
      return [Math.max(s[0], -W.shoulderX), Math.min(s[1], W.shoulderX)];
    }, y, toward);
    const sd = nearestRow(sideSpan, y, toward);
    const [a, b] = f || [-0.08 * H, 0.08 * H];
    const [c, d] = sd || [-0.06 * H, 0.06 * H];
    return { cx: (a + b) / 2, rx: Math.max((b - a) / 2, 0.01 * H), cz: (c + d) / 2, rz: Math.max((d - c) / 2, 0.01 * H) };
  };
  const leg = (sign, y, expX) => {
    const f = nearestRow((yy) => {
      const sp = smp.frontRow(yy).filter(([a, b]) => (sign > 0 ? b > 0 : a < 0));
      if (!sp.length) return null;
      let s = sp.reduce((p, c) => (Math.abs((c[0] + c[1]) / 2 - expX) < Math.abs((p[0] + p[1]) / 2 - expX) ? c : p));
      return sign > 0 ? [Math.max(s[0], 0), s[1]] : [s[0], Math.min(s[1], 0)];
    }, y, 1);
    const sd = nearestRow(sideSpan, y, 1);
    const [a, b] = f || [expX - 0.04 * H, expX + 0.04 * H];
    const [c, d] = sd || [-0.04 * H, 0.04 * H];
    return { cx: (a + b) / 2, rx: Math.max((b - a) / 2, 0.008 * H), cz: (c + d) / 2, rz: Math.max((d - c) / 2, 0.008 * H) };
  };
  // arm axis table: centre height and half thickness along x
  const armTable = {};
  for (const sign of [1, -1]) {
    const rows = [];
    let expY = (W.armpit + W.shoulder) / 2;
    const n = 64;
    for (let i = 0; i <= n; i++) {
      const x = sign * (W.shoulderX + ((W.tipX - W.shoulderX) * i) / n);
      const sp = smp.frontCol(x);
      let s = null;
      if (sp.length) s = sp.reduce((p, c) => (Math.abs((c[0] + c[1]) / 2 - expY) < Math.abs((p[0] + p[1]) / 2 - expY) ? c : p));
      if (s && s[1] - s[0] > 0.2 * H) s = [expY - 0.03 * H, expY + 0.03 * H]; // column hit the torso: fall back
      const cy = s ? (s[0] + s[1]) / 2 : expY;
      const ry = s ? Math.max((s[1] - s[0]) / 2, 0.004 * H) : rows.length ? rows[rows.length - 1].ry : 0.03 * H;
      rows.push({ x: Math.abs(x), cy, ry, cz: 0 });
      expY = cy;
    }
    armTable[sign] = rows;
  }
  for (const sign of [1, -1]) for (const r of armTable[sign]) r.cz = trunk(r.cy).cz;
  const armAt = (sign, x) => {
    const rows = armTable[sign];
    const ax = Math.abs(x);
    if (ax <= rows[0].x) return rows[0];
    for (let i = 1; i < rows.length; i++) {
      if (ax <= rows[i].x) {
        const t = (ax - rows[i - 1].x) / (rows[i].x - rows[i - 1].x || 1);
        return { x: ax, cy: rows[i - 1].cy + (rows[i].cy - rows[i - 1].cy) * t, ry: rows[i - 1].ry + (rows[i].ry - rows[i - 1].ry) * t, cz: rows[i - 1].cz + (rows[i].cz - rows[i - 1].cz) * t };
      }
    }
    return rows[rows.length - 1];
  };
  // Arm cross-section: its depth profile (z range per relative height) is what the arm
  // uses; its height is replaced by the arm's thickness in the front view.
  let section = null;
  if (masks.section) {
    const m = masks.section;
    const [cz, cy] = frame.sw(m.cx, m.cy);
    // Rows narrower than half of an ellipse fitted to the region's box (open or
    // U-shaped sketches) fall back to that ellipse, so the arm never collapses flat.
    const NP = 32, lo = new Float64Array(NP + 1), hi = new Float64Array(NP + 1);
    const rzBox = m.hw * frame.S.s;
    for (let i = 0; i <= NP; i++) {
      const v = -1 + (2 * i) / NP;
      const ell = rzBox * Math.sqrt(Math.max(0, 1 - v * v * 0.85));
      lo[i] = cz - ell; hi[i] = cz + ell;
      const sp = rowSpans(m, m.cy - v * m.hh * 0.96);
      if (!sp.length) continue;
      const za = frame.sw(sp[0][0], 0)[0], zb = frame.sw(sp[sp.length - 1][1], 0)[0];
      if (Math.abs(zb - za) >= ell) { lo[i] = Math.min(za, zb); hi[i] = Math.max(za, zb); }
    }
    section = { cz, cy, rz: (hi[NP / 2] - lo[NP / 2]) / 2, ry: m.hh * frame.S.s, lo, hi, NP };
  }
  const ry0 = { 1: armAt(1, W.shoulderX * 1.25).ry, [-1]: armAt(-1, W.shoulderX * 1.25).ry };
  const handDepth = (x) => {
    const sp = smp.topCol(x);
    if (!sp.length) return null;
    const s = sp.reduce((p, c) => (c[1] - c[0] > p[1] - p[0] ? c : p));
    return { cz: (s[0] + s[1]) / 2, rz: (s[1] - s[0]) / 2 };
  };
  const arm = (sign, x) => {
    const a = armAt(sign, x);
    if (masks.top && Math.abs(x) > W.wristX) {
      const h = handDepth(sign * Math.abs(x));
      if (h) return { cy: a.cy, ry: a.ry, cz: h.cz, rz: h.rz };
    }
    if (section) {
      // true depth at the shoulder, tapering with the arm's thickness in the front view
      const k = clamp(a.ry / (ry0[sign] || a.ry), 0.25, 2);
      return { cy: a.cy, ry: a.ry, cz: section.cz, rz: section.rz * k };
    }
    return { cy: a.cy, ry: a.ry, cz: a.cz, rz: a.ry };
  };
  // z limits for an arm point: section depth profile at the point's relative height
  const armDepthLimits = (sign, a, y) => {
    const k = clamp(a.ry / (ry0[sign] || a.ry), 0.25, 2);
    const v = clamp((y - a.cy) / (a.ry || 1e-6), -1, 1);
    const f = ((v + 1) / 2) * section.NP, i = Math.min(Math.floor(f), section.NP - 1), t = f - i;
    const lo = section.lo[i] + (section.lo[i + 1] - section.lo[i]) * t, hi = section.hi[i] + (section.hi[i + 1] - section.hi[i]) * t;
    return [section.cz + k * (lo - section.cz), section.cz + k * (hi - section.cz)];
  };
  return { H, W, trunk, leg, arm, armAt, armDepthLimits, section, ry0, samplers: smp, hasTop: !!masks.top };
}

// A symmetric stand-in measure with the same stations: used to find mirror pairs.
export function canonicalMeasure(measure) {
  const H = measure.H, W = measure.W;
  return {
    H, W,
    trunk: () => ({ cx: 0, cz: 0, rx: 0.09 * H, rz: 0.06 * H }),
    leg: (sign) => ({ cx: sign * 0.05 * H, cz: 0, rx: 0.04 * H, rz: 0.04 * H }),
    arm: () => ({ cy: (W.armpit + W.shoulder) / 2, cz: 0, ry: 0.03 * H, rz: 0.03 * H }),
  };
}
