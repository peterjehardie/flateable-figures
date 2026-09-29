// Rig toolkit: a skeleton for the inflated figure, and the means to swap in another one.
//
// - Body points ("slots"): named places on the settled mesh where joints can sit (pelvis, knee L,
//   index 2 R ...), measured from its edge loops, stations and the drawings.
// - Rigs: a list of joints with parents and rest positions. The built-in one uses Mixamo-style
//   names. Others load from our JSON, BVH (motion-capture skeleton) or glTF/GLB (the skeleton of a
//   skinned model), and their joints are matched to body points by name (Mixamo, Unreal, Rigify
//   and similar conventions); the match can be changed by hand.
// - Fitting: matched joints move to their body points; the others (twist bones, extra spine or
//   neck joints) keep their place between matched ones, or their offset from their parent scaled
//   to the figure.
// - Skin weights, test poses with deformation readouts, and export as a skinned glTF (.glb).
// Bind pose: every joint unrotated (world-aligned), so a joint's rest transform is its position.

// ---------------- body points ----------------
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
export const SLOTS = (() => {
  const s = ['pelvis', 'spine1', 'spine2', 'chest', 'neck', 'head', 'headTop'];
  for (const S of ['L', 'R']) {
    s.push(`clavicle ${S}`, `shoulder ${S}`, `elbow ${S}`, `wrist ${S}`);
    for (const f of FINGERS) for (let k = 1; k <= 4; k++) s.push(`${f}${k} ${S}`);
    s.push(`hip ${S}`, `knee ${S}`, `ankle ${S}`, `ball ${S}`, `toeTip ${S}`);
  }
  return s;
})();

