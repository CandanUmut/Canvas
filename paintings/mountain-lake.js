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


// Mix on the 2" brush, then pick the tool up. A blade has almost no sideways
// bleed through it -- which is true of steel -- so a mixture dragged up on a
// knife stays streaky and comes off far stronger than the same ratio mixed
// with bristles: the mountain grey came out #0c3352 on the knife against
// #365258 on the brush. You mix on the board and then load the knife from
// what you mixed, which is what this does.
function mixFor(parts, toolId, inches) {
  const got = s.mix(parts, { tool: 'brush-2inch' });
  if (toolId) s.tool(toolId, inches);
  return got;
}

// --------------------------------------------------------------- 1. canvas
s.baseCoat('liquid-white');
await stage('base');

// ------------------------------------------------------------------ 2. sky
// Blue across the top, warm cream low down behind the mountain, and the join
// worked together with a clean brush so no band shows a seam.
s.tool('brush-2inch', 2.0);

// A 2" brush carries about eleven inches of stroke before it runs down, and
// this canvas is twenty-four across. Painting each band in one pass left the
// right-hand half of the sky bare. So the sky goes on in overlapping sections,
// alternating direction, the way it is actually painted -- and the tool is
// reloaded at the start of every one of them.
function band(y0, y1, step, pressure) {
  s.set({ pressure });
  let flip = 0;
  for (let y = y0; y < y1; y += step) {
    for (let sec = 0; sec < 3; sec++) {
      const a = -60 + sec * 520;
      const b = a + 640;
      const yy = y + jit(8);
      flip++;
      s.stroke(flip % 2 ? [[a, yy], [b, yy]] : [[b, yy], [a, yy]], { step: 40 });
    }
  }
}

const skyTop = mixFor([['titanium-white', 16], ['phthalo-blue', 2], ['midnight-black', 1]], 'brush-2inch', 2.0);
log('sky top   ', skyTop.hex);
band(-20, 210, 24, 0.6);

const skyMid = mixFor([['titanium-white', 16], ['phthalo-blue', 1], ['midnight-black', 1]], 'brush-2inch', 2.0);
log('sky mid   ', skyMid.hex);
band(170, 340, 24, 0.6);

const skyWarm = mixFor([['titanium-white', 40], ['yellow-ochre', 1], ['van-dyke-brown', 3], ['midnight-black', 1]], 'brush-2inch', 2.0);
log('sky warm  ', skyWarm.hex);
band(320, 560, 24, 0.5);

const skyPink = mixFor([['titanium-white', 40], ['bright-red', 1], ['van-dyke-brown', 1], ['midnight-black', 1]], 'brush-2inch', 2.0);
log('sky pink  ', skyPink.hex);
band(420, 620, 26, 0.5);

// Blend with a clean brush, in both diagonals and in both directions.
//
// Properly diagonal. A rise of eighty over a run of six hundred is seven
// degrees off horizontal, which carries paint SIDEWAYS along a band instead of
// across the join between two bands -- and the sky's colour changes almost
// entirely up and down. Measured: ten such passes left the colour at every
// height exactly where it started, to the byte, while scrubbing half the paint
// off wherever the strokes began.
s.clean();
s.set({ pressure: 0.3 });
for (let i = 0; i < 7; i++) {
  const x0 = -80 + i * 70 + jit(30);
  for (let x = x0; x < W + 120; x += 190) {
    const dir = i % 2 ? 1 : -1;
    const rise = 260 + jit(60);
    const y = lerp(80, 540, ((i * 3 + x / 400) % 4) / 4) + jit(30);
    s.stroke([[x, y - rise * 0.5 * dir], [x + 230, y + rise * 0.5 * dir]], { step: 22 });
    s.stroke([[x + 230, y - rise * 0.4 * dir], [x, y + rise * 0.4 * dir]], { step: 22 });
  }
}
// Then soften it with the blender, which spreads what is there where it is
// rather than carrying it along a path. This is what takes the last of the
// stroke marks out of a sky.
s.tool('util-blender', 2.0).set({ pressure: 0.3 });
for (let i = 0; i < 5; i++) {
  const y = lerp(40, 600, i / 4) + jit(30);
  for (let sec = 0; sec < 3; sec++) {
    const a = -60 + sec * 520 + jit(30);
    s.stroke([[a, y + jit(40)], [a + 640, y + jit(40)]], { step: 34 });
  }
}
await stage('sky');

