// App controller: owns the document and the pipeline, wires the panels.

import { createDoc, prepareImported, exportSVG, loadProjectSVG, ensureGroups, assignViews, defaultGroup, ROLES, newPath, viewAtPoint } from './doc.js';
import { buildFigure, PRESETS, FIGURE_VERSION } from './figure.js';
import { traceImageData } from './trace.js';
import { buildMasks, calibrate, detectSection, buildModel } from './pipeline.js';
import { Frame, HEIGHT_STATIONS, ARM_STATIONS, STATION_LABEL, canonStations, autoStations, sanitizeStations } from './stations.js';
import { computeTags, tagModifiers } from './tags.js';
import { computeFit, maskImage } from './fit.js';
import { View2D, penPathOpts } from './view2d.js';
import { View3D } from './view3d.js';
import { PARTS } from './cage.js';
import { buildFace } from './face.js';
import { buildDigits } from './digits.js';
import { mirrorStroke, mirrorPts, symmetrizeFront } from './symmetry.js';
import { initRigPanel } from './rigpanel.js';
import { tagAnatomy } from './anatomy.js';
import { toOBJ, tagsJSON, makeZip, saveFile } from './exporter.js';
import { bboxOf, parseColor, colorName, toHex, simplify, polyLength } from './util.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');

const app = {
  doc: createDoc(),
  masks: null, maskImgs: null, frame: null, model: null, sim: null, fit: null, tagGroups: {}, pulledLoops: [],
  params: { N: 16, rings: 2, headRings: 2, handRings: 1, footRings: 2, jointLoops: true, shrink: 0.5, level: 1, digits: true, fingerRings: 3, toeRings: 1, face: true, faceRefine: true },
  prm: { pressure: 1, tension: 0.5, relax: 0.3, anchor: 0.15, constrain: true, symmetry: true, armDepth: 1, profile: 2.2, faceDetail: true },
  layer: 'line', faceMode: 'split', mirrorDraw: true,
  steps: 6, running: false, settled: false, gapFrac: 0.012, pinsOn: true,
  selected: null, selectedLandmark: null, penColor: '#1b1f27', paintMode: false, paintErase: false, paintGroup: null, brushPx: 22,
  shading: 'clay', css: {}, bgImage: null,
};
window.__app = app;

// ---------------- theme ----------------
function readCSS() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  app.css = { paper: g('--paper'), ink: g('--ink'), muted: g('--muted'), accent: g('--accent'), select: g('--select'), mark: g('--mark'), meshLine: g('--mesh-line'), viewport: g('--viewport'), gridA: g('--grid-a'), gridB: g('--grid-b'), line: g('--line') };
  if (app.v3) { app.v3.setTheme(app.css.viewport, app.css.gridA, app.css.gridB); app.v3.setAccent(app.css.accent); }
  if (app.masks) makeMaskImages();
  if (app.v2) app.v2.dirty = true;
  if (app.sim) applyShading();
}

// ---------------- pipeline ----------------
let tFull = null, tModel = null, tSave = null;
function scheduleFull(ms = 120) { clearTimeout(tFull); tFull = setTimeout(fullRebuild, ms); }
function scheduleModel(ms = 90) { clearTimeout(tModel); tModel = setTimeout(rebuildModel, ms); }
function scheduleSave() { clearTimeout(tSave); tSave = setTimeout(autosave, 1500); }

function makeMaskImages() {
  const hex = parseColor(app.css.accent) || { r: 14, g: 125, b: 137 };
  app.maskImgs = {};
  for (const v of ['front', 'side', 'top']) if (app.masks[v]) app.maskImgs[v] = maskImage(app.masks[v], [hex.r, hex.g, hex.b]);
  if (app.masks.section) app.maskImgs.section = maskImage(app.masks.section, [hex.r, hex.g, hex.b], 120);
}

function fullRebuild() {
  const doc = app.doc;
  ensureGroups(doc);
  app.masks = buildMasks(doc, { gapFrac: app.gapFrac });
  app.frame = calibrate(doc, app.masks);
  if (detectSection(doc, app.frame, app.masks)) app.masks = buildMasks(doc, { gapFrac: app.gapFrac });
  makeMaskImages();
  app.v3.setDrawings(doc, app.frame);
  renderDrawingPanel();
  rebuildModel();
}

function rebuildModel() {
  const doc = app.doc;
  if (!app.masks || !app.masks.front) {
    app.sim = null; app.model = null;
    setStatus('Add a front view outline to start.');
    app.v2.dirty = true;
    return;
  }
  app.frame = new Frame(doc);
  doc.stations = sanitizeStations({ ...canonStations(doc.canon), ...doc.stations });
  const t0 = performance.now();
  app.model = buildModel(doc, app.masks, app.frame, app.params);
  app.sim = app.model.sim;
  app.face = app.params.face ? buildFace(doc, app.frame, app.model.measure, app.sim.mesh, { ...app.prm, shrink: app.params.shrink }) : null;
  if (app.face && app.prm.faceDetail) app.sim.setCarried(app.face.inner);
  app.digits = app.params.digits ? buildDigits(doc, app.frame, app.model.measure, app.sim.mesh) : null;
  app.buildMs = performance.now() - t0;
  app.v3.setMesh(app.sim.mesh, app.sim.P);
  app.sim.computeNormals();
  app.settled = false;
  app.stillFrames = 0;
  if (app.rigPanel) app.rigPanel.onModel();
  app.anat = null;
  try { refreshAnatomy(false); } catch (e) { console.warn('anatomy', e); }
  setRunning(false);
  updateTags();
  updatePins();
  applyShading();
  app.v3.setLoops(app.sim.mesh.loops.filter((l) => l.station), app.pulledLoops);
  refreshFit();
  renderStations();
  renderTopology();
  renderExportLevels();
  app.v2.dirty = true;
  scheduleSave();
}

function updateTags() {
  if (!app.sim) return;
  const band = (app.masks.front ? app.masks.front.cell : 1) * 5;
  app.tagGroups = computeTags(app.doc, app.frame, app.sim, { band });
  const mods = tagModifiers(app.doc, app.frame, app.sim, app.tagGroups);
  app.sim.setModifiers(mods.pm, mods.tm, mods.axis, mods.aval);
  const changed = mods.pulled.length !== app.pulledLoops.length || mods.pulled.some((l, i) => l !== app.pulledLoops[i]);
  app.pulledLoops = mods.pulled;
  if (changed) app.v3.setLoops(app.sim.mesh.loops.filter((l) => l.station), app.pulledLoops);
  if (app.shading === 'tags') applyShading();
  renderTagCounts();
}

function refreshFit() {
  if (!app.sim) return;
  app.fit = computeFit(app.sim, app.frame, app.masks);
  const f = app.fit;
  const row = (k, v) => `<span>${k}</span><b>${v}</b>`;
  $('fit-stats').innerHTML = [
    row('front filled', f.front ? fmt(100 * f.front.cover, 1) + ' %' : '–'),
    row('front outside', f.front ? fmt(100 * f.front.over, 1) + ' %' : '–'),
    row('side filled', f.side ? fmt(100 * f.side.cover, 1) + ' %' : '–'),
    row('side outside', f.side ? fmt(100 * f.side.over, 1) + ' %' : '–'),
    row('steps run', app.sim.iter),
    row('movement', app.settled ? 'settled' : fmt(app.sim.lastMove * 1e4, 2) + ' ‰/step'),
  ].join('');
  app.v2.dirty = true;
}