// Where each body point is on the settled mesh (sim.P), from loops, stations and drawings.
export function computeSlots(model, sim) {
  const M = model.measure, W = M.W, H = M.H, P = sim.P, loops = sim.mesh.loops;
  const out = {};
  const loopBy = (name) => loops.find((l) => l.name === name);
  const stat = (l) => {
    let x = 0, y = 0, z = 0, z0 = Infinity, z1 = -Infinity;
    for (const v of l.verts) { x += P[3 * v]; y += P[3 * v + 1]; z += P[3 * v + 2]; z0 = Math.min(z0, P[3 * v + 2]); z1 = Math.max(z1, P[3 * v + 2]); }
    const n = l.verts.length;
    return { c: [x / n, y / n, z / n], depth: z1 - z0 };
  };
  const trunkAt = (y, back = 0) => { const pr = M.profileAt('trunk', y); return [0, y, pr[2] - back * pr[3]]; };
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  out.pelvis = trunkAt(W.crotch + 0.45 * (W.hip - W.crotch), 0.1);
  out.spine1 = trunkAt(W.waist, 0.3);
  out.spine2 = trunkAt(W.waist + 0.5 * (W.armpit - W.waist), 0.3);
  out.chest = trunkAt(W.armpit + 0.35 * (W.shoulder - W.armpit), 0.25);
  out.neck = trunkAt(W.shoulder + 0.4 * (W.chin - W.shoulder), 0.15);
  out.head = trunkAt(W.chin + 0.2 * (H - W.chin), 0.15);
  out.headTop = trunkAt(H - 0.005 * H, 0.1);
  for (const [S, s] of [['L', 1], ['R', -1]]) {
    const sx = W.shoulderX, arm = (x) => M.armAt(s, x);
    const yS = W.shoulder, prS = M.profileAt('trunk', yS);
    out[`clavicle ${S}`] = [s * 0.035 * H, yS - 0.01 * H, prS[2] + 0.25 * prS[3]];
    const a0 = arm(0.9 * sx);
    out[`shoulder ${S}`] = [s * 0.9 * sx, a0.cy, a0.cz];
    for (const [slot, name, back] of [['elbow', 'elbow', 0.15], ['wrist', 'wrist', 0]]) {
      const l = loopBy(`${name} ${S}`);
      if (l) { const st = stat(l); out[`${slot} ${S}`] = [st.c[0], st.c[1], st.c[2] - back * st.depth]; }
      else { const x = s * W[name + 'X']; const a = arm(Math.abs(x)); out[`${slot} ${S}`] = [x, a.cy, a.cz]; }
    }
    // fingers: from the digit's loops and tip on the mesh (knuckles, then phalanges 0.45/0.3/0.25)
    for (const f of FINGERS) {
      const ls = loops.filter((l) => l.name.startsWith(f + ' ') && l.name.endsWith(' ' + S)).sort((p, q) => +p.name.split(' ')[1] - +q.name.split(' ')[1]);
      if (!ls.length) continue;
      const c1 = stat(ls[0]).c, cl = stat(ls[ls.length - 1]).c;
      let d = [cl[0] - c1[0], cl[1] - c1[1], cl[2] - c1[2]];
      if (Math.hypot(...d) < 1e-6) d = [s, 0, 0];
      let dl = Math.hypot(...d); d = d.map((x) => x / dl);
      // tip: the furthest point of the mesh along the digit, near its axis
      let best = -Infinity;
      for (let i = 0; i < sim.n; i++) {
        if (sim.ext[i] !== 1) continue;
        const o = [P[3 * i] - c1[0], P[3 * i + 1] - c1[1], P[3 * i + 2] - c1[2]];
        const t = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
        const r = Math.hypot(o[0] - t * d[0], o[1] - t * d[1], o[2] - t * d[2]);
        if (r < 0.012 * H && t > best) best = t;
      }
      const L = Math.max(best, 0.01 * H);
      const at = (t) => [c1[0] + d[0] * t, c1[1] + d[1] * t, c1[2] + d[2] * t];
      const pts = f === 'thumb' ? [at(-0.9 * L), at(-0.15 * L), at(0.45 * L), at(L)] : (() => { const b = -0.45 * L, F = L - b; return [at(b), at(b + 0.45 * F), at(b + 0.75 * F), at(L)]; })();
      // the cage's knuckle loops, where it has them, are the joints (the thumb's first one is its
      // root in the palm: its base joint stays deeper, where the proportions put it)
      for (let k = f === 'thumb' ? 2 : 1; k <= 3; k++) { const kl = loopBy(`knuckle ${f} ${k} ${S}`); if (kl) pts[k - 1] = stat(kl).c; }
      pts.forEach((p, k) => (out[`${f}${k + 1} ${S}`] = p));
    }
    const lp = M.profileAt(s, W.crotch - 0.02 * H);
    out[`hip ${S}`] = [lp[0], W.crotch + 0.25 * (W.hip - W.crotch), lp[2]];
    for (const [slot, name] of [['knee', 'knee'], ['ankle', 'ankle']]) {
      const l = loopBy(`${name} ${S}`);
      if (l) out[`${slot} ${S}`] = stat(l).c;
      else { const y = W[name], pr = M.profileAt(s, y); out[`${slot} ${S}`] = [pr[0], y, pr[2]]; }
    }
    // foot: ball and toe tip from the foot's points on the mesh
    let zMax = -Infinity, zMin = Infinity;
    for (let i = 0; i < sim.n; i++) if (sim.ext[i] === 2 && Math.sign(P[3 * i]) === s) { zMax = Math.max(zMax, P[3 * i + 2]); zMin = Math.min(zMin, P[3 * i + 2]); }
    if (isFinite(zMax)) {
      const zb = zMax - 0.27 * (zMax - zMin);
      let xs = 0, c = 0;
      for (let i = 0; i < sim.n; i++) if (sim.ext[i] === 2 && Math.sign(P[3 * i]) === s && Math.abs(P[3 * i + 2] - zb) < 0.02 * H) { xs += P[3 * i]; c++; }
      const xb = c ? xs / c : out[`ankle ${S}`][0];
      out[`ball ${S}`] = [xb, 0.018 * H, zb];
      out[`toeTip ${S}`] = [xb, 0.012 * H, zMax];
    }
  }
  return out;
}

// ---------------- rigs ----------------
// { name, joints: [{ name, parent: index | -1, rest: [x,y,z] | null, slot: string | null }] }
const MX = (side, part) => (side === 'L' ? 'Left' : 'Right') + part;
export function baseRig() {
  const J = [];
  const add = (name, parent, slot) => { J.push({ name, parent: parent == null ? -1 : J.findIndex((j) => j.name === parent), rest: null, slot }); };
  add('Hips', null, 'pelvis'); add('Spine', 'Hips', 'spine1'); add('Spine1', 'Spine', 'spine2'); add('Spine2', 'Spine1', 'chest');
  add('Neck', 'Spine2', 'neck'); add('Head', 'Neck', 'head'); add('HeadTop_End', 'Head', 'headTop');
  for (const S of ['L', 'R']) {
    add(MX(S, 'Shoulder'), 'Spine2', `clavicle ${S}`); add(MX(S, 'Arm'), MX(S, 'Shoulder'), `shoulder ${S}`);
    add(MX(S, 'ForeArm'), MX(S, 'Arm'), `elbow ${S}`); add(MX(S, 'Hand'), MX(S, 'ForeArm'), `wrist ${S}`);
    for (const [f, mf] of [['thumb', 'Thumb'], ['index', 'Index'], ['middle', 'Middle'], ['ring', 'Ring'], ['little', 'Pinky']]) {
      let par = MX(S, 'Hand');
      for (let k = 1; k <= 4; k++) { const nm = MX(S, 'Hand' + mf + k); add(nm, par, `${f}${k} ${S}`); par = nm; }
    }
    add(MX(S, 'UpLeg'), 'Hips', `hip ${S}`); add(MX(S, 'Leg'), MX(S, 'UpLeg'), `knee ${S}`); add(MX(S, 'Foot'), MX(S, 'Leg'), `ankle ${S}`);
    add(MX(S, 'ToeBase'), MX(S, 'Foot'), `ball ${S}`); add(MX(S, 'Toe_End'), MX(S, 'ToeBase'), `toeTip ${S}`);
  }
  return { name: 'Built-in (Mixamo-style names)', joints: J, source: 'built-in' };
}

