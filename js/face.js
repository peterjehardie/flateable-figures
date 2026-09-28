// Face detail: the drawn face features become 3D targets for a second, slower pass on the head.
//
// Outlines alone can't shape a face: eye sockets, the sides of the nose and the lips sit inside
// every outline. What the drawings do give:
// - the profile's front edge down the centre line (brow, nose, lips, chin): how far each height
//   stands out from the rounded head;
// - features that cross the centre line in the front view (the base of the nose, the mouth):
//   how wide that relief is at their height;
// - features drawn in both views at the same height (brows: a line in each; eyes: a closed shape
//   in each): a curve in space, x and y from the front, depth from the side.
// From these a relief is built over the rounded head (depth added or taken away, per point of the
// face), and the loops round the eyes and the mouth are given the drawn shapes to follow.

export function buildFace(doc, frame, measure, mesh, prm) {
  const H = measure.H, chin = measure.W.chin, hh = H - chin;
  if (!(hh > 0)) return null;
  const smp = measure.samplers;
  const pe = prm.profile || 2.2;
  const head = measure.profileAt('trunk', chin + 0.55 * hh);
  const rx = head[1];

  // the rounded head the balloon settles on: front half of the superellipse at each height
  const baseZ = (x, y) => {
    const pr = measure.profileAt('trunk', y);
    const u = Math.min(0.999, Math.abs((x - pr[0]) / pr[1]));
    return pr[2] + pr[3] * Math.pow(1 - Math.pow(u, pe), 1 / pe);
  };

  // features on the head, in world units
  const inHead = (y) => y > chin - 0.08 * hh && y < H;
  const feats = { front: [], side: [] };
  for (const p of doc.paths) {
    if (p.role !== 'feature' || (p.view !== 'front' && p.view !== 'side') || p.pts.length < 2) continue;
    const pts = p.pts.map(([xd, yd]) => (p.view === 'front' ? frame.fw(xd, yd) : frame.sw(xd, yd)));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [a, b] of pts) { x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); }
    if (!inHead((y0 + y1) / 2)) continue;
    if (p.view === 'front' && Math.max(Math.abs(x0), Math.abs(x1)) > 1.2 * rx) continue;
    feats[p.view].push({ pts, closed: !!p.closed, x0, x1, y0, y1, yc: (y0 + y1) / 2 });
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) / Math.max(1e-6, Math.min(a.y1 - a.y0, b.y1 - b.y0) || 1e-6);
  // the side feature on the face (front half of the head) best matching a front one by height
  const sideMatch = (f, closed) => {
    let best = null, bo = 0.3;
    for (const s of feats.side) {
      if (s.closed !== closed) continue;
      const cz = measure.profileAt('trunk', s.yc)[2];
      if ((s.x0 + s.x1) / 2 < cz) continue; // ears and the back of the head
      const o = overlap(f, s) || (Math.abs(f.yc - s.yc) < 0.03 * hh ? 0.5 : 0);
      if (o > bo) { bo = o; best = s; }
    }
    return best;
  };

  // 1. centre line: how far the profile stands out from the rounded head
  const NY = 160, yA = chin - 0.04 * hh, yB = H;
  const mid = new Float64Array(NY);
  for (let k = 0; k < NY; k++) {
    const y = yA + ((k + 0.5) / NY) * (yB - yA);
    const sp = smp.sideRow(y);
    if (!sp.length) continue;
    const zf = Math.max(...sp.map((s) => s[1]));
    mid[k] = Math.max(0, zf - baseZ(0, y));
  }
  const midAt = (y) => {
    const f = ((y - yA) / (yB - yA)) * NY - 0.5;
    if (f < 0 || f > NY - 1) return 0;
    const i = Math.floor(f), t = f - i;
    return mid[i] * (1 - t) + mid[Math.min(NY - 1, i + 1)] * t;
  };
  // width of that relief: from features crossing the centre line; narrow (a nose bridge) elsewhere
  const hw0 = 0.12 * rx;
  const marks = feats.front.filter((f) => !f.closed && f.x0 < 0.01 * rx && f.x1 > -0.01 * rx && f.y1 - f.y0 < 0.15 * hh)
    .map((f) => ({ y: f.yc, hw: Math.max(hw0, (f.x1 - f.x0) / 2) })).sort((a, b) => a.y - b.y);
  const hwAt = (y) => {
    if (!marks.length) return hw0 * 1.5;
    if (y <= marks[0].y) return marks[0].hw;
    const top = marks[marks.length - 1];
    if (y >= top.y) { const t = Math.min(1, (y - top.y) / (0.2 * hh)); return top.hw + (hw0 - top.hw) * t; }
    for (let i = 1; i < marks.length; i++) if (y <= marks[i].y) {
      const t = (y - marks[i - 1].y) / (marks[i].y - marks[i - 1].y);
      return marks[i - 1].hw + (marks[i].hw - marks[i - 1].hw) * t;
    }
    return hw0;
  };

  // 2. lines drawn in both views (brows): a curve in space; relief = its depth over the head
  const ridges = [];
  for (const f of feats.front) {
    if (f.closed || (f.x0 < 0 && f.x1 > 0)) continue;
    const s = sideMatch(f, false);
    if (!s) continue;
    const fp = f.pts.slice().sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
    const sz = s.pts.map((p) => p[0]).sort((a, b) => b - a);
    const pts = fp.map(([x, y], i) => {
      const z = sz[Math.round((i / Math.max(1, fp.length - 1)) * (sz.length - 1))];
      return [x, y, Math.max(0, z - baseZ(x, y))];
    });
    ridges.push(pts);
  }
  const ridgeSig = 0.045 * hh;

  // 3. closed shapes in both views (eyes): the eye's front from the side, its outline from the front
  const eyes = [];
  for (const f of feats.front) {
    if (!f.closed || (f.x0 < 0 && f.x1 > 0)) continue;
    const s = sideMatch(f, true);
    if (!s) continue;
    const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
    // an eye sits in its socket: its front barely out of the rounded head at its centre
    const ry = (f.y1 - f.y0) / 2;
    eyes.push({ cx, cy, rx: (f.x1 - f.x0) / 2, ry, zFront: Math.min(s.x1, baseZ(cx, cy) + 0.4 * ry), zSide: s.x1, pts: f.pts });
  }

  // relief at a point of the face (metres of depth over the rounded head; negative = sunk in)
  const relief = (x, y) => {
    let r = 0;
    const m = midAt(y);
    if (m > 0) { const q = x / hwAt(y); r = m / (1 + q * q * q * q); }
    for (const pts of ridges) {
      let best = Infinity, rr = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay, ar] = pts[i], [bx, by, br] = pts[i + 1];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        const d2 = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
        if (d2 < best) { best = d2; rr = ar + (br - ar) * t; }
      }
      r = Math.max(r, rr * Math.exp(-best / (ridgeSig * ridgeSig)));
    }
    for (const e of eyes) {
      const q = Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry);
      if (q > 1.9) continue;
      // eyeball: a low dome whose front is the eye's front in the profile; round it, a groove
      // (the lids' edge) that eases back out to the head
      const base = baseZ(x, y);
      const ball = e.zFront - (q < 1 ? (1 - Math.sqrt(1 - q * q)) : 1) * 0.45 * e.ry;
      const w = q < 1 ? 1 : q < 1.9 ? 0.5 + 0.5 * Math.cos(((q - 1) / 0.9) * Math.PI) : 0;
      const zEye = q < 1 ? ball : ball - 0.25 * e.ry * Math.sin(((q - 1) / 0.9) * Math.PI);
      r = r * (1 - w) + (zEye - base) * w;
    }
    return r;
  };

  // vertices worked in this pass: the whole head (the back only smooths), and those of them on the face
  const n = mesh.nV, Q = mesh.quads;
  const onHead = new Uint8Array(n);
  for (let f = 0; f < Q.length / 4; f++) if (mesh.fpart[f] === 4) for (let i = 0; i < 4; i++) onHead[Q[4 * f + i]] = 1;
  const region = [];
  for (let i = 0; i < n; i++) if (onHead[i]) region.push(i);

  // loops that follow drawn shapes: the eyelid loop round the eye outline, the loop outside it
  // on the socket's rim; the lips loop on the mouth line, the loop outside it a little wider
  const loopTargets = [];
  const ellipsePts = (cx, cy, ax, ay) => Array.from({ length: 48 }, (_, i) => [cx + ax * Math.cos((i / 48) * 2 * Math.PI), cy + ay * Math.sin((i / 48) * 2 * Math.PI)]);
  const addLoop = (name, shape, scale) => {
    const lp = (mesh.loops || []).find((l) => l.name === name);
    if (!lp || !shape) return;
    let sx = 0, sy = 0;
    for (const [x, y] of shape) { sx += x; sy += y; }
    const cx = sx / shape.length, cy = sy / shape.length;
    loopTargets.push({ name, verts: Int32Array.from(lp.verts), shape: shape.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]), cx, cy });
  };
  for (const e of eyes) {
    const side = e.cx > 0 ? 'L' : 'R';
    addLoop('eyelid ' + side, e.pts, 1.0);
    addLoop('eye ' + side, e.pts, 1.35);
  }
  const mouth = marks.length ? feats.front.find((f) => !f.closed && f.x0 < 0 && f.x1 > 0 && Math.abs(f.yc - marks[0].y) < 1e-9) : null;
  if (mouth) {
    const hw = (mouth.x1 - mouth.x0) / 2;
    const lips = ellipsePts(0, mouth.yc, hw, 0.32 * hw);
    addLoop('lips', lips, 1.0);
    addLoop('mouth', lips, 1.45);
  }
  // inside the face loop: during the body pass these points are carried along by the loop (their
  // small quads would be overrun by the body's steps); the detail pass then shapes them
  const inner = [];
  const faceLoop = (mesh.loops || []).find((l) => l.name === 'face');
  const seedLoop = (mesh.loops || []).find((l) => l.name === 'lips' || l.name === 'eyelid L');
  if (faceLoop && seedLoop) {
    const nbs = Array.from({ length: n }, () => []);
    for (let f = 0; f < Q.length / 4; f++) for (let i = 0; i < 4; i++) { const u = Q[4 * f + i], w = Q[4 * f + ((i + 1) % 4)]; nbs[u].push(w); nbs[w].push(u); }
    const seen = new Uint8Array(n);
    for (const v of faceLoop.verts) seen[v] = 2;
    const stack = [seedLoop.verts[0]];
    while (stack.length) {
      const v = stack.pop();
      if (seen[v]) continue;
      seen[v] = 1; inner.push(v);
      for (const w of nbs[v]) if (!seen[w]) stack.push(w);
    }
    if (inner.length > n / 4) inner.length = 0; // leaked: the loop isn't closed round the face
  }
  // where a point inside the face loop belongs on the finished face: the cage was built at
  // `shrink` of the drawings' width round the centre line, at the drawings' heights, so undo
  // that scale across and set the depth from the rounded head plus the relief
  const shrink = Math.max(0.05, prm.shrink || 0.5);
  const flat = (v) => {
    const x0 = mesh.pos[3 * v], y = mesh.pos[3 * v + 1];
    const pr = measure.profileAt('trunk', y);
    return [pr[0] + (x0 - pr[0]) / shrink, y];
  };
  // ... and move what lies inside the outer eye and mouth loops onto the drawn eye and mouth:
  // centre to centre, scaled per axis, easing off outside the loop
  const warps = [];
  for (const L of loopTargets) {
    if (!/^(eye [LR]|mouth)$/.test(L.name)) continue;
    const pts = Array.from(L.verts, flat);
    const stat = (arr) => {
      let cx = 0, cy = 0;
      for (const [x, y] of arr) { cx += x; cy += y; }
      cx /= arr.length; cy /= arr.length;
      let sx = 0, sy = 0;
      for (const [x, y] of arr) { sx += (x - cx) ** 2; sy += (y - cy) ** 2; }
      return [cx, cy, Math.sqrt(sx / arr.length) || 1e-6, Math.sqrt(sy / arr.length) || 1e-6];
    };
    warps.push({ m: stat(pts), t: stat(L.shape) });
  }
  const layout = (v) => {
    let [x, y] = flat(v);
    for (const { m, t } of warps) {
      const d = Math.hypot((x - m[0]) / m[2], (y - m[1]) / m[3]) / Math.SQRT2;
      const w = d <= 1 ? 1 : d < 2.2 ? 0.5 + 0.5 * Math.cos(((d - 1) / 1.2) * Math.PI) : 0;
      if (!w) continue;
      const qx = t[0] + (x - m[0]) * (t[2] / m[2]), qy = t[1] + (y - m[1]) * (t[3] / m[3]);
      x += w * (qx - x); y += w * (qy - y);
    }
    return [x, y, baseZ(x, y) + relief(x, y)];
  };
  return { region: Int32Array.from(region), inner: Int32Array.from(inner), layout, relief, baseZ, loopTargets, chin, hh, rx, eyes: eyes.length, eyeList: eyes, ridges: ridges.length, marks: marks.length };
}