function updatePins() {
  if (!app.sim) return;
  const pins = [];
  const marks = [];
  for (const l of app.doc.landmarks) {
    const p = landmarkWorld(l);
    if (!p) continue;
    marks.push(p);
    if (!app.pinsOn) continue;
    const P = app.sim.P;
    let best = -1, bd = Infinity;
    for (let i = 0; i < app.sim.n; i++) {
      const d = (P[3 * i] - p[0]) ** 2 + (P[3 * i + 1] - p[1]) ** 2 + (P[3 * i + 2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) pins.push({ v: best, p });
  }
  app.sim.pins = pins;
  app.v3.setLandmarks(marks);
}

function landmarkWorld(l) {
  if (!l.front || !l.side || !app.frame) return null;
  const [x, yf] = app.frame.fw(...l.front);
  const [z, ys] = app.frame.sw(...l.side);
  return [x, (yf + ys) / 2, z];
}

// ---------------- shading ----------------
function applyShading() {
  const sim = app.sim;
  if (!sim) return;
  const n = sim.n;
  const cols = new Float32Array(n * 3);
  const hex = (h) => { const c = parseColor(h) || { r: 200, g: 200, b: 200 }; return [c.r / 255, c.g / 255, c.b / 255]; };
  const clay = [0.8, 0.79, 0.76];
  for (let i = 0; i < n; i++) cols.set(clay, 3 * i);
  if (app.shading === 'parts') {
    const Q = sim.mesh.quads;
    for (let f = 0; f < Q.length / 4; f++) {
      const c = hex(PARTS[sim.mesh.fpart[f]].color);
      for (let k = 0; k < 4; k++) cols.set(c, 3 * Q[4 * f + k]);
    }
  } else if (app.shading === 'tags') {
    for (const [name, g] of Object.entries(app.tagGroups)) {
      const s = app.doc.groups[name];
      if (!s || !s.visible) continue;
      const c = hex(s.color);
      for (let i = 0; i < n; i++) if (g[i]) cols.set(c, 3 * i);
    }
  } else if (app.shading === 'poles') {
    for (let i = 0; i < n; i++) {
      const v = sim.off[i + 1] - sim.off[i];
      if (v === 3) cols.set([0.18, 0.44, 0.88], 3 * i);
      else if (v === 5) cols.set([0.9, 0.45, 0.15], 3 * i);
      else if (v !== 4) cols.set([0.85, 0.2, 0.6], 3 * i);
    }
  } else if (app.shading === 'anatomy') {
    if (!app.anat) refreshAnatomy(false);
    const A = app.anat, Q = sim.mesh.quads;
    if (A) for (let f = 0; f < Q.length / 4; f++) { const c = A.regions[A.face[f]].color; for (let k = 0; k < 4; k++) cols.set(c, 3 * Q[4 * f + k]); }
  }
  app.v3.setColors(cols);
}

// ---------------- main loop ----------------
let frameNo = 0, lastFit = 0;
// Settled also when movement has stopped getting smaller: a dense mesh keeps a small shimmer
// above the threshold (spread thin over the whole body), and would otherwise never stop.
// Counted from when this run started (a continue or a new setting starts a new count).
const plat = { best: Infinity, at: 0, start: 0 };
function resetPlateau() { const it = app.sim ? app.sim.iter : 0; plat.best = Infinity; plat.at = it; plat.start = it; }
function plateau(sim) {
  const run = sim.iter - plat.start;
  if (run < 60) return false;
  if (sim.lastMove < 0.9 * plat.best) { plat.best = sim.lastMove; plat.at = sim.iter; }
  return (run > 600 && sim.iter - plat.at > 150 && sim.lastMove < 1e-4) || run > 2500;
}
function loop(t) {
  requestAnimationFrame(loop);
  const sim = app.sim;
  if (sim && app.running && !app.settled) {
    for (let i = 0; i < app.steps; i++) sim.step(app.prm);
    app.v3.update(sim.P, sim.N);
    frameNo++;
    if (frameNo % 12 === 0) updateTags();
    if (sim.detail) {
      // detail pass on the face: judged on the head only, with a cap
      const d = sim.detail;
      if ((sim.lastMove < 8e-6 && d.iter > 150) || d.iter > 900) { if (++app.stillFrames > 20 || d.iter > 900) { app.settled = true; refreshFit(); setRunning(false); toast('Face, hands and feet refined'); refreshAnatomy(); if (app.rigPanel) app.rigPanel.onSettled(); } }
      else app.stillFrames = 0;
    } else if ((sim.lastMove < 2.5e-5 && sim.iter > 60) || plateau(sim)) {
      if (++app.stillFrames > 30) {
        app.stillFrames = 0;
        if (app.prm.faceDetail && (app.face || app.digits)) { sim.startDetail(app.face, app.digits); goStep('refine', 'inflate'); toast('Body settled: now working the face, hands and feet in finer steps'); }
        else { app.settled = true; refreshFit(); setRunning(false); toast('Inflated: the balloon has settled'); refreshAnatomy(); if (app.rigPanel) app.rigPanel.onSettled(); }
      }
    } else app.stillFrames = 0;
    if (t - lastFit > 450) { lastFit = t; refreshFit(); }
    app.v2.dirty = true;
  }
  app.v2.draw();
  app.v3.render();
  if (frameNo % 20 === 0) statusLine();
}

// inflation only runs when asked: the Inflate button, or Deflate and reinflate
function wake() { app.settled = false; app.stillFrames = 0; resetPlateau(); }
// Show a step's panel. With `from`, only when that step is the one showing (so the panel follows
// the work without pulling the user away from another step).
function goStep(step, from) {
  const cur = document.querySelector('.tab[aria-selected="true"]');
  if (from && cur && cur.dataset.tab !== from) return;
  document.querySelectorAll('.tab').forEach((o) => o.setAttribute('aria-selected', String(o.dataset.tab === step)));
  document.querySelectorAll('.tabpanel').forEach((p) => (p.hidden = p.dataset.panel !== step));
  app.v3.show.skeleton = step === 'rig' && $('rig-show').checked;
  app.v3.applyVisibility();
}
app.goStep = goStep;
// What the finer pass did and found, shown in the Refine step
function refineStatus() {
  const sim = app.sim, el = $('refine-status');
  if (!el || !sim) return;
  const d = sim.detail, f = app.face, g = app.digits;
  const state = !sim.iter ? 'not started: the body inflates first' : d ? (app.running ? `refining · step ${d.iter}` : `done · ${d.iter} steps`) : app.running ? 'inflating the body first' : 'not refined yet';
  const rows = [['state', state]];
  if (f) rows.push(['face features used', `${f.eyes} eyes · ${f.ridges} brow lines · ${f.marks} widths (nose, mouth)`]);
  else rows.push(['face', app.params.face ? 'no face features found' : 'face loops are off (Refine → face loops)']);
  if (g) rows.push(['fingers and toes', `${g.matched} of ${g.digits} laid on their drawn shapes`]);
  else rows.push(['fingers and toes', 'no top view, or digits off']);
  el.innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  $('btn-refine').textContent = app.running && d ? 'Stop' : d && !app.running ? 'Refine again' : 'Refine face, hands and feet';
  $('btn-compare').disabled = !d;
}
// Start the finer pass now (after the body has inflated), or inflate first and refine after
function startRefine() {
  const sim = app.sim;
  if (!sim) return;
  if (app.running && sim.detail) { setRunning(false); return; }
  showBefore(false);
  if (!sim.iter || (app.running && !sim.detail)) { app.prm.faceDetail = true; $('faceDetail').checked = true; if (!app.running) setRunning(true); toast('Inflating the body first; refining follows'); return; }
  if (!app.face && !app.digits) { toast('Nothing to refine: no face features and no top view'); return; }
  sim.startDetail(app.face, app.digits);
  app.settled = false;
  setRunning(true);
}
// Before / after the finer pass
function showBefore(on) {
  const sim = app.sim, d = sim && sim.detail;
  app.comparing = !!(on && d);
  $('btn-compare').setAttribute('aria-pressed', String(app.comparing));
  $('btn-compare').textContent = app.comparing ? 'Show after' : 'Show before';
  if (!sim) return;
  if (app.comparing) app.v3.update(d.hold); else app.v3.update(sim.P, sim.N);
}
// Camera onto part of the figure
function lookAt(what) {
  const sim = app.sim, v3 = app.v3, M = app.model && app.model.measure;
  if (!sim || !M) return;
  const o = v3.orbit, P = sim.P, H = M.H;
  const around = (pick) => { let x = 0, y = 0, z = 0, n = 0, r = 0; for (let i = 0; i < sim.n; i++) if (pick(i)) { x += P[3 * i]; y += P[3 * i + 1]; z += P[3 * i + 2]; n++; } if (!n) return null; x /= n; y /= n; z /= n; for (let i = 0; i < sim.n; i++) if (pick(i)) r = Math.max(r, Math.hypot(P[3 * i] - x, P[3 * i + 1] - y, P[3 * i + 2] - z)); return { c: [x, y, z], r }; };
  let t = null, th = 0.45, ph = 1.45;
  if (what === 'face') { const hh = H - M.W.chin; t = { c: [0, M.W.chin + 0.5 * hh, M.profileAt('trunk', M.W.chin + 0.5 * hh)[2]], r: 0.75 * hh }; th = 0.35; }
  else if (what === 'hands') { t = around((i) => sim.ext[i] === 1 && P[3 * i] > 0); th = 0.5; ph = 1.0; }
  else if (what === 'feet') { t = around((i) => sim.ext[i] === 2); th = 0.6; ph = 1.15; }
  if (!t) { v3.preset('three'); return; }
  o.target.set(...t.c); o.dist = Math.max(0.12 * H, 3.2 * t.r); o.theta = th; o.phi = ph;
  v3.needs = true;
}
function markSteps() {
  const sim = app.sim;
  const done = {
    draw: !!(app.masks && app.masks.front && app.masks.side),
    inflate: !!(sim && sim.iter > 0 && (app.settled || sim.detail)),
    refine: !!(sim && app.settled && sim.detail),
    rig: !!(app.rigState && app.rigState.fit),
  };
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('done', !!done[t.dataset.tab]));
}
function setRunning(on) {
  if (on && app.comparing) showBefore(false);
  app.running = on;
  if (on) { wake(); if (app.rigPanel) app.rigPanel.onRun(); }
  $('btn-run').textContent = on ? 'Stop' : 'Inflate';
  $('btn-run2').textContent = on ? 'Stop' : app.sim && app.sim.iter > 0 ? 'Continue inflating' : 'Inflate';
  $('btn-run').setAttribute('aria-pressed', String(on));
  statusLine();
}

function statusLine() {
  const sim = app.sim;
  if (!sim) return;
  const f = app.fit || {};
  const cover = f.front ? `front <b>${fmt(100 * f.front.cover, 0)}%</b>` : '';
  const side = f.side ? ` side <b>${fmt(100 * f.side.cover, 0)}%</b>` : '';
  const state = app.running ? (sim.detail ? 'refining face, hands, feet' : 'inflating') : sim.iter === 0 ? 'press Inflate' : app.settled ? 'settled' : 'stopped';
  setStatus(`<b>${sim.mesh.quads.length / 4}</b> quads · ${cover}${side} · ${state}`, true);
  markSteps();
  refineStatus();
}
function setStatus(s, html) { if (html) $('status').innerHTML = s; else $('status').textContent = s; }

let toastT = null;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2400); }

