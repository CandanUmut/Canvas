// Replays a written-down painting in a real browser and saves what came out.
//
//   node tools/paint.mjs paintings/mountain-lake.js out/attempt-01
//
// The painting file is ordinary browser code with `s` bound to
// `window.studio.script` and `stage(name)` available to save a snapshot of
// the canvas as it stands. Nothing about it is special to the harness: the
// same lines typed into the console paint the same picture.

import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const { chromium } = pkg;

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('='))
);
const [scriptPath, outDir = 'out/run'] = args.filter((a) => !a.startsWith('--'));
const origin = flags.origin || 'http://127.0.0.1:8123';
// Software GL takes minutes over a full-size canvas, so a run can be tried
// small and then painted at size. The script is written in design
// coordinates, so the picture is the same either way.
const SIZES = {
  full: [1440, 1080, 24],
  half: [720, 540, 24],
  small: [1024, 768, 12],
};
const size = SIZES[flags.size || 'full'];
if (!scriptPath || !size) {
  console.error('usage: node tools/paint.mjs <painting.js> [outDir] [--size=full|half|small] [--origin=...]');
  process.exit(1);
}

const source = readFileSync(scriptPath, 'utf8');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || t.startsWith('[paint]')) console.log(t);
});

await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.studio && window.studio.canvas, null, { timeout: 30000 });
// Start from a bare canvas every run, so a replay does not paint on top of
// whatever the last one left in IndexedDB.
await page.evaluate(([w, h, inches]) => {
  window.studio.forget();
  window.studio.script.canvas(w, h, inches);
  window.studio.engine.clear(window.studio.palette);
}, size);
console.log(`canvas ${size[0]}x${size[1]} (${size[2]} in wide)`);

const t0 = Date.now();
let stageNo = 0;
let lastAt = t0;

// Each stage is written the moment it is painted, so a long run can be
// watched instead of waited out, and a run that dies still leaves its work.
await page.exposeBinding('__stage', async (_src, name, dataUrl) => {
  const n = String(stageNo++).padStart(2, '0');
  const file = resolve(outDir, `${n}-${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const now = Date.now();
  console.log(`${file}  (+${((now - lastAt) / 1000).toFixed(1)}s)`);
  lastAt = now;
});

await page.evaluate(
  async ({ src }) => {
    const s = window.studio.script;
    const grab = () => {
      const img = window.studio.engine.exportImage(window.studio.canvas);
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };
    const stage = (name) => window.__stage(name, grab());
    const log = (...a) => console.log('[paint]', ...a);
    // eslint-disable-next-line no-new-func
    const run = new Function('s', 'stage', 'log', `return (async () => {${src}\n})();`);
    await run(s, stage, log);
    await stage('final');
  },
  { src: source }
);

console.log(`painted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