// match a joint name to a body point (Mixamo, Unreal, Rigify, 3ds Max Biped, CC and similar)
export function guessSlot(rawName) {
  let n = rawName.replace(/^.*[:|]/, '').replace(/^(DEF|ORG|MCH|CC_Base|Bip0?1|mixamorig)[-_ ]?/i, '');
  const low = n.toLowerCase();
  if (/twist|roll|helper|corrective|ik|pole|target|_end_end|nub$/.test(low) && !/toe_?end|head_?top|end$/.test(low)) return null;
  let side = null;
  if (/^left|[._\- ]l$|^l[._\- ]|[._\- ]l[._\- ]|left/i.test(n) && !/^right/i.test(n)) side = 'L';
  if (/^right|[._\- ]r$|^r[._\- ]|[._\- ]r[._\- ]|right/i.test(n)) side = 'R';
  const word = low.replace(/left|right/g, ' ').replace(/(^|[._\- ])[lr](?=$|[._\- ])/g, ' ');
  const num = (() => { const m = word.match(/(\d+)(?!.*\d)/); return m ? +m[1] : null; })();
  for (const [f, re] of [['thumb', /thumb/], ['index', /index|pointer/], ['middle', /middle/], ['ring', /ring/], ['little', /pinky|little|small/]]) {
    if (!re.test(word) || !side) continue;
    let k = num == null ? 1 : num;
    if (/end|tip|nub/.test(word)) k = 4;
    if (/metacarpal/.test(word)) return null;
    return k >= 1 && k <= 4 ? `${f}${k} ${side}` : null;
  }
  if (side) {
    if (/toe_?end|toetip|toe_?tip/.test(word)) return `toeTip ${side}`;
    if (/toe|ball/.test(word)) return `ball ${side}`;
    if (/foot|ankle/.test(word)) return `ankle ${side}`;
    if (/up_?leg|upper_?leg|thigh|femur/.test(word)) return `hip ${side}`;
    if (/calf|shin|lower_?leg|knee|leg/.test(word)) return `knee ${side}`;
    if (/fore_?arm|lower_?arm|elbow/.test(word)) return `elbow ${side}`;
    if (/hand|wrist|palm/.test(word)) return `wrist ${side}`;
    if (/shoulder|clavicle|collar/.test(word)) return `clavicle ${side}`;
    if (/upper_?arm|arm/.test(word)) return `shoulder ${side}`;
    return null;
  }
  if (/head_?top|head_?end|headtop/.test(word)) return 'headTop';
  if (/head/.test(word)) return 'head';
  if (/neck/.test(word)) return 'neck';
  if (/hips|pelvis|hip$/.test(word)) return 'pelvis';
  if (/spine|chest|torso|abdomen|waist|back/.test(word)) return 'spine*';
  return null;
}

