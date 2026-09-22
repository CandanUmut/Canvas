// Does a stroke stay on the thing it started on, and is it still long enough
// to read as brushwork?
//
// The auto-painter's stroke-extension logic is pure arithmetic over the target
// picture, so it can be run here, offline, in about three seconds -- instead of
// painting a whole picture in a browser for half an hour and squinting at the
// result. That is the difference between trying one idea and trying twelve.
//
// Ground truth for "one thing" is deliberately neither of the stopping rules
// the auto-painter uses: the picture is quantised onto a coarse colour lattice
// first, and a stroke counts as straying if its points fall in more than one
// region. Otherwise each rule would be marking its own homework.
//
//   node tools/strokes.mjs docs/example.jpg
//
// Report the figures PER PASS. Measured across all passes the whole effect
// vanishes into nothing, because the final detail pass is grid 9 and len 1 and
// contributes several thousand two-point dabs by design, which swamp the few
// dozen strokes of the blocking-in pass where any of this matters.
import { readFileSync } from 'node:fs';
import { PASSES } from '../src/ui/autopaint.js';

// The other tools in here hardcode an absolute path to Playwright. Try the
// ordinary specifier first so this also runs on a machine that has it
// installed the normal way, and only fall back to that path.
const { chromium } = await import('playwright')
  .catch(() => import('/opt/node22/lib/node_modules/playwright/index.js'))
  .then(m => m.default ?? m);

const src = process.argv[2] || 'docs/example.jpg';
const LAT = Number(process.argv[3] || 3);

// Only for decoding the image; no simulation runs here.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const img = await page.evaluate(async ([d, type]) => {
  const im = new Image();
  im.src = `data:${type};base64,${d}`;
  await im.decode();
  const W = 720;
  const H = Math.round(im.height * W / im.width);
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d').drawImage(im, 0, 0, W, H);
  return { w: W, h: H, data: Array.from(c.getContext('2d').getImageData(0, 0, W, H).data) };
}, [readFileSync(src).toString('base64'), src.endsWith('.png') ? 'image/png' : 'image/jpeg']);
await browser.close();

const { w, h } = img;
const t = new Float32Array(w * h * 3);
for (let i = 0; i < w * h; i++) {
  t[i * 3] = img.data[i * 4] / 255;
  t[i * 3 + 1] = img.data[i * 4 + 1] / 255;
  t[i * 3 + 2] = img.data[i * 4 + 2] / 255;
}

const label = new Int32Array(w * h);
for (let i = 0; i < w * h; i++) {
  const r = Math.round(t[i * 3] * LAT);
  const g = Math.round(t[i * 3 + 1] * LAT);
  const b = Math.round(t[i * 3 + 2] * LAT);
  label[i] = (r * (LAT + 1) + g) * (LAT + 1) + b;
}

const luma = (a, i) => 0.299 * a[i * 3] + 0.587 * a[i * 3 + 1] + 0.114 * a[i * 3 + 2];

function blur(a, r) {
  if (r < 1) return a.slice();
  const out = new Float32Array(a.length);
  const tmp = new Float32Array(a.length);
  const k = Math.max(1, Math.round(r));
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -k; d <= k; d++) { const xx = x + d; if (xx < 0 || xx >= w) continue; s += a[(y * w + xx) * 3 + c]; n++; }
      tmp[(y * w + x) * 3 + c] = s / n;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -k; d <= k; d++) { const yy = y + d; if (yy < 0 || yy >= h) continue; s += tmp[(yy * w + x) * 3 + c]; n++; }
      out[(y * w + x) * 3 + c] = s / n;
    }
  }
  return out;
}

function sobel(a, i) {
  const gx = luma(a, i - w + 1) + 2 * luma(a, i + 1) + luma(a, i + w + 1)
           - luma(a, i - w - 1) - 2 * luma(a, i - 1) - luma(a, i + w - 1);
  const gy = luma(a, i + w - 1) + 2 * luma(a, i + w) + luma(a, i + w + 1)
           - luma(a, i - w - 1) - 2 * luma(a, i - w) - luma(a, i - w + 1);
  return [gx, gy];
}

function flowAt(a, x, y) {
  const xi = Math.min(w - 2, Math.max(1, x | 0));
  const yi = Math.min(h - 2, Math.max(1, y | 0));
  const [gx, gy] = sobel(a, yi * w + xi);
  const m = Math.hypot(gx, gy);
  return m < 1e-4 ? null : { x: -gy / m, y: gx / m };
}

