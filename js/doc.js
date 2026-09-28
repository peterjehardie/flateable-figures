// Drawing document: paths with roles, split into a front view and a side view.
// SVG is the authoring and project format; inside the app every path is a polyline.

import { bboxOf, polyLength, simplify, parseColor, toHex, colorClass, colorName } from './util.js';

export const ROLES = {
  line: 'Outline / contour',
  feature: 'Feature (tag)',
  section: 'Cross-section',
  guide: 'Height line',
  axis: 'Centre line',
  note: 'Note (ignored)',
};

let nextId = 1;
export function newPath(pts, opts = {}) {
  return {
    id: nextId++,
    pts,
    closed: !!opts.closed,
    color: opts.color || '#1b1f27',
    role: opts.role || 'line',
    group: opts.group || null,
    view: opts.view || null,
    part: opts.part || null, // for sections: 'arm'
    side: opts.side || null, // features: which surfaces they tag ('near' | 'far' | 'both'); null = view default
  };
}

export function createDoc() {
  return {
    paths: [],
    bg: null, // { src, x, y, w, h }
    splitX: 0,
    bounds: { x0: 0, y0: 0, x1: 1000, y1: 800 },
    views: {
      front: { top: 0, floor: 800, axis: 250, manual: {} },
      side: { top: 0, floor: 800, axis: 750, facing: 'left', manual: {} },
      top: { axisX: 250, axisZ: 1000, manual: {} }, // plan view of hands and feet, same scale as the front
    },
    splitY: null, // below this (and left of splitX) is the top view
    landmarks: [],
    groups: {}, // name -> { color, pressure, tension, loop, visible }
    paint: [], // painted tag dabs {group, p:[x,y,z], r, erase}
    stations: null, // filled by stations.js
    stationsAuto: true,
    sectionSeed: null, // a point inside the side-view area used as the arm cross-section
    sectionOff: false,
    heightM: 1.8,
    canon: 8,
  };
}

export function docBounds(doc) {
  let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of doc.paths) {
    const bb = bboxOf(p.pts);
    b.x0 = Math.min(b.x0, bb.x0); b.y0 = Math.min(b.y0, bb.y0);
    b.x1 = Math.max(b.x1, bb.x1); b.y1 = Math.max(b.y1, bb.y1);
  }
  if (doc.bg) {
    b.x0 = Math.min(b.x0, doc.bg.x); b.y0 = Math.min(b.y0, doc.bg.y);
    b.x1 = Math.max(b.x1, doc.bg.x + doc.bg.w); b.y1 = Math.max(b.y1, doc.bg.y + doc.bg.h);
  }
  if (!isFinite(b.x0)) b = { x0: 0, y0: 0, x1: 1000, y1: 800 };
  doc.bounds = b;
  return b;
}

// ---------- SVG import ----------
function sampleElement(el, step) {
  // Use the browser's own geometry so every SVG shape and curve type works.
  const ctm = el.getCTM();
  const tr = (p) => (ctm ? [ctm.a * p.x + ctm.c * p.y + ctm.e, ctm.b * p.x + ctm.d * p.y + ctm.f] : [p.x, p.y]);
  const tag = el.tagName.toLowerCase();
  let pts = [];
  let closed = false;
  if (tag === 'line') {
    const g = (n) => parseFloat(el.getAttribute(n) || 0);
    pts = [tr({ x: g('x1'), y: g('y1') }), tr({ x: g('x2'), y: g('y2') })];
  } else if (typeof el.getTotalLength === 'function') {
    let L = 0;
    try { L = el.getTotalLength(); } catch (e) { L = 0; }
    if (!(L > 0)) return null;
    const n = Math.max(2, Math.ceil(L / step));
    for (let i = 0; i <= n; i++) pts.push(tr(el.getPointAtLength((L * i) / n)));
    closed = ['rect', 'circle', 'ellipse', 'polygon'].includes(tag) || /z\s*$/i.test(el.getAttribute('d') || '');
  }
  return { pts, closed };
}

function styleColor(el) {
  let c = el.getAttribute('stroke');
  const st = el.getAttribute('style') || '';
  const m = st.match(/stroke\s*:\s*([^;]+)/);
  if (m) c = m[1];
  if (!c || c === 'none') {
    try { c = getComputedStyle(el).stroke; } catch (e) { /* not rendered */ }
  }
  if (!c || c === 'none') {
    const f = el.getAttribute('fill') || (st.match(/fill\s*:\s*([^;]+)/) || [])[1];
    if (f && f !== 'none') c = f;
  }
  const rgb = parseColor(c);
  return rgb ? toHex(rgb) : '#1b1f27';
}