// joint name -> body point for every joint; spine chains spread over spine1, spine2, chest
export function autoMap(rig) {
  const slots = rig.joints.map((j) => guessSlot(j.name));
  const depth = (i) => { let d = 0; for (let p = rig.joints[i].parent; p >= 0; p = rig.joints[p].parent) d++; return d; };
  const spine = slots.map((s, i) => (s === 'spine*' ? i : -1)).filter((i) => i >= 0).sort((a, b) => depth(a) - depth(b));
  for (const i of spine) slots[i] = null;
  if (spine.length === 1) slots[spine[0]] = 'spine1';
  else if (spine.length === 2) { slots[spine[0]] = 'spine1'; slots[spine[1]] = 'chest'; }
  else if (spine.length >= 3) { slots[spine[0]] = 'spine1'; slots[spine[Math.floor(spine.length / 2)]] = 'spine2'; slots[spine[spine.length - 1]] = 'chest'; }
  // one joint per body point: the one nearest the root keeps it
  const taken = new Map();
  rig.joints.forEach((j, i) => {
    const s = slots[i];
    if (!s) return;
    if (!taken.has(s) || depth(i) < depth(taken.get(s))) taken.set(s, i);
  });
  rig.joints.forEach((j, i) => { j.slot = slots[i] && taken.get(slots[i]) === i ? slots[i] : null; });
  // the root, if nothing matched it, is the pelvis
  const root = rig.joints.findIndex((j) => j.parent < 0);
  if (root >= 0 && !rig.joints.some((j) => j.slot === 'pelvis')) {
    const hipsChild = rig.joints.find((j) => j.parent === root && !j.slot);
    if (!rig.joints[root].slot) rig.joints[root].slot = 'pelvis';
    else if (hipsChild) hipsChild.slot = 'pelvis';
  }
  return rig;
}

// Fitted world positions for every joint of a rig.
export function fitRig(rig, slots, H) {
  const J = rig.joints, n = J.length;
  const src = J.map((j) => j.rest);
  const hasSrc = src.every((p) => p);
  let scale = 1;
  if (hasSrc) {
    let y0 = Infinity, y1 = -Infinity;
    for (const p of src) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    if (y1 - y0 > 1e-6) scale = (0.93 * H) / (y1 - y0);
  }
  const kids = Array.from({ length: n }, () => []);
  J.forEach((j, i) => { if (j.parent >= 0) kids[j.parent].push(i); });
  const order = [];
  const visit = (i) => { order.push(i); for (const c of kids[i]) visit(c); };
  J.forEach((j, i) => { if (j.parent < 0) visit(i); });
  const fit = new Array(n).fill(null);
  const mappedPos = (i) => (J[i].slot && slots[J[i].slot] ? slots[J[i].slot] : null);
  // first matched joint down a chain (through single children first)
  const firstMappedBelow = (i) => {
    const queue = [...kids[i]];
    while (queue.length) { const c = queue.shift(); if (mappedPos(c)) return c; queue.push(...kids[c]); }
    return -1;
  };
  for (const i of order) {
    const m = mappedPos(i);
    if (m) { fit[i] = m.slice(); continue; }
    const p = J[i].parent;
    if (p < 0) { fit[i] = hasSrc ? src[i].map((v) => v * scale) : [0, H * 0.5, 0]; continue; }
    const d = firstMappedBelow(i);
    if (hasSrc && d >= 0) {
      // keep its place between the matched joints above and below it
      let a = p; while (a >= 0 && !mappedPos(a) && J[a].parent >= 0) a = J[a].parent;
      const A = src[a], D = src[d], Pp = src[i];
      const ad = [D[0] - A[0], D[1] - A[1], D[2] - A[2]], L2 = ad[0] ** 2 + ad[1] ** 2 + ad[2] ** 2 || 1e-12;
      const t = Math.max(0, Math.min(1, ((Pp[0] - A[0]) * ad[0] + (Pp[1] - A[1]) * ad[1] + (Pp[2] - A[2]) * ad[2]) / L2));
      const fa = fit[a], fd = mappedPos(d);
      fit[i] = fa.map((v, k) => v + (fd[k] - v) * t);
    } else if (hasSrc) {
      fit[i] = fit[p].map((v, k) => v + (src[i][k] - src[p][k]) * scale);
    } else {
      fit[i] = fit[p].slice();
    }
  }
  return fit;
}

// ---------------- loading ----------------
export function parseRigJSON(text) {
  const o = JSON.parse(text);
  const js = o.joints || [];
  const names = js.map((j) => j.name);
  return {
    name: o.name || 'Rig (JSON)', source: 'json',
    joints: js.map((j) => ({ name: j.name, parent: j.parent == null || j.parent === '' ? -1 : typeof j.parent === 'number' ? j.parent : names.indexOf(j.parent), rest: j.position || j.rest || null, slot: j.slot || null })),
  };
}

