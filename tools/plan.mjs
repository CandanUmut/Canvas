// What would the picture-to-painting mode paint, and how?
//
//   node tools/plan.mjs docs/example.jpg [out.png]
//
// Plans a painting from a picture -- the mixes, the order, the brush that
// fits each shape, every stroke -- and reports it, in about a second. With an
// output path it also draws the plan: each stroke at its brush's width in its
// mix's colour, over the picture it came from. That is not what the paint
// will look like -- the simulation blends and carries wet paint, which is the
// point -- but it shows the STRUCTURE of the painting: whether the shapes
// survive, whether the strokes follow them, whether anything is left bare.
// Judging that took a half-hour browser run before this existed.
import { readFileSync, writeFileSync } from 'node:fs';
import { planPainting } from '../src/ui/autoplan.js';

// The other tools hardcode an absolute path to Playwright. Try the ordinary
// specifier first so this also runs where it was installed the normal way.
const { chromium } = await import('playwright')
  .catch(() => import('/opt/node22/lib/node_modules/playwright/index.js'))
  .then((m) => m.default ?? m);

const src = process.argv[2] || 'docs/example.jpg';
const out = process.argv[3];
const W = 720;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const b64 = readFileSync(src).toString('base64');
const type = src.endsWith('.png') ? 'image/png' : 'image/jpeg';
const img = await page.evaluate(async ([d, type, W]) => {
  const im = new Image();
  im.src = `data:${type};base64,${d}`;
  await im.decode();
  const H = Math.round((im.height * W) / im.width);
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d').drawImage(im, 0, 0, W, H);
  return { w: W, h: H, data: Array.from(c.getContext('2d').getImageData(0, 0, W, H).data) };
}, [b64, type, W]);

const data = new Float32Array(img.w * img.h * 3);
for (let i = 0; i < img.w * img.h; i++) {
  data[i * 3] = img.data[i * 4] / 255;
  data[i * 3 + 1] = img.data[i * 4 + 1] / 255;
  data[i * 3 + 2] = img.data[i * 4 + 2] / 255;
}

const t0 = Date.now();
const plan = planPainting({ data, width: img.w, height: img.h }, { inchesWide: 24 });
console.log(`${src}: planned in ${Date.now() - t0} ms, ${plan.loads.length} dips`);
const by = {};
for (const l of plan.loads) {
  by[l.stage] ??= { loads: 0, strokes: 0, tools: new Set() };
  by[l.stage].loads++;
  by[l.stage].strokes += l.strokes.length;
  by[l.stage].tools.add(l.tool.replace('brush-', ''));
}
for (const [k, v] of Object.entries(by)) {
  console.log(`  ${k.padEnd(11)} ${String(v.loads).padStart(4)} dips  ${String(v.strokes).padStart(5)} strokes   ${[...v.tools].join(', ')}`);
}
const lens = plan.loads.filter((l) => !l.taps).flatMap((l) => l.strokes.map((s) => s.length)).sort((a, b) => a - b);
console.log(`  stroke length in points: median ${lens[lens.length >> 1]}, 90th percentile ${lens[Math.floor(lens.length * 0.9)]}`);

if (out) {
  const url = await page.evaluate(async ([plan, pix, w, h]) => {
    const c = document.createElement('canvas');
    c.width = w * 2 + 8;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#1e1e1e';
    g.fillRect(0, 0, c.width, c.height);
    const id = new ImageData(new Uint8ClampedArray(pix), w, h);
    g.putImageData(id, 0, 0);
    g.fillStyle = '#f7f5f0';
    g.fillRect(w + 8, 0, w, h);
    const ppi = w / 24;
    for (const L of plan.loads) {
      const [r, gg, b] = L.rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
      g.strokeStyle = g.fillStyle = `rgb(${r},${gg},${b})`;
      g.lineCap = g.lineJoin = 'round';
      g.lineWidth = Math.max(1, L.inches * ppi * 0.85);
      for (const s of L.strokes) {
        if (L.taps || s.length === 1) {
          g.beginPath();
          g.ellipse(w + 8 + s[0][0], s[0][1], g.lineWidth * 0.5, g.lineWidth * 0.35, 0, 0, Math.PI * 2);
          g.fill();
        } else {
          g.beginPath();
          g.moveTo(w + 8 + s[0][0], s[0][1]);
          for (const [x, y] of s.slice(1)) g.lineTo(w + 8 + x, y);
          g.stroke();
        }
      }
    }
    return c.toDataURL('image/png');
  }, [plan, img.data, img.w, img.h]);
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`  drew the plan beside the picture -> ${out}`);
}
await browser.close();
