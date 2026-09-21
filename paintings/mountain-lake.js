// "Mountain Lake" -- after the Bob Ross painting: a snow peak over still
// water, autumn bushes down both banks, big evergreens framing the edges.
//
// Written in design coordinates against a 24 x 18 in canvas (1440 x 1080),
// origin top left, and painted back to front the way it is actually done.
// Every colour is mixed on the board first; nothing is used at tube strength,
// because almost nothing in a landscape is.

const W = 1440;
const H = 1080;
s.design(W);

// Deterministic, so two runs of this script give the same painting and any
// difference between them is a change in the simulation, not in the dice.
let seed = 20240921;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const jit = (a) => (rnd() - 0.5) * 2 * a;
const lerp = (a, b, t) => a + (b - a) * t;

// --------------------------------------------------------------- 1. canvas
s.baseCoat('liquid-white');
await stage('base');

// ------------------------------------------------------------------ 2. sky
// Blue across the top, warm cream low down behind the mountain, and the join
// worked together with a clean brush so no band shows a seam.
s.tool('brush-2inch', 2.0);

const skyTop = s.mix([['titanium-white', 7], ['phthalo-blue', 2], ['midnight-black', 1]]);
log('sky top   ', skyTop.hex);
s.set({ pressure: 0.6 });
for (let y = -20; y < 210; y += 24) s.stroke([[-60, y + jit(8)], [W + 60, y + jit(8)]], { step: 40 });

const skyMid = s.mix([['titanium-white', 12], ['phthalo-blue', 1]]);
log('sky mid   ', skyMid.hex);
for (let y = 170; y < 340; y += 24) s.stroke([[-60, y + jit(8)], [W + 60, y + jit(8)]], { step: 40 });

const skyWarm = s.mix([['titanium-white', 22], ['yellow-ochre', 2], ['bright-red', 1]]);
log('sky warm  ', skyWarm.hex);
s.set({ pressure: 0.5 });
for (let y = 320; y < 560; y += 24) s.stroke([[-60, y + jit(10)], [W + 60, y + jit(10)]], { step: 40 });

const skyPink = s.mix([['titanium-white', 26], ['bright-red', 1], ['yellow-ochre', 1]]);
log('sky pink  ', skyPink.hex);
for (let y = 420; y < 620; y += 26) s.stroke([[-60, y + jit(10)], [W + 60, y + jit(10)]], { step: 40 });

// Criss-cross with a clean brush. Blending along the bands only moves paint
// down the band; it is the diagonal that carries one into the next.
s.clean();
s.set({ pressure: 0.35 });
for (let i = 0; i < 22; i++) {
  const y = lerp(40, 600, i / 21);
  s.stroke([[-60, y + 80], [W + 60, y - 80]], { step: 34 });
  s.stroke([[-60, y - 80], [W + 60, y + 80]], { step: 34 });
}
await stage('sky');

// --------------------------------------------------------------- 3. clouds
// A bank of cumulus across the top right: lit on top, grey underneath, and
// the bottom edge pulled out into the sky so nothing has a cut edge.
const cloudLit = s.mix([['titanium-white', 30], ['yellow-ochre', 1]]);
log('cloud lit ', cloudLit.hex);
s.tool('brush-2inch', 1.1).set({ pressure: 0.62 });
const puff = (x, y, r, squash) => {
  const ring = [];
  for (let a = 0; a < Math.PI * 3.2; a += 0.45) {
    const rr = r * (0.72 + rnd() * 0.5) * (1 - a / 14);
    ring.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * squash]);
  }
  s.stroke(ring, { step: 8 });
};
for (const [x, y, r] of [
  [770, 70, 60], [880, 40, 70], [1000, 80, 62], [1110, 40, 72], [1230, 75, 66],
  [1350, 45, 70], [1430, 95, 60], [1040, 150, 58], [1170, 165, 62], [1300, 140, 58],
  [1410, 170, 54],
]) {
  puff(x, y, r, 0.6);
}
// Light wisps drawn out to the left, flat and thin.
s.set({ pressure: 0.3 });
for (const [x, y, len] of [[70, 55, 340], [150, 120, 300], [330, 30, 320], [430, 95, 260]]) {
  s.stroke([[x, y], [x + len * 0.45, y - 16], [x + len, y + 10]], { step: 14 });
}