function edgeMap(a) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const [gx, gy] = sobel(a, y * w + x);
    e[y * w + x] = Math.hypot(gx, gy);
  }
  const BINS = 512;
  let hi = 1e-6;
  for (let i = 0; i < e.length; i++) if (e[i] > hi) hi = e[i];
  const hist = new Int32Array(BINS);
  for (let i = 0; i < e.length; i++) hist[Math.min(BINS - 1, (e[i] / hi * BINS) | 0)]++;
  let seen = 0, top = hi;
  const want = e.length * 0.995;
  for (let b = 0; b < BINS; b++) { seen += hist[b]; if (seen >= want) { top = ((b + 1) / BINS) * hi; break; } }
  for (let i = 0; i < e.length; i++) e[i] = Math.min(1, e[i] / Math.max(top, 1e-6));
  return e;
}

const edges = edgeMap(t);

// `mode` selects which stopping rules are live, so a change can be measured
// against the alternatives rather than just against itself.
function run(mode) {
  const per = [];
  for (const pass of PASSES) {
    const want = blur(t, pass.blur);
    let n = 0, strayed = 0, pts = 0;
    for (let cy = pass.grid / 2; cy < h; cy += pass.grid)
      for (let cx = pass.grid / 2; cx < w; cx += pass.grid) {
        const i0 = (cy | 0) * w + (cx | 0);
        const colour = [want[i0 * 3], want[i0 * 3 + 1], want[i0 * 3 + 2]];
        const dir = flowAt(want, cx, cy);
        if (!dir) continue;
        const step = pass.grid * 0.5;
        const labs = new Set([label[i0]]);
        let px = cx, py = cy, len = 1;
        for (let k = 0; k < pass.len; k++) {
          px += dir.x * step;
          py += dir.y * step;
          if (px < -pass.grid || py < -pass.grid || px > w + pass.grid || py > h + pass.grid) break;
          const j = Math.min(h - 1, Math.max(0, py | 0)) * w + Math.min(w - 1, Math.max(0, px | 0));
          if (mode.edge && edges[j] > pass.edge) break;
          const d = Math.abs(want[j * 3] - colour[0])
                  + Math.abs(want[j * 3 + 1] - colour[1])
                  + Math.abs(want[j * 3 + 2] - colour[2]);
          if (d > 0.22) break;
          if (mode.sharp) {
            const sh = Math.abs(t[j * 3] - colour[0])
                     + Math.abs(t[j * 3 + 1] - colour[1])
                     + Math.abs(t[j * 3 + 2] - colour[2]);
            if (sh > pass.sharp) break;
          }
          labs.add(label[j]);
          len++;
        }
        n++; pts += len;
        if (labs.size > 1) strayed++;
      }
    per.push({ grid: pass.grid, tool: pass.tool, n, stray: 100 * strayed / Math.max(n, 1), avg: pts / Math.max(n, 1) });
  }
  return per;
}

const MODES = {
  neither: { edge: false, sharp: false },
  edge:    { edge: true,  sharp: false },
  sharp:   { edge: false, sharp: true  },
  both:    { edge: true,  sharp: true  },
};
const R = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, run(v)]));

console.log(`${src}  ${w}x${h}  colour lattice ${LAT}\n`);
console.log('strokes that cross a region boundary, and mean stroke length');
console.log('                          strayed                              length');
console.log('  pass            n   neither  edge  sharp   both     neither  edge  sharp   both');
for (let i = 0; i < PASSES.length; i++) {
  const p = k => R[k][i];
  const note = PASSES[i].len === 1 ? '   (dabs by design)' : '';
  console.log(
    `  ${p('neither').tool.replace('brush-', '').padEnd(8)} ${String(p('neither').grid).padStart(4)} ${String(p('neither').n).padStart(5)}` +
    ['neither', 'edge', 'sharp', 'both'].map(k => `${p(k).stray.toFixed(1).padStart(6)}%`).join('').replace(/%/g, '%') +
    '  ' + ['neither', 'edge', 'sharp', 'both'].map(k => p(k).avg.toFixed(2).padStart(7)).join('') + note);
}
console.log('\nblocking-in passes only (the detail dabs swamp the average otherwise):');
for (const k of Object.keys(MODES)) {
  const p = R[k].filter(x => x.n && PASSES[R[k].indexOf(x)].len > 1);
  const n = p.reduce((s, x) => s + x.n, 0);
  console.log(`  ${k.padEnd(8)} ${String(n).padStart(5)} strokes   strayed ${(p.reduce((s, x) => s + x.stray * x.n, 0) / n).toFixed(1).padStart(5)}%   mean length ${(p.reduce((s, x) => s + x.avg * x.n, 0) / n).toFixed(2)}`);
}
