// A sheet of single marks: each tool set down six times, big, on a light
// ground. What a tool's contact with the canvas actually looks like.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
import { writeFileSync } from 'node:fs';
const { chromium } = pkg;
const origin = process.argv[2] || 'http://127.0.0.1:8123';
const out = process.argv[3] || '/tmp/marksheet.png';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('pageerror', e => console.log('[err]', e.message));
await page.goto(origin + '/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.studio && window.studio.canvas);
const data = await page.evaluate(async () => {
  const s = window.studio.script, eng = window.studio.engine;
  s.canvas(1200, 800, 10).design(1200);       // 120 px/in -- big marks
  eng.clear(window.studio.canvas);
  s.baseCoat('liquid-white');
  const rows = [
    ['brush-fan',   0.9,  'tap'],
    ['brush-round', 0.7,  'tap'],
    ['knife-10',    1.6,  'pull'],
    ['brush-2inch', 1.0,  'pull'],
  ];
  for (let r = 0; r < rows.length; r++) {
    const [tool, inches, how] = rows[r];
    s.tool(tool, inches).set({ pressure: 0.7 });
    s.paint('midnight-black');
    const y = 110 + r * 190;
    for (let i = 0; i < 6; i++) {
      const x = 110 + i * 190;
      if (how === 'tap') s.tap([x, y]);
      else s.stroke([[x - 60, y - 55], [x + 60, y + 55]], { step: 7 });
    }
  }
  const img = eng.exportImage(window.studio.canvas);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c.toDataURL('image/png');
});
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log('wrote', out);
await browser.close();
