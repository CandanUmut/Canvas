// Bob Ross's tool roll, rebuilt as footprints.
//
// Each tool is defined by a bristle mask -- a small greyscale image of what the
// tool looks like pressed flat against the canvas. The gaps matter more than
// the bristles: the spaces between a fan brush's clumps are what make it read
// as evergreen boughs, and the frayed ends of the 2" brush are what turn one
// drag into a hundred separate streaks of cloud.

export const MASK_RES = 192;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function smooth(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Deterministic value noise, so a brush looks the same every session. */
function rnd(i, seed = 0) {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function noise1d(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const t = f * f * (3 - 2 * f);
  return rnd(i, seed) * (1 - t) + rnd(i + 1, seed) * t;
}

// --- footprint shapes -------------------------------------------------------

/**
 * Flat landscape brush: a block of bristles, frayed at the working edge.
 * `teeth` is the bristle count across the width.
 */
function flatMask({ teeth = 26, fray = 0.22, softU = 0.03, softV = 0.08, seed = 1 } = {}) {
  return (u, v) => {
    const streak = 0.5 + 0.5 * noise1d(u * teeth, seed);
    const clump = 0.55 + 0.45 * noise1d(u * teeth * 0.31, seed + 7);
    const col = Math.floor(u * teeth);
    const len = 1 - fray * rnd(col, seed + 3);
    const edgeU = smooth(0, softU, u) * smooth(0, softU, 1 - u);
    const half = Math.abs(v - 0.5) * 2;
    const edgeV = smooth(len, len - softV - 0.1, half);
    return streak * clump * edgeU * edgeV;
  };
}

/**
 * Fan brush: bristles splayed from a point below the footprint into separated
 * clumps. Tapping with this is how you paint a whole forest.
 */
function fanMask({ clumps = 9, spread = 0.66, seed = 2 } = {}) {
  const pivot = -0.42;
  return (u, v) => {
    const dx = u - 0.5;
    const dy = v - pivot;
    const r = Math.hypot(dx, dy);
    const t = Math.atan2(dx, dy) / spread; // -1..1 across the fan
    if (Math.abs(t) > 1.05) return 0;

    const c = (t * clumps * 0.5 + 0.5) % 1;
    const cc = c < 0 ? c + 1 : c;
    const gap = smooth(0, 0.34, cc) * smooth(0, 0.34, 1 - cc);
    const jitter = 0.7 + 0.3 * noise1d(t * clumps * 2.0, seed);

    // Outer clumps are shorter, so the fan's silhouette is curved.
    const reach = (1.0 - 0.16 * t * t) * (0.95 + 0.05 * rnd(Math.floor(t * clumps), seed));
    const radial = smooth(pivot + 0.30, pivot + 0.52, r) * smooth(reach + 0.42, reach + 0.30, r);
    const taper = smooth(1.05, 0.80, Math.abs(t));
    return gap * jitter * radial * taper;
  };
}

/** Round foliage brush: a dense circle with radial bristle clumping. */
function roundMask({ clumps = 14, soft = 0.26, seed = 3 } = {}) {
  return (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.hypot(dx, dy);
    if (r > 1.02) return 0;
    const a = Math.atan2(dy, dx) / Math.PI; // -1..1
    // Two frequencies plus a radial term, or the bristles line up into spokes
    // and the brush stamps a wagon wheel instead of a clump of leaves.
    const streak =
      0.52 + 0.30 * noise1d(a * clumps + r * 2.6, seed) + 0.22 * noise1d(a * clumps * 2.3 - r * 4.0, seed + 9);
    const reach = 0.74 + 0.26 * noise1d(a * clumps * 0.6, seed + 4);
    const body = smooth(reach, reach - soft, r);
    return streak * body;
  };
}

/** Filbert: rounded rectangle, oval tip, softer than a flat. */
function filbertMask({ teeth = 16, seed = 4 } = {}) {
  return (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 1.75;
    const r = Math.hypot(dx * 1.05, dy);
    const streak = 0.62 + 0.38 * noise1d(u * teeth, seed);
    return streak * smooth(1.0, 0.70, r);
  };
}

/** Script liner: a long thin point that holds a surprising amount of paint. */
function linerMask({ seed = 5 } = {}) {
  return (u, v) => {
    const taper = Math.pow(1 - smooth(0.0, 1.0, v), 1.8);
    const halfW = 0.5 * Math.max(taper, 0.02);
    const d = Math.abs(u - 0.5) / halfW;
    if (d > 1.2) return 0;
    const wobble = 0.85 + 0.15 * noise1d(v * 9, seed);
    return smooth(1.15, 0.45, d) * smooth(0, 0.05, v) * wobble;
  };
}

/**
 * Painting knife: no bristles at all. A hard steel edge, loaded so the
 * trailing edge drops the most paint -- that is what puts the crisp lit edge
 * on a mountain and lets the rest break up into rock face.
 */
function knifeMask({ bevel = 0.02, seed = 6 } = {}) {
  return (u, v) => {
    // The blade itself is straight steel, but the roll of paint riding on it
    // is not: it sits unevenly, runs out in patches, and lifts away at the
    // ends. Those irregularities are the whole difference between a stroke
    // that reads as rock face and one that reads as a grey playing card.
    //
    // u runs along the blade, v across its thickness. Travel is along v, so
    // the v edges stay crisp -- that is the edge doing the cutting -- while
    // the u ends round off the way a real blade lifts off the canvas.
    const ends = smooth(0, 0.085, u) * smooth(0, 0.085, 1 - u);

    const rollA = 0.06 * noise1d(u * 3.1, seed + 2);
    const rollB = 0.06 * noise1d(u * 3.1 + 11, seed + 3);
    const edge = smooth(rollA, rollA + bevel * 2.2, v) * smooth(rollB, rollB + bevel * 2.2, 1 - v);

    // Paint sits along the edge in patches -- some stretches loaded, some
    // scraped bare -- so a long pull breaks up instead of staying solid.
    const patch = noise1d(u * 4.5 + 20, seed + 6);
    const load = 0.48 + 0.52 * smooth(0.18, 0.60, patch);
    const grain = 0.72 + 0.28 * noise1d(u * 30, seed);
    const loadBias = 0.66 + 0.34 * smooth(0.6, 0.0, v);
    return ends * edge * load * grain * loadBias;
  };
}

/** Soft blender / rag: no hard edge anywhere. */
function ragMask() {
  return (u, v) => {
    const r = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
    return smooth(1.0, 0.1, r);
  };
}

/** Renders a mask function into a Uint8Array ready for an R8 texture. */
export function rasterizeMask(fn, res = MASK_RES) {
  const data = new Uint8Array(res * res);
  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) / res;
    for (let x = 0; x < res; x++) {
      const u = (x + 0.5) / res;
      data[y * res + x] = Math.round(clamp01(fn(u, v)) * 255);
    }
  }
  return data;
}

