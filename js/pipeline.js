// Drawing -> hull masks -> calibration & stations -> cage -> dense mesh -> balloon.

import { buildHullMask, buildHullMaskOpenHands, buildPolygonMask, labelRegions, regionAt, regionMask } from './mask.js';
import { Frame, autoCalibrate, autoStations, canonStations, sanitizeStations, makeMeasure, canonicalMeasure } from './stations.js';
import { buildCage } from './cage.js';
import { subdivide } from './subdiv.js';
import { Balloon, mirrorMap } from './balloon.js';
import { bboxOf } from './util.js';

// Everything drawn except height lines, notes and the centre line closes the outline: interior strokes
// can't change what the outside flood reaches, and coloured strokes often seal gaps.
const HULL_ROLES = new Set(['line', 'feature', 'section']);

export function buildMasks(doc, { gapFrac = 0.012, res = 1000 } = {}) {
  const masks = { front: null, side: null, top: null, section: null };
  let hFig = 0;
  for (const view of ['front', 'side', 'top']) {
    const ps = doc.paths.filter((p) => p.view === view && HULL_ROLES.has(p.role));
    if (!ps.some((p) => p.role === 'line')) continue;
    let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of ps) { const bb = bboxOf(p.pts); b.x0 = Math.min(b.x0, bb.x0); b.y0 = Math.min(b.y0, bb.y0); b.x1 = Math.max(b.x1, bb.x1); b.y1 = Math.max(b.y1, bb.y1); }
    const h = Math.max(b.y1 - b.y0, 1);
    const cell = h / res;
    // top view: the feet are single outlines with narrow notches between the toes, which thick
    // strokes would seal; there only the ends of open strokes are joined across gaps, and the gap
    // is measured on the figure's height (the top view itself is only a foot or so deep). Front
    // view: the same for the hands drawn in the outline, out at the ends of the arms.
    if (view === 'front') hFig = h;
    const top = view === 'top';
    const opts = { cell, gap: Math.max(gapFrac * (top && hFig ? hFig : h), cell * 0.75), ends: top };
    masks[view] = view === 'front' ? buildHullMaskOpenHands(ps, b, opts) : buildHullMask(ps, b, opts);
    masks[view].view = view;
  }
  const sec = doc.paths.find((p) => p.view === 'side' && p.role === 'section' && p.pts.length > 2);
  if (masks.side && doc.sectionSeed) {
    const L = sideRegions(doc, masks.side.cell);
    const id = regionAt(L, doc.sectionSeed[0], doc.sectionSeed[1]);
    if (id >= 0 && !L.comps[id].border) masks.section = regionMask(L, id);
  } else if (sec && masks.side) masks.section = buildPolygonMask(sec.pts, masks.side.cell * 0.5);
  return masks;
}

export function sideRegions(doc, cell) {
  const ps = doc.paths.filter((p) => p.view === 'side' && HULL_ROLES.has(p.role));
  let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of ps) { const bb = bboxOf(p.pts); b.x0 = Math.min(b.x0, bb.x0); b.y0 = Math.min(b.y0, bb.y0); b.x1 = Math.max(b.x1, bb.x1); b.y1 = Math.max(b.y1, bb.y1); }
  return labelRegions(ps, b, { cell, wall: 2.5 * cell });
}

export function calibrate(doc, masks) {
  autoCalibrate(doc, masks);
  const frame = new Frame(doc);
  if (!doc.stations || doc.stationsAuto) doc.stations = autoStations(doc, masks, frame);
  doc.stations = sanitizeStations({ ...canonStations(doc.canon), ...doc.stations });
  return frame;
}

// Pick the enclosed side-view area most likely to be the arm's end-on section: a roundish
// region (holes filled) centred between armpit and shoulder, inside the side outline.
export function detectSection(doc, frame, masks) {
  if (doc.sectionSeed || doc.sectionOff || doc.paths.some((p) => p.role === 'section') || !masks.side) return false;
  const st = doc.stations;
  const L = sideRegions(doc, masks.side.cell);
  let best = null, bestArea = 0;
  for (const c of L.comps) {
    if (c.border || c.count < 20) continue;
    const bx0 = L.x0 + c.x0 * L.cell, bx1 = L.x0 + (c.x1 + 1) * L.cell, by0 = L.y0 + c.y0 * L.cell, by1 = L.y0 + (c.y1 + 1) * L.cell;
    const t = frame.tFromDoc('side', (by0 + by1) / 2);
    const hT = ((by1 - by0) * frame.S.s) / frame.H;
    const asp = (bx1 - bx0) / (by1 - by0 || 1);
    if (t < st.armpit - 0.03 || t > st.shoulder + 0.04 || asp < 0.5 || asp > 2 || hT < 0.015 || hT > 0.12) continue;
    const area = (bx1 - bx0) * (by1 - by0);
    if (area > bestArea) { bestArea = area; best = c; }
  }
  if (!best) return false;
  const s = best.seed;
  doc.sectionSeed = [L.x0 + ((s % L.W) + 0.5) * L.cell, L.y0 + (((s / L.W) | 0) + 0.5) * L.cell];
  return true;
}

export function buildModel(doc, masks, frame, params) {
  const measure = makeMeasure(doc, masks, frame);
  const cage = buildCage(measure, params);
  const canon = buildCage(canonicalMeasure(measure), params);
  const { mesh, extras } = subdivide(cage, params.level, [canon.pos]);
  const sim = new Balloon(mesh, { samplers: measure.samplers, measure, H: frame.H });
  const mm = mirrorMap(extras[0], mesh.nV, frame.H * 1e-4);
  sim.mirror = mm.map;
  return { measure, cage, mesh, sim, mirrorMisses: mm.misses };
}