export function parseBVH(text) {
  const tok = text.replace(/[{}]/g, (m) => ` ${m} `).split(/\s+/).filter(Boolean);
  const joints = [];
  const stack = [];
  let i = 0, last = -1;
  while (i < tok.length) {
    const t = tok[i++];
    if (t === 'MOTION') break;
    if (t === 'ROOT' || t === 'JOINT') {
      const name = tok[i++];
      joints.push({ name, parent: stack.length ? stack[stack.length - 1] : -1, off: [0, 0, 0] });
      last = joints.length - 1;
    } else if (t === 'End') {
      i++; // "Site"
      const par = stack[stack.length - 1];
      joints.push({ name: joints[par].name + '_End', parent: par, off: [0, 0, 0] });
      last = joints.length - 1;
    } else if (t === '{') stack.push(last);
    else if (t === '}') stack.pop();
    else if (t === 'OFFSET') { joints[last].off = [+tok[i], +tok[i + 1], +tok[i + 2]]; i += 3; }
    else if (t === 'CHANNELS') { i += 1 + +tok[i]; }
  }
  const rest = [];
  joints.forEach((j, k) => { rest[k] = j.parent < 0 ? j.off.slice() : rest[j.parent].map((v, c) => v + j.off[c]); });
  return { name: 'Rig (BVH)', source: 'bvh', joints: joints.map((j, k) => ({ name: j.name, parent: j.parent, rest: rest[k], slot: null })) };
}

// glTF / GLB: the first skin's joints, their hierarchy and rest positions
export function parseGLTF(buf) {
  let json;
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = dv.getUint32(12, true);
    json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len)));
  } else json = JSON.parse(new TextDecoder().decode(u8));
  const nodes = json.nodes || [];
  const skin = (json.skins || [])[0];
  const jointIdx = skin ? skin.joints : nodes.map((_, k) => k);
  const parentOf = new Array(nodes.length).fill(-1);
  nodes.forEach((nd, k) => (nd.children || []).forEach((c) => (parentOf[c] = k)));
  const world = new Array(nodes.length).fill(null);
  const local = (nd) => {
    if (nd.matrix) return nd.matrix.slice();
    const [tx, ty, tz] = nd.translation || [0, 0, 0], [qx, qy, qz, qw] = nd.rotation || [0, 0, 0, 1], [sx, sy, sz] = nd.scale || [1, 1, 1];
    const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
    return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0, 2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0, 2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
  };
  const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const W = (k) => { if (world[k]) return world[k]; const l = local(nodes[k]); world[k] = parentOf[k] >= 0 ? mul(W(parentOf[k]), l) : l; return world[k]; };
  const set = new Map(jointIdx.map((k, i) => [k, i]));
  const joints = jointIdx.map((k) => {
    let p = parentOf[k];
    while (p >= 0 && !set.has(p)) p = parentOf[p];
    const m = W(k);
    return { name: nodes[k].name || 'joint' + k, parent: p >= 0 ? set.get(p) : -1, rest: [m[12], m[13], m[14]], slot: null };
  });
  return { name: 'Rig (glTF)', source: 'gltf', joints };
}

export function loadRigFile(name, data) {
  const low = name.toLowerCase();
  let rig;
  if (low.endsWith('.bvh')) rig = parseBVH(new TextDecoder().decode(data));
  else if (low.endsWith('.glb') || low.endsWith('.gltf')) rig = parseGLTF(data);
  else rig = parseRigJSON(new TextDecoder().decode(data));
  rig.name = name;
  if (!rig.joints.length) throw new Error('no joints found');
  if (!rig.joints.some((j) => j.slot)) autoMap(rig);
  return rig;
}

export function rigJSON(rig, fit) {
  return JSON.stringify({
    format: 'flateable-rig', version: 1, name: rig.name,
    joints: rig.joints.map((j, i) => ({ name: j.name, parent: j.parent >= 0 ? rig.joints[j.parent].name : null, slot: j.slot, position: fit ? fit[i].map((v) => +v.toFixed(5)) : j.rest })),
  }, null, 1);
}

