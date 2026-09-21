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
function flatMask({ teeth = 26, fray = 0.22, softU = 0.03, softV = 0.30, seed = 1 } = {}) {
  return (u, v) => {
    const streak = 0.62 + 0.38 * noise1d(u * teeth, seed);
    const clump = 0.55 + 0.45 * noise1d(u * teeth * 0.31, seed + 7);
    const col = Math.floor(u * teeth);
    const len = 1 - fray * rnd(col, seed + 3);
    const edgeU = smooth(0, softU, u) * smooth(0, softU, 1 - u);
    const half = Math.abs(v - 0.5) * 2;
    // The long edges of the footprint have to fade out, not stop dead. With a
    // hard edge every stroke left a band with a visible seam and overlapping
    // passes never merged into a sky -- they stacked like tape.
    const edgeV = smooth(len, len - softV, half);
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

/**
 * Renders a mask function into an RG8 texture.
 *
 *   R = the bristles themselves, streaks and all
 *   G = the ENVELOPE: the same footprint with the streaks smoothed out
 *
 * Both are needed because a loaded brush does not paint stripes with bare
 * canvas between them. It lays a continuous film and the bristles rake ridges
 * into its surface. Deposit therefore follows the envelope, while the streaks
 * drive impasto height -- and only when the paint runs out, or the touch is
 * light enough that the canvas tooth wins, do the bristles start to show as
 * actual gaps. Using the streaky value for coverage made every stroke a sparse
 * comb, so crossing strokes wove into a lattice instead of covering.
 */
export function rasterizeMask(fn, res = MASK_RES, softness = 0.055) {
  const raw = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) / res;
    for (let x = 0; x < res; x++) {
      raw[y * res + x] = clamp01(fn((x + 0.5) / res, v));
    }
  }

  // Separable box blur wide enough to erase bristle spacing but not the shape.
  const r = Math.max(1, Math.round(res * softness));
  const tmp = new Float32Array(res * res);
  const env = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= res) continue;
        sum += raw[y * res + xx];
        n++;
      }
      tmp[y * res + x] = sum / n;
    }
  }
  let peak = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= res) continue;
        sum += tmp[yy * res + x];
        n++;
      }
      const e = sum / n;
      env[y * res + x] = e;
      if (e > peak) peak = e;
    }
  }

  // Normalise so the middle of the footprint is fully covering.
  const gain = peak > 0.001 ? 1 / peak : 1;
  const data = new Uint8Array(res * res * 2);
  for (let i = 0; i < res * res; i++) {
    data[i * 2] = Math.round(raw[i] * 255);
    data[i * 2 + 1] = Math.round(clamp01(env[i] * gain) * 255);
  }
  return data;
}

// --- tool definitions -------------------------------------------------------
//
// Sizes are in INCHES and converted against the canvas at runtime. A 2" brush
// is two inches wide on a 24" canvas at any resolution, which is the only way
// the tools stay in proportion to the picture. They used to be fixed pixel
// sizes, which made every brush about twice too big and fine detail
// impossible.
//
// hold     how many layers deep a full tool's worth of paint is, spread over
//          its own footprint. This is the bridge between brush units and
//          canvas units, and the only place the two meet
// flow     layers laid down per footprint-length of travel, at full load
// pickup   fill-fraction gained per footprint-length through deep paint.
//          Loading saturates, so ~4 means one dip fills a brush to 80%
// knee     load below which the tool starts running dry and the stroke tails
//          off; (1 - knee) * hold / flow is how far it paints at full strength
// soak     surface volume at which pickup runs at its full rate
// soften   colour a pass takes on from the surface even when the tool is
//          full and no paint is moving -- this is wet-on-wet blending
// envelope how much the footprint's coverage shape is smoothed away from
//          the bristle streaks. Small for a steel knife edge, large for a
//          blender that should not stamp any pattern of its own
// smudge   isotropic diffusion strength. This is what a blender actually
//          does; smearing a footprint along a path only makes stripes
// jitter   how much the bristle pattern shifts between dabs; without it
//          repeated passes stack the same ribs into corduroy
// bleed    how freely paint spreads sideways through the bristle bed. High for
//          soft brushes, which homogenise into one mixed colour; near zero for
//          a steel blade, which genuinely does not
// dryOut   fill-fraction lost per footprint-length travelled
// spacing  dab spacing as a fraction of tool size
// aspect   footprint height / width

const BRUSH_DEFAULTS = {
  category: 'brush',
  aspect: 1,
  spacing: 0.060,
  hold: 3.6,
  flow: 1.50,
  pickup: 3.5,
  knee: 0.3,
  soak: 0.9,
  bleed: 0.9,
  soften: 1.1,
  jitter: 0.05,
  dryOut: 0.1,
  body: 0.85,
  wetness: 1.0,
  level: 0.0,
  scrape: 0.0,
  maxVolume: 1.9,
  followStroke: false,
  angle: 0,
  pressureSize: 0.45,
  pressureFlow: 0.65,
  inches: 1.0,
  range: [0.1, 4.0],
};

