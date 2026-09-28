// Hull masks: the inside of a view's outline as a signed distance field (SDF).
// Strokes are drawn thick (the gap tolerance) so small gaps close, the outside is
// flood-filled from the border, and whatever the flood cannot reach is "inside".
// The SDF is negative inside, positive outside, in document units, measured to the
// stroke centre line.

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Euclidean distance (pixels) from every pixel to the nearest pixel where feat[i] is 1.
function edt(feat, W, H) {
  const g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = feat[i] ? 0 : INF;
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = Math.sqrt(d[x]);
  }
  return g;
}

function makeCanvas(W, H) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(W, H);
  const c = document.createElement('canvas'); c.width = W; c.height = H; return c;
}

function frameFor(region, cell, padDoc) {
  const x0 = region.x0 - padDoc, y0 = region.y0 - padDoc;
  const W = Math.ceil((region.x1 - region.x0 + 2 * padDoc) / cell);
  const H = Math.ceil((region.y1 - region.y0 + 2 * padDoc) / cell);
  return { x0, y0, W, H, cell };
}

function finish(fr, R, offsetPx) {
  const { W, H } = fr;
  const notR = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) notR[i] = R[i] ? 0 : 1;
  const dOut = edt(R, W, H); // for outside pixels: distance to region
  const dIn = edt(notR, W, H); // for inside pixels: distance to outside
  const sd = new Float32Array(W * H);
  let area = 0;
  for (let i = 0; i < W * H; i++) {
    const s = R[i] ? -dIn[i] + 0.5 : dOut[i] - 0.5;
    sd[i] = (s + offsetPx) * fr.cell;
    if (sd[i] < 0) area++;
  }
  // light blur so a nearly straight outline doesn't read as pixel stair-steps (which the
  // balloon would copy as ripples); distances near the edge barely change
  const tmp = new Float32Array(W * H);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      tmp[i] = (sd[x > 0 ? i - 1 : i] + 2 * sd[i] + sd[x < W - 1 ? i + 1 : i]) / 4;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      sd[i] = (tmp[y > 0 ? i - W : i] + 2 * tmp[i] + tmp[y < H - 1 ? i + W : i]) / 4;
    }
  }
  area = 0;
  for (let i = 0; i < W * H; i++) if (sd[i] < 0) area++;
  // unit gradient field (central differences), sampled alongside the distance
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const a = sd[x > 0 ? i - 1 : i], b = sd[x < W - 1 ? i + 1 : i];
    const c = sd[y > 0 ? i - W : i], d = sd[y < H - 1 ? i + W : i];
    const vx = b - a, vy = d - c, L = Math.hypot(vx, vy) || 1;
    gx[i] = vx / L; gy[i] = vy / L;
  }
  return { ...fr, sd, gx, gy, area };
}

