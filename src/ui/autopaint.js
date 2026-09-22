// Painting from a photograph.
//
// Not a filter. It picks up the same brushes, mixes on the same board and lays
// the same wet paint as a person does -- it just decides where to put it by
// looking at a picture. Every stroke goes through the StrokeRunner and the
// simulation, so the paint behaves exactly as it would under your own hand:
// it blends into what is already wet, runs out, picks up colour it is dragged
// through, and piles up thick enough to catch the light.
//
// The method is the one from Hertzmann's painterly rendering: work from big
// brushes to small, and at each size only paint where the canvas is still
// wrong. That is also how anyone is taught to paint -- block it in, then work
// down into it -- so it suits the tools rather than fighting them.

/** Gaussian-ish blur of an RGB float image, separable, in place-ish. */
function blur(src, w, h, radius) {
  if (radius < 1) return src.slice();
  const r = Math.round(radius);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = sum * norm;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        sum += src[(y * w + add) * 3 + c] - src[(y * w + sub) * 3 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = sum * norm;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        sum += tmp[(add * w + x) * 3 + c] - tmp[(sub * w + x) * 3 + c];
      }
    }
  }
  return out;
}

const luma = (p, i) => p[i * 3] * 0.2126 + p[i * 3 + 1] * 0.7152 + p[i * 3 + 2] * 0.0722;

/** Which way the picture is NOT changing here -- the direction to draw along. */
function flowAt(img, w, h, x, y) {
  const xi = Math.min(w - 2, Math.max(1, x | 0));
  const yi = Math.min(h - 2, Math.max(1, y | 0));
  const i = yi * w + xi;
  const gx =
    luma(img, i - w + 1) + 2 * luma(img, i + 1) + luma(img, i + w + 1) -
    luma(img, i - w - 1) - 2 * luma(img, i - 1) - luma(img, i + w - 1);
  const gy =
    luma(img, i + w - 1) + 2 * luma(img, i + w) + luma(img, i + w + 1) -
    luma(img, i - w - 1) - 2 * luma(img, i - w) - luma(img, i - w + 1);
  const mag = Math.hypot(gx, gy);
  // Along the edge, not across it: that is how a brush follows a form.
  if (mag < 1e-4) return null;
  return { x: -gy / mag, y: gx / mag, mag };
}

/**
 * The passes. Big flat brushes block the picture in; smaller ones go back over
 * whatever is still wrong; the last pass is short dabs for the detail that is
 * too small to draw through.
 */
const PASSES = [
  { tool: 'brush-2inch', inches: 2.0, grid: 96, blur: 34, error: 0.055, len: 7, pressure: 0.62 },
  { tool: 'brush-2inch', inches: 1.2, grid: 52, blur: 18, error: 0.070, len: 7, pressure: 0.58 },
  { tool: 'brush-1inch', inches: 0.7, grid: 30, blur: 9, error: 0.085, len: 6, pressure: 0.55 },
  { tool: 'brush-filbert', inches: 0.34, grid: 16, blur: 4, error: 0.105, len: 5, pressure: 0.5 },
  { tool: 'brush-round', inches: 0.16, grid: 9, blur: 2, error: 0.135, len: 1, pressure: 0.5 },
];

/**
 * @param s       window.studio.script
 * @param target  {data: Float32Array rgb 0..1, width, height} at canvas size
 * @param opts    {onProgress(done, total, label), shouldStop(), baseCoat}
 */
export async function paintFromPicture(s, target, opts = {}) {
  const { width: w, height: h } = target;
  const onProgress = opts.onProgress || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const breathe = () => new Promise((r) => requestAnimationFrame(r));

  s.design(w);
  if (opts.baseCoat !== false) s.baseCoat('liquid-white');
  await breathe();

  for (const [pi, pass] of PASSES.entries()) {
    if (shouldStop()) return;
    onProgress(pi, PASSES.length, `${pass.tool} at ${pass.inches}"`);

    const want = blur(target.data, w, h, pass.blur);

    // What is on the canvas now, so this pass only touches what is wrong.
    const shot = s.pixels();
    const have = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      have[i * 3] = shot.data[i * 4] / 255;
      have[i * 3 + 1] = shot.data[i * 4 + 1] / 255;
      have[i * 3 + 2] = shot.data[i * 4 + 2] / 255;
    }

    s.tool(pass.tool, pass.inches).set({ pressure: pass.pressure });

    // Visit the grid in a shuffled order. Painting it row by row lays a
    // corduroy of same-length strokes marching across the picture.
    const cells = [];
    for (let gy = pass.grid * 0.5; gy < h; gy += pass.grid) {
      for (let gx = pass.grid * 0.5; gx < w; gx += pass.grid) cells.push([gx, gy]);
    }
    for (let i = cells.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }

    let laid = 0;
    for (const [cx0, cy0] of cells) {
      if (shouldStop()) return;
      const cx = cx0 + (Math.random() - 0.5) * pass.grid * 0.7;
      const cy = cy0 + (Math.random() - 0.5) * pass.grid * 0.7;
      const xi = Math.min(w - 1, Math.max(0, cx | 0));
      const yi = Math.min(h - 1, Math.max(0, cy | 0));
      const i = yi * w + xi;

      const err =
        Math.abs(have[i * 3] - want[i * 3]) +
        Math.abs(have[i * 3 + 1] - want[i * 3 + 1]) +
        Math.abs(have[i * 3 + 2] - want[i * 3 + 2]);
      if (err < pass.error * 3) continue;

      // Dip the brush in what this part of the picture is.
      const colour = [want[i * 3], want[i * 3 + 1], want[i * 3 + 2]];
      s.colour(colour);

      if (pass.len <= 1) {
        s.tap([cx, cy]);
        laid++;
        continue;
      }

      // Draw along the form, re-checking as it goes: a stroke stops where the
      // picture stops being the colour the brush is carrying.
      const step = pass.grid * 0.75;
      const pts = [[cx, cy]];
      let px = cx;
      let py = cy;
      let dir = flowAt(want, w, h, px, py) || { x: 1, y: 0 };
      for (let k = 0; k < pass.len; k++) {
        const nd = flowAt(want, w, h, px, py);
        if (nd) {
          // Turn smoothly; a brush does not pivot.
          const dot = nd.x * dir.x + nd.y * dir.y;
          const f = dot < 0 ? -1 : 1;
          dir = { x: dir.x * 0.45 + nd.x * f * 0.55, y: dir.y * 0.45 + nd.y * f * 0.55 };
          const m = Math.hypot(dir.x, dir.y) || 1;
          dir = { x: dir.x / m, y: dir.y / m };
        }
        px += dir.x * step;
        py += dir.y * step;
        if (px < -pass.grid || py < -pass.grid || px > w + pass.grid || py > h + pass.grid) break;
        const j = Math.min(h - 1, Math.max(0, py | 0)) * w + Math.min(w - 1, Math.max(0, px | 0));
        const d =
          Math.abs(want[j * 3] - colour[0]) +
          Math.abs(want[j * 3 + 1] - colour[1]) +
          Math.abs(want[j * 3 + 2] - colour[2]);
        if (d > 0.22) break;
        pts.push([px, py]);
      }
      if (pts.length < 2) pts.push([cx + 0.01, cy]);
      s.stroke(pts, { step: Math.max(4, pass.grid * 0.35) });
      laid++;

      // Let the screen catch up now and then, so it can be watched.
      if (laid % 24 === 0) await breathe();
    }
    await breathe();
  }
  onProgress(PASSES.length, PASSES.length, 'done');
}
