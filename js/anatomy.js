// Anatomy on the mesh: every quad gets the body region it represents, every edge loop the
// anatomical line it follows, and a coverage report says which of the loops a deforming
// character needs are there, partly there, or missing, and how dense each region is. The labels
// are worked out from where things are (body part, height against the stations, which way the
// surface faces round its own axis, and the face and digit loops), so they follow any cage.

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];

// ---------------- helpers ----------------
function neighbours(n, Q) {
  const nb = Array.from({ length: n }, () => []);
  for (let f = 0; f < Q.length / 4; f++) for (let i = 0; i < 4; i++) { const a = Q[4 * f + i], b = Q[4 * f + ((i + 1) % 4)]; nb[a].push(b); nb[b].push(a); }
  return nb;
}
// the vertices on the smaller side of a closed loop (its inside)
function insideOf(loop, nb, n) {
  const seen = new Uint8Array(n);
  for (const v of loop) seen[v] = 2;
  let best = null;
  for (const v0 of loop) for (const s0 of nb[v0]) {
    if (seen[s0]) continue;
    const got = [], st = [s0];
    while (st.length) { const v = st.pop(); if (seen[v]) continue; seen[v] = 1; got.push(v); for (const w of nb[v]) if (!seen[w]) st.push(w); }
    if (!best || got.length < best.length) best = got;
  }
  const set = new Set(best || []);
  for (const v of loop) set.add(v);
  return set;
}

