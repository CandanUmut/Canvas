// The pieces a landscape is actually made of, each painted on its own, so a
// change to a tool can be judged in a minute instead of an hour. Six panels,
// left to right, top to bottom.
const W = 1440;
const H = 1080;
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const jit = (a) => (rnd() - 0.5) * 2 * a;

s.design(W);
s.baseCoat('liquid-white');

// Panel 1 (0-480, 0-540): a big evergreen, fan brush, tapped downward.
{
  const mix = s.mix([['sap-green', 3], ['phthalo-blue', 1], ['midnight-black', 1]], { tool: 'brush-fan' });
  log('evergreen mix', mix.hex);
  s.tool('brush-fan', 0.9).set({ pressure: 0.6 });
  const x = 240;
  const top = 80;
  const base = 500;
  s.tool('brush-liner', 0.1);
  s.stroke([[x, top], [x, base]], { step: 4 });
  s.tool('brush-fan', 0.9);
  const rows = 18;
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = top + (base - top) * t;
    const half = 12 + 150 * Math.pow(t, 1.3);
    const n = Math.max(1, Math.round(half / 16));
    for (let j = 0; j <= n; j++) {
      const off = (half * j) / n;
      for (const sx of [-1, 1]) {
        if (j === 0 && sx < 0) continue;
        s.stroke([[x + sx * off, y - 6], [x + sx * off * 1.12, y + 10 + off * 0.22]], { step: 4 });
      }
    }
  }
}
await stage('evergreen');

// Panel 2 (480-960, 0-540): autumn bushes, round brush, tapped.
{
  s.tool('brush-round', 0.5).set({ pressure: 0.6 });
  for (const [id, n] of [['sap-green', 90], ['yellow-ochre', 70], ['cadmium-yellow', 60], ['bright-red', 25]]) {
    s.paint(id);
    for (let i = 0; i < n; i++) {
      s.tap([560 + rnd() * 340, 300 + rnd() * 200]);
    }
  }
}
await stage('bushes');

// Panel 3 (960-1440, 0-540): a knife mountain against a laid sky.
{
  s.tool('brush-2inch', 1.2);
  const sky = s.mix([['titanium-white', 9], ['phthalo-blue', 1]]);
  log('sky mix', sky.hex);
  s.set({ pressure: 0.6 });
  for (let y = 20; y < 420; y += 20) s.stroke([[950, y], [1450, y + jit(6)]], { step: 26 });
  const grey = s.mix([['titanium-white', 5], ['midnight-black', 1], ['phthalo-blue', 1]], { tool: 'knife-10' });
  log('mountain grey', grey.hex);
  s.tool('knife-10', 1.6).set({ pressure: 0.8 });
  const ridge = [[980, 380], [1090, 250], [1150, 150], [1230, 250], [1310, 200], [1440, 330]];
  s.stroke(ridge, { step: 6 });
  for (let i = 0; i < ridge.length - 1; i++) {
    for (let t = 0; t <= 1; t += 0.2) {
      const x = ridge[i][0] + (ridge[i + 1][0] - ridge[i][0]) * t;
      const y = ridge[i][1] + (ridge[i + 1][1] - ridge[i][1]) * t;
      s.stroke([[x, y], [x + jit(20), y + 90 + rnd() * 80]], { step: 6 });
    }
  }
  s.paint('titanium-white');
  s.tool('knife-10', 1.2).set({ pressure: 0.5 });
  for (const [x, y, dx, dy] of [[1150, 155, -70, 130], [1150, 155, -30, 160], [1090, 255, -70, 110], [1310, 205, 70, 110]]) {
    s.stroke([[x, y], [x + dx, y + dy]], { step: 6 });
  }
}
await stage('knife-mountain');

// Panel 4 (0-480, 540-1080): blending a sky -- two colours, criss-crossed.
{
  s.tool('brush-2inch', 1.6);
  s.paint('phthalo-blue');
  s.set({ pressure: 0.6 });
  for (let y = 570; y < 700; y += 18) s.stroke([[-40, y], [500, y]], { step: 26 });
  s.paint('cadmium-yellow');
  for (let y = 760; y < 900; y += 18) s.stroke([[-40, y], [500, y]], { step: 26 });
  s.clean();
  s.set({ pressure: 0.4 });
  for (let i = 0; i < 14; i++) {
    const y = 600 + i * 22;
    s.stroke([[-40, y + 70], [500, y - 70]], { step: 20 });
    s.stroke([[-40, y - 70], [500, y + 70]], { step: 20 });
  }
}
await stage('sky-blend');

// Panel 5 (480-960, 540-1080): still water with reflections.
{
  s.tool('brush-2inch', 1.4);
  const water = s.mix([['titanium-white', 5], ['phthalo-blue', 1], ['sap-green', 1]]);
  log('water mix', water.hex);
  s.set({ pressure: 0.5 });
  for (let y = 600; y < 1060; y += 18) s.stroke([[490, y], [950, y + jit(4)]], { step: 26 });
  // Pull the bank colours straight down, then cut across to still them.
  s.tool('brush-1inch', 0.7).set({ pressure: 0.45 });
  for (const [id, xs] of [['sap-green', [540, 620, 700]], ['cadmium-yellow', [580, 760, 860]], ['van-dyke-brown', [820, 900]]]) {
    s.paint(id);
    for (const x of xs) s.stroke([[x, 620], [x + jit(8), 800 + rnd() * 160]], { step: 6 });
  }
  s.clean();
  s.tool('brush-2inch', 1.4).set({ pressure: 0.3 });
  for (let y = 630; y < 1060; y += 14) s.stroke([[490, y], [950, y]], { step: 26 });
}
await stage('water');

// Panel 6 (960-1440, 540-1080): a dry-brush value scale and a liner test.
{
  s.tool('brush-2inch', 1.2);
  s.paint('titanium-white');
  for (let i = 0; i < 6; i++) {
    s.set({ pressure: 0.12 + i * 0.17 });
    s.stroke([[970, 600 + i * 40], [1430, 600 + i * 40]], { step: 26 });
  }
  s.tool('brush-liner', 0.12);
  s.paint('van-dyke-brown');
  s.set({ thinner: 0.7, pressure: 0.5 });
  for (let i = 0; i < 8; i++) {
    const x = 1000 + i * 55;
    s.stroke([[x, 1050], [x + jit(30), 950], [x + jit(50), 870]], { step: 4 });
  }
  s.set({ thinner: 0 });
}