function tool(def) {
  const t = { ...BRUSH_DEFAULTS, ...def };
  t.mask = rasterizeMask(t.shape, MASK_RES, t.envelope);
  return t;
}

export const TOOLS = [
  tool({
    id: 'brush-2inch',
    name: '2" Landscape Brush',
    short: '2"',
    rackName: '2 inch',
    blurb:
      'The one he reaches for constantly. Skies, water, big clouds, the base of every tree and bush. Drag it flat to blend, tap its corner to build.',
    shape: flatMask({ teeth: 30, fray: 0.24, softV: 0.30 }),
    inches: 2.0,
    range: [0.5, 5.0],
    hold: 16.0,
    flow: 1.37,
    pickup: 4.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.055,
    envelope: 0.055,
    smudge: 0.05,
    soften: 0.3,
    dryOut: 0.05,
    aspect: 0.55,
    spacing: 0.05,
    body: 0.8,
    followStroke: false,
  }),
  tool({
    id: 'brush-1inch',
    name: '1" Landscape Brush',
    short: '1"',
    rackName: '1 inch',
    blurb: 'Same brush, half the reach. Smaller skies, tree trunks, tighter blending.',
    shape: flatMask({ teeth: 20, fray: 0.26, softV: 0.32, seed: 11 }),
    inches: 1.0,
    range: [0.25, 3.0],
    hold: 14.0,
    flow: 1.43,
    pickup: 4.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.055,
    envelope: 0.055,
    smudge: 0.05,
    soften: 0.3,
    dryOut: 0.06,
    aspect: 0.58,
    spacing: 0.055,
  }),
  tool({
    id: 'brush-fan',
    name: 'Fan Brush',
    short: 'Fan',
    rackName: 'Fan',
    blurb:
      'Evergreens, clouds, distant forests, grass. Tap downward with the tip for boughs; sweep it sideways for soft cloud edges.',
    shape: fanMask({ clumps: 9 }),
    inches: 1.6,
    range: [0.3, 3.0],
    hold: 8.0,
    flow: 1.62,
    pickup: 3.0,
    knee: 0.35,
    soak: 0.9,
    bleed: 0.7,
    jitter: 0.012,
    envelope: 0.03,
    soften: 0.22,
    dryOut: 0.14,
    aspect: 0.62,
    spacing: 0.068,
    body: 0.95,
    followStroke: false,
    pressureSize: 0.30,
  }),
  tool({
    id: 'brush-round',
    name: 'Round Foliage Brush',
    short: 'Round',
    rackName: 'Round',
    blurb: 'Bushes, foothills, the soft ragged mass of a distant treeline. Tap, never drag.',
    shape: roundMask({ clumps: 15 }),
    inches: 0.75,
    range: [0.15, 2.5],
    hold: 8.0,
    flow: 1.69,
    pickup: 3.0,
    knee: 0.35,
    soak: 0.9,
    bleed: 0.7,
    jitter: 0.05,
    envelope: 0.04,
    soften: 0.22,
    dryOut: 0.16,
    aspect: 1.0,
    spacing: 0.075,
    body: 0.95,
  }),
  tool({
    id: 'brush-filbert',
    name: 'Filbert Brush',
    short: 'Filb',
    rackName: 'Filbert',
    blurb: 'Soft oval tip. Rounded highlights, petals, gentle blending in tight spots.',
    shape: filbertMask(),
    inches: 0.6,
    range: [0.1, 2.0],
    hold: 9.0,
    flow: 1.49,
    pickup: 3.5,
    knee: 0.3,
    soak: 0.9,
    bleed: 0.9,
    jitter: 0.04,
    envelope: 0.045,
    smudge: 0.04,
    soften: 0.26,
    dryOut: 0.09,
    aspect: 1.3,
    spacing: 0.068,
    followStroke: true,
  }),
  tool({
    id: 'brush-oval',
    name: 'Oval Brush',
    short: 'Oval',
    rackName: 'Oval',
    blurb: 'Broad and soft. Good for laying big washes of colour and for gentle blends.',
    shape: filbertMask({ teeth: 24, seed: 14 }),
    inches: 1.4,
    range: [0.3, 3.0],
    hold: 14.0,
    flow: 1.37,
    pickup: 4.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.05,
    envelope: 0.055,
    smudge: 0.05,
    soften: 0.3,
    dryOut: 0.07,
    aspect: 1.0,
    spacing: 0.062,
  }),
  tool({
    id: 'brush-liner',
    name: '#2 Script Liner',
    short: 'Liner',
    rackName: 'Liner',
    blurb:
      'Thin the paint right down with odorless thinner first. Twigs, branches, wave foam, cabin details -- and your signature.',
    shape: linerMask(),
    inches: 0.12,
    range: [0.02, 0.6],
    hold: 7.0,
    flow: 1.89,
    pickup: 2.5,
    knee: 0.25,
    soak: 0.9,
    bleed: 0.8,
    jitter: 0.006,
    envelope: 0.012,
    soften: 0.12,
    dryOut: 0.1,
    aspect: 5.0,
    spacing: 0.038,
    body: 0.55,
    followStroke: true,
    pressureSize: 0.70,
  }),
  tool({
    id: 'brush-detail',
    name: 'Detail Round',
    short: 'Det',
    rackName: 'Detail',
    blurb: 'Small, tight, controllable. Little highlights and final touches.',
    shape: roundMask({ clumps: 8, soft: 0.4, seed: 21 }),
    inches: 0.3,
    range: [0.05, 1.2],
    hold: 6.0,
    flow: 1.69,
    pickup: 2.5,
    knee: 0.3,
    soak: 0.9,
    bleed: 0.8,
    jitter: 0.03,
    envelope: 0.02,
    soften: 0.16,
    dryOut: 0.11,
    aspect: 1.0,
    spacing: 0.068,
    followStroke: false,
  }),
  tool({
    id: 'knife-10',
    name: '#10 Painting Knife',
    short: '#10',
    rackName: 'No. 10',
    blurb:
      'Mountains. Load a roll of paint on the long edge, press, and pull down -- let it break up on the way for rock face.',
    category: 'knife',
    shape: knifeMask(),
    inches: 2.8,
    range: [0.6, 6.0],
    hold: 30.0,
    flow: 1.82,
    pickup: 6.0,
    knee: 0.2,
    soak: 0.6,
    bleed: 0.15,
    jitter: 0.004,
    envelope: 0.01,
    soften: 0.14,
    dryOut: 0.09,
    aspect: 0.16,
    spacing: 0.032,
    body: 1.25,
    level: 0.35,
    maxVolume: 2.4,
    followStroke: true,
    pressureSize: 0.15,
    pressureFlow: 0.80,
  }),
  tool({
    id: 'knife-5',
    name: '#5 Painting Knife',
    short: '#5',
    rackName: 'No. 5',
    blurb: 'The small knife. Cabin walls, fence posts, tight rock edges, cutting in a horizon.',
    category: 'knife',
    shape: knifeMask({ bevel: 0.03, seed: 16 }),
    inches: 1.5,
    range: [0.3, 3.5],
    hold: 26.0,
    flow: 1.82,
    pickup: 5.5,
    knee: 0.2,
    soak: 0.6,
    bleed: 0.15,
    jitter: 0.004,
    envelope: 0.01,
    soften: 0.14,
    dryOut: 0.09,
    aspect: 0.22,
    spacing: 0.03,
    body: 1.25,
    level: 0.35,
    maxVolume: 2.4,
    followStroke: true,
    pressureSize: 0.15,
  }),
  tool({
    id: 'knife-scrape',
    name: 'Knife Scrape',
    short: 'Scr',
    rackName: 'Scraper',
    blurb:
      'Turn the knife over and take paint off. Perfect for cutting a clean water line or fixing a happy accident.',
    category: 'knife',
    shape: knifeMask({ bevel: 0.02, seed: 19 }),
    inches: 2.0,
    range: [0.3, 5.0],
    hold: 1.0,
    flow: 0.00,
    pickup: 0.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 0.15,
    jitter: 0.004,
    envelope: 0.01,
    soften: 0.0,
    dryOut: 0.1,
    aspect: 0.2,
    spacing: 0.03,
    scrape: 0.55,
    followStroke: true,
  }),
  tool({
    id: 'util-blender',
    name: 'Clean Blender',
    short: 'Blend',
    rackName: 'Blender',
    blurb:
      'A dry 2" brush with no paint on it. Pure blending -- softens edges, pulls mist across mountains, feathers a horizon away.',
    category: 'utility',
    shape: flatMask({ teeth: 8, fray: 0.12, softV: 0.6, seed: 23 }),
    inches: 2.0,
    range: [0.4, 5.0],
    hold: 1.5,
    flow: 0.22,
    pickup: 1.2,
    knee: 0.4,
    soak: 0.9,
    bleed: 1.2,
    jitter: 0.09,
    envelope: 0.09,
    smudge: 0.95,
    soften: 0.55,
    dryOut: 0.2,
    aspect: 0.6,
    spacing: 0.045,
    body: 0.35,
    level: 0.25,
    noLoad: true,
  }),
  tool({
    id: 'util-rag',
    name: 'Rag / Wipe',
    short: 'Rag',
    rackName: 'Rag',
    blurb: 'Wipe back to bare canvas. Every happy accident has a way out.',
    category: 'utility',
    shape: ragMask(),
    inches: 1.8,
    range: [0.3, 4.5],
    hold: 1.0,
    flow: 0.00,
    pickup: 0.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.06,
    envelope: 0.07,
    smudge: 0.3,
    soften: 0.0,
    dryOut: 0.1,
    aspect: 1.0,
    spacing: 0.075,
    scrape: 0.85,
    noLoad: true,
  }),
];

export const TOOLS_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

export const TOOL_CATEGORIES = [
  { id: 'brush', label: 'Brushes' },
  { id: 'knife', label: 'Knives' },
  { id: 'utility', label: 'Utility' },
];