// Outline mask from open or closed strokes.
export function buildHullMask(paths, region, { cell, gap }) {
  const lw = Math.max(1.5, (2 * gap) / cell);
  const fr = frameFor(region, cell, gap + cell * 6);
  const { W, H } = fr;
  const cv = makeCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#000';
  for (const p of paths) {
    ctx.beginPath();
    p.pts.forEach(([x, y], i) => {
      const px = (x - fr.x0) / cell, py = (y - fr.y0) / cell;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    if (p.closed) ctx.closePath();
    if (p.pts.length === 1) ctx.lineTo((p.pts[0][0] - fr.x0) / cell + 0.01, (p.pts[0][1] - fr.y0) / cell);
    ctx.stroke();
  }
  const a = ctx.getImageData(0, 0, W, H).data;
  const wall = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) wall[i] = a[i * 4 + 3] > 60 ? 1 : 0;
  // flood fill the outside from the border
  const out = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (i) => { if (!out[i] && !wall[i]) { out[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) {
    const i = stack[--sp];
    const x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  const R = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) R[i] = out[i] ? 0 : 1;
  return finish(fr, R, lw / 2);
}

// Filled closed polygon (cross-sections).
export function buildPolygonMask(pts, cell) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const fr = frameFor({ x0, y0, x1, y1 }, cell, cell * 8 + (x1 - x0) * 0.5);
  const { W, H } = fr;
  const cv = makeCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const px = (x - fr.x0) / cell, py = (y - fr.y0) / cell; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  const a = ctx.getImageData(0, 0, W, H).data;
  const R = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) R[i] = a[i * 4 + 3] > 127 ? 1 : 0;
  const m = finish(fr, R, 0);
  m.cx = (x0 + x1) / 2; m.cy = (y0 + y1) / 2; m.hw = (x1 - x0) / 2; m.hh = (y1 - y0) / 2;
  return m;
}

// Bilinear SDF sample in document coordinates.
export function sdAt(m, x, y) {
  const fx = (x - m.x0) / m.cell - 0.5, fy = (y - m.y0) / m.cell - 0.5;
  const W = m.W, H = m.H;
  const cx = Math.min(Math.max(fx, 0), W - 1.001), cy = Math.min(Math.max(fy, 0), H - 1.001);
  const ix = Math.floor(cx), iy = Math.floor(cy), tx = cx - ix, ty = cy - iy;
  const i = iy * W + ix, sd = m.sd;
  let v = (sd[i] * (1 - tx) + sd[i + 1] * tx) * (1 - ty) + (sd[i + W] * (1 - tx) + sd[i + W + 1] * tx) * ty;
  const ox = fx - cx, oy = fy - cy;
  if (ox || oy) v += Math.hypot(ox, oy) * m.cell;
  return v;
}

// Signed distance plus unit gradient (pointing outward) in document coordinates.
export function sdGrad(m, x, y) {
  const fx = (x - m.x0) / m.cell - 0.5, fy = (y - m.y0) / m.cell - 0.5;
  const W = m.W, H = m.H;
  const cx = Math.min(Math.max(fx, 0), W - 1.001), cy = Math.min(Math.max(fy, 0), H - 1.001);
  const ix = Math.floor(cx), iy = Math.floor(cy), tx = cx - ix, ty = cy - iy;
  const i = iy * W + ix;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  const sd = m.sd;
  let d = sd[i] * w00 + sd[i + 1] * w10 + sd[i + W] * w01 + sd[i + W + 1] * w11;
  const ox = fx - cx, oy = fy - cy;
  if (ox || oy) {
    // outside the raster: distance grows, gradient points away from it
    const L = Math.hypot(ox, oy);
    return { d: d + L * m.cell, gx: ox / L, gy: oy / L };
  }
  if (d <= 0) return { d, gx: 0, gy: 0 };
  let gx = m.gx[i] * w00 + m.gx[i + 1] * w10 + m.gx[i + W] * w01 + m.gx[i + W + 1] * w11;
  let gy = m.gy[i] * w00 + m.gy[i + 1] * w10 + m.gy[i + W] * w01 + m.gy[i + W + 1] * w11;
  const L = Math.hypot(gx, gy) || 1;
  return { d, gx: gx / L, gy: gy / L };
}

export function insideAt(m, x, y) { return sdAt(m, x, y) < 0; }

// Horizontal inside runs at document height y, as [x0, x1] intervals.
export function rowSpans(m, y) {
  const r = Math.round((y - m.y0) / m.cell - 0.5);
  if (r < 0 || r >= m.H) return [];
  const out = [];
  let start = -1;
  for (let c = 0; c <= m.W; c++) {
    const ins = c < m.W && m.sd[r * m.W + c] < 0;
    if (ins && start < 0) start = c;
    if (!ins && start >= 0) { out.push([m.x0 + start * m.cell, m.x0 + c * m.cell]); start = -1; }
  }
  return out;
}

export function colSpans(m, x) {
  const c = Math.round((x - m.x0) / m.cell - 0.5);
  if (c < 0 || c >= m.W) return [];
  const out = [];
  let start = -1;
  for (let r = 0; r <= m.H; r++) {
    const ins = r < m.H && m.sd[r * m.W + c] < 0;
    if (ins && start < 0) start = r;
    if (!ins && start >= 0) { out.push([m.y0 + start * m.cell, m.y0 + r * m.cell]); start = -1; }
  }
  return out;
}

export function maskBBox(m) {
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
  for (let r = 0; r < m.H; r++) for (let c = 0; c < m.W; c++) {
    if (m.sd[r * m.W + c] < 0) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c; }
  }
  if (r1 < 0) return null;
  return { x0: m.x0 + c0 * m.cell, x1: m.x0 + (c1 + 1) * m.cell, y0: m.y0 + r0 * m.cell, y1: m.y0 + (r1 + 1) * m.cell };
}

