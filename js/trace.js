// Raster drawing (PNG/JPG) -> centre-line polylines, one set per ink colour.
// Pixels are sorted into ink classes (black, grey, and each distinct hue),
// each class is thinned to a one-pixel skeleton, and the skeleton is walked into paths.

import { simplify, toHex, rgbToHsl, polyLength } from './util.js';
import { newPath, isNearlyClosed } from './doc.js';

export function traceImageData(img) {
  const { width: W, height: H, data } = img;
  const cls = new Int16Array(W * H).fill(-1); // -1 background, 0 dark, 1 gray, 2.. hue clusters
  const hues = [];
  const hueIdx = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    if (a < 100) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = (mx - mn) / 255;
    const l = (mx + mn) / 510;
    // (thin coloured strokes are mostly pale anti-aliased pixels: count them too)
    if (chroma > 0.14 && l < 0.95) {
      const { h } = rgbToHsl({ r, g, b });
      hueIdx[i] = hues.length;
      hues.push(h);
    } else if (l < 0.45) cls[i] = 0;
    else if (l < 0.8 && chroma < 0.15) cls[i] = 1;
  }
  // Anti-aliased black lines have grey fringes and grey cores in places: a connected
  // blob of dark+grey pixels counts as black if a fair share of it is dark.
  {
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let s = 0; s < W * H; s++) {
      if (seen[s] || (cls[s] !== 0 && cls[s] !== 1)) continue;
      const comp = [];
      let dark = 0;
      seen[s] = 1; stack.push(s);
      while (stack.length) {
        const i = stack.pop();
        comp.push(i);
        if (cls[i] === 0) dark++;
        const x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (!seen[j] && (cls[j] === 0 || cls[j] === 1)) { seen[j] = 1; stack.push(j); }
        }
      }
      const c = dark / comp.length > 0.25 ? 0 : 1;
      for (const i of comp) cls[i] = c;
    }
  }
  // Hue histogram -> peaks -> clusters.
  const bins = new Float64Array(72);
  for (const h of hues) bins[Math.floor(h / 5) % 72]++;
  const sm = bins.map((_, i) => bins[(i + 71) % 72] * 0.5 + bins[i] + bins[(i + 1) % 72] * 0.5);
  const peaks = [];
  for (let i = 0; i < 72; i++) {
    if (sm[i] >= 25 && sm[i] >= sm[(i + 71) % 72] && sm[i] > sm[(i + 1) % 72]) peaks.push(i * 5 + 2.5);
  }
  const hdist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const sums = peaks.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (let i = 0; i < W * H; i++) {
    const k = hueIdx[i];
    if (k < 0 || !peaks.length) continue;
    let best = 0, bd = Infinity;
    for (let p = 0; p < peaks.length; p++) { const d = hdist(hues[k], peaks[p]); if (d < bd) { bd = d; best = p; } }
    if (bd > 20) continue;
    cls[i] = 2 + best;
    const s = sums[best];
    s.r += data[i * 4]; s.g += data[i * 4 + 1]; s.b += data[i * 4 + 2]; s.n++;
  }
  const classColors = ['#1b1f27', '#8a8f98', ...sums.map((s) => (s.n ? toHex({ r: s.r / s.n, g: s.g / s.n, b: s.b / s.n }) : '#ff00ff'))];

  const paths = [];
  const nClasses = 2 + peaks.length;
  for (let c = 0; c < nClasses; c++) {
    const bin = new Uint8Array(W * H);
    let count = 0;
    for (let i = 0; i < W * H; i++) if (cls[i] === c) { bin[i] = 1; count++; }
    if (count < 20) continue;
    closeSmallHoles(bin, W, H);
    thin(bin, W, H);
    removeStairs(bin, W, H);
    const chains = tidyChains(walkSkeleton(bin, W, H), Math.max(7, 0.012 * Math.max(W, H)));
    // drop only short pieces that touch nothing (specks), keep short connectors
    const ends = new Map();
    const k = ([x, y]) => `${Math.round(x)},${Math.round(y)}`;
    for (const pl of chains) for (const e of [pl[0], pl[pl.length - 1]]) ends.set(k(e), (ends.get(k(e)) || 0) + 1);
    for (const pl of chains) {
      const L = polyLength(pl);
      const touching = (ends.get(k(pl[0])) || 0) > 1 || (ends.get(k(pl[pl.length - 1])) || 0) > 1;
      if (L < 10 && !touching) continue;
      let pts = simplify(pl, 0.9);
      const closed = isNearlyClosed(pts) && polyLength(pts) > 30;
      if (closed) pts = pts.slice(0, -1);
      paths.push(newPath(pts, { closed, color: classColors[c] }));
    }
  }
  return paths;
}