export function parseSVG(text) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
  holder.innerHTML = text;
  const svg = holder.querySelector('svg');
  if (!svg) throw new Error('No <svg> element found in the file.');
  document.body.appendChild(holder);
  const out = [];
  let meta = null;
  let bg = null;
  try {
    const metaEl = svg.querySelector('metadata#ff-project, metadata[id="ff-project"]');
    if (metaEl) { try { meta = JSON.parse(metaEl.textContent); } catch (e) { meta = null; } }
    const img = svg.querySelector('image[data-ff-bg]');
    if (img) {
      bg = {
        src: img.getAttribute('href') || img.getAttribute('xlink:href'),
        x: +img.getAttribute('x') || 0, y: +img.getAttribute('y') || 0,
        w: +img.getAttribute('width'), h: +img.getAttribute('height'),
      };
    }
    const els = svg.querySelectorAll('path, polyline, polygon, line, rect, circle, ellipse');
    for (const el of els) {
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol')) continue;
      const s = sampleElement(el, 2);
      if (!s || s.pts.length < 2) continue;
      let pts = simplify(s.pts, 0.35);
      if (s.closed && pts.length > 2) {
        const a = pts[0], b = pts[pts.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5) pts = pts.slice(0, -1);
      }
      const d = el.dataset || {};
      out.push(newPath(pts, {
        closed: s.closed || isNearlyClosed(pts),
        color: styleColor(el),
        role: d.role || null,
        group: d.group || null,
        view: d.view || null,
        part: d.part || null,
        side: d.side || undefined,
      }));
    }
  } finally {
    holder.remove();
  }
  return { paths: out, meta, bg };
}

export function isNearlyClosed(pts) {
  if (pts.length < 4) return false;
  const L = polyLength(pts);
  const a = pts[0], b = pts[pts.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < Math.max(3, L * 0.04);
}

// ---------- automatic roles and view split ----------
export function autoSplit(doc) {
  // Find the widest empty vertical band between drawn shapes: front on the left, side on the right.
  const boxes = doc.paths.filter((p) => p.role !== 'guide').map((p) => bboxOf(p.pts)).sort((a, b) => a.x0 - b.x0);
  if (boxes.length < 2) { doc.splitX = (doc.bounds.x0 + doc.bounds.x1) / 2; return; }
  let reach = boxes[0].x1, bestGap = -1, split = (doc.bounds.x0 + doc.bounds.x1) / 2;
  for (let i = 1; i < boxes.length; i++) {
    const gap = boxes[i].x0 - reach;
    if (gap > bestGap) { bestGap = gap; split = reach + gap / 2; }
    reach = Math.max(reach, boxes[i].x1);
  }
  doc.splitX = split;
}

export function assignViews(doc) {
  for (const p of doc.paths) {
    if (p.role === 'guide') { p.view = 'both'; continue; }
    const bb = bboxOf(p.pts);
    p.view = viewAtPoint(doc, (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
  }
}

export function viewAtPoint(doc, x, y) {
  if (x >= doc.splitX) return 'side';
  return doc.splitY != null && y > doc.splitY ? 'top' : 'front';
}

export function autoRoles(doc) {
  const b = doc.bounds;
  const W = b.x1 - b.x0, H = b.y1 - b.y0;
  for (const p of doc.paths) {
    if (p.role && p.role !== 'auto' && p._roleFromFile) continue;
    const bb = bboxOf(p.pts);
    const c = parseColor(p.color);
    const cls = colorClass(c);
    if (bb.h < H * 0.02 && bb.w > W * 0.12 && hasFreeEnd(p, doc.paths, H * 0.015)) p.role = 'guide';
    else if (cls === 'color') p.role = 'feature';
    else if (cls === 'gray' || cls === 'light') p.role = 'note';
    else p.role = 'line';
    if (p.role === 'feature' && !p.group) p.group = colorName(c);
  }
}

// A height line has at least one end that touches nothing else.
function hasFreeEnd(p, all, tol) {
  const free = (q) => !all.some((o) => o !== p && o.pts.some(([x, y]) => Math.abs(x - q[0]) < tol && Math.abs(y - q[1]) < tol));
  return free(p.pts[0]) || free(p.pts[p.pts.length - 1]);
}

// After views are known: a long, thin, coloured vertical path near the middle of the
// front view is the centre line. (Black verticals are usually leg outlines.)
export function detectAxis(doc) {
  const front = doc.paths.filter((p) => p.view === 'front' && p.role === 'line');
  if (!front.length) return;
  const fb = front.map((p) => bboxOf(p.pts)).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) }));
  const H = fb.y1 - fb.y0, mid = (fb.x0 + fb.x1) / 2;
  let best = null, bd = Infinity;
  for (const p of doc.paths) {
    if (p.view !== 'front' || p.role !== 'feature') continue;
    const bb = bboxOf(p.pts);
    if (bb.w > H * 0.03 || bb.h < H * 0.15) continue;
    const d = Math.abs((bb.x0 + bb.x1) / 2 - mid);
    if (d < H * 0.08 && d < bd) { bd = d; best = p; }
  }
  if (best) {
    const g = best.group;
    for (const p of doc.paths) if (p.view === 'front' && p.role === 'feature' && p.group === g && bboxOf(p.pts).w < H * 0.03 && Math.abs((bboxOf(p.pts).x0 + bboxOf(p.pts).x1) / 2 - mid) < H * 0.08) { p.role = 'axis'; p.group = null; }
  }
}

