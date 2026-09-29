// 2D workspace: both drawings on one sheet, with the hull fill, silhouette check,
// proportion guides, station lines (shared by both views), the cage's loops projected
// back onto the drawings, landmarks, and a cursor that links the two views.

import { HEIGHT_STATIONS, ARM_STATIONS, STATION_LABEL } from './stations.js';
import { distToPolyline, simplify, bboxOf, parseColor, colorClass, colorName } from './util.js';
import { newPath, isNearlyClosed, viewAtPoint } from './doc.js';
import { PARTS } from './cage.js';

const HIT = 7;

export class View2D {
  constructor(canvas, app) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { s: 1, ox: 0, oy: 0 };
    this.tool = 'select';
    this.show = { hull: true, fit: true, stations: true, heads: false, parts: false, mesh: false, bg: true, features: true };
    this.hover = null;
    this.drag = null;
    this.cursor = null;
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const el = this.canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = el.clientWidth; this.h = el.clientHeight;
    this.canvas.width = Math.max(1, this.w * dpr); this.canvas.height = Math.max(1, this.h * dpr);
    if (!this._fitted && this.w > 0) { this.fit(); this._fitted = true; }
    this.dirty = true;
  }

  fit() {
    const b = this.app.doc.bounds;
    const pad = 28;
    const s = Math.min((this.w - 2 * pad) / (b.x1 - b.x0 || 1), (this.h - 2 * pad) / (b.y1 - b.y0 || 1));
    this.view.s = s > 0 ? s : 1;
    this.view.ox = (b.x0 + b.x1) / 2 - this.w / 2 / this.view.s;
    this.view.oy = (b.y0 + b.y1) / 2 - this.h / 2 / this.view.s;
    this.dirty = true;
  }

  toScreen(x, y) { return [(x - this.view.ox) * this.view.s, (y - this.view.oy) * this.view.s]; }
  toDoc(sx, sy) { return [sx / this.view.s + this.view.ox, sy / this.view.s + this.view.oy]; }
  evDoc(e) { const r = this.canvas.getBoundingClientRect(); return this.unmirror(...this.toDoc(e.clientX - r.left, e.clientY - r.top)); }
  // Back view: the front panel is shown as seen from behind (mirrored about the front centre line).
  // Points are stored as in the front view, so the outline is shared.
  isBack() { return !!this.app.backView; }
  unmirror(x, y) {
    if (!this.isBack() || viewAtPoint(this.app.doc, x, y) !== 'front') return [x, y];
    return [2 * this.app.doc.views.front.axis - x, y];
  }
  mirrorCtx(ctx) { const ax = this.app.doc.views.front.axis; ctx.translate(2 * ax, 0); ctx.scale(-1, 1); }
  // which layer a stroke belongs to, and whether it can be picked right now
  static layerOf(p) { return p.role === 'feature' ? 'feature' : p.role === 'line' || p.role === 'section' ? 'line' : 'note'; }
  onFace(p) { return !(p.view === 'front' && p.role === 'feature') || (p.side === 'far') === this.isBack(); }
  pickable(p) { return View2D.layerOf(p) === (this.app.layer || 'line') && this.onFace(p) && !(p.role === 'axis' || p.role === 'guide'); }
  viewAt(x, y) { return viewAtPoint(this.app.doc, x, y); }

  // ---------- hit testing on draggable guides ----------
  handles() {
    const app = this.app, doc = app.doc, fr = app.frame;
    if (!fr) return [];
    const b = doc.bounds, sx = doc.splitX;
    const out = [];
    const range = { front: [b.x0 - 30, sx], side: [sx, b.x1 + 30] };
    for (const view of ['front', 'side']) {
      const v = doc.views[view];
      out.push({ kind: 'cal', view, key: 'top', y: v.top, x0: range[view][0], x1: range[view][1] });
      out.push({ kind: 'cal', view, key: 'floor', y: v.floor, x0: range[view][0], x1: range[view][1] });
      out.push({ kind: 'axis', view, x: v.axis, y0: v.top, y1: v.floor });
      if (this.show.stations && doc.stations) {
        for (const k of HEIGHT_STATIONS) out.push({ kind: 'st', view, key: k, y: fr.yDoc(view, doc.stations[k]), x0: range[view][0], x1: range[view][1] });
      }
    }
    if (this.show.stations && doc.stations) {
      const ya = fr.yDoc('front', doc.stations.armpit), ys = fr.yDoc('front', doc.stations.shoulder);
      const pad = (ya - ys) * 0.6;
      for (const k of ARM_STATIONS) for (const sign of [1, -1]) {
        const [x] = fr.fd(sign * doc.stations[k] * fr.H, 0);
        out.push({ kind: 'arm', key: k, sign, x, y0: ys - pad, y1: ya + pad });
      }
    }
    out.push({ kind: 'split', x: sx, y0: b.y0, y1: b.y1 });
    if (doc.splitY != null) {
      out.push({ kind: 'splitY', y: doc.splitY, x0: b.x0 - 30, x1: sx });
      const tv = doc.views.top;
      if (tv) out.push({ kind: 'topz', y: tv.axisZ, x0: b.x0 - 30, x1: sx });
    }
    return out;
  }

  hitHandle(x, y) {
    const tol = HIT / this.view.s;
    let best = null, bd = tol;
    for (const h of this.handles()) {
      let d = Infinity;
      if (h.y !== undefined && h.x0 !== undefined) { if (x >= h.x0 && x <= h.x1) d = Math.abs(y - h.y); }
      else if (h.x !== undefined) { if (y >= h.y0 - tol && y <= h.y1 + tol) d = Math.abs(x - h.x); }
      if (h.kind === 'split') d += tol * 0.5; // lowest priority
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  hitPath(x, y) {
    const tol = HIT / this.view.s;
    let best = null, bd = tol;
    for (const p of this.app.doc.paths) {
      if (!this.pickable(p)) continue;
      const bb = bboxOf(p.pts);
      if (x < bb.x0 - tol || x > bb.x1 + tol || y < bb.y0 - tol || y > bb.y1 + tol) continue;
      const d = distToPolyline(x, y, p.pts, p.closed);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  hitLandmark(x, y) {
    const tol = (HIT + 3) / this.view.s;
    for (const l of this.app.doc.landmarks) for (const k of ['front', 'side']) {
      if (l[k] && Math.hypot(l[k][0] - x, l[k][1] - y) < tol) return { l, k };
    }
    return null;
  }

  // ---------- events ----------
  bindEvents() {
    const c = this.canvas;
    const pointers = new Map();
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const [dx, dy] = this.toDoc(mx, my);
      const k = Math.exp(-e.deltaY * 0.0015);
      this.view.s *= k;
      this.view.ox = dx - mx / this.view.s;
      this.view.oy = dy - my / this.view.s;
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { this.drag = { kind: 'pinch', d: this.pinchDist(pointers) }; return; }
      const [x, y] = this.evDoc(e);
      if (e.button === 1 || e.button === 2 || this.spaceDown) { this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.ox, oy: this.view.oy }; return; }
      if (this.tool === 'pen') { this.drag = { kind: 'pen', pts: [[x, y]] }; return; }
      if (this.tool === 'erase') { const p = this.hitPath(x, y); if (p) this.app.deletePath(p); return; }
      if (this.tool === 'fill') { this.app.fillAt(this.viewAt(x, y), [x, y]); return; }
      if (this.tool === 'landmark') {
        const hl = this.hitLandmark(x, y);
        if (hl) { this.drag = { kind: 'lm', ...hl }; this.app.selectLandmark(hl.l); return; }
        this.app.placeLandmark(this.viewAt(x, y), [x, y]);
        return;
      }
      // select tool
      const hl = this.hitLandmark(x, y);
      if (hl) { this.drag = { kind: 'lm', ...hl }; this.app.selectLandmark(hl.l); return; }
      const h = this.hitHandle(x, y);
      if (h) { this.drag = { kind: 'handle', h }; return; }
      const p = this.hitPath(x, y);
      this.app.selectPath(p);
      if (!p) this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.ox, oy: this.view.oy };
    });
    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [x, y] = this.evDoc(e);
      this.cursor = { x, y, view: this.viewAt(x, y) };
      this.app.onCursor(this.cursor);
      const d = this.drag;
      if (d && d.kind === 'pinch' && pointers.size === 2) {
        const nd = this.pinchDist(pointers);
        const r = c.getBoundingClientRect();
        const [a, b] = [...pointers.values()];
        const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        const [dx, dy] = this.toDoc(mx, my);
        this.view.s *= nd / d.d;
        d.d = nd;
        this.view.ox = dx - mx / this.view.s; this.view.oy = dy - my / this.view.s;
      } else if (d && d.kind === 'pan') {
        this.view.ox = d.ox - (e.clientX - d.sx) / this.view.s;
        this.view.oy = d.oy - (e.clientY - d.sy) / this.view.s;
      } else if (d && d.kind === 'pen') {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) > 1.5 / this.view.s) d.pts.push([x, y]);
      } else if (d && d.kind === 'handle') {
        this.app.dragHandle(d.h, x, y);
      } else if (d && d.kind === 'lm') {
        d.l[d.k] = [x, y];
        this.app.landmarksChanged();
      } else {
        const h = this.tool === 'select' ? this.hitHandle(x, y) : null;
        this.hover = h || (this.tool !== 'pen' ? this.hitPath(x, y) : null);
        c.style.cursor = this.tool === 'pen' || this.tool === 'fill' ? 'crosshair' : h ? (h.x !== undefined && h.y === undefined ? 'ew-resize' : 'ns-resize') : this.hover ? 'pointer' : this.tool === 'landmark' ? 'copy' : 'default';
      }
      this.dirty = true;
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      const d = this.drag;
      this.drag = null;
      if (d && d.kind === 'pen' && d.pts.length > 1) {
        const pts = simplify(d.pts, 0.6 / this.view.s);
        const closed = isNearlyClosed(pts);
        this.app.addPath(pts, closed);
      }
      if (d && d.kind === 'handle') this.app.dragHandleEnd(d.h);
      if (d && d.kind === 'lm') this.app.landmarksChanged(true);
      this.dirty = true;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.cursor = null; this.app.onCursor(null); this.dirty = true; });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
  }

  pinchDist(pointers) { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; }

  // ---------- drawing ----------
  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const { ctx, app } = this;
    const doc = app.doc, fr = app.frame;
    const css = app.css;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = css.paper;
    ctx.fillRect(0, 0, this.w, this.h);
    const s = this.view.s;
    ctx.save();
    ctx.translate(-this.view.ox * s, -this.view.oy * s);
    ctx.scale(s, s);
    const px = 1 / s;
    // background image
    if (this.show.bg && doc.bg && app.bgImage) {
      ctx.globalAlpha = 0.28;
      ctx.drawImage(app.bgImage, doc.bg.x, doc.bg.y, doc.bg.w, doc.bg.h);
      ctx.globalAlpha = 1;
    }
    // hull fill and silhouette check
    for (const view of ['front', 'side', 'top']) {
      const m = app.masks && app.masks[view];
      if (!m) continue;
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      if (view === 'front' && this.isBack()) this.mirrorCtx(ctx);
      if (this.show.hull && app.maskImgs && app.maskImgs[view]) ctx.drawImage(app.maskImgs[view], m.x0, m.y0, m.W * m.cell, m.H * m.cell);
      if (this.show.fit && app.fit && app.fit[view] && app.sim && app.sim.iter > 0 && !(view === 'front' && this.isBack())) ctx.drawImage(app.fit[view].canvas, m.x0, m.y0, m.W * m.cell, m.H * m.cell);
      ctx.restore();
      ctx.imageSmoothingEnabled = true;
    }
    if (app.masks && app.masks.section && app.maskImgs.section) {
      const m = app.masks.section;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(app.maskImgs.section, m.x0, m.y0, m.W * m.cell, m.H * m.cell);
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = css.accent;
      ctx.font = `${10.5 * px}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.fillText('arm section', m.cx + m.hw + 4 * px, m.cy + 3 * px);
    }
    // head-unit guide
    if (fr && this.show.heads) this.drawHeads(ctx, px);
    // projected mesh loops / part boxes
    if (fr && app.sim && this.show.mesh) this.drawMeshProjection(ctx, px);
    if (fr && app.sim && this.show.parts) this.drawPartBoxes(ctx, px);
    // paths
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const back = this.isBack();
    for (const p of doc.paths) {
      if (p.role === 'feature' && this.show.features === false) continue;
      const sel = p === app.selected, hov = p === this.hover;
      const mir = back && p.view === 'front';
      if (mir) { ctx.save(); this.mirrorCtx(ctx); }
      ctx.beginPath();
      p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (p.closed) ctx.closePath();
      let w = 1.6, col = p.color, dash = null, alpha = 1;
      if (p.role === 'line') col = css.ink;
      if (p.role === 'guide') { col = css.muted; dash = [6, 4]; w = 1; alpha = 0.7; }
      if (p.role === 'note') { col = css.muted; w = 1; alpha = 0.55; }
      if (p.role === 'axis') { dash = [2, 3]; }
      if (p.role === 'section') { col = css.accent; w = 2.2; }
      if (p.role === 'feature' && doc.groups[p.group] && !doc.groups[p.group].visible) alpha = 0.25;
      // other layers dimmed; features of the other face (front or back) barely there
      if (View2D.layerOf(p) !== (app.layer || 'line') && p.role !== 'guide' && p.role !== 'axis') alpha *= 0.4;
      if (!this.onFace(p)) alpha *= 0.3;
      if (sel || hov) {
        ctx.save(); ctx.strokeStyle = css.select; ctx.globalAlpha = sel ? 0.45 : 0.25; ctx.lineWidth = (w + 6) * px; ctx.stroke(); ctx.restore();
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = w * px;
      ctx.setLineDash(dash ? dash.map((v) => v * px) : []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (mir) ctx.restore();
    }
    // pen preview (stored as in the front view, so mirrored back for display)
    if (this.drag && this.drag.kind === 'pen') {
      const d0 = this.drag.pts[0];
      const mir = back && viewAtPoint(doc, d0[0], d0[1]) === 'front';
      if (mir) { ctx.save(); this.mirrorCtx(ctx); }
      ctx.beginPath();
      this.drag.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = app.penColor; ctx.lineWidth = 1.8 * px; ctx.stroke();
      if (mir) ctx.restore();
    }
    if (back && app.frame) {
      ctx.fillStyle = css.accent;
      ctx.font = `600 ${12 * px}px "IBM Plex Mono", ui-monospace, monospace`;
      const ax = doc.views.front.axis, top = doc.views.front.top;
      ctx.textAlign = 'center';
      ctx.fillText('BACK · seen from behind', ax, top - 14 * px);
      ctx.textAlign = 'left';
    }
    if (fr) this.drawGuides(ctx, px);
    this.drawLandmarks(ctx, px);
    // cursor link
    if (fr && this.cursor) {
      const t = fr.tFromDoc(this.cursor.view, this.cursor.y);
      ctx.strokeStyle = css.accent; ctx.globalAlpha = 0.7; ctx.lineWidth = 1 * px; ctx.setLineDash([3 * px, 3 * px]);
      const b = doc.bounds;
      for (const view of ['front', 'side']) {
        const y = fr.yDoc(view, t);
        const [x0, x1] = view === 'front' ? [b.x0 - 20, doc.splitX] : [doc.splitX, b.x1 + 20];
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawHeads(ctx, px) {
    const { app } = this, doc = app.doc, fr = app.frame, css = app.css;
    const n = doc.canon;
    const b = doc.bounds;
    ctx.font = `${10 * px}px "IBM Plex Mono", ui-monospace, monospace`;
    for (const view of ['front', 'side']) {
      const [x0, x1] = view === 'front' ? [b.x0 - 24, doc.splitX - 10] : [doc.splitX + 10, b.x1 + 24];
      for (let k = 0; k <= Math.ceil(n); k++) {
        const t = 1 - k / n;
        if (t < -0.001) break;
        const y = fr.yDoc(view, t);
        ctx.strokeStyle = css.muted; ctx.globalAlpha = 0.3; ctx.lineWidth = px;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.globalAlpha = 0.7; ctx.fillStyle = css.muted;
        if (view === 'front' && k < n) ctx.fillText(`${k + 1}`, x0 + 2 * px, fr.yDoc(view, 1 - (k + 0.5) / n) + 3 * px);
      }
      // shoulder and hip width guides (2 and 1.5 heads), front only
      if (view === 'front') {
        const hu = fr.H / n;
        const ys = fr.yDoc('front', doc.stations.shoulder), yh = fr.yDoc('front', doc.stations.hip);
        ctx.strokeStyle = css.muted; ctx.globalAlpha = 0.5; ctx.setLineDash([3 * px, 3 * px]);
        for (const [w, y] of [[hu * 2, ys], [hu * 1.5, yh]]) {
          const [xa] = fr.fd(-w / 2, 0), [xb] = fr.fd(w / 2, 0);
          ctx.beginPath(); ctx.moveTo(xa, y - 14 * px); ctx.lineTo(xa, y + 14 * px); ctx.moveTo(xb, y - 14 * px); ctx.lineTo(xb, y + 14 * px); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }
  }

  drawGuides(ctx, px) {
    const { app } = this, css = app.css;
    const hov = this.hover && this.hover.kind ? this.hover : null;
    ctx.font = `${10.5 * px}px "IBM Plex Mono", ui-monospace, monospace`;
    for (const h of this.handles()) {
      const active = hov && hov.kind === h.kind && hov.key === h.key && hov.view === h.view && hov.sign === h.sign;
      ctx.lineWidth = (active ? 2 : 1) * px;
      if (h.kind === 'split') {
        ctx.strokeStyle = css.muted; ctx.globalAlpha = 0.35; ctx.setLineDash([2 * px, 6 * px]);
        ctx.beginPath(); ctx.moveTo(h.x, h.y0); ctx.lineTo(h.x, h.y1); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        continue;
      }
      if (h.kind === 'splitY') {
        ctx.strokeStyle = css.muted; ctx.globalAlpha = 0.35; ctx.setLineDash([2 * px, 6 * px]);
        ctx.beginPath(); ctx.moveTo(h.x0, h.y); ctx.lineTo(h.x1, h.y); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 0.7; ctx.fillStyle = css.muted;
        ctx.fillText('top view (hands and feet, seen from above) ↓', h.x0 + 2 * px, h.y + 13 * px);
        ctx.globalAlpha = 1;
        continue;
      }
      if (h.kind === 'topz') {
        ctx.strokeStyle = css.ink; ctx.globalAlpha = 0.45; ctx.setLineDash([8 * px, 4 * px, 2 * px, 4 * px]);
        ctx.beginPath(); ctx.moveTo(h.x0, h.y); ctx.lineTo(h.x1, h.y); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = css.ink;
        ctx.fillText('depth 0 · front is down the page', h.x0 + 2 * px, h.y - 3 * px);
        ctx.globalAlpha = 1;
        continue;
      }
      if (h.kind === 'axis') {
        ctx.strokeStyle = css.ink; ctx.globalAlpha = 0.45; ctx.setLineDash([8 * px, 4 * px, 2 * px, 4 * px]);
        ctx.beginPath(); ctx.moveTo(h.x, h.y0); ctx.lineTo(h.x, h.y1); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        continue;
      }
      if (h.kind === 'arm') {
        ctx.strokeStyle = css.accent; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(h.x, h.y0); ctx.lineTo(h.x, h.y1); ctx.stroke();
        if (h.sign > 0) {
          const i = ARM_STATIONS.indexOf(h.key);
          ctx.fillStyle = css.accent;
          ctx.fillText(STATION_LABEL[h.key].toLowerCase(), h.x + 3 * px, (i % 2 ? h.y1 + 12 * px : h.y0 - 4 * px));
        }
        ctx.globalAlpha = 1;
        continue;
      }
      const isCal = h.kind === 'cal';
      ctx.strokeStyle = isCal ? css.ink : css.accent;
      ctx.globalAlpha = isCal ? 0.6 : 0.75;
      ctx.setLineDash(isCal ? [10 * px, 4 * px] : []);
      ctx.beginPath(); ctx.moveTo(h.x0, h.y); ctx.lineTo(h.x1, h.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isCal ? css.ink : css.accent;
      const label = isCal ? (h.key === 'top' ? 'top of head' : 'floor') : STATION_LABEL[h.key].toLowerCase();
      if (h.view === 'front') ctx.fillText(label, h.x0 + 2 * px, h.y - 3 * px);
      else { const w = ctx.measureText(label).width; ctx.fillText(label, h.x1 - w - 2 * px, h.y - 3 * px); }
      ctx.globalAlpha = 1;
    }
  }

  drawMeshProjection(ctx, px) {
    const { app } = this, fr = app.frame, sim = app.sim, css = app.css;
    const P = sim.P;
    const E = sim.mesh.cageEdges;
    ctx.lineWidth = 0.9 * px;
    if (app.masks && app.masks.top) {
      ctx.strokeStyle = css.meshLine; ctx.globalAlpha = 0.55;
      ctx.beginPath();
      for (let i = 0; i < E.length; i += 2) {
        const a = E[i], b = E[i + 1];
        if (!sim.ext[a] || !sim.ext[b] || sim.N[3 * a + 1] < -0.05) continue;
        const [xa, ya] = fr.td(P[3 * a], P[3 * a + 2]), [xb, yb] = fr.td(P[3 * b], P[3 * b + 2]);
        ctx.moveTo(xa, ya); ctx.lineTo(xb, yb);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const view of ['front', 'side']) {
      const mir = view === 'front' && this.isBack(), fs = mir ? -1 : 1;
      if (mir) { ctx.save(); this.mirrorCtx(ctx); }
      ctx.strokeStyle = css.meshLine;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      for (let i = 0; i < E.length; i += 2) {
        const a = E[i], b = E[i + 1];
        // front view shows the near (front-facing) half only, side view the near side
        const na = view === 'front' ? fs * sim.N[3 * a + 2] : sim.N[3 * a] * fr.S.dir;
        if (na < -0.05) continue;
        const [xa, ya] = view === 'front' ? fr.fd(P[3 * a], P[3 * a + 1]) : fr.sd(P[3 * a + 2], P[3 * a + 1]);
        const [xb, yb] = view === 'front' ? fr.fd(P[3 * b], P[3 * b + 1]) : fr.sd(P[3 * b + 2], P[3 * b + 1]);
        ctx.moveTo(xa, ya); ctx.lineTo(xb, yb);
      }
      ctx.stroke();
      // station loops in accent
      ctx.strokeStyle = css.accent; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.4 * px;
      ctx.beginPath();
      for (const l of [...sim.mesh.loops.filter((q) => q.station), ...(app.pulledLoops || [])]) {
        const v = l.verts;
        for (let i = 0; i < v.length; i++) {
          const a = v[i], b = v[(i + 1) % v.length];
          const na = view === 'front' ? fs * sim.N[3 * a + 2] : sim.N[3 * a] * fr.S.dir;
          if (na < -0.05) continue;
          const [xa, ya] = view === 'front' ? fr.fd(P[3 * a], P[3 * a + 1]) : fr.sd(P[3 * a + 2], P[3 * a + 1]);
          const [xb, yb] = view === 'front' ? fr.fd(P[3 * b], P[3 * b + 1]) : fr.sd(P[3 * b + 2], P[3 * b + 1]);
          ctx.moveTo(xa, ya); ctx.lineTo(xb, yb);
        }
      }
      ctx.stroke();
      ctx.lineWidth = 0.9 * px;
      if (mir) ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawPartBoxes(ctx, px) {
    const { app } = this, fr = app.frame, sim = app.sim;
    const Q = sim.mesh.quads, P = sim.P;
    for (const view of ['front', 'side']) {
      const boxes = new Map();
      for (let f = 0; f < Q.length / 4; f++) {
        const part = sim.mesh.fpart[f];
        if (view === 'side' && (PARTS[part].name.endsWith(' R'))) continue;
        let b = boxes.get(part);
        if (!b) { b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; boxes.set(part, b); }
        for (let i = 0; i < 4; i++) {
          const v = Q[4 * f + i];
          const [x, y] = view === 'front' ? fr.fd(P[3 * v], P[3 * v + 1]) : fr.sd(P[3 * v + 2], P[3 * v + 1]);
          if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
        }
      }
      ctx.lineWidth = 2 * px;
      for (const [part, b] of boxes) {
        ctx.strokeStyle = PARTS[part].color;
        ctx.globalAlpha = 0.85;
        roundRect(ctx, b.x0 - 3 * px, b.y0 - 3 * px, b.x1 - b.x0 + 6 * px, b.y1 - b.y0 + 6 * px, 6 * px);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  drawLandmarks(ctx, px) {
    const { app } = this, css = app.css, fr = app.frame;
    ctx.font = `${10.5 * px}px "IBM Plex Mono", ui-monospace, monospace`;
    for (const l of app.doc.landmarks) {
      const sel = l === app.selectedLandmark;
      if (l.front && l.side) {
        ctx.strokeStyle = css.mark; ctx.globalAlpha = 0.5; ctx.setLineDash([2 * px, 4 * px]); ctx.lineWidth = px;
        ctx.beginPath(); ctx.moveTo(...l.front); ctx.lineTo(...l.side); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      for (const k of ['front', 'side']) {
        const p = l[k];
        if (!p) continue;
        const r = (sel ? 6 : 4.5) * px;
        ctx.strokeStyle = css.mark; ctx.lineWidth = (sel ? 2.2 : 1.6) * px;
        ctx.beginPath(); ctx.moveTo(p[0] - r, p[1]); ctx.lineTo(p[0] + r, p[1]); ctx.moveTo(p[0], p[1] - r); ctx.lineTo(p[0], p[1] + r); ctx.stroke();
        ctx.beginPath(); ctx.arc(p[0], p[1], r * 0.8, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = css.mark;
        ctx.fillText(l.name, p[0] + r + 2 * px, p[1] - r);
      }
      if (fr && l.front && !l.side) {
        // show where it must land in the side view
        const t = fr.tFromDoc('front', l.front[1]);
        const y = fr.yDoc('side', t);
        const b = app.doc.bounds;
        ctx.strokeStyle = css.mark; ctx.globalAlpha = 0.45; ctx.setLineDash([5 * px, 4 * px]); ctx.lineWidth = px;
        ctx.beginPath(); ctx.moveTo(app.doc.splitX, y); ctx.lineTo(b.x1 + 20, y); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }

export function penPathOpts(color) {
  const cls = colorClass(parseColor(color));
  return cls === 'color' ? { role: 'feature', group: colorName(parseColor(color)) } : { role: 'line' };
}