// --------------------------------------------------------------- 3. clouds
// A bank of cumulus across the top right. A cloud is not a ring: it is built
// out of many small circular scrubs off the corner of the brush, packed into
// an irregular mass. Tracing one big circle per cloud left a row of pebbles
// with holes in them, which is what the last attempt painted.
function cloudMass(cx, cy, rx, ry, density, r0) {
  const n = Math.max(6, Math.round((rx * ry * density) / 900));
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd());
    // Bunch the bumps towards the top: a cumulus piles upward and its
    // underside is flat.
    const x = cx + Math.cos(a) * rx * d;
    const y = cy + Math.sin(a) * ry * d * (Math.sin(a) < 0 ? 1 : 0.55);
    const r = r0 * (0.65 + rnd() * 0.7);
    const turn = [];
    for (let t = 0; t < Math.PI * 2.6; t += 0.55) {
      turn.push([x + Math.cos(t) * r, y + Math.sin(t) * r * 0.78]);
    }
    s.stroke(turn, { step: 8 });
  }
}

// The grey mass first: a cloud's shadow is still full of light, and the lit
// tops have to sit ON something.
const cloudGrey = mixFor([['titanium-white', 26], ['midnight-black', 2], ['phthalo-blue', 1]], 'brush-2inch', 0.9);
log('cloud grey', cloudGrey.hex);
s.tool('brush-2inch', 0.9).set({ pressure: 0.55 });
cloudMass(1050, 130, 400, 105, 1.0, 26);
cloudMass(1380, 150, 180, 95, 1.0, 26);
cloudMass(830, 95, 150, 65, 0.9, 22);

// Then the lit tops, overlapping the upper edge of the grey.
const cloudLit = mixFor([['titanium-white', 40], ['yellow-ochre', 1], ['midnight-black', 1]], 'brush-2inch', 0.8);
log('cloud lit ', cloudLit.hex);
s.tool('brush-2inch', 0.8).set({ pressure: 0.6 });
cloudMass(1040, 75, 370, 60, 1.1, 22);
cloudMass(1380, 90, 170, 55, 1.1, 22);
cloudMass(830, 60, 140, 42, 1.0, 20);
s.paint('titanium-white');
s.tool('brush-2inch', 0.6).set({ pressure: 0.55 });
for (const [x, y, r] of [[880, 42, 40], [1120, 38, 44], [1330, 46, 40], [1010, 62, 32]]) {
  cloudMass(x, y, r, r * 0.45, 1.2, 15);
}

// Light wisps drawn out to the left, flat and thin.
s.tool('brush-2inch', 1.0).set({ pressure: 0.3 });
for (const [x, y, len] of [[70, 55, 340], [150, 120, 300], [330, 30, 320], [430, 95, 260]]) {
  s.stroke([[x, y], [x + len * 0.45, y - 16], [x + len, y + 10]], { step: 14 });
}