// Fill 1-pixel pinholes inside thick strokes so thinning doesn't make tiny loops.
function closeSmallHoles(bin, W, H) {
  const add = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (bin[i]) continue;
    const n = bin[i - 1] + bin[i + 1] + bin[i - W] + bin[i + W];
    if (n >= 3) add.push(i);
  }
  for (const i of add) bin[i] = 1;
}

// Zhang–Suen thinning.
function thin(img, W, H) {
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!img[i]) continue;
          const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
          const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (pass === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
          else { if (p2 * p4 * p8 || p2 * p6 * p8) continue; }
          del.push(i);
        }
      }
      for (const i of del) img[i] = 0;
      if (del.length) changed = true;
    }
  }
}

// Remove corner pixels of L-shaped steps so the skeleton is a clean 8-connected line
// (otherwise every diagonal step looks like a three-way junction).
function removeStairs(img, W, H) {
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!img[i]) continue;
      const n = img[i - W], e = img[i + 1], s = img[i + W], w = img[i - 1];
      const ne = img[i - W + 1], se = img[i + W + 1], sw = img[i + W - 1], nw = img[i - W - 1];
      const count = n + e + s + w + ne + se + sw + nw;
      if (count !== 2) continue;
      if ((n && e && !ne && !sw && !s && !w) || (e && s && !se && !nw && !n && !w) || (s && w && !sw && !ne && !n && !e) || (w && n && !nw && !se && !s && !e)) img[i] = 0;
    }
  }
}

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function walkSkeleton(img, W, H) {
  const nb = (i) => {
    const x = i % W, y = (i / W) | 0, out = [];
    for (const [dx, dy] of N8) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (img[j]) out.push(j);
    }
    return out;
  };
  const deg = new Uint8Array(W * H);
  const pix = [];
  for (let i = 0; i < W * H; i++) if (img[i]) { deg[i] = nb(i).length; pix.push(i); }
  const usedEdge = new Set();
  const key = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const out = [];
  const isNode = (i) => deg[i] !== 2;
  const walk = (start, next) => {
    const line = [start];
    let prev = start, cur = next;
    usedEdge.add(key(start, next));
    while (true) {
      line.push(cur);
      if (isNode(cur) || cur === start) break;
      const cand = nb(cur).filter((j) => j !== prev && !usedEdge.has(key(cur, j)));
      if (!cand.length) break;
      // prefer 4-neighbours to avoid diagonal shortcuts
      cand.sort((a, b) => Math.abs(a - cur) === 1 || Math.abs(a - cur) === W ? -1 : 1);
      const n = cand[0];
      usedEdge.add(key(cur, n));
      prev = cur; cur = n;
    }
    return line;
  };
  for (const i of pix) {
    if (!isNode(i)) continue;
    for (const j of nb(i)) if (!usedEdge.has(key(i, j))) out.push(walk(i, j));
  }
  for (const i of pix) {
    for (const j of nb(i)) if (!usedEdge.has(key(i, j))) out.push(walk(i, j));
  }
  // Tiny chains between two junction pixels are diagonal shortcuts: drop them, then
  // join chains whose ends meet one-to-one into longer paths.
  const lines = out
    .filter((l) => !(l.length <= 2 && isNode(l[0]) && isNode(l[l.length - 1])))
    .map((l) => l.map((i) => [i % W + 0.5, ((i / W) | 0) + 0.5]));
  return joinChains(lines, 2.3);
}

