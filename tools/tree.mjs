// One evergreen and one patch of foliage, big, so the marks can be seen.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
import { writeFileSync } from 'node:fs';
const { chromium } = pkg;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('pageerror', e => console.log('[err]', e.message));
await page.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.studio && window.studio.canvas);
const data = await page.evaluate(async () => {
  const s = window.studio.script, eng = window.studio.engine;
  s.canvas(1000, 800, 10).design(1000);      // 100 px/in
  eng.clear(window.studio.canvas); eng.clear(window.studio.palette);
  s.baseCoat('liquid-white');
  let seed = 5; const rnd = () => ((seed = (seed*1664525+1013904223)>>>0)/4294967296);
  const jit = a => (rnd()-0.5)*2*a;

  // a sky behind, so the tree has something to be dark against
  s.tool('brush-2inch', 2.0); s.mix([['titanium-white',16],['phthalo-blue',2],['midnight-black',1]]);
  s.set({ pressure: 0.55 });
  for (let y=-20;y<820;y+=24) s.stroke([[-60,y],[1060,y+jit(6)]],{step:40});

  const dark = s.mix([['sap-green',3],['phthalo-blue',2],['midnight-black',3],['van-dyke-brown',1]], {tool:'brush-2inch'});
  console.log('[t] dark', dark.hex);

  // ONE tree. Bob builds a fir as a MASS: taps close enough together that they
  // merge into solid dark, then catches the near edge of each bough with a
  // lighter green. A lattice of separate marks with sky between them is not a
  // tree, however good each mark is.
  const x = 300, top = 90, base = 700, width = 300;
  s.tool('brush-liner', 0.07); s.set({ thinner: 0.6 });
  s.stroke([[x, top+6],[x+jit(4), base]], { step: 4 });
  s.set({ thinner: 0 });
  s.tool('brush-fan', 0.44); s.set({ pressure: 0.62 });
  const rows = 34;
  for (let pass=0; pass<3; pass++) {
    for (let i=0;i<rows;i++) {
      const t = i/(rows-1);
      const y = top + (base-top)*t + jit(7);
      const half = 6 + width*Math.pow(t,1.45)*0.5;
      const n = Math.max(1, Math.round(half/16));
      s.set({ angle: jit(12) }); s.tap([x+jit(5), y]);
      for (let j=1;j<=n;j++) {
        const off = half*j/n * (0.82 + rnd()*0.3);
        const droop = off*0.32;
        s.set({ angle: -22 + jit(16) }); s.tap([x-off+jit(7), y+droop+jit(7)]);
        s.set({ angle:  22 + jit(16) }); s.tap([x+off+jit(7), y+droop+jit(7)]);
      }
    }
  }
  // Light on the near edge of the boughs -- the underside of a fir is black,
  // the top of each bough catches the sky.
  s.mix([['sap-green',3],['cadmium-yellow',3],['titanium-white',1]], {tool:'brush-2inch'});
  s.tool('brush-fan', 0.32); s.set({ pressure: 0.4 });
  for (let i=0;i<70;i++) {
    const t = 0.15 + rnd()*0.85;
    const y = top + (base-top)*t;
    const half = 6 + width*Math.pow(t,1.45)*0.5;
    const side = rnd()<0.5 ? -1 : 1;
    const off = half*(0.45+rnd()*0.55);
    s.set({ angle: side*24 + jit(14) });
    s.tap([x + side*off + jit(6), y + off*0.30 - 6 + jit(5)]);
  }
  s.set({ angle: 0 });

  // a patch of autumn foliage next to it
  for (const [parts,n] of [
    [[['sap-green',2],['midnight-black',3],['yellow-ochre',2]], 260],
    [[['yellow-ochre',3],['titanium-white',6],['van-dyke-brown',1]], 220],
    [[['cadmium-yellow',2],['titanium-white',6],['yellow-ochre',2]], 160],
  ]) {
    s.mix(parts, { tool: 'brush-2inch' });
    s.tool('brush-round', 0.2); s.set({ pressure: 0.6 });
    for (let i=0;i<n;i++) s.tap([620+rnd()*330, 380+rnd()*330]);
  }

  const img = eng.exportImage(window.studio.canvas);
  const c = document.createElement('canvas'); c.width=img.width; c.height=img.height;
  c.getContext('2d').putImageData(img,0,0); return c.toDataURL('image/png');
});
writeFileSync('/tmp/claude-0/-home-user-Canvas/adf7b2d1-a8d1-524c-9d2f-fec1a8fea891/scratchpad/work/tree.png', Buffer.from(data.split(',')[1],'base64'));
console.log('wrote tree.png');
await browser.close();
