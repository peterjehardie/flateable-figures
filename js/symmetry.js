// Left-right symmetry in the front view: mirrored twins for strokes drawn on one side, closing a
// half outline drawn from the centre line, and rebuilding the whole front view from one half.

export const mirrorPts = (pts, axis) => pts.map(([x, y]) => [2 * axis - x, y]);

// A new stroke under mirror drawing. A half outline (both ends on the centre line) closes with its
// mirror image; a stroke on one side gets a mirrored twin; one crossing the centre line stays as drawn.
export function mirrorStroke(pts, closed, axis, tol, isOutline) {
  const n = pts.length;
  const rel = pts.map(([x]) => x - axis);
  const lo = Math.min(...rel), hi = Math.max(...rel);
  if (!closed && isOutline && Math.abs(rel[0]) < tol && Math.abs(rel[n - 1]) < tol && (hi > tol || lo < -tol)) {
    const a = pts.map(([x, y], i) => [i === 0 || i === n - 1 ? axis : x, y]);
    return { pts: [...a, ...mirrorPts(a, axis).reverse().slice(1, -1)], closed: true, twin: null };
  }
  if (lo > -tol || hi < tol) {
    if (hi < tol && lo > -tol) return { pts, closed, twin: null }; // on the line itself
    return { pts, closed, twin: mirrorPts(pts, axis) };
  }
  return { pts, closed, twin: null };
}

// The part of a stroke on one side of the centre line (sgn = +1: larger x), with the points where
// it crosses the line. A closed stroke's half runs from where it enters that side to where it
// leaves (joined across the line if it crosses more than twice).
function halfOf(pts, closed, axis, sgn) {
  const n = pts.length, out = [];
  const side = (p) => sgn * (p[0] - axis) >= 0;
  const cross = (a, b) => { const t = (axis - a[0]) / (b[0] - a[0]); return [axis, a[1] + (b[1] - a[1]) * t]; };
  if (closed) {
    let i0 = -1;
    for (let i = 0; i < n; i++) if (!side(pts[i]) && side(pts[(i + 1) % n])) { i0 = i; break; }
    if (i0 < 0) return pts.slice();
    for (let k = 0; k < n; k++) {
      const a = pts[(i0 + k) % n], b = pts[(i0 + k + 1) % n];
      if (side(a)) out.push(a);
      if (side(a) !== side(b)) out.push(cross(a, b));
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    if (side(a)) out.push(a);
    if (i < n - 1 && side(a) !== side(pts[i + 1])) out.push(cross(a, pts[i + 1]));
  }
  return out;
}

// Rebuild the front view symmetric from the half with sign sgn (+1: right of the page).
export function symmetrizeFront(doc, sgn, newPath) {
  const axis = doc.views.front.axis;
  const out = [];
  let made = 0;
  for (const p of doc.paths) {
    if (p.view !== 'front' || p.role === 'guide' || p.role === 'axis') { out.push(p); continue; }
    const rel = p.pts.map(([x]) => sgn * (x - axis));
    const lo = Math.min(...rel), hi = Math.max(...rel);
    const eps = 1e-6 * (Math.abs(axis) + 1);
    if (lo >= -eps) {
      // wholly on the kept side: keep it and add its mirror
      out.push(p);
      if (hi > eps) { const q = newPath(mirrorPts(p.pts, axis), { ...p, closed: p.closed }); q.twin = p.id; p.twin = q.id; out.push(q); made++; }
      continue;
    }
    if (hi <= eps) continue; // wholly on the other side: its mirror comes from the kept side
    // crosses the centre line: keep the half, add its mirror
    const h = halfOf(p.pts, p.closed, axis, sgn);
    if (h.length < 2) continue;
    const mir = mirrorPts(h, axis).reverse();
    const onAxis = (q) => Math.abs(q[0] - axis) < 1e-9 * (Math.abs(axis) + 1);
    const joined = p.closed ? [...h, ...mir.slice(1, -1)] : onAxis(h[0]) ? [...mir.slice(0, -1), ...h] : [...h, ...mir.slice(1)];
    // points lying on the line itself come through twice
    const pts = joined.filter((q, i) => { const r = joined[(i + joined.length - 1) % joined.length]; return !(i > 0 || p.closed) || Math.hypot(q[0] - r[0], q[1] - r[1]) > 1e-9; });
    const q = newPath(pts, { ...p, closed: p.closed });
    out.push(q);
    made++;
  }
  doc.paths = out;
  return made;
}
