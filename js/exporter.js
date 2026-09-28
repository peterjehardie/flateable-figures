// Export: OBJ (quads, one group per part) at any subdivision level, tags and loops as
// JSON, and the project SVG — bundled in a zip.

import { PARTS } from './cage.js';

export function toOBJ(sim, level) {
  const lv = sim.mesh.levels[level];
  const P = sim.P;
  const lines = ['# Flateable Figures export', `# level ${level}: ${lv.nV} vertices, ${lv.quads.length / 4} quads`, 'o figure'];
  for (let i = 0; i < lv.nV; i++) lines.push(`v ${P[3 * i].toFixed(5)} ${P[3 * i + 1].toFixed(5)} ${P[3 * i + 2].toFixed(5)}`);
  const byPart = new Map();
  for (let f = 0; f < lv.quads.length / 4; f++) {
    const p = lv.fpart[f];
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p).push(f);
  }
  for (const [p, faces] of [...byPart.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`g ${PARTS[p].name.replace(/\s+/g, '_')}`);
    for (const f of faces) {
      const q = lv.quads;
      lines.push(`f ${q[4 * f] + 1} ${q[4 * f + 1] + 1} ${q[4 * f + 2] + 1} ${q[4 * f + 3] + 1}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function tagsJSON(sim, level, groups, loops) {
  const nV = sim.mesh.levels[level].nV;
  const g = {};
  for (const [name, arr] of Object.entries(groups)) {
    const ids = [];
    for (let i = 0; i < nV; i++) if (arr[i]) ids.push(i);
    g[name] = ids;
  }
  const l = {};
  for (const lp of loops) l[lp.name] = lp.verts.filter((v) => v < nV);
  return JSON.stringify({ level, vertices: nV, tagGroups: g, edgeLoops: l }, null, 1);
}

// ---- minimal zip (stored, no compression) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameB = enc.encode(name);
    const body = typeof data === 'string' ? enc.encode(data) : data;
    const crc = crc32(body);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, body.length, true);
    h.setUint32(22, body.length, true); h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nameB, body);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true); c.setUint32(24, body.length, true); c.setUint16(28, nameB.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nameB);
    offset += 30 + nameB.length + body.length;
  }
  const cSize = central.reduce((s, a) => s + a.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

// Save through the viewer's download capability when framed as an artifact, else a plain download.
export async function saveFile(filename, blob) {
  try {
    if (window.claude && window.claude.use) {
      const dl = await window.claude.use('downloads');
      if (dl) { await dl.save({ filename, data: blob }); return 'saved'; }
    }
  } catch (e) {
    if (e && e.code === 'declined') return 'declined';
    if (e && e.code && e.code !== 'unavailable' && e.code !== 'not_granted') throw e;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return 'saved';
}