// Soften the underside into the sky. The top of a cloud is crisp; the bottom
// is not an edge at all.
s.clean();
s.tool('util-blender', 1.2).set({ pressure: 0.28 });
for (let i = 0; i < 7; i++) {
  const y = 185 + i * 16;
  s.stroke([[720, y + 26], [W + 40, y - 18]], { step: 26 });
  s.stroke([[W + 40, y - 6], [720, y + 34]], { step: 26 });
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

const rock = mixFor([['titanium-white', 5], ['midnight-black', 3], ['phthalo-blue', 1]], 'knife-10', 1.5);
log('mtn rock  ', rock.hex);
s.tool('knife-10', 1.5).set({ pressure: 0.85 });

// The blade follows the stroke, so the mark it leaves is a wide band lying
// ACROSS the direction of travel. Pull straight down and the band is
// horizontal, and one pull per ridge point steps the silhouette down in flat
// notches -- a staircase, which is what the last attempt painted. Pull along
// the fall line instead, perpendicular to the ridge just there, and the band
// lies parallel to the ridge: the top of the mark IS the ridge.
const PEAK = 10;   // index of the main peak in `ridge`
for (let i = 0; i < ridge.length - 1; i++) {
  const [x0, y0] = ridge[i];
  const [x1, y1] = ridge[i + 1];
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  // Downhill, at right angles to this piece of the ridge.
  let nx = (y1 - y0) / len;
  let ny = -(x1 - x0) / len;
  if (ny < 0) { nx = -nx; ny = -ny; }
  // Faces near the peak are long; the shoulders run out shallow.
  const out = Math.abs(i - PEAK) / (i < PEAK ? PEAK : ridge.length - 2 - PEAK);
  const reach = 340 * (1 - out * 0.55);
  // Three overlapping pulls per piece of ridge, each starting a little along
  // it, so the faces knit together instead of stacking as separate slabs.
  for (let k = 0; k < 3; k++) {
    const t = (k + 0.5) / 3;
    const sx = lerp(x0, x1, t) + jit(5);
    const sy = lerp(y0, y1, t) + jit(3);
    const r = reach * (0.7 + rnd() * 0.5);
    s.stroke([[sx, sy], [sx + nx * r + jit(24), sy + ny * r]], { step: 9 });
  }
}
// No cutting back along the ridge afterwards: travelling ALONG it puts the
// blade across it, so the mark straddles the line and smears rock half a
// blade-width up into the sky. The fall-line pulls already leave the ridge as
// their top edge, which is the whole point of pulling them that way.
await stage('mountain-mass');

// Snow on the faces that catch the light. It goes on the same way the mass
// did -- down the fall line, so the mark lies parallel to the ridge -- but
// several times over each face. One pull of white onto a thick wet dark moves
// it about a third of the way, which is right: you go back over it, and the
// part that does not quite cover is the grey the mountain needs anyway.
const snowLit = mixFor([['titanium-white', 60], ['phthalo-blue', 1]], 'knife-10', 1.2);
log('snow lit  ', snowLit.hex);
s.set({ pressure: 0.62 });
const PEAK2 = 10;
for (let i = 0; i < ridge.length - 1; i++) {
  const [x0, y0] = ridge[i];
  const [x1, y1] = ridge[i + 1];
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  let nx = (y1 - y0) / len;
  let ny = -(x1 - x0) / len;
  if (ny < 0) { nx = -nx; ny = -ny; }
  const out = Math.abs(i - PEAK2) / (i < PEAK2 ? PEAK2 : ridge.length - 2 - PEAK2);
  // Snow lies on the faces that turn towards the light, which here is up and
  // to the left, and it runs out before the foot of the mountain.
  const lit = i < PEAK2 ? 1.0 : 0.55;
  const reach = 300 * (1 - out * 0.6) * lit;
  if (reach < 30) continue;
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 0; k < 2; k++) {
      const t = (k + 0.5) / 2;
      const sx = lerp(x0, x1, t) + jit(6);
      const sy = lerp(y0, y1, t) + jit(3);
      const r = reach * (0.55 + rnd() * 0.55);
      s.stroke([[sx, sy], [sx + nx * r + jit(20), sy + ny * r]], { step: 9 });
    }
  }
}

// The shoulder of snow the mountain stands on, sweeping left and down.
s.tool('knife-10', 1.7).set({ pressure: 0.62 });
for (let pass = 0; pass < 2; pass++) {
  for (let x = 120; x < 860; x += 30) {
    const top = lerp(560, 500, Math.min(1, (x - 120) / 500)) + jit(24);
    s.stroke([[x, top], [x + jit(36), top + 110 + rnd() * 90]], { step: 8 });
  }
}
await stage('mountain-snow');