// --- tool definitions -------------------------------------------------------
//
// flow      volume laid down in one pass at full load; ~0.7 already covers
// pickup    share of the existing wet paint one pass lifts (wet-on-wet!)
// capacity  how much the tool holds. capacity/flow is how many footprint-
//           lengths of fully covered stroke it lays before running dry, so a
//           knife -- which sweeps a thin edge but carries a fat roll of paint
//           on it -- needs a much bigger number than a broad flat brush
// dryOut    load lost per brush-width travelled, so a stroke fades out
// body      stiffness: high builds impasto ridges, low lies flat
// level     knives flatten what they pass over
// spacing   dab spacing as a fraction of tool size; lower is smoother, slower
// aspect    footprint height / width

const BRUSH_DEFAULTS = {
  category: 'brush',
  aspect: 1,
  spacing: 0.055,
  flow: 1.10,
  pickup: 0.30,
  capacity: 8.0,
  dryOut: 0.25,
  body: 0.85,
  wetness: 1.0,
  level: 0.0,
  scrape: 0.0,
  maxVolume: 1.9,
  followStroke: false,
  angle: 0,
  pressureSize: 0.45,
  pressureFlow: 0.65,
  sizeRange: [8, 460],
};

function tool(def) {
  const t = { ...BRUSH_DEFAULTS, ...def };
  t.mask = rasterizeMask(t.shape);
  return t;
}