// ---------------- skin weights ----------------
// Each bone is the segment from a joint to a child; it moves with the joint. A point takes the
// nearest bones of its own body part (and, for limbs, of the trunk; for the trunk, of the limbs'
// roots), weighted by 1/distance^4, at most four.
export function computeWeights(sim, rig, fit) {
  const P = sim.P, n = sim.n, J = rig.joints;
  const segs = [];
  J.forEach((j, i) => {
    if (j.parent < 0) return;
    segs.push({ joint: j.parent, a: fit[j.parent], b: fit[i] });
  });
  // leaf joints with no bone of their own still move what is nearest them
  const hasKid = new Set(J.map((j) => j.parent));
  J.forEach((j, i) => {
    if (hasKid.has(i) || j.parent < 0) return;
    const a = fit[i], p = fit[j.parent], d = a.map((v, k) => v - p[k]);
    segs.push({ joint: i, a, b: a.map((v, k) => v + 0.3 * d[k]) });
  });
  // body part of each bone: the part of the mesh point nearest its middle
  const cls = sim.cls;
  for (const s of segs) {
    const m = s.a.map((v, k) => (v + s.b[k]) / 2);
    let best = Infinity, c = 0;
    for (let i = 0; i < n; i += 3) { const d = (P[3 * i] - m[0]) ** 2 + (P[3 * i + 1] - m[1]) ** 2 + (P[3 * i + 2] - m[2]) ** 2; if (d < best) { best = d; c = cls[i]; } }
    s.cls = c;
  }
  const idx = new Uint16Array(4 * n), wt = new Float32Array(4 * n);
  const cand = [];
  for (let v = 0; v < n; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2], c = cls[v];
    cand.length = 0;
    for (const s of segs) {
      if (!(s.cls === c || (c > 0 && s.cls === 0) || (c === 0))) continue;
      const ab = [s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]], L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - s.a[0]) * ab[0] + (y - s.a[1]) * ab[1] + (z - s.a[2]) * ab[2]) / L2));
      const d = Math.hypot(x - s.a[0] - t * ab[0], y - s.a[1] - t * ab[1], z - s.a[2] - t * ab[2]);
      cand.push([d, s.joint]);
    }
    cand.sort((p, q) => p[0] - q[0]);
    const d0 = Math.max(cand[0][0], 1e-4);
    // on hands and feet the digits sit a centimetre or two apart: keep each to its own bones
    const reach = sim.ext[v] ? 1.35 : 2.2;
    // one weight per joint (a joint with several bones, e.g. the hips, counts once)
    const per = new Map();
    for (const [d, j] of cand) {
      if (d > reach * d0) break;
      const w = 1 / Math.pow(Math.max(d, 1e-4) / d0, 4);
      per.set(j, Math.max(per.get(j) || 0, w));
    }
    const top = [...per.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
    const sum = top.reduce((a, t) => a + t[1], 0);
    top.forEach(([j, w], k) => { idx[4 * v + k] = j; wt[4 * v + k] = w / sum; });
  }
  return { idx, wt };
}

// ---------------- posing ----------------
const qAxis = (ax, ang) => { const s = Math.sin(ang / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)]; };
const qMul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qMat = ([x, y, z, w]) => [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
const mv = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];

// test poses, in degrees, each applied to the matching joints of both sides
export const POSES = [
  { key: 'elbow', label: 'Bend elbows', max: 140 },
  { key: 'knee', label: 'Bend knees', max: 140 },
  { key: 'armDown', label: 'Arms down', max: 80 },
  { key: 'armUp', label: 'Arms up', max: 80 },
  { key: 'legFwd', label: 'Legs forward', max: 100 },
  { key: 'spine', label: 'Bend forward', max: 60 },
  { key: 'head', label: 'Turn head', max: 70 },
  { key: 'fingers', label: 'Curl fingers', max: 90 },
  { key: 'foot', label: 'Toes up', max: 30 },
];
// local rotation (quaternion) per joint for a set of pose values
export function poseRotations(rig, values) {
  const r = rig.joints.map(() => [0, 0, 0, 1]);
  const deg = Math.PI / 180;
  rig.joints.forEach((j, i) => {
    const s = j.slot;
    if (!s) return;
    const side = s.endsWith(' L') ? 1 : s.endsWith(' R') ? -1 : 0;
    const base = s.replace(/ [LR]$/, '');
    let q = [0, 0, 0, 1];
    const rot = (ax, a) => { if (a) q = qMul(q, qAxis(ax, a * deg)); };
    if (base === 'elbow') rot([0, 1, 0], -side * (values.elbow || 0));
    if (base === 'knee') rot([1, 0, 0], values.knee || 0);
    if (base === 'shoulder') { rot([0, 0, 1], -side * (values.armDown || 0)); rot([0, 0, 1], side * (values.armUp || 0)); }
    if (base === 'hip') rot([1, 0, 0], -(values.legFwd || 0));
    if (base === 'spine1' || base === 'spine2' || base === 'chest') rot([1, 0, 0], (values.spine || 0) / 3);
    if (base === 'neck' || base === 'head') rot([0, 1, 0], (values.head || 0) / 2);
    if (/^(index|middle|ring|little)[123]$/.test(base)) rot([0, 0, 1], -side * (values.fingers || 0));
    if (/^thumb[23]$/.test(base)) rot([0, 1, 0], -side * (values.fingers || 0) * 0.5);
    if (base === 'ankle') rot([1, 0, 0], -(values.foot || 0));
    r[i] = q;
  });
  return r;
}