// Shadow faces: the right of each spine, cooler and darker than the snow but
// nowhere near the rock.
const snowShade = mixFor([['titanium-white', 22], ['phthalo-blue', 1], ['midnight-black', 1]], 'knife-5');
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
mixFor([['titanium-white', 2], ['midnight-black', 4], ['phthalo-blue', 1], ['van-dyke-brown', 1]], 'knife-5');
for (let i = 0; i < 46; i++) {
  const t = rnd();
  const x = lerp(300, 1060, t) + jit(40);
  const y = lerp(330, 560, t) + rnd() * 130;
  s.stroke([[x, y], [x + jit(18), y + 16 + rnd() * 34]], { step: 5 });
}
await stage('mountain-detail');

// Mist the base so the mountain sits BEHIND the land instead of on top of it.
s.clean();
s.tool('util-blender', 1.6).set({ pressure: 0.22 });
for (let y = 620; y < 712; y += 18) s.stroke([[-60, y], [W + 60, y + jit(8)]], { step: 40 });
await stage('mountain-mist');

// --------------------------------------------------- 5. distant small peaks
s.tool('knife-5', 0.8).set({ pressure: 0.5 });
mixFor([['titanium-white', 26], ['phthalo-blue', 1], ['midnight-black', 1]], 'knife-5');
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
s.tool('util-blender', 1.2).set({ pressure: 0.2 });
for (let y = 704; y < 754; y += 16) s.stroke([[-60, y], [W + 60, y]], { step: 40 });
await stage('far-peaks');

// ---------------------------------------------------- 6. distant tree line
// The dark the whole picture is measured against. Everything above it is
// light; without it the snow has nothing to be bright against.
const treeDark = mixFor([['sap-green', 3], ['phthalo-blue', 2], ['midnight-black', 2], ['van-dyke-brown', 1]],
  'brush-fan', 0.5);
log('tree dark ', treeDark.hex);
s.set({ pressure: 0.6 });
// One tap of a fan brush moves wet Liquid White about a third of the way to
// the colour on the bristles -- which is right, and why a dark goes on in
// several passes. Without them the band that the whole picture's value range
// is measured against came out a pale scribble.
for (let pass = 0; pass < 3; pass++) {
  for (let x = -20; x < W + 20; x += 13) {
    const top = 744 + jit(30);
    for (let y = top; y < 814; y += 16) s.tap([x + jit(9), y]);
  }
}
await stage('treeline');

// ------------------------------------------------- 7. mid-ground evergreens
// A fir is a trunk with boughs hung off it, wider as they go down, and the
// gaps between the boughs are what make it read as a tree.
//
// The boughs are TAPPED, not drawn. A fan brush set down leaves the splay of
// its bristles, which is the shape of a bough; dragged, it leaves a streak,
// and a tree built out of streaks comes out a shaggy pole. The brush is also
// angled out to each side, the way you would turn it in your hand.
function evergreen(x, baseY, topY, width, size) {
  s.tool('brush-liner', Math.max(0.05, size * 0.09));
  s.set({ thinner: 0.6 });
  s.stroke([[x, topY + 6], [x + jit(3), baseY]], { step: 4 });
  s.set({ thinner: 0 });

  s.tool('brush-fan', size);
  const rows = Math.max(7, Math.round((baseY - topY) / (size * 30)));
  // Twice over. One touch of a fan brush moves wet paint about a third of the
  // way to the colour on it, so a single pass leaves a grey tree.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < rows; i++) {
      const t = i / (rows - 1);
      const y = topY + (baseY - topY) * t;
      const half = 4 + width * Math.pow(t, 1.4) * 0.5;
      const n = Math.round(half / (size * 26));
      s.set({ angle: 0 });
      s.tap([x + jit(2), y]);
      for (let j = 1; j <= n; j++) {
        const off = (half * j) / n;
        const droop = off * 0.3;
        s.set({ angle: -22 });
        s.tap([x - off + jit(3), y + droop + jit(3)]);
        s.set({ angle: 22 });
        s.tap([x + off + jit(3), y + droop + jit(3)]);
      }
    }
  }
  s.set({ angle: 0 });
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
// A small brush and a great many taps. What separates a bank of autumn bushes
// from a row of blobs is the number of separate touches and the number of
// values among them -- the reference carries about three times the fine
// texture of anything painted here so far, and this is where most of it is.
const bank = (x) => 800 + (x > 400 && x < 1080 ? 34 : 0) + jit(26);
const clumps = [];
// Two rows: the far bank and the strip of ground in front of it, so no bare
// canvas is left between the trees and the water.
for (let x = -20; x < W + 20; x += 18) {
  clumps.push([x, bank(x)]);
  clumps.push([x + 9, bank(x) + 42]);
}