// ---------------- document actions (called by the 2D view) ----------------
app.selectPath = (p) => { app.selected = p; renderSelCard(); app.v2.dirty = true; };
app.deletePath = (p) => {
  // a mirrored twin goes with it
  app.doc.paths = app.doc.paths.filter((q) => q !== p && !(p.twin != null && q.id === p.twin) && !(q.twin != null && q.twin === p.id));
  if (app.selected === p) app.selected = null;
  renderSelCard();
  scheduleFull();
};
// Eraser: cut out the part of a stroke within r of (cx, cy); what is left stays as open strokes.
// A mirrored twin loses the mirrored part.
app.erasePart = (p, cx, cy, r, noTwin) => {
  const doc = app.doc;
  const src = p.closed ? [...p.pts, p.pts[0]] : p.pts;
  const dense = [];
  for (let i = 0; i < src.length - 1; i++) {
    const [x0, y0] = src[i], [x1, y1] = src[i + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r / 3)));
    for (let j = 0; j < k; j++) dense.push([x0 + ((x1 - x0) * j) / k, y0 + ((y1 - y0) * j) / k]);
  }
  dense.push(src[src.length - 1]);
  const keep = dense.map(([x, y]) => Math.hypot(x - cx, y - cy) > r);
  if (keep.every(Boolean)) return false;
  let runs = [], cur = [];
  dense.forEach((q, i) => { if (keep[i]) cur.push(q); else if (cur.length) { runs.push(cur); cur = []; } });
  if (cur.length) runs.push(cur);
  // a closed stroke cut once is one open stroke, starting and ending at the cut
  if (p.closed && runs.length > 1 && keep[0] && keep[keep.length - 1]) { const last = runs.pop(); runs[0] = [...last, ...runs[0]]; }
  runs = runs.filter((q) => q.length > 1 && polyLength(q) > r * 0.5); // crumbs go
  const twin = !noTwin && p.twin != null ? doc.paths.find((q) => q.id === p.twin) : null;
  doc.paths = doc.paths.filter((q) => q !== p);
  const made = [];
  for (const q of runs) {
    const np = newPath(simplify(q, r / 12), { closed: false, color: p.color, role: p.role, group: p.group, view: p.view, part: p.part, side: p.side });
    doc.paths.push(np);
    made.push(np);
  }
  if (twin) {
    const tw = app.erasePart(twin, 2 * doc.views.front.axis - cx, cy, r, true);
    // pieces stay twinned: each with the other side's piece nearest its mirror image
    const ax = doc.views.front.axis;
    const cen = (q) => { let x = 0, y = 0; for (const [a, b] of q.pts) { x += a; y += b; } return [x / q.pts.length, y / q.pts.length]; };
    for (const a of made) {
      const [x, y] = cen(a);
      let best = null, bd = Infinity;
      for (const b of Array.isArray(tw) ? tw : []) { if (b.twin != null) continue; const [u, v] = cen(b); const d = Math.hypot(2 * ax - u - x, v - y); if (d < bd) { bd = d; best = b; } }
      if (best) { a.twin = best.id; best.twin = a.id; }
    }
  }
  if (app.selected === p) app.selected = null;
  return noTwin ? made : true;
};
app.eraseDone = () => { renderSelCard(); scheduleFull(10); };
app.addPath = (pts, closed, meta = {}) => {
  const doc = app.doc;
  const bb = bboxOf(pts);
  const view = viewAtPoint(doc, (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
  // the active layer sets what the stroke is: outline, feature (grouped by pen colour) or note
  const layer = app.layer || 'line';
  let opts;
  if (layer === 'feature') {
    const o = penPathOpts(app.penColor);
    opts = o.role === 'feature' ? { ...o, color: app.penColor } : { role: 'feature', group: 'marks', color: '#b0587a' };
    if (view === 'front' && meta.back) opts.side = 'far';
  } else opts = { role: layer, color: layer === 'line' ? '#1b1f27' : '#8a919c' };
  let twin = null;
  if (app.mirrorDraw && view === 'front' && layer !== 'note') {
    const tol = 0.012 * (doc.views.front.floor - doc.views.front.top);
    const r = mirrorStroke(pts, closed, doc.views.front.axis, tol, layer === 'line');
    pts = r.pts; closed = r.closed; twin = r.twin;
  }
  const p = newPath(pts, { closed, ...opts, view });
  doc.paths.push(p);
  if (twin) { const q = newPath(twin, { closed, ...opts, view }); q.twin = p.id; p.twin = q.id; doc.paths.push(q); }
  ensureGroups(doc);
  app.selected = p;
  renderSelCard();
  scheduleFull(10);
};
app.onCursor = (c) => {
  if (!c || !app.frame) { app.v3.setCursor(null); $('note2d').textContent = ''; return; }
  if (c.view === 'top') {
    const [x, z] = app.frame.tw(c.x, c.y);
    app.v3.setCursor(null);
    $('note2d').textContent = `top view · x ${fmt(x, 3)} m · z ${fmt(z, 3)} m (forward)`;
    return;
  }
  const t = app.frame.tFromDoc(c.view, c.y);
  const y = t * app.frame.H;
  app.v3.setCursor(y);
  const st = app.doc.stations;
  let near = '', nd = 0.02;
  if (st) for (const k of HEIGHT_STATIONS) if (Math.abs(st[k] - t) < nd) { nd = Math.abs(st[k] - t); near = ' · ' + STATION_LABEL[k].toLowerCase(); }
  $('note2d').textContent = `${c.view} · height ${fmt(y, 3)} m · ${fmt((1 - t) * app.doc.canon, 2)} heads from top${near}`;
};
app.dragHandle = (h, x, y) => {
  const doc = app.doc;
  if (h.kind === 'st') {
    doc.stations[h.key] = app.frame.tFromDoc(h.view, y);
    setAuto(false);
  } else if (h.kind === 'arm') {
    doc.stations[h.key] = Math.abs(app.frame.fw(x, 0)[0]) / app.frame.H;
    setAuto(false);
  } else if (h.kind === 'cal') {
    doc.views[h.view][h.key] = y;
    doc.views[h.view].manual[h.key] = true;
    app.frame = new Frame(doc);
    app.v3.setDrawings(doc, app.frame);
  } else if (h.kind === 'axis') {
    doc.views[h.view].axis = x;
    doc.views[h.view].manual.axis = true;
    app.frame = new Frame(doc);
    app.v3.setDrawings(doc, app.frame);
  } else if (h.kind === 'split') {
    doc.splitX = x;
  } else if (h.kind === 'splitY') {
    doc.splitY = y;
  } else if (h.kind === 'topz') {
    doc.views.top.axisZ = y;
    doc.views.top.manual.axisZ = true;
    app.frame = new Frame(doc);
    app.v3.setDrawings(doc, app.frame);
  }
  renderStations();
  scheduleModel(140);
};
app.dragHandleEnd = (h) => {
  if (h.kind === 'split' || h.kind === 'splitY') { assignViews(app.doc); scheduleFull(10); return; }
  doc_sanitize();
  scheduleModel(10);
};
function doc_sanitize() { app.doc.stations = sanitizeStations(app.doc.stations); }

app.fillAt = (view, pt) => {
  if (view !== 'side') { toast('Fill sets the arm cross-section: click inside an enclosed area of the side view'); return; }
  app.doc.sectionSeed = pt;
  app.doc.sectionOff = false;
  for (const p of app.doc.paths) if (p.role === 'section') p.role = 'line';
  app.masks = buildMasks(app.doc, { gapFrac: app.gapFrac });
  if (!app.masks.section) { app.doc.sectionSeed = null; toast('That area is not enclosed. Click inside a closed shape.'); }
  else toast('Arm cross-section set');
  makeMaskImages();
  renderDrawingPanel();
  rebuildModel();
};

let lmCount = 0;
app.placeLandmark = (view, pt) => {
  const doc = app.doc;
  const pending = app.selectedLandmark && !app.selectedLandmark[view] ? app.selectedLandmark : null;
  if (pending) pending[view] = pt;
  else {
    lmCount = Math.max(lmCount, doc.landmarks.length) + 1;
    const l = { name: 'P' + lmCount, front: null, side: null };
    l[view] = pt;
    doc.landmarks.push(l);
    app.selectedLandmark = l;
  }
  app.landmarksChanged(true);
};
app.selectLandmark = (l) => { app.selectedLandmark = l; renderLandmarks(); app.v2.dirty = true; };
app.landmarksChanged = (final) => {
  app.v2.dirty = true;
  if (final) { updatePins(); renderLandmarks(); wake(); scheduleSave(); }
};
let paintTick = 0;
app.onPaint = (p, r, erase) => {
  if (!app.paintGroup) { toast('Make a tag group first'); return; }
  app.doc.paint.push({ group: app.paintGroup, p, r, erase: !!erase });
  if (++paintTick % 3 === 0) { updateTags(); applyShading(); }
};
app.onPaintEnd = () => { updateTags(); applyShading(); scheduleSave(); wake(); };

function setAuto(on) { app.doc.stationsAuto = on; $('st-auto').checked = on; }

// ---------------- loading ----------------
async function setDoc(doc) {
  app.doc = doc;
  app.selected = null; app.selectedLandmark = null;
  app.bgImage = null;
  if (doc.bg && doc.bg.src) {
    const img = new Image();
    img.src = doc.bg.src;
    try { await img.decode(); app.bgImage = img; } catch (e) { app.bgImage = null; }
  }
  $('height').value = doc.heightM.toFixed(2);
  $('canon').value = String(doc.canon);
  $('st-auto').checked = doc.stationsAuto;
  app.paintGroup = Object.keys(doc.groups)[0] || null;
  app.v2.fit();
  fullRebuild();
  app.v3.preset('three');
}

async function imageToDoc(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  const paths = traceImageData(ctx.getImageData(0, 0, c.width, c.height));
  const doc = createDoc();
  doc.paths = paths;
  doc.bg = { src, x: 0, y: 0, w: c.width, h: c.height };
  prepareImported(doc);
  return doc;
}

function readAsDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }

async function openFile(file) {
  const mode = $('import-mode').value;
  setStatus('reading ' + file.name + '…');
  let doc;
  try {
    // clean vector outlines need almost no gap closing; traced sketches need more
    if (/svg/.test(file.type) || /\.svg$/i.test(file.name)) {
      const r = loadProjectSVG(await file.text());
      doc = r.doc;
      app.gapFrac = (r.meta && r.meta.gapFrac) || 0.004;
    } else {
      doc = await imageToDoc(await readAsDataURL(file));
      app.gapFrac = 0.012;
    }
    syncControls();
  } catch (e) {
    toast('Could not read that file: ' + e.message);
    return;
  }
  if (mode === 'both') { await setDoc(doc); toast(`Loaded ${file.name}`); return; }
  mergeView(doc, mode);
  toast(`Loaded ${file.name} as the ${mode} view`);
}

// Put a single-view file next to the existing other view, scaled to the same height.
async function mergeView(src, view) {
  const doc = app.doc;
  const other = view === 'front' ? 'side' : 'front';
  const keep = doc.paths.filter((p) => p.view === other || p.view === 'both');
  const incoming = src.paths.filter((p) => p.role !== 'guide');
  const lb = (ps) => ps.filter((p) => p.role === 'line').map((p) => bboxOf(p.pts)).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  const kb = lb(keep.filter((p) => p.view === other)), ib = lb(incoming);
  if (!isFinite(ib.x0)) { toast('No outline strokes found in that file.'); return; }
  let s = 1, dx = 0, dy = 0;
  if (isFinite(kb.x0)) {
    s = (kb.y1 - kb.y0) / (ib.y1 - ib.y0 || 1);
    const gap = (kb.y1 - kb.y0) * 0.25;
    dy = kb.y0 - ib.y0 * s;
    dx = view === 'side' ? kb.x1 + gap - ib.x0 * s : kb.x0 - gap - ib.x1 * s;
  }
  for (const p of incoming) { p.pts = p.pts.map(([x, y]) => [x * s + dx, y * s + dy]); p.view = view; }
  doc.paths = [...keep, ...incoming];
  for (const [k, g] of Object.entries(src.groups)) if (!doc.groups[k]) doc.groups[k] = g;
  const nb = lb(doc.paths.filter((p) => p.view === 'front')), sb = lb(doc.paths.filter((p) => p.view === 'side'));
  if (isFinite(nb.x1) && isFinite(sb.x0)) doc.splitX = (nb.x1 + sb.x0) / 2;
  if (view === 'front') doc.bg = null;
  for (const v of ['front', 'side']) doc.views[v].manual = {};
  prepareImported(doc, { keepRoles: true });
  await setDoc(doc);
}

async function loadSample(name) {
  // generated reference figures: clean vector outlines need almost no gap closing
  app.gapFrac = 0.003;
  syncControls();
  await setDoc(buildFigure(name));
}

function projectSVG() {
  return exportSVG(app.doc, { params: app.params, prm: app.prm, gapFrac: app.gapFrac });
}
function autosave() {
  try { localStorage.setItem('ff-project-v4', projectSVG()); } catch (e) { /* storage unavailable or full */ }
}
function applyProjectMeta(meta) {
  if (!meta) return;
  if (meta.params) Object.assign(app.params, meta.params);
  if (meta.prm) Object.assign(app.prm, meta.prm);
  if (meta.gapFrac) app.gapFrac = meta.gapFrac;
  syncControls();
}

// ---------------- panels ----------------
function renderDrawingPanel() {
  renderSelCard();
  const counts = {};
  for (const p of app.doc.paths) counts[p.role] = (counts[p.role] || 0) + 1;
  $('stroke-stats').innerHTML = Object.entries(ROLES).map(([k, v]) => `<span>${v}</span><b>${counts[k] || 0}</b>`).join('');
  for (const b of $('facing').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.facing === app.doc.views.side.facing));
  const sec = app.masks && app.masks.section;
  $('section-state').innerHTML = sec
    ? `<span class="chip ok">set</span> ${fmt(2 * sec.hw * app.frame.S.s * 100, 1)} × ${fmt(2 * sec.hh * app.frame.S.s * 100, 1)} cm`
    : '<span class="chip">none</span> arms assumed round';
  renderTags();
}