// world rotation (3x3) and position of every joint in a pose (bind pose unrotated)
export function forward(rig, fit, rots) {
  const J = rig.joints, n = J.length;
  const Rq = new Array(n), T = new Array(n);
  const done = new Array(n).fill(false);
  const go = (i) => {
    if (done[i]) return;
    const p = J[i].parent;
    if (p < 0) { Rq[i] = rots[i]; T[i] = fit[i].slice(); }
    else {
      go(p);
      Rq[i] = qMul(Rq[p], rots[i]);
      const off = mv(qMat(Rq[p]), [fit[i][0] - fit[p][0], fit[i][1] - fit[p][1], fit[i][2] - fit[p][2]]);
      T[i] = [T[p][0] + off[0], T[p][1] + off[1], T[p][2] + off[2]];
    }
    done[i] = true;
  };
  for (let i = 0; i < n; i++) go(i);
  return { R: Rq.map(qMat), T };
}

// linear blend skinning: posed positions
export function deform(sim, rig, fit, skin, rots, out) {
  const { R, T } = forward(rig, fit, rots);
  const P = sim.P, n = sim.n;
  out = out || new Float64Array(3 * n);
  for (let v = 0; v < n; v++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = skin.wt[4 * v + k];
      if (!w) continue;
      const j = skin.idx[4 * v + k], m = R[j], f = fit[j], t = T[j];
      const px = P[3 * v] - f[0], py = P[3 * v + 1] - f[1], pz = P[3 * v + 2] - f[2];
      x += w * (m[0] * px + m[3] * py + m[6] * pz + t[0]);
      y += w * (m[1] * px + m[4] * py + m[7] * pz + t[1]);
      z += w * (m[2] * px + m[5] * py + m[8] * pz + t[2]);
    }
    out[3 * v] = x; out[3 * v + 1] = y; out[3 * v + 2] = z;
  }
  return { pos: out, joints: T, R };
}

// how a pose treats the surface: volume kept, quads squashed (area < 30%) or turned inside out
export function poseReport(mesh, rest, posed, skin, R) {
  const Q = mesh.quads;
  let v0 = 0, v1 = 0, squashed = 0, flipped = 0;
  const area = (A, a, b, c, d) => {
    const ux = A[3 * c] - A[3 * a], uy = A[3 * c + 1] - A[3 * a + 1], uz = A[3 * c + 2] - A[3 * a + 2];
    const wx = A[3 * d] - A[3 * b], wy = A[3 * d + 1] - A[3 * b + 1], wz = A[3 * d + 2] - A[3 * b + 2];
    return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  };
  const vol = (A, a, b, c) => (A[3 * a] * (A[3 * b + 1] * A[3 * c + 2] - A[3 * b + 2] * A[3 * c + 1]) - A[3 * a + 1] * (A[3 * b] * A[3 * c + 2] - A[3 * b + 2] * A[3 * c]) + A[3 * a + 2] * (A[3 * b] * A[3 * c + 1] - A[3 * b + 1] * A[3 * c])) / 6;
  const strain = new Float32Array(mesh.nV);
  const cnt = new Uint16Array(mesh.nV);
  for (let f = 0; f < Q.length; f += 4) {
    const a = Q[f], b = Q[f + 1], c = Q[f + 2], d = Q[f + 3];
    v0 += vol(rest, a, b, c) + vol(rest, a, c, d);
    v1 += vol(posed, a, b, c) + vol(posed, a, c, d);
    const n0 = area(rest, a, b, c, d), n1 = area(posed, a, b, c, d);
    const A0 = Math.hypot(...n0), A1 = Math.hypot(...n1);
    const ratio = A1 / Math.max(A0, 1e-12);
    if (ratio < 0.3) squashed++;
    for (const v of [a, b, c, d]) { strain[v] += Math.log(Math.max(ratio, 1e-3)); cnt[v]++; }
    // turned over: against the rest normal carried round by the bone that moves the quad most
    const r0 = mv(R[skin.idx[4 * a]], n0);
    if (r0[0] * n1[0] + r0[1] * n1[1] + r0[2] * n1[2] < -0.2 * A0 * A1) flipped++;
  }
  for (let v = 0; v < mesh.nV; v++) if (cnt[v]) strain[v] /= cnt[v];
  return { volume: v1 / (v0 || 1) - 1, squashed, flipped, quads: Q.length / 4, strain };
}

