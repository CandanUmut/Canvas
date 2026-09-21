// What the simulation actually does, as numbers.
//
//   node tools/probe.mjs
//
// Each probe is one thing a wet-on-wet painter relies on, set up from a bare
// canvas and measured off the surface and off the bristles. Run it before and
// after a change to the model and the difference is the answer.

import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pkg;

const origin = process.argv[2] || 'http://127.0.0.1:8123';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.studio && window.studio.canvas);

const results = await page.evaluate(async () => {
  const s = window.studio.script;
  const eng = window.studio.engine;
  const hex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const out = [];
  // Small and square: these probes are about transfer, not composition.
  s.canvas(720, 540, 12).design(720);

  const fresh = () => {
    eng.clear(window.studio.canvas);
    eng.clear(window.studio.palette);
    s.baseCoat('liquid-white');
  };

  // 1. Does a loaded brush take on the colour it is dragged through?
  {
    fresh();
    s.tool('brush-2inch', 2.0).set({ pressure: 0.7 });
    s.paint('phthalo-blue');
    for (let y = 150; y < 320; y += 16) s.stroke([[-60, y], [780, y]], { step: 30 });
    const under = s.at(360, 240);
    s.paint('titanium-white');
    const before = s.brush();
    s.stroke([[-60, 240], [780, 240]], { step: 30 });
    const after = s.brush();
    out.push({
      probe: 'loaded white brush dragged across wet blue',
      wants: 'brush comes back blue-tinged; the band goes pale blue, not white',
      underneath: hex(under.colour),
      brushBefore: hex(before.colour),
      brushAfter: hex(after.colour),
      brushLoadAfter: +after.load.toFixed(3),
      canvasAfter: hex(s.at(360, 240).colour),
      canvasOffStroke: hex(s.at(360, 180).colour),
    });
  }

  // 2. Does a clean brush stay clean for the stroke that follows?
  {
    fresh();
    s.tool('brush-2inch', 2.0).set({ pressure: 0.7 });
    s.paint('bright-red');
    s.stroke([[-60, 150], [780, 150]], { step: 30 });
    s.clean();
    const afterClean = s.brush();
    s.stroke([[-60, 400], [780, 400]], { step: 30 });
    out.push({
      probe: 'clean the brush, then paint',
      wants: 'the next stroke lays nothing; bare canvas stays bare',
      brushAfterClean: hex(afterClean.colour),
      loadAfterClean: +afterClean.load.toFixed(3),
      brushAfterStroke: hex(s.brush().colour),
      canvasWhereCleanBrushWent: hex(s.at(360, 400).colour),
      volumeThere: +s.at(360, 400).volume.toFixed(3),
    });
  }

  // 3. Can a clean brush soften a hard edge between two wet colours?
  {
    fresh();
    s.tool('brush-2inch', 2.0).set({ pressure: 0.7 });
    s.paint('prussian-blue');
    for (let y = 120; y < 265; y += 16) s.stroke([[-60, y], [780, y]], { step: 30 });
    s.paint('titanium-white');
    for (let y = 275; y < 420; y += 16) s.stroke([[-60, y], [780, y]], { step: 30 });
    const edgeBefore = [250, 262, 270, 278, 290].map((y) => hex(s.at(360, y).colour));
    // Criss-cross with a clean brush, the way a sky is blended.
    s.clean();
    for (let i = 0; i < 10; i++) {
      const y = 200 + i * 14;
      s.stroke([[-60, y + 60], [780, y - 60]], { step: 24 });
      s.stroke([[-60, y - 60], [780, y + 60]], { step: 24 });
    }
    const edgeAfter = [250, 262, 270, 278, 290].map((y) => hex(s.at(360, y).colour));
    out.push({
      probe: 'soften a hard edge between wet blue and wet white',
      wants: 'the five samples across the join run as a gradient, not two blocks',
      before: edgeBefore,
      after: edgeAfter,
    });
  }

  // 4. How many layers does one ordinary pass lay down?
  {
    for (const [toolId, inches] of [['brush-2inch', 2.0], ['brush-1inch', 1.0], ['knife-10', 1.5]]) {
      fresh();
      s.tool(toolId, inches).set({ pressure: 0.7 });
      s.paint('titanium-white');
      const base = s.at(360, 300).volume;
      s.stroke([[-60, 300], [780, 300]], { step: 30 });
      const one = s.at(360, 300).volume;
      s.stroke([[-60, 300], [780, 300]], { step: 30 });
      out.push({
        probe: `one pass of ${toolId}`,
        wants: 'about half a layer, so the wet paint under it still shows through',
        baseCoatVolume: +base.toFixed(3),
        afterOnePass: +one.toFixed(3),
        afterTwoPasses: +s.at(360, 300).volume.toFixed(3),
        laidByOnePass: +(one - base).toFixed(3),
      });
    }
  }

  // 5. Does a dry-brush touch break up over the canvas weave?
  {
    fresh();
    s.tool('brush-2inch', 2.0);
    s.paint('titanium-white');
    for (const p of [0.15, 0.45, 0.9]) {
      s.set({ pressure: p });
      const y = p < 0.2 ? 150 : p < 0.5 ? 270 : 390;
      s.stroke([[-60, y], [780, y]], { step: 30 });
      const vols = [];
      for (let x = 200; x < 520; x += 3) vols.push(s.at(x, y).volume);
      const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
      const sd = Math.sqrt(vols.reduce((a, b) => a + (b - mean) ** 2, 0) / vols.length);
      out.push({
        probe: `pressure ${p} stroke`,
        wants: 'light pressure leaves a broken, patchy mark (high variation)',
        meanVolume: +mean.toFixed(3),
        variation: +(sd / Math.max(mean, 1e-3)).toFixed(3),
      });
    }
  }

  // 6. What does a mixed colour actually come out as?
  {
    fresh();
    const mixes = [
      [[['titanium-white', 10], ['phthalo-blue', 1]], 'sky blue'],
      [[['titanium-white', 6], ['midnight-black', 1], ['phthalo-blue', 1]], 'mountain grey'],
      [[['titanium-white', 8], ['cadmium-yellow', 1]], 'pale warm horizon'],
      [[['sap-green', 3], ['phthalo-blue', 1], ['midnight-black', 1]], 'evergreen dark'],
      [[['cadmium-yellow', 3], ['yellow-ochre', 2], ['titanium-white', 1]], 'autumn yellow'],
    ];
    for (const [parts, name] of mixes) {
      s.tool('brush-2inch', 2.0);
      const got = s.mix(parts);
      out.push({
        probe: `mix: ${name}`,
        parts: parts.map(([id, n]) => `${n}x ${id}`).join(' + '),
        got: got.hex,
        load: +got.load.toFixed(3),
      });
    }
  }

  return out;
});

for (const r of results) {
  console.log('\n' + r.probe);
  for (const [k, v] of Object.entries(r)) {
    if (k === 'probe') continue;
    console.log(`   ${k.padEnd(26)} ${Array.isArray(v) ? v.join('  ') : v}`);
  }
}
await browser.close();
