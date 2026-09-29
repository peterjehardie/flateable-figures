import { buildFigure } from '../../js/figure.js';
const key = process.argv[2] || 'male';
const doc = buildFigure(key);
const out = { front: [], side: [], frontFeature: [], sideFeature: [] };
const by = (v, role) => doc.paths.filter((p) => p.view === v && p.role === role);
const views = {};
for (const v of ['front', 'side']) {
  const ps = by(v, 'line'); const all = ps.flatMap((p) => p.pts);
  const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
  views[v] = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
const H = 1.83, s = H / (views.front.y1 - views.front.y0);
const conv = (v, q) => {
  const b = views[v], c = v === 'front' ? (b.x0 + b.x1) / 2 : (b.x0 + b.x1) / 2;
  const h = (q[0] - c) * s, z = (b.y1 - q[1]) * s * (H / ((b.y1 - b.y0) * s));
  return [h, z];
};
for (const v of ['front', 'side']) {
  for (const p of by(v, 'line')) out[v].push({ closed: !!p.closed, pts: p.pts.map((q) => conv(v, q)) });
  for (const p of by(v, 'feature')) out[v + 'Feature'].push({ closed: !!p.closed, pts: p.pts.map((q) => conv(v, q)) });
}
console.log(JSON.stringify(out));
console.error(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length + ' strokes ' + v.reduce((a, p) => a + p.pts.length, 0) + ' pts'])), views);