export const TOOLS = [
  tool({
    id: 'brush-2inch',
    name: '2" Landscape Brush',
    short: '2"',
    blurb:
      'The one he reaches for constantly. Skies, water, big clouds, the base of every tree and bush. Drag it flat to blend, tap its corner to build.',
    shape: flatMask({ teeth: 30, fray: 0.24, softV: 0.09 }),
    aspect: 0.30,
    size: 250,
    spacing: 0.035,
    flow: 1.00,
    pickup: 0.38,
    capacity: 10.0,
    dryOut: 0.18,
    body: 0.8,
    followStroke: false,
    sizeRange: [60, 520],
  }),
  tool({
    id: 'brush-1inch',
    name: '1" Landscape Brush',
    short: '1"',
    blurb: 'Same brush, half the reach. Smaller skies, tree trunks, tighter blending.',
    shape: flatMask({ teeth: 20, fray: 0.26, softV: 0.10, seed: 11 }),
    aspect: 0.34,
    size: 130,
    spacing: 0.04,
    flow: 1.05,
    pickup: 0.36,
    capacity: 10.5,
    dryOut: 0.20,
    sizeRange: [30, 300],
  }),
  tool({
    id: 'brush-fan',
    name: 'Fan Brush',
    short: 'Fan',
    blurb:
      'Evergreens, clouds, distant forests, grass. Tap downward with the tip for boughs; sweep it sideways for soft cloud edges.',
    shape: fanMask({ clumps: 9 }),
    aspect: 0.62,
    size: 120,
    spacing: 0.05,
    flow: 1.30,
    pickup: 0.22,
    capacity: 9.0,
    dryOut: 0.55,
    body: 0.95,
    followStroke: false,
    pressureSize: 0.30,
    sizeRange: [30, 320],
  }),
  tool({
    id: 'brush-round',
    name: 'Round Foliage Brush',
    short: 'Round',
    blurb: 'Bushes, foothills, the soft ragged mass of a distant treeline. Tap, never drag.',
    shape: roundMask({ clumps: 15 }),
    aspect: 1.0,
    size: 78,
    spacing: 0.06,
    flow: 1.40,
    capacity: 7.0,
    pickup: 0.20,
    dryOut: 0.65,
    body: 0.95,
    sizeRange: [16, 240],
  }),
  tool({
    id: 'brush-filbert',
    name: 'Filbert Brush',
    short: 'Filb',
    blurb: 'Soft oval tip. Rounded highlights, petals, gentle blending in tight spots.',
    shape: filbertMask(),
    aspect: 1.35,
    size: 60,
    spacing: 0.05,
    flow: 1.20,
    capacity: 7.2,
    dryOut: 0.30,
    pickup: 0.30,
    followStroke: true,
    sizeRange: [12, 200],
  }),
  tool({
    id: 'brush-oval',
    name: 'Oval Brush',
    short: 'Oval',
    blurb: 'Broad and soft. Good for laying big washes of colour and for gentle blends.',
    shape: filbertMask({ teeth: 24, seed: 14 }),
    aspect: 0.9,
    size: 120,
    spacing: 0.045,
    flow: 1.05,
    capacity: 8.4,
    dryOut: 0.25,
    pickup: 0.34,
    sizeRange: [30, 320],
  }),
  tool({
    id: 'brush-liner',
    name: '#2 Script Liner',
    short: 'Liner',
    blurb:
      'Thin the paint right down with odorless thinner first. Twigs, branches, wave foam, cabin details -- and your signature.',
    shape: linerMask(),
    aspect: 5.0,
    size: 16,
    spacing: 0.025,
    flow: 1.60,
    pickup: 0.10,
    capacity: 9.6,
    dryOut: 0.30,
    body: 0.55,
    followStroke: true,
    pressureSize: 0.70,
    sizeRange: [3, 60],
  }),
  tool({
    id: 'brush-detail',
    name: 'Detail Round',
    short: 'Det',
    blurb: 'Small, tight, controllable. Little highlights and final touches.',
    shape: roundMask({ clumps: 8, soft: 0.4, seed: 21 }),
    aspect: 1.0,
    size: 20,
    spacing: 0.05,
    flow: 1.30,
    capacity: 6.5,
    dryOut: 0.35,
    pickup: 0.18,
    followStroke: false,
    sizeRange: [3, 80],
  }),
  tool({
    id: 'knife-10',
    name: '#10 Painting Knife',
    short: '#10',
    blurb:
      'Mountains. Load a roll of paint on the long edge, press, and pull down -- let it break up on the way for rock face.',
    category: 'knife',
    shape: knifeMask(),
    aspect: 0.16,
    size: 170,
    spacing: 0.022,
    flow: 1.80,
    pickup: 0.30,
    capacity: 40.0,
    dryOut: 0.40,
    body: 1.25,
    level: 0.35,
    maxVolume: 2.4,
    followStroke: true,
    pressureSize: 0.15,
    pressureFlow: 0.80,
    sizeRange: [40, 400],
  }),
  tool({
    id: 'knife-5',
    name: '#5 Painting Knife',
    short: '#5',
    blurb: 'The small knife. Cabin walls, fence posts, tight rock edges, cutting in a horizon.',
    category: 'knife',
    shape: knifeMask({ bevel: 0.03, seed: 16 }),
    aspect: 0.22,
    size: 80,
    spacing: 0.02,
    flow: 1.80,
    pickup: 0.28,
    capacity: 36.0,
    dryOut: 0.40,
    body: 1.25,
    level: 0.35,
    maxVolume: 2.4,
    followStroke: true,
    pressureSize: 0.15,
    sizeRange: [16, 200],
  }),
  tool({
    id: 'knife-scrape',
    name: 'Knife Scrape',
    short: 'Scr',
    blurb:
      'Turn the knife over and take paint off. Perfect for cutting a clean water line or fixing a happy accident.',
    category: 'knife',
    shape: knifeMask({ bevel: 0.02, seed: 19 }),
    aspect: 0.2,
    size: 120,
    spacing: 0.02,
    flow: 0.0,
    pickup: 0.0,
    scrape: 0.55,
    followStroke: true,
    sizeRange: [20, 340],
  }),
  tool({
    id: 'util-blender',
    name: 'Clean Blender',
    short: 'Blend',
    blurb:
      'A dry 2" brush with no paint on it. Pure blending -- softens edges, pulls mist across mountains, feathers a horizon away.',
    category: 'utility',
    shape: flatMask({ teeth: 34, fray: 0.3, softV: 0.14, seed: 23 }),
    aspect: 0.32,
    size: 200,
    spacing: 0.03,
    flow: 0.80,
    pickup: 0.55,
    capacity: 2.4,
    dryOut: 0.45,
    body: 0.35,
    level: 0.25,
    noLoad: true,
    sizeRange: [40, 520],
  }),
  tool({
    id: 'util-rag',
    name: 'Rag / Wipe',
    short: 'Rag',
    blurb: 'Wipe back to bare canvas. Every happy accident has a way out.',
    category: 'utility',
    shape: ragMask(),
    aspect: 1.0,
    size: 110,
    spacing: 0.06,
    flow: 0.0,
    pickup: 0.0,
    scrape: 0.85,
    noLoad: true,
    sizeRange: [20, 420],
  }),
];

export const TOOLS_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

export const TOOL_CATEGORIES = [
  { id: 'brush', label: 'Brushes' },
  { id: 'knife', label: 'Knives' },
  { id: 'utility', label: 'Utility' },
];
