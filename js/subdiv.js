// Catmull–Clark subdivision for closed all-quad meshes.
// Vertex numbering keeps every coarser level as a prefix: cage vertex i is vertex i
// at every level, so the cage can always be read back off the dense mesh.

export function subdivideTopology(mesh) {
  const nV = mesh.nV, Q = mesh.quads, nF = Q.length / 4;
  const emap = new Map();
  const eA = [], eB = [], eF = [];
  for (let f = 0; f < nF; f++) for (let i = 0; i < 4; i++) {
    const a = Q[4 * f + i], b = Q[4 * f + ((i + 1) % 4)];
    const key = a < b ? a * 2097152 + b : b * 2097152 + a;
    let e = emap.get(key);
    if (e === undefined) { e = eA.length; emap.set(key, e); eA.push(Math.min(a, b)); eB.push(Math.max(a, b)); eF.push([]); }
    eF[e].push(f);
  }
  const nE = eA.length;
  const fp = (f) => nV + f;
  const ep = (e) => nV + nF + e;
  const edgeOf = (a, b) => emap.get(a < b ? a * 2097152 + b : b * 2097152 + a);
  const quads = new Int32Array(nF * 16);
  const fpart = new Uint8Array(nF * 4);
  for (let f = 0; f < nF; f++) for (let i = 0; i < 4; i++) {
    const v = Q[4 * f + i], vn = Q[4 * f + ((i + 1) % 4)], vp = Q[4 * f + ((i + 3) % 4)];
    const o = (4 * f + i) * 4;
    quads[o] = v; quads[o + 1] = ep(edgeOf(v, vn)); quads[o + 2] = fp(f); quads[o + 3] = ep(edgeOf(vp, v));
    fpart[4 * f + i] = mesh.fpart[f];
  }
  // vertex -> incident faces and edges
  const vf = Array.from({ length: nV }, () => []);
  const ve = Array.from({ length: nV }, () => []);
  for (let f = 0; f < nF; f++) for (let i = 0; i < 4; i++) vf[Q[4 * f + i]].push(f);
  for (let e = 0; e < nE; e++) { ve[eA[e]].push(e); ve[eB[e]].push(e); }
  const nV2 = nV + nF + nE;
  return { nV, nF, nE, nV2, quads, fpart, eA, eB, eF, vf, ve, edgeOf, Q };
}

export function subdividePositions(t, pos) {
  const { nV, nF, nE, nV2, eA, eB, eF, vf, ve, Q } = t;
  const out = new Float64Array(nV2 * 3);
  for (let f = 0; f < nF; f++) for (let c = 0; c < 3; c++) {
    out[3 * (nV + f) + c] = (pos[3 * Q[4 * f] + c] + pos[3 * Q[4 * f + 1] + c] + pos[3 * Q[4 * f + 2] + c] + pos[3 * Q[4 * f + 3] + c]) / 4;
  }
  for (let e = 0; e < nE; e++) {
    const fs = eF[e];
    for (let c = 0; c < 3; c++) {
      let s = pos[3 * eA[e] + c] + pos[3 * eB[e] + c];
      let n = 2;
      for (const f of fs) { s += out[3 * (nV + f) + c]; n++; }
      out[3 * (nV + nF + e) + c] = s / n;
    }
  }
  for (let v = 0; v < nV; v++) {
    const n = ve[v].length;
    for (let c = 0; c < 3; c++) {
      let q = 0; for (const f of vf[v]) q += out[3 * (nV + f) + c]; q /= vf[v].length;
      let r = 0; for (const e of ve[v]) r += (pos[3 * eA[e] + c] + pos[3 * eB[e] + c]) / 2; r /= n;
      out[3 * v + c] = (q + 2 * r + (n - 3) * pos[3 * v + c]) / n;
    }
  }
  return out;
}