// ---------------- glTF export (.glb) ----------------
export function toGLB(sim, level, rig, fit, skin) {
  const lv = sim.mesh.levels[level];
  const nV = lv.nV, Q = lv.quads, P = sim.P;
  const pos = new Float32Array(3 * nV), nrm = new Float32Array(3 * nV);
  for (let i = 0; i < 3 * nV; i++) pos[i] = P[i];
  for (let f = 0; f < Q.length; f += 4) {
    const a = Q[f], b = Q[f + 1], c = Q[f + 2], d = Q[f + 3];
    const ux = pos[3 * c] - pos[3 * a], uy = pos[3 * c + 1] - pos[3 * a + 1], uz = pos[3 * c + 2] - pos[3 * a + 2];
    const wx = pos[3 * d] - pos[3 * b], wy = pos[3 * d + 1] - pos[3 * b + 1], wz = pos[3 * d + 2] - pos[3 * b + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const v of [a, b, c, d]) { nrm[3 * v] += nx; nrm[3 * v + 1] += ny; nrm[3 * v + 2] += nz; }
  }
  for (let i = 0; i < nV; i++) { const L = Math.hypot(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]) || 1; nrm[3 * i] /= L; nrm[3 * i + 1] /= L; nrm[3 * i + 2] /= L; }
  const idx = new Uint32Array((Q.length / 4) * 6);
  for (let f = 0, t = 0; f < Q.length; f += 4) { idx[t++] = Q[f]; idx[t++] = Q[f + 1]; idx[t++] = Q[f + 2]; idx[t++] = Q[f]; idx[t++] = Q[f + 2]; idx[t++] = Q[f + 3]; }
  const jn = new Uint16Array(4 * nV), wn = new Float32Array(4 * nV);
  jn.set(skin.idx.subarray(0, 4 * nV)); wn.set(skin.wt.subarray(0, 4 * nV));
  const J = rig.joints, nJ = J.length;
  const ibm = new Float32Array(16 * nJ);
  for (let j = 0; j < nJ; j++) { ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -fit[j][0], -fit[j][1], -fit[j][2], 1], 16 * j); }
  // binary buffer
  const chunks = [pos, nrm, jn, wn, idx, ibm];
  const views = [];
  let off = 0;
  for (const c of chunks) { views.push({ byteOffset: off, byteLength: c.byteLength }); off += Math.ceil(c.byteLength / 4) * 4; }
  const bin = new Uint8Array(off);
  chunks.forEach((c, k) => bin.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), views[k].byteOffset));
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nV; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[3 * i + k]); mx[k] = Math.max(mx[k], pos[3 * i + k]); }
  const nodes = J.map((j, i) => ({ name: j.name, translation: j.parent < 0 ? fit[i].slice() : fit[i].map((v, k) => v - fit[j.parent][k]) }));
  J.forEach((j, i) => { if (j.parent >= 0) (nodes[j.parent].children ||= []).push(i); });
  const roots = J.map((j, i) => (j.parent < 0 ? i : -1)).filter((i) => i >= 0);
  nodes.push({ name: 'figure', mesh: 0, skin: 0 });
  const gltf = {
    asset: { version: '2.0', generator: 'Flateable Figures' },
    scene: 0, scenes: [{ nodes: [...roots, nJ] }],
    nodes,
    meshes: [{ name: 'figure', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 4, mode: 4 }] }],
    skins: [{ name: rig.name, joints: J.map((_, i) => i), inverseBindMatrices: 5, skeleton: roots[0] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views.map((v, k) => ({ buffer: 0, byteOffset: v.byteOffset, byteLength: v.byteLength, ...(k === 4 ? { target: 34963 } : k < 4 ? { target: 34962 } : {}) })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: nV, type: 'VEC3', min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: nV, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: nV, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: nV, type: 'VEC4' },
      { bufferView: 4, componentType: 5125, count: idx.length, type: 'SCALAR' },
      { bufferView: 5, componentType: 5126, count: nJ, type: 'MAT4' },
    ],
  };
  let js = new TextEncoder().encode(JSON.stringify(gltf));
  const jl = Math.ceil(js.length / 4) * 4;
  const jsonB = new Uint8Array(jl).fill(0x20); jsonB.set(js);
  const total = 12 + 8 + jl + 8 + bin.length;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jsonB, 20);
  dv.setUint32(20 + jl, bin.length, true); dv.setUint32(24 + jl, 0x004e4942, true); out.set(bin, 28 + jl);
  return out;
}