// The bellies. Grey, not black -- a cloud's shadow is still full of light.
const cloudGrey = s.mix([['titanium-white', 7], ['midnight-black', 1], ['phthalo-blue', 1]]);
log('cloud grey', cloudGrey.hex);
s.tool('brush-2inch', 1.0).set({ pressure: 0.5 });
for (const [x, y, r] of [
  [900, 175, 54], [1010, 205, 56], [1130, 225, 58], [1250, 205, 56], [1370, 230, 54],
  [1440, 195, 50], [960, 100, 40], [1190, 110, 42],
]) {
  puff(x, y, r, 0.5);
}
// Lay the lit tops back over the grey so the light sits ON the cloud.
s.tool('brush-2inch', 0.8).set({ pressure: 0.55 });
s.paint('titanium-white');
for (const [x, y, r] of [[880, 45, 44], [1110, 42, 46], [1350, 48, 44], [1000, 75, 36], [1240, 72, 38]]) {
  puff(x, y, r, 0.55);
}
// Soften the bottom edge into the sky.
s.clean();
s.tool('util-blender', 1.4).set({ pressure: 0.3 });
for (let i = 0; i < 8; i++) {
  const y = 190 + i * 18;
  s.stroke([[700, y + 30], [W + 40, y - 20]], { step: 26 });
}
await stage('clouds');

// ------------------------------------------------------------- 4. mountain
// The ridge, measured off the reference. Left shoulder, a secondary peak, the
// main peak, then a long right shoulder running down behind the trees.
const ridge = [
  [110, 545], [200, 500], [270, 462], [340, 414], [400, 352], [442, 312], [470, 288],
  [505, 322], [545, 300], [578, 272], [615, 245],
  [648, 292], [678, 330], [706, 348], [742, 332], [790, 366], [842, 386],
  [900, 402], [962, 418], [1030, 444], [1104, 478], [1180, 512], [1262, 550], [1350, 592],
];

const rock = s.mix([['titanium-white', 2], ['midnight-black', 2], ['phthalo-blue', 1]], { tool: 'knife-10' });
log('mtn rock  ', rock.hex);
s.tool('knife-10', 1.5).set({ pressure: 0.85 });

// The blade follows the stroke, so a long pull DOWN FROM THE RIDGE leaves a
// wide mark with the ridge as its top edge. That is the whole trick: the
// mountain is built out of a few long pulls, not a hundred short ones -- short
// overlapping strokes round the silhouette off into a haystack, which is
// exactly what the first attempt came out as.
//
// Each pull runs down the fall line: away from the peak on the side of it the
// face is on, and further on the faces nearest the peak.
const PEAK = 10;   // index of the main peak in `ridge`
for (let i = 0; i < ridge.length; i++) {
  const [x, y] = ridge[i];
  const side = i < PEAK ? -1 : 1;
  // How far round the shoulder this is, 0 at the peak and 1 at the far end.
  const out = Math.abs(i - PEAK) / (side < 0 ? PEAK : ridge.length - 1 - PEAK);
  const reach = 300 * (1 - out * 0.62);
  for (let k = 0; k < 3; k++) {
    const spread = 0.18 + k * 0.16;
    s.stroke(
      [[x + jit(8), y + jit(4)], [x + side * reach * spread + jit(20), y + reach * (0.9 - k * 0.12)]],
      { step: 9 }
    );
  }
}
// Cut the ridge back in over the top of it. It is the one edge in the picture
// that has to stay hard, and pulling the faces down softens it.
s.tool('knife-5', 0.7).set({ pressure: 0.9 });
s.stroke(ridge, { step: 4 });
await stage('mountain-mass');

// Snow on the faces that catch the light -- the left of every spine. Pulled
// DOWN from the ridge, and never quite to the bottom, so rock stays showing.
const snowLit = s.mix([['titanium-white', 26], ['phthalo-blue', 1]], { tool: 'knife-10' });
log('snow lit  ', snowLit.hex);
s.tool('knife-10', 1.2).set({ pressure: 0.6 });
const spines = [
  [615, 250, -150, 210], [615, 250, -95, 250], [615, 250, -40, 270],
  [578, 278, -120, 200], [545, 305, -105, 175],
  [470, 292, -110, 165], [470, 292, -62, 200], [442, 318, -118, 145],
  [400, 358, -110, 130], [340, 420, -95, 110], [270, 468, -80, 95],
  [648, 298, 60, 210], [678, 336, 95, 190], [742, 338, 110, 170],
  [842, 392, 120, 150], [962, 424, 130, 130], [1104, 484, 130, 110], [1262, 556, 110, 80],
];
for (const [x, y, dx, dy] of spines) s.stroke([[x, y], [x + dx, y + dy]], { step: 7 });