export function ensureGroups(doc) {
  for (const p of doc.paths) {
    if (p.role !== 'feature') continue;
    if (!p.group) p.group = colorName(parseColor(p.color));
    if (!doc.groups[p.group]) doc.groups[p.group] = defaultGroup(p.color);
  }
  for (const d of doc.paint) if (!doc.groups[d.group]) doc.groups[d.group] = defaultGroup('#d0457a');
}

export function defaultGroup(color) {
  return { color, pressure: 1, tension: 1, loop: false, visible: true };
}

export function prepareImported(doc, { keepRoles = false } = {}) {
  docBounds(doc);
  if (!keepRoles) {
    autoRoles(doc);
    autoSplit(doc);
    assignViews(doc);
    detectAxis(doc);
  } else {
    if (!doc.splitX) autoSplit(doc);
    for (const p of doc.paths) if (!p.view) { const bb = bboxOf(p.pts); p.view = viewAtPoint(doc, (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2); }
    if (!doc.views.top) doc.views.top = { axisX: doc.views.front.axis, axisZ: 0, manual: {} };
  }
  ensureGroups(doc);
}

// ---------- SVG export (the project file) ----------
export function exportSVG(doc, extraMeta = {}) {
  const b = docBounds(doc);
  const pad = 20;
  const vb = [b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad].map((v) => +v.toFixed(2));
  const f = (v) => +v.toFixed(2);
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb.join(' ')}" width="${vb[2]}" height="${vb[3]}">`);
  const meta = {
    version: 1, splitX: doc.splitX, splitY: doc.splitY, figureKey: doc.figureKey, views: doc.views, landmarks: doc.landmarks, groups: doc.groups,
    paint: doc.paint, sectionSeed: doc.sectionSeed, sectionOff: doc.sectionOff, stations: doc.stations, stationsAuto: doc.stationsAuto, heightM: doc.heightM, canon: doc.canon, ...extraMeta,
  };
  lines.push(`<metadata id="ff-project">${escapeXML(JSON.stringify(meta))}</metadata>`);
  if (doc.bg && doc.bg.src) lines.push(`<image data-ff-bg="1" x="${doc.bg.x}" y="${doc.bg.y}" width="${doc.bg.w}" height="${doc.bg.h}" opacity="0.35" href="${doc.bg.src}"/>`);
  for (const view of ['front', 'side', 'top', 'both']) {
    const ps = doc.paths.filter((p) => p.view === view);
    if (!ps.length) continue;
    lines.push(`<g id="${view}">`);
    for (const p of ps) {
      const d = 'M' + p.pts.map(([x, y]) => f(x) + ' ' + f(y)).join(' L') + (p.closed ? ' Z' : '');
      const attrs = [`d="${d}"`, 'fill="none"', `stroke="${p.color}"`, 'stroke-width="2"', 'stroke-linecap="round"', 'stroke-linejoin="round"', `data-role="${p.role}"`, `data-view="${p.view}"`];
      if (p.group) attrs.push(`data-group="${escapeXML(p.group)}"`);
      if (p.part) attrs.push(`data-part="${p.part}"`);
      if (p.role === 'feature' && p.side) attrs.push(`data-side="${p.side}"`);
      lines.push(`  <path ${attrs.join(' ')}/>`);
    }
    lines.push('</g>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}

function escapeXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function loadProjectSVG(text) {
  const { paths, meta, bg } = parseSVG(text);
  const doc = createDoc();
  doc.paths = paths;
  doc.bg = bg;
  const hasRoles = paths.some((p) => p.role);
  for (const p of paths) if (p.role) p._roleFromFile = true;
  if (meta) {
    for (const k of ['splitX', 'splitY', 'figureKey', 'views', 'landmarks', 'groups', 'paint', 'sectionSeed', 'sectionOff', 'stations', 'stationsAuto', 'heightM', 'canon']) if (meta[k] !== undefined) doc[k] = meta[k];
  }
  if (hasRoles) {
    for (const p of paths) if (!p.role) p.role = 'line';
    prepareImported(doc, { keepRoles: true });
  } else {
    prepareImported(doc);
  }
  return { doc, meta };
}