for (const [parts, n, size, chance] of [
  [[['sap-green', 2], ['midnight-black', 3], ['yellow-ochre', 2]], 7, 0.34, 0.85],
  [[['sap-green', 2], ['midnight-black', 2], ['yellow-ochre', 3]], 6, 0.30, 0.70],
  [[['yellow-ochre', 3], ['titanium-white', 6], ['van-dyke-brown', 1]], 6, 0.26, 0.60],
  [[['cadmium-yellow', 2], ['titanium-white', 6], ['yellow-ochre', 2]], 5, 0.22, 0.45],
]) {
  mixFor(parts, 'brush-round', size);
  s.set({ pressure: 0.6 });
  for (const [x, y] of clumps) {
    if (rnd() > chance) continue;
    for (let i = 0; i < n; i++) s.tap([x + jit(24), y + jit(30)]);
  }
}
// A patch of burnt orange on the right bank, where the reference has one.
mixFor([['bright-red', 1], ['yellow-ochre', 6], ['van-dyke-brown', 2], ['titanium-white', 3]], 'brush-round', 0.26);
for (let i = 0; i < 60; i++) s.tap([980 + rnd() * 240, 866 + rnd() * 66]);
await stage('bushes');

// ------------------------------------------------------------- 9. the water
// Still water is the sky, upside down and a little darker. Lay it flat, pull
// the bank colours straight down into it, then cut across to still it.
const waterBase = mixFor([['titanium-white', 22], ['sap-green', 1], ['phthalo-blue', 1]], 'brush-2inch', 1.5);
log('water     ', waterBase.hex);
s.set({ pressure: 0.5 });
// Right across, and right down to the bottom edge. The banks and the bushes
// go over the ends of it afterwards; what must not happen is bare canvas left
// showing, and the last attempt left the water sitting in the middle of the
// picture like a swimming pool with white all round it.
for (let y = 852; y < H + 30; y += 18) {
  for (let sec = 0; sec < 3; sec++) {
    const a = -60 + sec * 520;
    const b = a + 640;
    const yy = y + jit(4);
    s.stroke(sec % 2 ? [[b, yy], [a, yy]] : [[a, yy], [b, yy]], { step: 34 });
  }
}
// Darker towards the near bank: water takes the sky at a distance and the
// bottom of the lake close to.
mixFor([['titanium-white', 10], ['sap-green', 2], ['phthalo-blue', 1], ['yellow-ochre', 1]], 'brush-2inch', 1.5);
s.set({ pressure: 0.4 });
for (let y = 990; y < H + 30; y += 18) {
  s.stroke([[1460, y + jit(4)], [-60, y + jit(4)]], { step: 34 });
}