// The shoulder of snow the mountain stands on, sweeping left and down.
s.tool('knife-10', 1.7).set({ pressure: 0.62 });
for (let x = 120; x < 860; x += 30) {
  const top = lerp(560, 500, Math.min(1, (x - 120) / 500)) + jit(24);
  s.stroke([[x, top], [x + jit(36), top + 110 + rnd() * 90]], { step: 8 });
}
await stage('mountain-snow');

// Shadow faces: the right of each spine, cooler and darker than the snow but
// nowhere near the rock.
const snowShade = s.mix([['titanium-white', 8], ['phthalo-blue', 1], ['midnight-black', 1]], { tool: 'knife-5' });
log('snow shade', snowShade.hex);
s.tool('knife-5', 0.85).set({ pressure: 0.5 });
for (const [x, y, dx, dy] of [
  [615, 256, 52, 165], [578, 284, 44, 140], [545, 310, 40, 120],
  [470, 298, 48, 145], [442, 324, 40, 118], [400, 364, 44, 100],
  [648, 304, -34, 150], [706, 356, -30, 120], [790, 374, -30, 105], [900, 410, -30, 90],
]) {
  s.stroke([[x, y], [x + dx, y + dy]], { step: 6 });
}
// A few rock breaks in the snow, small and dark, following the fall line.
s.tool('knife-5', 0.34).set({ pressure: 0.55 });
s.mix([['midnight-black', 2], ['van-dyke-brown', 1], ['phthalo-blue', 1]], { tool: 'knife-5' });
for (let i = 0; i < 46; i++) {
  const t = rnd();
  const x = lerp(300, 1060, t) + jit(40);
  const y = lerp(330, 560, t) + rnd() * 130;
  s.stroke([[x, y], [x + jit(18), y + 16 + rnd() * 34]], { step: 5 });
}
await stage('mountain-detail');

// Mist the base so the mountain sits BEHIND the land instead of on top of it.
s.clean();
s.tool('util-blender', 2.2).set({ pressure: 0.32 });
for (let y = 600; y < 720; y += 14) s.stroke([[-60, y], [W + 60, y + jit(8)]], { step: 40 });
await stage('mountain-mist');

// --------------------------------------------------- 5. distant small peaks
s.tool('knife-5', 0.8).set({ pressure: 0.5 });
s.mix([['titanium-white', 10], ['phthalo-blue', 1], ['midnight-black', 1]], { tool: 'knife-5' });
for (const [px, py, half] of [
  [470, 690, 95], [560, 655, 80], [640, 672, 74], [806, 632, 104],
  [888, 668, 84], [1052, 640, 112], [1180, 678, 90],
]) {
  s.stroke([[px - half, py + 76], [px, py], [px + half, py + 80]], { step: 6 });
  for (let t = -0.75; t <= 0.75; t += 0.25) {
    s.stroke([[px + half * t * 0.45, py + Math.abs(t) * 46], [px + half * t * 0.8, py + 86]], { step: 6 });
  }
}
s.paint('titanium-white');
s.tool('knife-5', 0.6).set({ pressure: 0.45 });
for (const [px, py, half] of [[806, 636, 104], [1052, 644, 112], [470, 694, 95]]) {
  s.stroke([[px, py], [px - half * 0.6, py + 70]], { step: 6 });
}
s.clean();
s.tool('util-blender', 1.5).set({ pressure: 0.26 });
for (let y = 700; y < 762; y += 12) s.stroke([[-60, y], [W + 60, y]], { step: 40 });
await stage('far-peaks');

// ---------------------------------------------------- 6. distant tree line
// The dark the whole picture is measured against. Everything above it is
// light; without it the snow has nothing to be bright against.
const treeDark = s.mix([['sap-green', 3], ['phthalo-blue', 2], ['midnight-black', 2], ['van-dyke-brown', 1]], {
  tool: 'brush-fan',
});
log('tree dark ', treeDark.hex);
s.tool('brush-fan', 0.5).set({ pressure: 0.55 });
for (let x = -20; x < W + 20; x += 22) {
  const top = 744 + jit(30);
  for (let y = top; y < 812; y += 20) s.tap([x + jit(10), y]);
}
await stage('treeline');