// ---------- enclosed regions (paint-bucket) ----------
// Every stroke is a wall; each connected area between walls is a region.
export function labelRegions(paths, region, { cell, wall }) {
  const lw = Math.max(1.5, wall / cell);
  const fr = frameFor(region, cell, cell * 6);
  const { W, H } = fr;
  const cv = makeCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw; ctx.strokeStyle = '#000';
  for (const p of paths) {
    ctx.beginPath();
    p.pts.forEach(([x, y], i) => { const px = (x - fr.x0) / cell, py = (y - fr.y0) / cell; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    if (p.closed) ctx.closePath();
    ctx.stroke();
  }
  const a = ctx.getImageData(0, 0, W, H).data;
  const lab = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) if (a[i * 4 + 3] > 60) lab[i] = -2; // wall
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (lab[s] !== -1) continue;
    const id = comps.length;
    let sp = 0, count = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, border = false;
    lab[s] = id; stack[sp++] = s;
    while (sp) {
      const i = stack[--sp];
      count++;
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x > 0 && lab[i - 1] === -1) { lab[i - 1] = id; stack[sp++] = i - 1; }
      if (x < W - 1 && lab[i + 1] === -1) { lab[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && lab[i - W] === -1) { lab[i - W] = id; stack[sp++] = i - W; }
      if (y < H - 1 && lab[i + W] === -1) { lab[i + W] = id; stack[sp++] = i + W; }
    }
    comps.push({ id, count, x0, y0, x1, y1, border, seed: s });
  }
  return { ...fr, lab, comps, lw };
}

export function regionAt(L, x, y) {
  const c = Math.floor((x - L.x0) / L.cell), r = Math.floor((y - L.y0) / L.cell);
  if (c < 0 || r < 0 || c >= L.W || r >= L.H) return -1;
  // walls: look around for the nearest region
  for (let d = 0; d < 4; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
    const cc = c + dx, rr = r + dy;
    if (cc < 0 || rr < 0 || cc >= L.W || rr >= L.H) continue;
    const v = L.lab[rr * L.W + cc];
    if (v >= 0) return v;
  }
  return -1;
}

// Mask of one region with its holes filled (a ring around a smaller shape counts as solid),
// measured to the wall centre line.
export function regionMask(L, id) {
  const { W, H } = L;
  const inR = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (L.lab[i] === id) inR[i] = 1;
  // flood the outside of the region; what the flood can't reach is region + holes + walls around holes
  const out = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (i) => { if (!out[i] && !inR[i]) { out[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) {
    const i = stack[--sp];
    const x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  // the wall ring around the region is outside but touches the region: grow into it by half a wall
  const R = new Uint8Array(W * H);
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < W * H; i++) if (!out[i]) { R[i] = 1; const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const m = finish(L, R, L.lw / 2);
  const cx = L.x0 + ((x0 + x1 + 1) / 2) * L.cell, cy = L.y0 + ((y0 + y1 + 1) / 2) * L.cell;
  m.cx = cx; m.cy = cy; m.hw = ((x1 - x0 + 1) / 2 + L.lw / 2) * L.cell; m.hh = ((y1 - y0 + 1) / 2 + L.lw / 2) * L.cell;
  return m;
}