function renderSelCard() {
  const p = app.selected, el = $('sel-card');
  if (!p) { el.innerHTML = '<p class="hint">Click a stroke in the drawings to set its role, view or tag group.</p>'; return; }
  const groups = Object.keys(app.doc.groups);
  el.innerHTML = `<div class="sel-card">
    <div class="row"><label for="sel-role">Role</label><select id="sel-role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === p.role ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="row"><label for="sel-view">View</label><select id="sel-view">${['front', 'side', 'both'].map((v) => `<option ${v === p.view ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    ${p.role === 'feature' ? `<div class="row"><label for="sel-group">Tag group</label><input type="text" id="sel-group" list="group-names" value="${escapeAttr(p.group || '')}"></div>
    <datalist id="group-names">${groups.map((g) => `<option value="${escapeAttr(g)}">`).join('')}</datalist>
    <div class="row"><label for="sel-side">Tags the surface</label><select id="sel-side">${[['', 'default for view'], ['near', 'facing this view'], ['far', 'facing away'], ['both', 'both sides']].map(([v, l]) => `<option value="${v}" ${(p.side || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
    <div class="row"><label for="sel-closed">Closed shape</label><input type="checkbox" id="sel-closed" ${p.closed ? 'checked' : ''}></div>
    <div class="stats"><span>points</span><b>${p.pts.length}</b><span>colour</span><b><span class="swatch" style="display:inline-block;vertical-align:-2px;background:${p.color}"></span> ${p.color}</b></div>
    <div class="btn-row"><button class="btn" id="sel-del">Delete stroke</button></div></div>`;
  $('sel-role').onchange = (e) => {
    p.role = e.target.value;
    if (p.role === 'feature' && !p.group) p.group = colorName(parseColor(p.color));
    if (p.role === 'section') p.part = 'arm';
    if (p.role === 'section') for (const q of app.doc.paths) if (q !== p && q.role === 'section') q.role = 'line';
    ensureGroups(app.doc); renderSelCard(); scheduleFull(10);
  };
  $('sel-view').onchange = (e) => { p.view = e.target.value; scheduleFull(10); };
  const g = $('sel-group');
  if (g) g.onchange = (e) => { p.group = e.target.value.trim() || colorName(parseColor(p.color)); ensureGroups(app.doc); renderTags(); updateTags(); wake(); };
  const sd = $('sel-side');
  if (sd) sd.onchange = (e) => { p.side = e.target.value || null; updateTags(); wake(); };
  $('sel-closed').onchange = (e) => { p.closed = e.target.checked; scheduleFull(10); };
  $('sel-del').onclick = () => app.deletePath(p);
}
function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function renderStations() {
  const doc = app.doc, fr = app.frame;
  if (!doc.stations || !fr) return;
  const H = fr.H, n = doc.canon;
  const rows = ['chin', 'neck', 'shoulder', 'armpit', 'waist', 'hip', 'crotch', 'knee', 'ankle'];
  const tbl = $('st-table');
  if (!tbl.dataset.built) {
    tbl.innerHTML = rows.map((k) => `<label for="st-${k}">${STATION_LABEL[k]}</label><input type="number" id="st-${k}" step="0.005"><span class="hu" id="hu-${k}"></span>`).join('');
    for (const k of rows) $('st-' + k).addEventListener('change', (e) => { doc.stations[k] = +e.target.value / app.frame.H; setAuto(false); doc_sanitize(); scheduleModel(10); });
    $('arm-table').innerHTML = ARM_STATIONS.map((k) => `<label for="st-${k}">${STATION_LABEL[k]}</label><input type="number" id="st-${k}" step="0.005"><span class="hu" id="hu-${k}"></span>`).join('');
    for (const k of ARM_STATIONS) $('st-' + k).addEventListener('change', (e) => { doc.stations[k] = +e.target.value / app.frame.H; setAuto(false); doc_sanitize(); scheduleModel(10); });
    tbl.dataset.built = '1';
  }
  for (const k of rows) {
    const inp = $('st-' + k);
    if (document.activeElement !== inp) inp.value = (doc.stations[k] * H).toFixed(3);
    $('hu-' + k).textContent = ((1 - doc.stations[k]) * n).toFixed(2) + ' hd';
  }
  for (const k of ARM_STATIONS) {
    const inp = $('st-' + k);
    if (document.activeElement !== inp) inp.value = (doc.stations[k] * H).toFixed(3);
    $('hu-' + k).textContent = (doc.stations[k] * n).toFixed(2) + ' hd';
  }
  const heads = 1 / (1 - doc.stations.chin);
  $('heads-readout').innerHTML = `<span>drawing measures</span><b>${fmt(heads, 1)} heads</b><span>head height</span><b>${fmt(H * (1 - doc.stations.chin), 3)} m</b><span>canon crotch at</span><b>${fmt(canonStations(n).crotch * H, 3)} m</b><span>drawing crotch at</span><b>${fmt(doc.stations.crotch * H, 3)} m</b>`;
  const f = doc.views.front, s = doc.views.side;
  const man = (v, k) => (v.manual[k] ? ' ✎' : '');
  $('cal-readout').innerHTML = `<span>front top / floor</span><b>${fmt(f.top, 0)}${man(f, 'top')} / ${fmt(f.floor, 0)}${man(f, 'floor')}</b><span>front centre line</span><b>${fmt(f.axis, 0)}${man(f, 'axis')}</b><span>side top / floor</span><b>${fmt(s.top, 0)}${man(s, 'top')} / ${fmt(s.floor, 0)}${man(s, 'floor')}</b><span>side depth axis</span><b>${fmt(s.axis, 0)}${man(s, 'axis')}</b><span>scale front / side</span><b>${fmt(fr.F.s * 1000, 3)} / ${fmt(fr.S.s * 1000, 3)} mm per unit</b>`;
  renderLandmarks();
}

function renderLandmarks() {
  const el = $('lm-list');
  const doc = app.doc;
  if (!doc.landmarks.length) { el.innerHTML = '<p class="hint">No landmarks yet.</p>'; return; }
  el.innerHTML = doc.landmarks.map((l, i) => `<div class="lm-item ${l === app.selectedLandmark ? 'sel' : ''}" data-i="${i}"><input type="text" value="${escapeAttr(l.name)}" aria-label="Landmark name"><span class="chip ${l.front ? 'ok' : ''}">front</span><span class="chip ${l.side ? 'ok' : ''}">side</span><button class="btn" data-del="${i}" aria-label="Delete landmark">×</button></div>`).join('');
  el.querySelectorAll('.lm-item').forEach((row) => {
    const l = doc.landmarks[+row.dataset.i];
    row.querySelector('input').onchange = (e) => { l.name = e.target.value; app.v2.dirty = true; scheduleSave(); };
    row.onclick = (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') app.selectLandmark(l); };
    row.querySelector('[data-del]').onclick = () => { doc.landmarks.splice(+row.dataset.i, 1); if (app.selectedLandmark === l) app.selectedLandmark = null; app.landmarksChanged(true); };
  });
}

function renderTopology() {
  const c = app.model.cage.check, sim = app.sim;
  const row = (k, v) => `<span>${k}</span><b>${v}</b>`;
  $('topo-stats').innerHTML = [
    row('cage quads', c.faces), row('cage vertices', c.verts),
    row('poles with 3 edges', c.poles3), row('poles with 5 edges', c.poles5),
    row('other poles', c.polesOther),
    row('closed surface', c.badEdges ? `<span class="chip warn">${c.badEdges} open edges</span>` : '<span class="chip ok">yes</span>'),
    row('mesh quads', sim.mesh.quads.length / 4), row('mesh vertices', sim.n),
    row('edge loops', sim.mesh.loops.length), row('mirror pairs found', app.model.mirrorMisses ? `${sim.n - app.model.mirrorMisses}/${sim.n}` : 'all'),
    row('build time', fmt(app.buildMs, 0) + ' ms'),
  ].join('');
}

function renderExportLevels() {
  const sel = $('exp-level');
  const lv = app.sim.mesh.levels;
  const cur = sel.value;
  sel.innerHTML = lv.map((l, i) => `<option value="${i}">${i === 0 ? 'cage' : 'level ' + i} · ${l.quads.length / 4} quads</option>`).join('');
  sel.value = cur && +cur < lv.length ? cur : String(lv.length - 1);
}

function renderTags() {
  const doc = app.doc;
  const el = $('tag-list');
  const names = Object.keys(doc.groups);
  if (!names.length) el.innerHTML = '<p class="hint">No feature groups yet. Draw on the Features layer, or make a group and paint.</p>';
  else el.innerHTML = names.map((name) => {
    const g = doc.groups[name];
    return `<div class="tag-item ${name === app.paintGroup ? 'active' : ''}" data-name="${escapeAttr(name)}">
      <div class="tag-head"><input type="color" value="${toHex(parseColor(g.color) || { r: 200, g: 60, b: 120 })}" aria-label="Group colour" style="width:22px;height:18px;padding:0;border:0;background:none"><input type="text" value="${escapeAttr(name)}" aria-label="Group name"><span class="chip" data-count>0</span><label class="toggle" title="Show"><input type="checkbox" data-vis ${g.visible ? 'checked' : ''}>show</label></div>
      <details class="tag-more" ${app.openTags && app.openTags.has(name) ? 'open' : ''}><summary>settings</summary>
      <div class="tag-body">
        <div class="slider"><label>puff out</label><span class="val">${fmt(g.pressure, 2)}×</span><input type="range" min="0" max="2.5" step="0.05" value="${g.pressure}" data-k="pressure" aria-label="Pressure multiplier"></div>
        <div class="slider"><label>flatten</label><span class="val">${fmt(g.tension, 2)}×</span><input type="range" min="0" max="4" step="0.05" value="${g.tension}" data-k="tension" aria-label="Tension multiplier"></div>
      </div>
      <label class="toggle"><input type="checkbox" data-loop ${g.loop ? 'checked' : ''}>pull the nearest ring onto this group's lines</label>
      <div class="btn-row"><button class="btn" data-paint>Paint with this</button><button class="btn" data-clear>Clear paint</button><button class="btn" data-del>Delete group</button></div>
      </details>
    </div>`;
  }).join('');
  el.querySelectorAll('.tag-item').forEach((item) => {
    const name = item.dataset.name;
    const g = doc.groups[name];
    const [colorIn, nameIn] = item.querySelectorAll('.tag-head input');
    colorIn.oninput = (e) => { g.color = e.target.value; applyShading(); scheduleSave(); };
    nameIn.onchange = (e) => {
      const nn = e.target.value.trim();
      if (!nn || nn === name || doc.groups[nn]) { e.target.value = name; return; }
      doc.groups[nn] = g; delete doc.groups[name];
      for (const p of doc.paths) if (p.group === name) p.group = nn;
      for (const d of doc.paint) if (d.group === name) d.group = nn;
      if (app.paintGroup === name) app.paintGroup = nn;
      renderTags(); updateTags(); scheduleSave();
    };
    item.querySelector('.tag-more').ontoggle = (e) => { app.openTags = app.openTags || new Set(); if (e.target.open) app.openTags.add(name); else app.openTags.delete(name); };
    item.querySelector('[data-vis]').onchange = (e) => { g.visible = e.target.checked; applyShading(); app.v2.dirty = true; };
    item.querySelectorAll('input[type=range]').forEach((r) => {
      r.oninput = (e) => { g[r.dataset.k] = +e.target.value; r.previousElementSibling.textContent = fmt(+e.target.value, 2) + '×'; updateTags(); wake(); scheduleSave(); };
    });
    item.querySelector('[data-loop]').onchange = (e) => { g.loop = e.target.checked; updateTags(); wake(); scheduleSave(); };
    item.querySelector('[data-paint]').onclick = () => { app.paintGroup = name; $('paint-on').checked = true; setPaint(true); renderTags(); };
    item.querySelector('[data-clear]').onclick = () => { doc.paint = doc.paint.filter((d) => d.group !== name); updateTags(); applyShading(); wake(); };
    item.querySelector('[data-del]').onclick = () => {
      delete doc.groups[name];
      for (const p of doc.paths) if (p.group === name && p.role === 'feature') { p.role = 'note'; }
      doc.paint = doc.paint.filter((d) => d.group !== name);
      if (app.paintGroup === name) app.paintGroup = Object.keys(doc.groups)[0] || null;
      renderTags(); renderDrawingPanel(); updateTags(); applyShading(); wake();
    };
  });
  const ps = $('paint-group');
  ps.innerHTML = names.map((n) => `<option ${n === app.paintGroup ? 'selected' : ''}>${escapeAttr(n)}</option>`).join('');
  renderTagCounts();
}

function renderTagCounts() {
  document.querySelectorAll('#tag-list .tag-item').forEach((item) => {
    const g = app.tagGroups[item.dataset.name];
    let c = 0;
    if (g) for (let i = 0; i < g.length; i++) c += g[i];
    item.querySelector('[data-count]').textContent = c + ' v';
  });
}

function setPaint(on) {
  app.paintMode = on;
  if (!on) app.v3.hideBrush();
  $('stage3d').style.cursor = on ? 'crosshair' : '';
  if (on && !app.paintGroup) {
    const name = 'painted';
    if (!app.doc.groups[name]) app.doc.groups[name] = defaultGroup('#d0457a');
    app.paintGroup = name;
    renderTags();
  }
  if (on && app.shading !== 'tags') setShading('tags');
}

// Anatomy: labels on quads and loops, and the coverage report in the Refine step
function refreshAnatomy(render = true) {
  if (!app.sim || !app.model) return;
  app.anat = tagAnatomy(app.model, app.sim);
  const A = app.anat, cv = A.coverage;
  const mark = { yes: '●', part: '◐', no: '○' };
  $('anat-score').innerHTML = `<span>coverage</span><b>${Math.round(100 * cv.score)}%</b><span>regions</span><b>${A.regions.length}</b><span>loops with an anatomical role</span><b>${A.loops.filter((l) => !/^plain ring/.test(l.anatomy)).length} of ${A.loops.length}</b>`;
  let area = '';
  $('anat-items').innerHTML = cv.items.map((it) => {
    const head = it.area !== area ? `<div class="anat-area">${(area = it.area)}</div>` : '';
    return `${head}<div class="anat-item ${it.status}" title="${it.note || ''}"><span class="anat-mark">${mark[it.status]}</span><span>${it.label}${it.note ? `<small>${it.note}</small>` : ''}</span></div>`;
  }).join('') + (cv.thin.length ? `<p class="hint">Few quads for their size (below 0.8× the body's average): <b>${cv.thin.join(', ')}</b></p>` : '');
  $('anat-regions').innerHTML = '<span><b>region</b></span><span><b>quads</b></span><span><b>density</b></span>' + A.regions.map((r) => `<span><i class="anat-sw" style="background:rgb(${r.color.map((c) => Math.round(255 * c)).join(',')})"></i>${r.name}</span><span>${r.quads}</span><span class="${r.density < 0.8 ? 'low' : ''}">${r.density.toFixed(2)}×</span>`).join('');
  if (render && app.shading === 'anatomy') applyShading();
}
app.refreshAnatomy = refreshAnatomy;
function setShading(s) {
  app.shading = s;
  for (const b of $('shading').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.shade === s));
  applyShading();
}

// ---------------- controls ----------------
const SLIDERS = {
  gap: { get: () => app.gapFrac * 100, set: (v) => { app.gapFrac = v / 100; scheduleFull(200); }, show: (v) => (app.masks && app.masks.front ? `${fmt(v, 1)}% · ${fmt(v / 100 * (app.doc.views.front.floor - app.doc.views.front.top), 0)} units` : fmt(v, 1) + '%') },
  rings: { get: () => app.params.rings, set: (v) => { app.params.rings = v; scheduleModel(); } },
  headRings: { get: () => app.params.headRings, set: (v) => { app.params.headRings = v; scheduleModel(); } },
  handRings: { get: () => app.params.handRings, set: (v) => { app.params.handRings = v; scheduleModel(); } },
  fingerRings: { get: () => app.params.fingerRings, set: (v) => { app.params.fingerRings = v; scheduleModel(); } },
  toeRings: { get: () => app.params.toeRings, set: (v) => { app.params.toeRings = v; scheduleModel(); } },
  footRings: { get: () => app.params.footRings, set: (v) => { app.params.footRings = v; scheduleModel(); } },
  level: { get: () => app.params.level, set: (v) => { app.params.level = v; scheduleModel(); } },
  pressure: { get: () => app.prm.pressure, set: (v) => { app.prm.pressure = v; wake(); } },
  tension: { get: () => app.prm.tension, set: (v) => { app.prm.tension = v; wake(); } },
  relax: { get: () => app.prm.relax, set: (v) => { app.prm.relax = v; wake(); } },
  anchor: { get: () => app.prm.anchor, set: (v) => { app.prm.anchor = v; wake(); } },
  shrink: { get: () => app.params.shrink, set: (v) => { app.params.shrink = v; scheduleModel(200); } },
  armDepth: { get: () => app.prm.armDepth, set: (v) => { app.prm.armDepth = v; wake(); } },
  profile: { get: () => (app.prm.profile ? app.prm.profile : 12), set: (v) => { app.prm.profile = v >= 12 ? 0 : v; wake(); }, show: (v) => (v >= 12 ? 'off (box)' : v <= 2.05 ? 'ellipse' : fmt(v, 1)) },
  steps: { get: () => app.steps, set: (v) => { app.steps = v; } },
  brush: { get: () => app.brushPx, set: (v) => { app.brushPx = v; }, show: (v) => v + ' px' },
};

function syncControls() {
  for (const [id, s] of Object.entries(SLIDERS)) {
    const el = $(id);
    el.value = s.get();
    $(id + '-val').textContent = s.show ? s.show(+el.value) : fmtSlider(+el.value);
  }
  $('jointLoops').checked = app.params.jointLoops;
  $('digits').checked = app.params.digits;
  $('face').checked = app.params.face;
  $('faceRefine').checked = app.params.faceRefine;
  $('constrain').checked = app.prm.constrain;
  $('symmetry').checked = app.prm.symmetry;
  $('faceDetail').checked = app.prm.faceDetail;
  for (const b of $('ringN').querySelectorAll('button')) b.setAttribute('aria-pressed', String(+b.dataset.n === app.params.N));
}
function fmtSlider(v) { return Number.isInteger(v) ? String(v) : v.toFixed(2); }

function bindControls() {
  for (const [id, s] of Object.entries(SLIDERS)) {
    $(id).addEventListener('input', (e) => { const v = +e.target.value; $(id + '-val').textContent = s.show ? s.show(v) : fmtSlider(v); s.set(v); });
  }
  $('jointLoops').onchange = (e) => { app.params.jointLoops = e.target.checked; scheduleModel(); };
  $('digits').onchange = (e) => { app.params.digits = e.target.checked; scheduleModel(); };
  $('face').onchange = (e) => { app.params.face = e.target.checked; scheduleModel(); };
  $('faceRefine').onchange = (e) => { app.params.faceRefine = e.target.checked; scheduleModel(); };
  $('constrain').onchange = (e) => { app.prm.constrain = e.target.checked; wake(); };
  $('symmetry').onchange = (e) => { app.prm.symmetry = e.target.checked; wake(); };
  $('faceDetail').onchange = (e) => { app.prm.faceDetail = e.target.checked; if (app.sim) { if (!e.target.checked) app.sim.stopDetail(); app.sim.setCarried(e.target.checked && app.face ? app.face.inner : null); } wake(); };
  $('ringN').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; app.params.N = +b.dataset.n; syncControls(); scheduleModel(10); };
  $('btn-restart').onclick = () => { rebuildModel(); setRunning(true); };
  $('btn-run').onclick = () => { if (!app.running) goStep('inflate', 'draw'); setRunning(!app.running); };
  $('btn-run2').onclick = () => $('btn-run').click();
  $('btn-refine').onclick = startRefine;
  $('btn-compare').onclick = () => showBefore(!app.comparing);
  document.querySelectorAll('[data-look]').forEach((b) => (b.onclick = () => lookAt(b.dataset.look)));
  // steps
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => goStep(t.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => goStep(b.dataset.goto)));
  // menus close on a click elsewhere or Escape
  document.addEventListener('pointerdown', (e) => { for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const d of document.querySelectorAll('details.menu[open]')) d.open = false; });
  // 2D tools and overlays
  const setTool = (tool) => {
    app.v2.tool = tool;
    for (const b of $('tools2d').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  };
  $('tools2d').onclick = (e) => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); };
  document.querySelectorAll('[data-tool2]').forEach((b) => (b.onclick = () => { setTool(b.dataset.tool2); b.closest('details').open = false; toast(b.dataset.tool2 === 'fill' ? 'Click inside the arm section in the side view' : 'Click a point in the front view, then the same point in the side view'); }));
  document.querySelectorAll('[data-show2d]').forEach((c) => (c.onchange = (e) => { app.v2.show[c.dataset.show2d] = e.target.checked; app.v2.dirty = true; }));
  $('btn-fit2d').onclick = () => app.v2.fit();
  $('pen-color').oninput = (e) => { app.penColor = e.target.value; if (penPathOpts(app.penColor).role === 'feature') setLayer('feature'); setTool('pen'); };
  // layers, front / back, mirror drawing
  const setLayer = (l) => { app.layer = l; for (const b of $('layers2d').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.layer === l)); app.selected = null; renderSelCard(); app.v2.dirty = true; };
  $('layers2d').onclick = (e) => { const b = e.target.closest('button'); if (b) setLayer(b.dataset.layer); };
  const setFace = (m) => { app.faceMode = m; for (const b of $('face2d').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.face === m)); app.selected = null; renderSelCard(); app.v2.dirty = true; };
  $('face2d').onclick = (e) => { const b = e.target.closest('button'); if (b) setFace(b.dataset.face); };
  $('mirror-draw').onchange = (e) => { app.mirrorDraw = e.target.checked; };
  const symm = (sgn) => { const n = symmetrizeFront(app.doc, sgn, newPath); app.selected = null; renderSelCard(); scheduleFull(10); toast(`Front view made symmetric (${n} strokes mirrored)`); };
  $('btn-sym-left').onclick = () => symm(-1);
  $('btn-anat-shade').onclick = () => { refreshAnatomy(false); setShading('anatomy'); };
  // name the region under the pointer when colouring by anatomy
  $('c3d').addEventListener('pointermove', (e) => {
    if (app.shading !== 'anatomy' || !app.anat || e.buttons) return;
    const hit = app.v3.pick(e);
    const A = app.anat;
    $('note3d').textContent = hit && hit.quad >= 0 && hit.quad < A.face.length ? A.regions[A.face[hit.quad]].name : '';
  });
  $('btn-sym-right').onclick = () => symm(1);
  // 3D
  document.querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => app.v3.preset(b.dataset.cam)));
  $('ortho').onchange = (e) => { app.v3.useOrtho = e.target.checked; app.v3.needs = true; };
  $('shading').onclick = (e) => { const b = e.target.closest('button'); if (b) setShading(b.dataset.shade); };
  document.querySelectorAll('[data-show3d]').forEach((c) => (c.onchange = (e) => { app.v3.show[c.dataset.show3d] = e.target.checked; app.v3.applyVisibility(); }));
  // drawing panel
  $('height').onchange = (e) => { app.doc.heightM = Math.max(0.3, +e.target.value || 1.8); fullRebuild(); };
  $('facing').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    app.doc.views.side.facing = b.dataset.facing; app.doc.views.side.manual.facing = true; fullRebuild();
  };
  // stations panel
  $('canon').onchange = (e) => { app.doc.canon = +e.target.value; if (!app.doc.stationsAuto) { app.v2.dirty = true; renderStations(); } else scheduleFull(10); };
  $('btn-fit-st').onclick = () => { app.doc.stations = autoStations(app.doc, app.masks, app.frame); doc_sanitize(); scheduleModel(10); toast('Stations fitted to the drawing'); };
  $('btn-canon-st').onclick = () => { app.doc.stations = canonStations(app.doc.canon); setAuto(false); scheduleModel(10); toast(`Stations set to the ${app.doc.canon}-head canon`); };
  $('st-auto').onchange = (e) => { setAuto(e.target.checked); if (e.target.checked) scheduleFull(10); };
  $('btn-cal-reset').onclick = () => { for (const v of ['front', 'side', 'top']) if (app.doc.views[v]) app.doc.views[v].manual = {}; fullRebuild(); };
  $('btn-clear-section').onclick = () => {
    app.doc.sectionSeed = null; app.doc.sectionOff = true;
    for (const p of app.doc.paths) if (p.role === 'section') p.role = 'line';
    fullRebuild();
  };
  $('pins-on').onchange = (e) => { app.pinsOn = e.target.checked; updatePins(); wake(); };
  // tags panel
  $('btn-newtag').onclick = () => {
    let i = 1; while (app.doc.groups['tag ' + i]) i++;
    const name = 'tag ' + i;
    const hues = ['#d0457a', '#3d8bd9', '#e08a1e', '#6a4fc9', '#2f9e6a'];
    app.doc.groups[name] = defaultGroup(hues[(i - 1) % hues.length]);
    app.paintGroup = name;
    renderTags();
  };
  $('paint-on').onchange = (e) => setPaint(e.target.checked);
  $('paint-erase').onchange = (e) => { app.paintErase = e.target.checked; };
  $('paint-group').onchange = (e) => { app.paintGroup = e.target.value; renderTags(); };
  // files
  $('btn-open').onclick = () => $('file').click();
  $('file').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  $('sel-sample').innerHTML = '<option value="">Reference figures…</option>' + Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  $('sel-sample').onchange = async (e) => { const v = e.target.value; e.target.value = ''; if (v) { setStatus('building figure…'); await loadSample(v); toast(PRESETS[v].label + ' loaded'); } };
  $('btn-save').onclick = async () => {
    try { const r = await saveFile('flateable-figure.svg', new Blob([projectSVG()], { type: 'image/svg+xml' })); if (r === 'saved') toast('Project saved as SVG'); }
    catch (err) { toast('Save failed: ' + (err.message || err.code)); }
  };
  const doExport = async () => {
    if (!app.sim) return;
    const level = +$('exp-level').value;
    const files = [
      { name: 'figure.obj', data: toOBJ(app.sim, level) },
      { name: 'figure-tags.json', data: tagsJSON(app.sim, level, app.tagGroups, app.sim.mesh.loops) },
      ...(app.anat && level === app.sim.mesh.levels.length - 1 ? [{ name: 'figure-anatomy.json', data: JSON.stringify({ level, regions: app.anat.regions.map((r, i) => ({ name: r.name, quads: [...app.anat.face].map((k, f) => (k === i ? f : -1)).filter((f) => f >= 0) })), loops: app.anat.loops, coverage: app.anat.coverage }, null, 1) }] : []),
      { name: 'figure-project.svg', data: projectSVG() },
    ];
    try { const r = await saveFile('flateable-figure.zip', makeZip(files)); if (r === 'saved') toast('Exported OBJ, tags and project'); }
    catch (err) { toast('Export failed: ' + (err.message || err.code)); }
  };
  $('btn-export').onclick = () => { goStep('rig'); $('exp-level').focus(); };
  $('btn-export2').onclick = doExport;
  $('btn-copy-obj').onclick = async () => {
    if (!app.sim) return;
    const txt = toOBJ(app.sim, +$('exp-level').value);
    try { await navigator.clipboard.writeText(txt); toast(`OBJ copied (${Math.round(txt.length / 1024)} KB)`); }
    catch (e) { toast('Clipboard refused the copy'); }
  };
  // drag and drop
  const stage = $('stage2d'), drop = $('drop');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
  stage.addEventListener('dragleave', () => drop.classList.remove('on'));
  stage.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('on'); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
  // keys
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select');
    else if (k === 'p') setTool('pen');
    else if (k === 'e') setTool('erase');
    else if (k === 'l') setTool('landmark');
    else if (k === 'f') setTool('fill');
    else if ((k === 'delete' || k === 'backspace') && app.selected) { e.preventDefault(); app.deletePath(app.selected); }
    else if (k === 'escape') { app.selectPath(null); app.selectedLandmark = null; app.v2.dirty = true; }
  });
}

// ---------------- boot ----------------
async function boot() {
  app.v2 = new View2D($('c2d'), app);
  app.v3 = new View3D($('c3d'), app);
  readCSS();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readCSS);
  new MutationObserver(readCSS).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  bindControls();
  app.rigPanel = initRigPanel(app, { $, toast, applyShading });
  syncControls();
  requestAnimationFrame(loop);
  let saved = null;
  try { saved = localStorage.getItem('ff-project-v4'); } catch (e) { saved = null; }
  if (saved) {
    try {
      const { doc, meta } = loadProjectSVG(saved);
      applyProjectMeta(meta);
      // an older copy of a reference figure: load the current drawing instead
      if (doc.figureKey && PRESETS[doc.figureKey] && (doc.figureVersion || 1) < FIGURE_VERSION) {
        await loadSample(doc.figureKey);
        toast('The reference figure has been redrawn since your last session: loaded the new one');
        return;
      }
      await setDoc(doc);
      toast('Restored your last session');
      return;
    } catch (e) { /* fall through to the sample */ }
  }
  await loadSample('male');
}
boot().catch((e) => { console.error(e); setStatus('Error: ' + e.message); });