// ------------------------------------------------- 7. mid-ground evergreens
// A fir is a trunk with boughs hung off it, wider as they go down, and the
// gaps between the boughs are what make it read as a tree.
function evergreen(x, baseY, topY, width, size) {
  s.tool('brush-liner', Math.max(0.06, size * 0.1));
  s.set({ thinner: 0.5 });
  s.stroke([[x, topY], [x + jit(3), baseY]], { step: 4 });
  s.set({ thinner: 0 });
  s.tool('brush-fan', size);
  const rows = Math.max(6, Math.round((baseY - topY) / (size * 26)));
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = topY + (baseY - topY) * t;
    const half = 6 + width * Math.pow(t, 1.35) * 0.5;
    const n = Math.max(1, Math.round(half / (size * 22)));
    for (let j = 0; j <= n; j++) {
      const off = (half * j) / n;
      for (const sx of [-1, 1]) {
        if (j === 0 && sx < 0) continue;
        s.stroke(
          [[x + sx * off, y - size * 8], [x + sx * off * 1.1, y + size * 12 + off * 0.2]],
          { step: 4 }
        );
      }
    }
  }
}
s.set({ pressure: 0.6 });
for (const [x, base, top, w, sz] of [
  [300, 812, 556, 86, 0.5], [352, 820, 640, 56, 0.36], [430, 818, 628, 62, 0.4],
  [472, 816, 668, 46, 0.32], [660, 828, 700, 48, 0.32], [700, 824, 726, 38, 0.28],
  [896, 828, 686, 54, 0.36], [952, 824, 722, 40, 0.28], [1108, 816, 592, 74, 0.46],
]) {
  evergreen(x, base, top, w, sz);
}
await stage('mid-trees');

// --------------------------------------------------- 8. autumn bushes, banks
// Three yellows and a green, tapped, each left partly showing through the
// next. Autumn is not one colour.
s.tool('brush-round', 0.42).set({ pressure: 0.6 });
const bank = (x) => 806 + (x > 400 && x < 1080 ? 34 : 0) + jit(26);
const clumps = [];
for (let x = -20; x < W + 20; x += 30) clumps.push([x, bank(x)]);

for (const [parts, n] of [
  [[['sap-green', 4], ['midnight-black', 1], ['cadmium-yellow', 1]], 5],
  [[['yellow-ochre', 3], ['cadmium-yellow', 2], ['titanium-white', 1]], 5],
  [[['cadmium-yellow', 4], ['titanium-white', 2], ['yellow-ochre', 1]], 4],
]) {
  s.mix(parts, { tool: 'brush-round' });
  for (const [x, y] of clumps) {
    if (rnd() > 0.72) continue;
    for (let i = 0; i < n; i++) s.tap([x + jit(26), y + jit(32)]);
  }
}
// A patch of burnt orange on the right bank, where the reference has one.
s.mix([['bright-red', 3], ['yellow-ochre', 2], ['van-dyke-brown', 1]], { tool: 'brush-round' });
for (let i = 0; i < 30; i++) s.tap([980 + rnd() * 240, 866 + rnd() * 66]);
await stage('bushes');

// ------------------------------------------------------------- 9. the water
// Still water is the sky, upside down and a little darker. Lay it flat, pull
// the bank colours straight down into it, then cut across to still it.
const waterBase = s.mix([['titanium-white', 9], ['sap-green', 1], ['phthalo-blue', 1]], { tool: 'brush-2inch' });
log('water     ', waterBase.hex);
s.tool('brush-2inch', 1.5).set({ pressure: 0.5 });
for (let y = 862; y < H + 20; y += 20) s.stroke([[260, y], [1240, y + jit(5)]], { step: 32 });

s.tool('brush-1inch', 0.6).set({ pressure: 0.42 });
for (const [parts, xs] of [
  [[['sap-green', 3], ['midnight-black', 1]], [430, 520, 600, 690, 780, 860]],
  [[['cadmium-yellow', 3], ['yellow-ochre', 2]], [470, 560, 900, 980, 1060]],
  [[['van-dyke-brown', 2], ['bright-red', 1]], [1020, 1100, 1160]],
]) {
  s.mix(parts, { tool: 'brush-1inch' });
  for (const x of xs) s.stroke([[x, 866], [x + jit(10), 966 + rnd() * 90]], { step: 7 });
}
// Cut across. This is what turns a set of vertical smears into water.
s.clean();
s.tool('brush-2inch', 1.5).set({ pressure: 0.28 });
for (let y = 872; y < H + 20; y += 14) s.stroke([[250, y], [1250, y]], { step: 34 });
// A couple of still, light ripples.
s.paint('titanium-white');
s.tool('brush-1inch', 0.35).set({ pressure: 0.3 });
for (const [x, y, len] of [[520, 930, 200], [760, 990, 260], [980, 1046, 220], [620, 1012, 180]]) {
  s.stroke([[x, y], [x + len, y + jit(4)]], { step: 12 });
}
await stage('water');