// A brush leaves short spurs on the skeleton, and three chain ends meeting at one point stop
// chains from joining, so closed shapes and long lines come out in pieces. Prune the spurs,
// join again, then bridge free ends that are each other's nearest within a few pixels.
function tidyChains(chains, gap) {
  const key = ([x, y]) => `${Math.round(x / 2)},${Math.round(y / 2)}`;
  for (let pass = 0; pass < 3; pass++) {
    const deg = new Map();
    for (const c of chains) for (const e of [c[0], c[c.length - 1]]) deg.set(key(e), (deg.get(key(e)) || 0) + 1);
    const before = chains.length;
    chains = chains.filter((c) => {
      const d0 = deg.get(key(c[0])), d1 = deg.get(key(c[c.length - 1]));
      return !(polyLength(c) < 14 && ((d0 === 1 && d1 >= 3) || (d1 === 1 && d0 >= 3)));
    });
    chains = joinChains(chains, 2.5);
    if (chains.length === before) break;
  }
  // bridge small gaps between free ends (mutual nearest, within `gap` px)
  const free = [];
  chains.forEach((c, i) => { free.push({ i, end: 0, p: c[0] }, { i, end: 1, p: c[c.length - 1] }); });
  const nearest = (a) => { let b = null, bd = gap; for (const o of free) { if (o === a || (o.i === a.i && chains[a.i].length < 8)) continue; const d = Math.hypot(o.p[0] - a.p[0], o.p[1] - a.p[1]); if (d < bd) { bd = d; b = o; } } return b; };
  const pairs = [];
  for (const a of free) { const b = nearest(a); if (b && nearest(b) === a && (a.i < b.i || (a.i === b.i && a.end < b.end))) pairs.push([a, b]); }
  if (!pairs.length) return chains;
  // closing a single chain on itself: nudge its last point onto the first so it reads as closed
  for (const [a, b] of pairs) if (a.i === b.i) { const c = chains[a.i]; c.push(c[0].slice()); }
  const merged = joinChains(chains, gap + 0.5);
  return merged;
}

function joinChains(lines, tol) {
  lines = lines.filter((l) => l.length > 1);
  const n = lines.length;
  const endPt = (id) => { const l = lines[id >> 1]; return id & 1 ? l[l.length - 1] : l[0]; };
  const cell = tol * 2;
  const grid = new Map();
  const gk = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (let id = 0; id < 2 * n; id++) {
    const [x, y] = endPt(id);
    const k = gk(x, y);
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(id);
  }
  const nbrs = (id) => {
    const [x, y] = endPt(id);
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), out = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const o of grid.get(`${cx + a},${cy + b}`) || []) {
        if (o >> 1 === id >> 1) continue;
        const [ox, oy] = endPt(o);
        if (Math.hypot(ox - x, oy - y) <= tol) out.push(o);
      }
    }
    return out;
  };
  const link = new Int32Array(2 * n).fill(-1);
  const nb = [];
  for (let id = 0; id < 2 * n; id++) nb.push(nbrs(id));
  for (let id = 0; id < 2 * n; id++) if (nb[id].length === 1 && nb[nb[id][0]].length === 1) link[id] = nb[id][0];
  const used = new Uint8Array(n);
  const result = [];
  for (let c = 0; c < n; c++) {
    if (used[c]) continue;
    // walk back to the start of this sequence
    let cur = c, entry = 0, guard = 0; // entry: the end we enter the chain from
    while (guard++ < n) {
      const l = link[2 * cur + entry];
      if (l < 0 || (l >> 1) === c) break;
      cur = l >> 1; entry = 1 - (l & 1);
    }
    // now walk forward from `cur`, entering at `entry`
    let pts = [];
    let id = 2 * cur + entry;
    guard = 0;
    while (guard++ <= n) {
      const ch = id >> 1;
      if (used[ch]) break;
      used[ch] = 1;
      const l = lines[ch];
      const seq = (id & 1) ? l.slice().reverse() : l;
      pts = pts.length ? pts.concat(seq.slice(1)) : seq.slice();
      const exit = id ^ 1;
      const nx = link[exit];
      if (nx < 0) break;
      id = nx;
    }
    result.push(pts);
  }
  return result;
}