function subdivideAttrs(t, mesh) {
  const { nV, nF, nE, nV2, eA, eB, Q } = t;
  const ax = new Int8Array(nV2), av = new Float64Array(nV2), rr = new Float64Array(nV2);
  for (let v = 0; v < nV; v++) { ax[v] = mesh.anchorAxis[v]; av[v] = mesh.anchorVal[v]; rr[v] = mesh.rref[v]; }
  for (let f = 0; f < nF; f++) {
    const vs = [Q[4 * f], Q[4 * f + 1], Q[4 * f + 2], Q[4 * f + 3]];
    const a0 = mesh.anchorAxis[vs[0]];
    const same = a0 >= 0 && vs.every((v) => mesh.anchorAxis[v] === a0);
    ax[nV + f] = same ? a0 : -1;
    av[nV + f] = same ? vs.reduce((s, v) => s + mesh.anchorVal[v], 0) / 4 : 0;
    rr[nV + f] = vs.reduce((s, v) => s + mesh.rref[v], 0) / 4;
  }
  for (let e = 0; e < nE; e++) {
    const a = eA[e], b = eB[e], i = nV + nF + e;
    const same = mesh.anchorAxis[a] >= 0 && mesh.anchorAxis[a] === mesh.anchorAxis[b];
    ax[i] = same ? mesh.anchorAxis[a] : -1;
    av[i] = same ? (mesh.anchorVal[a] + mesh.anchorVal[b]) / 2 : 0;
    rr[i] = (mesh.rref[a] + mesh.rref[b]) / 2;
  }
  return { anchorAxis: ax, anchorVal: av, rref: rr };
}

// Subdivide `levels` times. Returns the dense mesh plus what is needed to trace
// cage edges and cage loops through it, and the topology of each level (for export).
export function subdivide(cage, levels, extraPositions = []) {
  let mesh = { nV: cage.nV, quads: cage.quads, fpart: cage.fpart, pos: cage.pos, anchorAxis: cage.anchorAxis, anchorVal: cage.anchorVal, rref: cage.rref };
  let extras = extraPositions.slice();
  let loops = cage.loops.map((l) => ({ ...l }));
  // cage edges as vertex pairs
  let flagged = [];
  {
    const seen = new Set();
    const Q = cage.quads;
    for (let f = 0; f < Q.length / 4; f++) for (let i = 0; i < 4; i++) {
      const a = Q[4 * f + i], b = Q[4 * f + ((i + 1) % 4)];
      const key = a < b ? a * 2097152 + b : b * 2097152 + a;
      if (!seen.has(key)) { seen.add(key); flagged.push(a, b); }
    }
  }
  const levelMeshes = [{ nV: mesh.nV, quads: mesh.quads, fpart: mesh.fpart }];
  for (let l = 0; l < levels; l++) {
    const t = subdivideTopology(mesh);
    const pos = subdividePositions(t, mesh.pos);
    extras = extras.map((p) => subdividePositions(t, p));
    const attrs = subdivideAttrs(t, mesh);
    const epIdx = (a, b) => t.nV + t.nF + t.edgeOf(a, b);
    loops = loops.map((lp) => {
      const v = [];
      for (let i = 0; i < lp.verts.length; i++) { const a = lp.verts[i], b = lp.verts[(i + 1) % lp.verts.length]; v.push(a, epIdx(a, b)); }
      return { ...lp, verts: v };
    });
    const nf = [];
    for (let i = 0; i < flagged.length; i += 2) { const a = flagged[i], b = flagged[i + 1], e = epIdx(a, b); nf.push(a, e, e, b); }
    flagged = nf;
    mesh = { nV: t.nV2, quads: t.quads, fpart: t.fpart, pos, ...attrs };
    levelMeshes.push({ nV: t.nV2, quads: t.quads, fpart: t.fpart });
  }
  mesh.loops = loops;
  mesh.cageEdges = new Uint32Array(flagged);
  mesh.levels = levelMeshes;
  mesh.cageNV = cage.nV;
  return { mesh, extras };
}