// ---------------- faces ----------------
export function tagAnatomy(model, sim) {
  const mesh = sim.mesh, Q = mesh.quads, P = sim.P, n = sim.n, nF = Q.length / 4;
  const M = model.measure, W = M.W, H = M.H, hh = H - W.chin;
  const loops = mesh.loops || [];
  const nb = neighbours(n, Q);
  const byName = (nm) => loops.find((l) => l.name === nm);
  // regions enclosed by loops: innermost wins
  const vRegion = new Array(n).fill(null);
  const mark = (loopName, label) => { const l = byName(loopName); if (!l) return; for (const v of insideOf(l.verts, nb, n)) vRegion[v] = label; };
  mark('face', 'face');
  for (const S of ['L', 'R']) { mark(`eye ${S}`, `eyelid ${S}`); mark(`eyelid ${S}`, `eye ${S}`); }
  mark('mouth', 'lips'); mark('lips', 'mouth');
  // digits: everything beyond each digit's first loop
  const digitGroups = new Map();
  for (const l of loops) {
    const m = /^(thumb|index|middle|ring|little) (\d+) ([LR])$/.exec(l.name) || /^toe (\d)\.(\d+) ([LR])$/.exec(l.name);
    if (!m) continue;
    const key = l.name.startsWith('toe') ? `toe ${m[1]} ${m[3]}` : `${m[1]} ${m[3]}`;
    const k = l.name.startsWith('toe') ? +m[2] : +m[2];
    const g = digitGroups.get(key);
    if (!g || k < g.k) digitGroups.set(key, { k, verts: l.verts });
  }
  for (const [key, g] of digitGroups) for (const v of insideOf(g.verts, nb, n)) vRegion[v] = key.startsWith('toe') ? `toes ${key.slice(-1)}` : key;

  const labels = new Array(nF);
  for (let f = 0; f < nF; f++) {
    let x = 0, y = 0, z = 0;
    const vs = [Q[4 * f], Q[4 * f + 1], Q[4 * f + 2], Q[4 * f + 3]];
    for (const v of vs) { x += P[3 * v]; y += P[3 * v + 1]; z += P[3 * v + 2]; }
    x /= 4; y /= 4; z /= 4;
    const part = mesh.fpart[f];
    const S = x >= 0 ? 'L' : 'R', s = x >= 0 ? 1 : -1;
    // loop-enclosed regions first (every corner inside)
    const r0 = vRegion[vs[0]];
    if (r0 && vs.every((v) => vRegion[v] === r0) && r0 !== 'face') { labels[f] = r0; continue; }
    const inFace = vs.every((v) => vRegion[v]);
    labels[f] = classify(part, x, y, z, S, s, inFace);
  }

  function classify(part, x, y, z, S, s, inFace) {
    if (part <= 4) {
      const pr = M.profileAt('trunk', y);
      const th = (Math.atan2((x - pr[0]) / pr[1], (z - pr[2]) / pr[3]) * 180) / Math.PI, a = Math.abs(th);
      const front = a < 40, back = a > 125;
      const ux = Math.abs(x - pr[0]) / pr[1];
      if (part === 4) {
        const t = (y - W.chin) / hh;
        if (inFace) {
          if (t > 0.62) return 'forehead';
          if (t > 0.5) return 'brow';
          if (ux < 0.2 && t > 0.24) return 'nose';
          if (t < 0.18) return 'chin';
          return `cheek ${S}`;
        }
        if (t > 0.85) return 'crown';
        if (front) return t < 0.3 ? 'chin' : 'forehead';
        if (back) return t < 0.3 ? 'nape' : 'back of head';
        if (t > 0.3 && t < 0.62) return `ear ${S}`;
        return t <= 0.3 ? `jaw ${S}` : `temple ${S}`;
      }
      if (part === 3) return front ? 'throat' : back ? 'nape' : `neck side ${S}`;
      // the torso by height against the stations, not by mesh part
      const chestLow = W.armpit - 0.05 * H, backLow = W.armpit - 0.09 * H;
      if (y > W.shoulder - 0.025 * H) return front ? (ux < 0.12 ? 'sternum' : `clavicle ${S}`) : back ? 'trapezius' : `shoulder top ${S}`;
      if (front && y > chestLow) return ux < 0.12 ? 'sternum' : `pectoral ${S}`;
      if (back && y > backLow) return `scapula ${S}`;
      if (!front && !back && y > W.armpit - 0.03 * H) return `armpit ${S}`;
      if (y > W.waist) return front ? 'upper abdomen' : back ? `mid back ${S}` : `ribs ${S}`;
      if (y > W.hip) return front ? (ux < 0.5 ? 'abdomen' : `oblique ${S}`) : back ? 'lower back' : `oblique ${S}`;
      return front ? (y < W.crotch + 0.05 * H ? 'groin' : 'lower belly') : back ? `gluteus ${S}` : `hip ${S}`;
    }
    if (part >= 5 && part <= 10) {
      const hand = part === 7 || part === 10, fore = part === 6 || part === 9;
      const ax = Math.abs(x), a = M.armAt(s, ax);
      const v = y - a.cy, w = z - a.cz;
      if (hand) return z < M.arm(s, ax).cz ? `back of hand ${S}` : `palm ${S}`; // palm forward
      const nearElbow = Math.abs(ax - W.elbowX) < 0.035 * H;
      if (nearElbow) return w > Math.abs(v) * 0.5 ? `elbow crease ${S}` : w < -Math.abs(v) * 0.5 ? `elbow ${S}` : `elbow side ${S}`;
      if (fore) return W.wristX - ax < 0.025 * H ? `wrist ${S}` : v > 0 ? `forearm top ${S}` : `forearm under ${S}`;
      if (ax < W.shoulderX * 1.35) return v >= 0 || w > 0 ? `deltoid ${S}` : `armpit ${S}`;
      return w >= 0 ? `biceps ${S}` : `triceps ${S}`;
    }
    // legs
    const foot = part === 13 || part === 16, shin = part === 12 || part === 15;
    if (foot) {
      const ank = M.profileAt(s, W.ankle);
      if (z < ank[2] - 0.2 * ank[3]) return `heel ${S}`;
      return y < 0.012 * H ? `sole ${S}` : `top of foot ${S}`;
    }
    const pr = M.profileAt(s, y);
    const u = (x - pr[0]) * s, w = z - pr[2];
    if (Math.abs(y - W.knee) < 0.035 * H) return w > Math.abs(u) ? `kneecap ${S}` : w < -Math.abs(u) ? `back of knee ${S}` : `knee side ${S}`;
    if (shin) return y < W.ankle + 0.025 * H ? `ankle ${S}` : w >= 0 ? `shin ${S}` : `calf ${S}`;
    if (Math.abs(u) > Math.abs(w)) return u < 0 ? `inner thigh ${S}` : `outer thigh ${S}`;
    if (w < 0) return y > W.crotch - 0.05 * H ? `gluteal fold ${S}` : `hamstrings ${S}`;
    return `quadriceps ${S}`;
  }

  // left and right are mirror images: the right side takes its labels from the left, face by face
  if (sim.mirror) {
    const byVerts = new Map();
    const key = (vs) => vs.slice().sort((p, q) => p - q).join(',');
    for (let f = 0; f < nF; f++) byVerts.set(key([Q[4 * f], Q[4 * f + 1], Q[4 * f + 2], Q[4 * f + 3]]), f);
    const swap = (l) => l.replace(/ L$/, ' \u0000').replace(/ R$/, ' L').replace(/ \u0000$/, ' R');
    for (let f = 0; f < nF; f++) {
      const vs = [Q[4 * f], Q[4 * f + 1], Q[4 * f + 2], Q[4 * f + 3]];
      let cx = 0; for (const v of vs) cx += P[3 * v];
      if (cx >= 0) continue;
      const m = vs.map((v) => sim.mirror[v]);
      if (m.some((v) => v < 0)) continue;
      const g = byVerts.get(key(m));
      if (g !== undefined && g !== f) labels[f] = swap(labels[g]);
    }
  }
  // regions, colours, density (quads per area against the body's average)
  const areaOf = (f) => {
    const [a, b, c, d] = [Q[4 * f], Q[4 * f + 1], Q[4 * f + 2], Q[4 * f + 3]];
    const ux = P[3 * c] - P[3 * a], uy = P[3 * c + 1] - P[3 * a + 1], uz = P[3 * c + 2] - P[3 * a + 2];
    const vx = P[3 * d] - P[3 * b], vy = P[3 * d + 1] - P[3 * b + 1], vz = P[3 * d + 2] - P[3 * b + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const reg = new Map();
  let totalA = 0;
  for (let f = 0; f < nF; f++) {
    const k = labels[f];
    const A = areaOf(f);
    totalA += A;
    const r = reg.get(k) || { name: k, quads: 0, area: 0 };
    r.quads++; r.area += A;
    reg.set(k, r);
  }
  const avg = nF / totalA;
  const regions = [...reg.values()].map((r) => ({ ...r, density: r.quads / r.area / avg, family: familyOf(r.name) })).sort((a, b) => a.family.order - b.family.order || a.name.localeCompare(b.name));
  const index = new Map(regions.map((r, i) => [r.name, i]));
  const face = new Uint16Array(nF);
  for (let f = 0; f < nF; f++) face[f] = index.get(labels[f]);
  regions.forEach((r) => (r.color = colorOf(r)));

  const loopTags = loops.map((l) => ({ name: l.name, anatomy: loopAnatomy(l.name) }));
  const coverage = coverageReport(model, sim, loops, regions);
  return { face, regions, loops: loopTags, coverage, level: mesh.levels ? mesh.levels.length - 1 : 0 };
}

// ---------------- colours ----------------
const FAMILIES = [
  { key: 'face', order: 0, hue: 350, re: /^(eye|eyelid|mouth|lips|nose|cheek|brow|forehead|chin)/ },
  { key: 'head', order: 1, hue: 20, re: /^(crown|back of head|ear|jaw|temple|nape)/ },
  { key: 'neck', order: 2, hue: 285, re: /^(throat|neck)/ },
  { key: 'torso front', order: 3, hue: 30, re: /^(sternum|clavicle|pectoral|upper abdomen|abdomen|oblique|ribs|lower belly|groin|shoulder top)/ },
  { key: 'back', order: 4, hue: 55, re: /^(trapezius|scapula|mid back|lower back|gluteus|hip )/ },
  { key: 'shoulder and arm', order: 5, hue: 135, re: /^(deltoid|armpit|biceps|triceps|elbow|forearm|wrist)/ },
  { key: 'hand', order: 6, hue: 175, re: /^(palm|back of hand|thumb|index|middle|ring|little)/ },
  { key: 'leg', order: 7, hue: 210, re: /^(quadriceps|hamstrings|inner thigh|outer thigh|gluteal fold|kneecap|back of knee|knee side|shin|calf|ankle)/ },
  { key: 'foot', order: 8, hue: 255, re: /^(heel|sole|top of foot|toes)/ },
];
function familyOf(name) { return FAMILIES.find((f) => f.re.test(name)) || { key: 'other', order: 9, hue: 0 }; }
function hash(s) { let h = 7; for (const c of s.replace(/ [LR]$/, '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function colorOf(r) {
  const h = (r.family.hue + ((hash(r.name) % 7) - 3) * 12 + 360) % 360;
  const l = 0.46 + ((hash(r.name) >> 3) % 6) * 0.055, sat = 0.58;
  const k = (m) => (m + h / 30) % 12, a = sat * Math.min(l, 1 - l);
  const c = (m) => l - a * Math.max(-1, Math.min(k(m) - 3, Math.min(9 - k(m), 1)));
  return [c(0), c(8), c(4)];
}

// ---------------- loops ----------------
export function loopAnatomy(name) {
  const S = / ([LR])$/.exec(name), side = S ? ' ' + S[1] : '';
  const base = name.replace(/ [LR]$/, '');
  const M = {
    face: 'face outline', eye: 'eye socket rim', eyelid: 'eyelid edge', mouth: 'mouth corners (outer lip ring)', lips: 'lip line',
    crotch: 'groin ring', hip: 'hip ring', waist: 'waist', armpit: 'armpit ring', shoulder: 'shoulder line', neck: 'neck ring', chin: 'jaw and chin ring',
    'mouth low': 'below the mouth', 'mouth high': 'above the mouth', nostrils: 'ring at the nostrils', 'eye low': 'under the eyes', 'eye high': 'over the eyes', forehead: 'ring over the brow', crown: 'crown',
    nose: 'nose loop', brow: 'brow loop over the eyes',
    knee: 'knee axis', 'knee band': 'knee bend band', ankle: 'ankle', sole: 'sole', 'upper thigh': 'top of the thigh',
    elbow: 'elbow axis', 'elbow band': 'elbow bend band', wrist: 'wrist', 'wrist band': 'wrist bend band', 'upper arm': 'top of the arm',
    deltoid: 'deltoid (shoulder cap)', clavicle: 'collarbone line', pectoral: 'chest muscle edge', scapula: 'shoulder blade', 'gluteal fold': 'buttock fold', groin: 'groin line', 'hip joint': 'hip joint',
    'elbow crease': 'elbow crease', 'knee crease': 'knee crease', patella: 'kneecap', nasolabial: 'nose-to-mouth fold', jaw: 'jaw line', ear: 'ear',
  };
  if (M[base]) return M[base] + side;
  let m;
  if ((m = /^(thumb|index|middle|ring|little) (\d+)$/.exec(base))) return `${m[1]} finger ring ${m[2]}${side}`;
  if ((m = /^toe (\d)\.(\d+)$/.exec(base))) return `toe ${m[1]} ring${side}`;
  if ((m = /^knuckle (\w+) (\d)$/.exec(base))) return `${m[1]} knuckle ${m[2]}${side}`;
  if (/^palm/.test(base)) return 'palm ring' + side;
  if (/^foot/.test(base)) return 'foot ring' + side;
  if (/^(trunk|leg|arm) \d+/.test(base)) return 'plain ring' + side;
  return name;
}

// ---------------- coverage ----------------
// What a deforming character's topology is usually expected to have, checked on this mesh.
function coverageReport(model, sim, loops, regions) {
  const has = (nm) => loops.some((l) => l.name === nm);
  const both = (base) => (has(`${base} L`) && has(`${base} R`) ? 2 : has(`${base} L`) || has(`${base} R`) ? 1 : 0);
  const P = sim.P, W = model.measure.W, H = model.measure.H;
  const cy = (l) => { let y = 0; for (const v of l.verts) y += P[3 * v + 1]; return y / l.verts.length; };
  // a loop that stays on the front of the head (a face loop, not a ring round the head)
  const onFace = (nm) => { const l = loops.find((q) => q.name === nm); if (!l) return false; const pr = model.measure.profileAt('trunk', cy(l)); return l.verts.every((v) => P[3 * v + 2] > pr[2]); };
  const ringsNear = (base, y0, y1) => loops.filter((l) => l.name.startsWith(base) && cy(l) > y0 && cy(l) < y1).length;
  const items = [];
  const add = (area, label, status, note) => items.push({ area, label, status, note });
  const st2 = (k) => (k === 2 ? 'yes' : k === 1 ? 'part' : 'no');
  // face
  add('face', 'Two loops round each eye', has('eye L') && has('eyelid L') && has('eye R') && has('eyelid R') ? 'yes' : has('eye L') ? 'part' : 'no');
  add('face', 'Two loops round the mouth', has('mouth') && has('lips') ? 'yes' : has('mouth') ? 'part' : 'no');
  add('face', 'Nose-to-mouth fold (nasolabial loop)', has('nasolabial') ? 'yes' : 'no');
  add('face', 'Brow loop over the eyes', onFace('brow') ? 'yes' : has('brow') ? 'part' : 'no', has('brow') && !onFace('brow') ? 'only a ring round the head at brow height' : '');
  add('face', 'Nose loops', onFace('nose') ? 'yes' : has('nose') ? 'part' : 'no', has('nose') && !onFace('nose') ? 'only a ring round the head at nose height' : '');
  add('face', 'Jaw line', has('jaw') ? 'yes' : has('chin') ? 'part' : 'no', has('jaw') ? '' : 'the chin ring stands in');
  add('face', 'Ears', st2(both('ear')));
  // neck and shoulders
  const neckRings = loops.filter((l) => cy(l) > W.shoulder && cy(l) < W.chin && l.verts.length > 8).length;
  add('neck', 'Two or more rings in the neck', neckRings >= 2 ? 'yes' : neckRings ? 'part' : 'no', `${neckRings} found`);
  add('shoulder', 'Loop round the shoulder (deltoid)', st2(both('deltoid')));
  add('shoulder', 'Armpit loops', st2(both('armpit')));
  add('shoulder', 'Collarbone line', st2(both('clavicle')));
  add('torso', 'Chest muscle edge (pectoral)', st2(both('pectoral')));
  add('torso', 'Shoulder blades', st2(both('scapula')));
  // arms and hands
  const elbowRings = ringsNear('elbow', 0, H);
  add('arm', 'Elbow crease pattern', both('elbow crease') === 2 ? 'yes' : elbowRings >= 4 ? 'part' : 'no', both('elbow crease') ? '' : 'three plain rings, no crease wedge');
  add('arm', 'Wrist ring', st2(both('wrist')));
  add('hand', 'Knuckle loops at the joints', loops.some((l) => /^knuckle /.test(l.name)) ? 'yes' : loops.some((l) => /^palm/.test(l.name)) ? 'part' : 'no', loops.some((l) => /^knuckle /.test(l.name)) ? '' : 'finger rings sit at fixed fractions, not at the knuckles');
  add('hand', 'Separate fingers and thumb', loops.some((l) => /^index /.test(l.name)) && loops.some((l) => /^thumb /.test(l.name)) ? 'yes' : 'no');
  // hips and legs
  add('hip', 'Loop round the hip joint', st2(both('hip joint')));
  add('hip', 'Buttock fold', st2(both('gluteal fold')));
  add('hip', 'Groin line', st2(both('groin')));
  add('leg', 'Knee crease pattern', both('knee crease') === 2 || both('patella') === 2 ? 'yes' : ringsNear('knee', 0, H) >= 4 ? 'part' : 'no', both('knee crease') ? '' : 'three plain rings, no crease wedge');
  const ankleRings = loops.filter((l) => /^(ankle|leg \d+|foot 1) /.test(l.name) && Math.abs(cy(l) - W.ankle) < 0.04 * H).length;
  add('leg', 'Ankle bend rings', ankleRings >= 3 ? 'yes' : ankleRings ? 'part' : 'no', `${ankleRings} near the ankle`);
  add('foot', 'Separate toes', loops.some((l) => /^toe /.test(l.name)) ? 'yes' : 'no');
  const val = { yes: 1, part: 0.5, no: 0 };
  const score = items.reduce((a, it) => a + val[it.status], 0) / items.length;
  // regions that bend or carry expression, with few quads for their size
  const thin = regions.filter((r) => /^(elbow|kneecap|back of knee|armpit|deltoid|shoulder top|gluteal fold|groin|eyelid|lips|mouth|nose|cheek|wrist|ankle)/.test(r.name) && r.density < 0.8).map((r) => r.name);
  return { items, score, thin };
}