// ------------------------------------------------- 10. banks and foreground
s.mix([['titanium-white', 5], ['yellow-ochre', 2], ['van-dyke-brown', 1]], { tool: 'knife-10' });
s.tool('knife-10', 0.9).set({ pressure: 0.5 });
for (const [x, y, len] of [[1150, 952, 250], [1206, 1000, 234], [1268, 1052, 172], [1120, 916, 200]]) {
  s.stroke([[x, y], [x + len, y + 20]], { step: 7 });
}
// Rocks at the near bank, bottom centre-left.
s.mix([['van-dyke-brown', 3], ['midnight-black', 1], ['titanium-white', 1]], { tool: 'knife-5' });
s.tool('knife-5', 0.6).set({ pressure: 0.6 });
for (const [x, y, w] of [[640, 1020, 60], [700, 1046, 70], [764, 1026, 54], [596, 1052, 48]]) {
  s.stroke([[x - w / 2, y], [x + w / 2, y + 10]], { step: 6 });
}
s.paint('titanium-white');
s.tool('knife-5', 0.4).set({ pressure: 0.4 });
for (const [x, y, w] of [[640, 1014, 50], [700, 1040, 60], [764, 1020, 44]]) {
  s.stroke([[x - w / 2, y], [x + w / 2, y + 4]], { step: 6 });
}

// Grass and bushes across the very front, left corner and right bank.
s.tool('brush-round', 0.4).set({ pressure: 0.6 });
for (const parts of [
  [['sap-green', 3], ['cadmium-yellow', 2], ['midnight-black', 1]],
  [['cadmium-yellow', 3], ['yellow-ochre', 2]],
  [['yellow-ochre', 3], ['van-dyke-brown', 1]],
]) {
  s.mix(parts, { tool: 'brush-round' });
  for (let i = 0; i < 70; i++) {
    const left = rnd() < 0.55;
    const x = left ? rnd() * 440 : 1040 + rnd() * 400;
    const y = (left ? 900 : 940) + rnd() * 180;
    s.tap([x, y]);
  }
}
await stage('foreground');

// --------------------------------------------- 11. the framing evergreens
// Nearest, so darkest and largest. They hold the two edges of the picture in.
s.mix([['sap-green', 3], ['phthalo-blue', 2], ['midnight-black', 3], ['van-dyke-brown', 1]], {
  tool: 'brush-fan',
});
s.set({ pressure: 0.62 });
for (const [x, base, top, w, sz] of [
  [116, 860, 130, 168, 0.8], [36, 916, 250, 140, 0.7], [196, 884, 338, 120, 0.6],
  [1272, 870, 334, 150, 0.72], [1368, 902, 396, 126, 0.64], [1180, 892, 430, 104, 0.54],
  [1420, 940, 470, 96, 0.5],
]) {
  evergreen(x, base, top, w, sz);
}
// A little light on the near edge of the nearest boughs.
s.mix([['sap-green', 3], ['cadmium-yellow', 2]], { tool: 'brush-fan' });
s.tool('brush-fan', 0.4).set({ pressure: 0.4 });
for (let i = 0; i < 46; i++) {
  const left = rnd() < 0.5;
  const x = left ? 40 + rnd() * 170 : 1190 + rnd() * 220;
  const y = 300 + rnd() * 540;
  s.tap([x, y]);
}
await stage('framing-trees');

// ----------------------------------------------------------- 12. signature
s.tool('brush-liner', 0.1);
s.paint('alizarin-crimson');
s.set({ thinner: 0.7, pressure: 0.5 });
s.stroke([[58, 962], [58, 916], [78, 924], [60, 938], [82, 962]], { step: 3 });
s.stroke([[94, 962], [94, 930], [108, 926], [112, 940], [96, 942]], { step: 3 });
s.stroke([[126, 932], [140, 928], [130, 944], [144, 948], [132, 962]], { step: 3 });
s.stroke([[156, 932], [170, 928], [160, 944], [174, 948], [162, 962]], { step: 3 });
s.set({ thinner: 0 });