// Reflections: pull the bank colours straight down, then cut across.
s.set({ pressure: 0.42 });
for (const [parts, xs] of [
  [[['sap-green', 3], ['midnight-black', 3], ['cadmium-yellow', 2], ['van-dyke-brown', 1]], [330, 430, 520, 600, 690, 780, 860, 940]],
  [[['yellow-ochre', 3], ['titanium-white', 4], ['van-dyke-brown', 1]], [370, 470, 560, 900, 980, 1060, 1140]],
  [[['van-dyke-brown', 3], ['bright-red', 1], ['titanium-white', 2]], [1020, 1100, 1160, 1240]],
]) {
  mixFor(parts, 'brush-1inch', 0.6);
  s.set({ pressure: 0.42 });
  for (const x of xs) s.stroke([[x, 856], [x + jit(10), 946 + rnd() * 110]], { step: 7 });
}
// Cut across. This is what turns a set of vertical smears into water.
s.clean();
s.tool('brush-2inch', 1.5).set({ pressure: 0.26 });
for (let y = 860; y < H + 30; y += 12) {
  s.stroke(y % 24 ? [[-60, y], [1500, y]] : [[1500, y], [-60, y]], { step: 34 });
}
// A few still, light ripples.
s.paint('titanium-white');
s.tool('brush-1inch', 0.3).set({ pressure: 0.28 });
for (const [x, y, len] of [
  [430, 920, 260], [700, 968, 300], [930, 1020, 260], [560, 1000, 200], [820, 1060, 240],
]) {
  s.stroke([[x, y], [x + len, y + jit(3)]], { step: 12 });
}
await stage('water');

// ------------------------------------------------- 10. banks and foreground
mixFor([['titanium-white', 34], ['yellow-ochre', 1], ['van-dyke-brown', 2], ['midnight-black', 1]], 'knife-10', 0.9);
s.tool('knife-10', 0.9).set({ pressure: 0.5 });
for (const [x, y, len] of [[1150, 952, 250], [1206, 1000, 234], [1268, 1052, 172], [1120, 916, 200]]) {
  s.stroke([[x, y], [x + len, y + 20]], { step: 7 });
}
// Rocks at the near bank, bottom centre-left.
mixFor([['van-dyke-brown', 3], ['midnight-black', 2], ['titanium-white', 3]], 'knife-5', 0.6);
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
for (const parts of [
  [['sap-green', 2], ['cadmium-yellow', 3], ['midnight-black', 2], ['yellow-ochre', 2]],
  [['sap-green', 2], ['cadmium-yellow', 3], ['midnight-black', 1], ['yellow-ochre', 2]],
  [['yellow-ochre', 3], ['titanium-white', 4], ['van-dyke-brown', 1]],
  [['yellow-ochre', 3], ['van-dyke-brown', 1], ['titanium-white', 2]],
]) {
  mixFor(parts, 'brush-round', 0.28);
  s.set({ pressure: 0.6 });
  for (let i = 0; i < 130; i++) {
    const left = rnd() < 0.55;
    // Right into the corners: the very front of the picture is the nearest
    // thing in it and there should be no canvas showing through it.
    const x = left ? rnd() * 420 - 20 : 1060 + rnd() * 400;
    const y = (left ? 880 : 910) + rnd() * 220;
    s.tap([x, y]);
  }
}
await stage('foreground');

// --------------------------------------------- 11. the framing evergreens
// Nearest, so darkest and largest. They hold the two edges of the picture in.
mixFor([['sap-green', 3], ['phthalo-blue', 2], ['midnight-black', 3], ['van-dyke-brown', 1]], 'brush-fan', 0.8);
s.set({ pressure: 0.62 });
for (const [x, base, top, w, sz] of [
  [116, 860, 130, 168, 0.8], [36, 916, 250, 140, 0.7], [196, 884, 338, 120, 0.6],
  [1272, 870, 334, 150, 0.72], [1368, 902, 396, 126, 0.64], [1180, 892, 430, 104, 0.54],
  [1420, 940, 470, 96, 0.5],
]) {
  evergreen(x, base, top, w, sz);
}
// A little light on the near edge of the nearest boughs.
mixFor([['sap-green', 3], ['cadmium-yellow', 2], ['midnight-black', 1]], 'brush-fan', 0.4);
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
