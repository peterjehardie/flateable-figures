// 3D viewport: shaded balloon, quad wireframe, cage edges, station loops,
// the drawings on their planes (front at z = 0, side at x = 0), landmarks and cursor.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';

export class View3D {
  constructor(canvas, app) {
    this.app = app;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.useOrtho = false;
    this.orbit = { target: new THREE.Vector3(0, 0.9, 0), dist: 4.2, theta: 0.55, phi: 1.43 };
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-3, 2, -3);
    this.scene.add(rim);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.drawGroup = new THREE.Group();
    this.scene.add(this.drawGroup);
    this.markGroup = new THREE.Group();
    this.scene.add(this.markGroup);
    // cursor plane
    const cp = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.8), new THREE.MeshBasicMaterial({ color: 0x0f7a86, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    cp.rotation.x = -Math.PI / 2;
    cp.visible = false;
    this.cursorPlane = cp;
    this.scene.add(cp);
    this.grid = new THREE.GridHelper(4, 20, 0x9aa1ab, 0xc9ced6);
    this.scene.add(this.grid);
    this.show = { wire: true, cage: false, loops: true, drawings: false, shading: 'clay' };
    this.raycaster = new THREE.Raycaster();
    this.painting = false;
    this.bindControls();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  setTheme(bg, gridA, gridB) {
    this.renderer.setClearColor(new THREE.Color(bg));
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(4, 20, new THREE.Color(gridA), new THREE.Color(gridB));
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.6;
    this.scene.add(this.grid);
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.aspect = w / h;
    this.needs = true;
  }

  camera() { return this.useOrtho ? this.ortho : this.persp; }

  updateCamera() {
    const o = this.orbit;
    const s = Math.sin(o.phi);
    const pos = new THREE.Vector3(o.target.x + o.dist * s * Math.sin(o.theta), o.target.y + o.dist * Math.cos(o.phi), o.target.z + o.dist * s * Math.cos(o.theta));
    for (const cam of [this.persp, this.ortho]) { cam.position.copy(pos); cam.lookAt(o.target); }
    const hh = o.dist * Math.tan((this.persp.fov * Math.PI) / 360);
    this.ortho.left = -hh * this.aspect; this.ortho.right = hh * this.aspect; this.ortho.top = hh; this.ortho.bottom = -hh;
    this.ortho.updateProjectionMatrix();
  }

  preset(name) {
    const o = this.orbit;
    const H = this.app.frame ? this.app.frame.H : 1.8;
    o.target.set(0, H * 0.5, 0);
    o.dist = H * 2.3;
    if (name === 'front') { o.theta = 0; o.phi = Math.PI / 2; }
    else if (name === 'side') { o.theta = (this.app.doc.views.side.facing === 'right' ? -1 : 1) * Math.PI / 2; o.phi = Math.PI / 2; }
    else if (name === 'back') { o.theta = Math.PI; o.phi = Math.PI / 2; }
    else { o.theta = 0.6; o.phi = 1.35; }
    this.needs = true;
  }

  bindControls() {
    const c = this.canvas;
    let drag = null;
    const pointers = new Map();
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.app.paintMode && e.button === 0 && !e.altKey && pointers.size === 1) {
        this.painting = true;
        this.paintAt(e);
        return;
      }
      drag = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
    });
    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.painting) { this.paintAt(e); return; }
      if (this.app.paintMode) this.hoverBrush(e);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._pinch) this.orbit.dist *= this._pinch / d;
        this._pinch = d;
        this.needs = true;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const o = this.orbit;
      if (drag.button === 2 || drag.button === 1 || drag.shift) {
        const cam = this.camera();
        const k = (o.dist * 1.1) / c.clientHeight;
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
        o.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else {
        o.theta -= dx * 0.008;
        o.phi = Math.min(Math.max(o.phi - dy * 0.008, 0.05), Math.PI - 0.05);
      }
      this.needs = true;
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      this._pinch = null;
      if (this.painting) { this.painting = false; this.app.onPaintEnd(); }
      drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.orbit.dist *= Math.exp(e.deltaY * 0.0012);
      this.orbit.dist = Math.min(Math.max(this.orbit.dist, 0.2), 30);
      this.needs = true;
    }, { passive: false });
  }

  pick(e) {
    if (!this.mesh) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera());
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    return hit ? { point: hit.point, ndc } : null;
  }

  worldRadius(point, px) {
    const cam = this.camera();
    const h = this.canvas.clientHeight;
    if (this.useOrtho) return (px / h) * (this.ortho.top - this.ortho.bottom);
    const d = cam.position.distanceTo(point);
    return (px / h) * 2 * d * Math.tan((this.persp.fov * Math.PI) / 360);
  }

  hoverBrush(e) {
    const hit = this.pick(e);
    if (!this.brush) {
      this.brush = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 }));
      this.scene.add(this.brush);
    }
    this.brush.visible = !!hit;
    if (hit) {
      const r = this.worldRadius(hit.point, this.app.brushPx);
      this.brush.position.copy(hit.point);
      this.brush.scale.setScalar(r);
    }
    this.needs = true;
  }

  paintAt(e) {
    const hit = this.pick(e);
    this.hoverBrush(e);
    if (!hit) return;
    this.app.onPaint([hit.point.x, hit.point.y, hit.point.z], this.worldRadius(hit.point, this.app.brushPx), e.shiftKey || this.app.paintErase);
  }

  hideBrush() { if (this.brush) this.brush.visible = false; this.needs = true; }

  // ---------- content ----------
  setMesh(mesh, P) {
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry && o.geometry.dispose(); }
    const n = mesh.nV;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.8), 3);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setAttribute('color', this.colAttr);
    const Q = mesh.quads;
    const tri = new Uint32Array((Q.length / 4) * 6);
    for (let f = 0, t = 0; f < Q.length; f += 4) { tri[t++] = Q[f]; tri[t++] = Q[f + 1]; tri[t++] = Q[f + 2]; tri[t++] = Q[f]; tri[t++] = Q[f + 2]; tri[t++] = Q[f + 3]; }
    geo.setIndex(new THREE.BufferAttribute(tri, 1));
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.group.add(this.mesh);
    // wireframe of every quad edge
    const seen = new Set(), we = [];
    for (let f = 0; f < Q.length; f += 4) for (let i = 0; i < 4; i++) {
      const a = Q[f + i], b = Q[f + ((i + 1) % 4)];
      const k = a < b ? a * 2097152 + b : b * 2097152 + a;
      if (!seen.has(k)) { seen.add(k); we.push(a, b); }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', this.posAttr);
    wg.setIndex(new THREE.BufferAttribute(new Uint32Array(we), 1));
    this.wire = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x2a3140, transparent: true, opacity: 0.22 }));
    this.group.add(this.wire);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', this.posAttr);
    cg.setIndex(new THREE.BufferAttribute(mesh.cageEdges, 1));
    this.cage = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x1c2230, transparent: true, opacity: 0.85 }));
    this.group.add(this.cage);
    this.setLoops(mesh.loops.filter((l) => l.station), []);
    this.update(P);
    this.applyVisibility();
  }

  setLoops(stationLoops, pulledLoops) {
    if (this.loopsObj) { this.group.remove(this.loopsObj); this.loopsObj.geometry.dispose(); }
    if (!this.posAttr) return;
    const idx = [], col = [];
    const add = (l, c) => { for (let i = 0; i < l.verts.length; i++) idx.push(l.verts[i], l.verts[(i + 1) % l.verts.length]); };
    for (const l of stationLoops) add(l);
    for (const l of pulledLoops) add(l);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.posAttr);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    this.loopsObj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x0f9aa8, depthTest: true }));
    this.loopsObj.renderOrder = 2;
    this.group.add(this.loopsObj);
    this.applyVisibility();
  }

  setAccent(hex) { if (this.loopsObj) this.loopsObj.material.color.set(hex); if (this.cursorPlane) this.cursorPlane.material.color.set(hex); }

  update(P, Nn) {
    if (!this.posAttr) return;
    const a = this.posAttr.array;
    for (let i = 0; i < a.length; i++) a[i] = P[i];
    this.posAttr.needsUpdate = true;
    if (Nn) { const b = this.nrmAttr.array; for (let i = 0; i < b.length; i++) b[i] = Nn[i]; this.nrmAttr.needsUpdate = true; }
    else this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
    this.needs = true;
  }

  setColors(cols) {
    if (!this.colAttr) return;
    this.colAttr.array.set(cols);
    this.colAttr.needsUpdate = true;
    this.needs = true;
  }

  applyVisibility() {
    if (this.wire) this.wire.visible = this.show.wire;
    if (this.cage) this.cage.visible = this.show.cage;
    if (this.loopsObj) this.loopsObj.visible = this.show.loops;
    this.drawGroup.visible = this.show.drawings;
    if (this.skel) this.skel.visible = this.show.skeleton !== false;
    this.needs = true;
  }

  setDrawings(doc, frame) {
    for (const o of [...this.drawGroup.children]) { this.drawGroup.remove(o); o.geometry.dispose(); }
    if (!frame) return;
    const make = (view, color, opacity) => {
      const pts = [];
      for (const p of doc.paths) {
        if (p.view !== view || p.role === 'guide' || p.role === 'note') continue;
        const seg = p.closed ? [...p.pts, p.pts[0]] : p.pts;
        for (let i = 0; i < seg.length - 1; i++) {
          for (const [xd, yd] of [seg[i], seg[i + 1]]) {
            if (view === 'front') { const [x, y] = frame.fw(xd, yd); pts.push(x, y, 0); }
            else if (view === 'side') { const [z, y] = frame.sw(xd, yd); pts.push(0, y, z); }
            else {
              const [x, z] = frame.tw(xd, yd);
              const st = doc.stations;
              const handY = st ? ((st.armpit + st.shoulder) / 2) * frame.H : frame.H * 0.8;
              pts.push(x, st && Math.abs(x) > st.wristX * frame.H * 0.9 ? handY : 0.002, z);
            }
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
      l.renderOrder = 3;
      this.drawGroup.add(l);
    };
    make('front', 0xd9463b, 0.55);
    make('side', 0x2f6fe0, 0.55);
    make('top', 0x2f9e6a, 0.7);
    this.needs = true;
  }

  // skeleton: bones as lines, joints as dots, drawn over the mesh
  setSkeleton(rig, pos) {
    if (!this.skel) {
      this.skel = new THREE.Group();
      this.skel.renderOrder = 5;
      this.scene.add(this.skel);
    }
    for (const o of [...this.skel.children]) { this.skel.remove(o); o.geometry.dispose(); }
    if (!rig || !pos) { this.needs = true; return; }
    const seg = [], pts = [];
    rig.joints.forEach((j, i) => {
      pts.push(...pos[i]);
      if (j.parent >= 0) seg.push(...pos[j.parent], ...pos[i]);
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: this.skelColor || 0xe0a100, depthTest: false, transparent: true, opacity: 0.95 }));
    lines.renderOrder = 5;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const dots = new THREE.Points(pg, new THREE.PointsMaterial({ color: this.skelColor || 0xe0a100, size: 6, sizeAttenuation: false, depthTest: false }));
    dots.renderOrder = 6;
    this.skel.add(lines, dots);
    this.skel.visible = this.show.skeleton !== false;
    this.needs = true;
  }

  setLandmarks(list) {
    for (const o of [...this.markGroup.children]) { this.markGroup.remove(o); o.geometry.dispose(); }
    for (const p of list) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0xe0a100, depthTest: false }));
      m.position.set(p[0], p[1], p[2]);
      m.renderOrder = 4;
      this.markGroup.add(m);
    }
    this.needs = true;
  }

  setCursor(y) {
    this.cursorPlane.visible = y != null;
    if (y != null) this.cursorPlane.position.set(0, y, 0);
    this.needs = true;
  }

  render() {
    if (!this.needs) return;
    this.needs = false;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera());
  }
}
