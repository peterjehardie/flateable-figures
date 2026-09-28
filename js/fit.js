// Silhouette check: project the balloon into each view, on the same raster as the
// hull mask, and compare. Red = balloon outside the drawing, blue = drawing not yet filled.

export function computeFit(sim, frame, masks) {
  const out = {};
  for (const view of ['front', 'side', 'top']) {
    const m = masks[view];
    if (!m) continue;
    const cv = document.createElement('canvas');
    cv.width = m.W; cv.height = m.H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    const P = sim.P, Q = sim.mesh.quads;
    const px = new Float32Array(sim.n * 2);
    for (let i = 0; i < sim.n; i++) {
      const [xd, yd] = view === 'front' ? frame.fd(P[3 * i], P[3 * i + 1]) : view === 'side' ? frame.sd(P[3 * i + 2], P[3 * i + 1]) : frame.td(P[3 * i], P[3 * i + 2]);
      px[2 * i] = (xd - m.x0) / m.cell; px[2 * i + 1] = (yd - m.y0) / m.cell;
    }
    // each quad as its own path: overlapping front/back faces must not cancel out
    for (let f = 0; f < Q.length; f += 4) {
      // the top view only draws hands and feet, so only they are compared there
      if (view === 'top' && !(sim.ext[Q[f]] && sim.ext[Q[f + 1]] && sim.ext[Q[f + 2]] && sim.ext[Q[f + 3]])) continue;
      ctx.beginPath();
      ctx.moveTo(px[2 * Q[f]], px[2 * Q[f] + 1]);
      ctx.lineTo(px[2 * Q[f + 1]], px[2 * Q[f + 1] + 1]);
      ctx.lineTo(px[2 * Q[f + 2]], px[2 * Q[f + 2] + 1]);
      ctx.lineTo(px[2 * Q[f + 3]], px[2 * Q[f + 3] + 1]);
      ctx.closePath();
      ctx.fill();
    }
    const got = ctx.getImageData(0, 0, m.W, m.H);
    const d = got.data;
    let inside = 0, covered = 0, over = 0;
    const img = ctx.createImageData(m.W, m.H);
    const o = img.data;
    for (let i = 0; i < m.W * m.H; i++) {
      const ins = m.sd[i] < 0, mesh = d[i * 4 + 3] > 100;
      if (ins) inside++;
      if (ins && mesh) covered++;
      if (mesh && !ins && m.sd[i] > m.cell * 1.5) { over++; o[i * 4] = 217; o[i * 4 + 1] = 70; o[i * 4 + 2] = 59; o[i * 4 + 3] = 170; }
      else if (ins && !mesh && m.sd[i] < -m.cell * 1.5) { o[i * 4] = 47; o[i * 4 + 1] = 111; o[i * 4 + 2] = 224; o[i * 4 + 3] = 120; }
    }
    ctx.clearRect(0, 0, m.W, m.H);
    ctx.putImageData(img, 0, 0);
    out[view] = { canvas: cv, cover: inside ? covered / inside : 0, over: inside ? over / inside : 0 };
  }
  return out;
}

// Tinted image of a hull mask for display.
export function maskImage(m, rgb, alpha = 46) {
  const cv = document.createElement('canvas');
  cv.width = m.W; cv.height = m.H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(m.W, m.H);
  for (let i = 0; i < m.W * m.H; i++) {
    if (m.sd[i] < 0) { img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = alpha; }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
