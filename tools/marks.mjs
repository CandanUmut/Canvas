// How alike is one touch of a tool to the next?
//
// Sets the same tool down a dozen times on clean canvas, reads back each mark,
// and reports how well they correlate with one another. A real brush rearranges
// its bristles every time it is pressed; if every mark is the same picture, a
// tree built out of them comes out as wallpaper.
import pkg from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pkg;
const origin = process.argv[2] || 'http://127.0.0.1:8123';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', e => console.log('[err]', e.message));
await page.goto(origin + '/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.studio && window.studio.canvas);
const out = await page.evaluate(() => {
  const s = window.studio.script, eng = window.studio.engine;
  const res = [];
  s.canvas(720, 540, 12).design(720);   // 60 px/in
  for (const [tool, inches, how] of [
    ['brush-fan', 1.2, 'tap'], ['brush-round', 0.8, 'tap'],
    ['knife-10', 2.0, 'pull'], ['brush-2inch', 1.5, 'pull'],
  ]) {
    const marks = [];
    for (let i = 0; i < 10; i++) {
      eng.clear(window.studio.canvas);
      s.baseCoat('liquid-white');
      s.tool(tool, inches).set({ pressure: 0.7 });
      s.paint('midnight-black');
      if (how === 'tap') s.tap([360, 270]);
      else s.stroke([[300, 200], [420, 340]], { step: 8 });
      // Read the mark as a small grid of volumes.
      const g = [];
      for (let y = 190; y < 350; y += 5) for (let x = 280; x < 440; x += 5) g.push(s.at(x, y).volume);
      marks.push(g);
    }
    // Mean pairwise Pearson correlation between marks.
    const corr = (a, b) => {
      const n = a.length;
      const ma = a.reduce((p, q) => p + q, 0) / n, mb = b.reduce((p, q) => p + q, 0) / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { const u = a[i] - ma, v = b[i] - mb; num += u * v; da += u * u; db += v * v; }
      return num / Math.sqrt(Math.max(da * db, 1e-9));
    };
    let sum = 0, cnt = 0;
    for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) { sum += corr(marks[i], marks[j]); cnt++; }
    res.push({ tool, how, sameness: +(sum / cnt).toFixed(3) });
  }
  return res;
});
console.log('how alike is one touch to the next (1.000 = the identical stamp every time)');
for (const r of out) console.log(`   ${r.tool.padEnd(13)} ${r.how.padEnd(5)} sameness ${r.sameness}`);
await browser.close();
