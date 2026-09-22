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
 * Fan brush.
 *
 * The hairs leave a flat ferrule in a shallow arc, and what touches the canvas
 * when you tap with it is the TIPS -- a row of short, separate needle clusters
 * with air between them and ragged ends. Not long rays.
 *
 * Drawing them as rays from a pivot below the footprint, which is what this
 * used to do, gives every touch the outline of a folding hand-fan: a wedge of
 * straight lines converging to a point. It reads as a graphic, and a tree built
 * out of it reads as wallpaper however much the clumps are shuffled.
 */
function fanMask({ clumps = 11, arc = 0.20, seed = 2 } = {}) {
  const bundles = [];
  for (let i = 0; i < clumps; i++) {
    const t = ((i + 0.5) / clumps) * 2 - 1;      // -1..1 across the ferrule
    bundles.push({
      t,
      // Hairs lean outwards, and by quite different amounts -- a bundle that
      // leans uniformly leaves a row of upright bars, which reads as a
      // barcode rather than as needles.
      lean: t * 0.26 + (rnd(i, seed + 4) - 0.5) * 0.44,
      w: 0.28 + 0.44 * rnd(i, seed + 1),          // half-width, in clump units
      reach: 0.34 + 0.66 * rnd(i, seed + 2),      // how far down the tips go
      dens: 0.60 + 0.40 * rnd(i, seed + 3),
      hairs: 5 + Math.floor(rnd(i, seed + 8) * 4),
    });
  }
  const pitch = 2 / clumps;

  return (u, v) => {
    // v: 0 at the ferrule, 1 at the tips. The arc lifts the outer clumps.
    const t = (u - 0.5) * 2;
    const lift = arc * t * t;
    let best = 0;
    for (const b of bundles) {
      // Where this clump sits at this height, leaning as it descends.
      const centre = b.t + b.lean * v;
      const d = Math.abs(t - centre) / (pitch * b.w);
      if (d > 1.3) continue;
      const across = smooth(1.3, 0.18, d);
      // Along the hairs: they start at the ferrule and stop at ragged tips.
      // Every hair in the clump ends somewhere different, so the tip of the
      // mark is ragged rather than cut off square.
      const tip = b.reach * (1 - lift) + 0.16 * noise1d(t * 23 + b.t * 7, seed + 5);
      const along = smooth(-0.04, 0.10, v) * smooth(tip + 0.12, tip - 0.10, v);
      // Individual hairs inside the clump: a few, and clearly separate.
      const hair = 0.42 + 0.58 * noise1d((t - centre) * b.hairs * 6.0 + b.t * 31, seed + 6);
      best = Math.max(best, across * along * hair * b.dens);
    }
    return best;
  };
}

/**
 * Round foliage brush.
 *
 * A bundle of hairs that splays into separate points when you press it. What
 * it leaves is a rough rosette of small marks with real gaps between them and
 * an irregular outline -- the gaps are what let the colour behind show through
 * a bush, and they are the whole reason this brush exists.
 *
 * Drawn as a disc with radial spokes, which is what this used to be, it leaves
 * a little wheel: a solid centre with lines coming off it. Tapped a hundred
 * times that reads as mush, not as leaves.
 */
function roundMask({ clumps = 13, seed = 3 } = {}) {
  const pts = [];
  for (let i = 0; i < clumps; i++) {
    const a = ((i + 0.5) / clumps) * Math.PI * 2 + (rnd(i, seed + 1) - 0.5) * 0.7;
    pts.push({
      a,
      // How far out this point sits, and how big a mark it makes. Points that
      // sit far out are smaller -- they are the few hairs that splayed widest.
      rad: 0.18 + 0.76 * rnd(i, seed + 2),
      size: 0.16 + 0.20 * rnd(i, seed + 3),
      dens: 0.62 + 0.38 * rnd(i, seed + 4),
      squash: 0.55 + 0.6 * rnd(i, seed + 7),
    });
  }
  return (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    if (dx * dx + dy * dy > 1.35) return 0;
    let best = 0;
    for (const p of pts) {
      const cx = Math.cos(p.a) * p.rad;
      const cy = Math.sin(p.a) * p.rad;
      // Each point is a small mark drawn out along the direction it splayed.
      const ex = dx - cx;
      const ey = dy - cy;
      const along = ex * Math.cos(p.a) + ey * Math.sin(p.a);
      const across = -ex * Math.sin(p.a) + ey * Math.cos(p.a);
      const d = Math.hypot(along / (p.size * 1.5), across / (p.size * p.squash));
      if (d > 1.25) continue;
      const hair = 0.55 + 0.45 * noise1d(across * 26 + p.a * 9, seed + 6);
      best = Math.max(best, smooth(1.25, 0.15, d) * hair * p.dens);
    }
    return best;
  };
}

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
    // A painting knife is a sheet of steel, and which way you look at it
    // matters. ACROSS the blade the edge is the crispest thing in the
    // toolbox -- that hard line is what cuts a ridge into a mountain, and
    // softening it turned every peak into a rounded lozenge. ALONG the blade
    // there is no edge at all, just paint running out, so the ends have to
    // fade or consecutive dabs stamp their corners down the stroke and a
    // mountain becomes a stack of bricks.
    //
    // u runs along the blade, v across its thickness.
    const ends = smooth(0, 0.16, u) * smooth(0, 0.16, 1 - u);

    // The roll of paint sits unevenly, so the blade meets the canvas at a
    // slightly different place along its length -- but it stays a hard edge.
    const rollA = 0.06 * noise1d(u * 3.4, seed + 2);
    const rollB = 0.06 * noise1d(u * 3.4 + 11, seed + 3);
    const edge = smooth(rollA, rollA + bevel * 0.6, v) * smooth(rollB, rollB + bevel * 0.6, 1 - v);

    // Loaded in patches: some stretches carry paint, some are scraped bare,
    // and the bare ones are what let the ground show through a knife stroke.
    // Whatever varies ALONG the blade gets swept into a line running down the
    // pull, because the blade travels edge-on: a ripple here does not read as
    // texture, it reads as corduroy. So the blade is mostly evenly loaded, and
    // the variation is the occasional bare patch where the roll has run out --
    // which is what lets the ground show through a knife stroke.
    const patch = noise1d(u * 2.4 + 20, seed + 6) * 0.72 + noise1d(u * 6.0 + 5, seed + 9) * 0.28;
    const load = 0.82 + 0.18 * smooth(0.30, 0.62, patch) - 0.55 * smooth(0.26, 0.10, patch);
    // NO fine grain along the blade. Steel has no hairs, and a ripple at this
    // pitch survives the envelope blur and comes out as parallel striations --
    // every pull down a mountain arrived combed, where a knife should leave a
    // flat plane. What a blade does vary is WHERE the roll of paint sits, and
    // that is `patch` above, which is coarse.
    const grain = 1.0;
    // Most of the paint comes off the trailing edge.
    const loadBias = 0.58 + 0.42 * smooth(0.66, 0.0, v);
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
// bristleBias  how much the bristle streaks drive COVERAGE rather than just
//          impasto. High for a fan brush, where the gaps between the clumps
//          are the whole effect; low for a flat brush laying a sky, where a
//          gap is just bare canvas showing through
// cut      per dab, the share of bristles that fail to catch the surface.
//          This is what stops a tool stamping an identical mark every touch
// angleJitter  per-dab wobble in how the tool is held, in radians
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

// `flow` is layers laid per footprint-length at full load. These were set when
// a tool laid and lifted paint at the same time, so roughly half of what a pass
// put down was scrubbed off again by the same pass; the numbers had to be
// nearly double what they meant. Transfer is one-way now, so they are what they
// say: one pass of the 2" brush leaves about four tenths of a layer.
const BRUSH_DEFAULTS = {
  category: 'brush',
  // How far the bundle rearranges from one contact to the next. A tool's
  // footprint is one picture, rasterised once, so without this every touch
  // stamps the identical shape and foliage comes out as wallpaper. Soft, loose
  // bundles move a lot; a flat brush held broadside moves little; steel does
  // not move at all.
  splay: 0.5,
  aspect: 1,
  spacing: 0.060,
  hold: 3.6,
  flow: 0.83,
  pickup: 3.5,
  knee: 0.3,
  soak: 0.9,
  bleed: 0.9,
  // The share of the canvas's colour a tool takes on per pass, whatever it is
  // already carrying -- mass and colour transfer are separate. Every tool sets
  // its own; this is only the floor.
  soften: 0.3,
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
    splay: 0.35,
    name: '2" Landscape Brush',
    short: '2"',
    rackName: '2 inch',
    blurb:
      'The one he reaches for constantly. Skies, water, big clouds, the base of every tree and bush. Drag it flat to blend, tap its corner to build.',
    shape: flatMask({ teeth: 30, fray: 0.24, softV: 0.30 }),
    inches: 2.0,
    range: [0.5, 5.0],
    hold: 16.0,
    flow: 0.75,
    pickup: 4.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.055,
    envelope: 0.055,
    bristleBias: 0.24,
    cut: 0.1,
    angleJitter: 0.035,
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
    splay: 0.38,
    name: '1" Landscape Brush',
    short: '1"',
    rackName: '1 inch',
    blurb: 'Same brush, half the reach. Smaller skies, tree trunks, tighter blending.',
    shape: flatMask({ teeth: 20, fray: 0.26, softV: 0.32, seed: 11 }),
    inches: 1.0,
    range: [0.25, 3.0],
    hold: 14.0,
    flow: 0.79,
    pickup: 4.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.055,
    envelope: 0.055,
    bristleBias: 0.24,
    cut: 0.1,
    angleJitter: 0.035,
    smudge: 0.05,
    soften: 0.3,
    dryOut: 0.06,
    aspect: 0.58,
    spacing: 0.055,
  }),
  tool({
    id: 'brush-fan',
    splay: 1.0,
    name: 'Fan Brush',
    short: 'Fan',
    rackName: 'Fan',
    blurb:
      'Evergreens, clouds, distant forests, grass. Tap downward with the tip for boughs; sweep it sideways for soft cloud edges.',
    shape: fanMask({ clumps: 9 }),
    inches: 1.6,
    range: [0.3, 3.0],
    hold: 8.0,
    flow: 0.89,
    pickup: 3.0,
    knee: 0.35,
    soak: 0.9,
    bleed: 0.7,
    jitter: 0.012,
    envelope: 0.008,
    bristleBias: 0.95,
    cut: 0.4,
    angleJitter: 0.22,
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
    splay: 0.95,
    name: 'Round Foliage Brush',
    short: 'Round',
    rackName: 'Round',
    blurb: 'Bushes, foothills, the soft ragged mass of a distant treeline. Tap, never drag.',
    shape: roundMask({ clumps: 15 }),
    inches: 0.75,
    range: [0.15, 2.5],
    hold: 8.0,
    flow: 0.93,
    pickup: 3.0,
    knee: 0.35,
    soak: 0.9,
    bleed: 0.7,
    jitter: 0.05,
    envelope: 0.014,
    bristleBias: 0.85,
    cut: 0.34,
    angleJitter: 0.6,
    soften: 0.22,
    dryOut: 0.16,
    aspect: 1.0,
    spacing: 0.075,
    body: 0.95,
  }),
  tool({
    id: 'brush-filbert',
    splay: 0.55,
    name: 'Filbert Brush',
    short: 'Filb',
    rackName: 'Filbert',
    blurb: 'Soft oval tip. Rounded highlights, petals, gentle blending in tight spots.',
    shape: filbertMask(),
    inches: 0.6,
    range: [0.1, 2.0],
    hold: 9.0,
    flow: 0.82,
    pickup: 3.5,
    knee: 0.3,
    soak: 0.9,
    bleed: 0.9,
    jitter: 0.04,
    envelope: 0.03,
    bristleBias: 0.45,
    cut: 0.18,
    angleJitter: 0.14,
    smudge: 0.04,
    soften: 0.26,
    dryOut: 0.09,
    aspect: 1.3,
    spacing: 0.068,
    followStroke: true,
  }),
  tool({
    id: 'brush-oval',
    splay: 0.4,
    name: 'Oval Brush',
    short: 'Oval',
    rackName: 'Oval',
    blurb: 'Broad and soft. Good for laying big washes of colour and for gentle blends.',
    shape: filbertMask({ teeth: 24, seed: 14 }),
    inches: 1.4,
    range: [0.3, 3.0],
    hold: 14.0,
    flow: 0.75,
    pickup: 4.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.05,
    envelope: 0.055,
    bristleBias: 0.26,
    cut: 0.1,
    angleJitter: 0.04,
    smudge: 0.05,
    soften: 0.3,
    dryOut: 0.07,
    aspect: 1.0,
    spacing: 0.062,
  }),
  tool({
    id: 'brush-liner',
    splay: 0.3,
    name: '#2 Script Liner',
    short: 'Liner',
    rackName: 'Liner',
    blurb:
      'Thin the paint right down with odorless thinner first. Twigs, branches, wave foam, cabin details -- and your signature.',
    shape: linerMask(),
    inches: 0.12,
    range: [0.02, 0.6],
    hold: 7.0,
    flow: 1.04,
    pickup: 2.5,
    knee: 0.25,
    soak: 0.9,
    bleed: 0.8,
    jitter: 0.006,
    envelope: 0.012,
    bristleBias: 0.35,
    cut: 0.08,
    angleJitter: 0.02,
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
    splay: 0.45,
    name: 'Detail Round',
    short: 'Det',
    rackName: 'Detail',
    blurb: 'Small, tight, controllable. Little highlights and final touches.',
    shape: roundMask({ clumps: 8, soft: 0.4, seed: 21 }),
    inches: 0.3,
    range: [0.05, 1.2],
    hold: 6.0,
    flow: 0.93,
    pickup: 2.5,
    knee: 0.3,
    soak: 0.9,
    bleed: 0.8,
    jitter: 0.03,
    envelope: 0.014,
    bristleBias: 0.7,
    cut: 0.26,
    angleJitter: 0.5,
    soften: 0.16,
    dryOut: 0.11,
    aspect: 1.0,
    spacing: 0.068,
    followStroke: false,
  }),
  tool({
    id: 'knife-10',
    // A knife is loaded by drawing a THIN ROLL of paint along its edge, never
    // by burying the whole blade. That roll is what lets one pull lay a clean
    // plane and then run out into broken rock, and it is how the blade keeps a
    // hard edge on the side that is cutting.
    dipRegion: { x0: -0.1, y0: -0.1, x1: 1.1, y1: 0.38 },
    splay: 0.0,
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
    flow: 1.0,
    pickup: 6.0,
    knee: 0.2,
    soak: 0.6,
    bleed: 0.15,
    jitter: 0.004,
    envelope: 0.01,
    // The blade's own picture drives coverage: not hairs, but the coarse
    // patches where the roll of paint sits and where it has run out. That
    // patchiness is what lets the ground show through a knife stroke.
    bristleBias: 0.45,
    cut: 0.2,
    angleJitter: 0.015,
    soften: 0.14,
    // A steel blade does not lose paint the way bristles do, and a knife's
    // footprint along the direction of travel is only its thickness -- so a
    // loss charged per footprint-length is charged to it thirty times over one
    // pull down a mountain. At 0.09 the blade ran out after four inches and
    // spent the rest of the stroke lifting paint instead of laying it.
    dryOut: 0.02,
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
    // A knife is loaded by drawing a THIN ROLL of paint along its edge, never
    // by burying the whole blade. That roll is what lets one pull lay a clean
    // plane and then run out into broken rock, and it is how the blade keeps a
    // hard edge on the side that is cutting.
    dipRegion: { x0: -0.1, y0: -0.1, x1: 1.1, y1: 0.38 },
    splay: 0.0,
    name: '#5 Painting Knife',
    short: '#5',
    rackName: 'No. 5',
    blurb: 'The small knife. Cabin walls, fence posts, tight rock edges, cutting in a horizon.',
    category: 'knife',
    shape: knifeMask({ bevel: 0.03, seed: 16 }),
    inches: 1.5,
    range: [0.3, 3.5],
    hold: 26.0,
    flow: 1.0,
    pickup: 5.5,
    knee: 0.2,
    soak: 0.6,
    bleed: 0.15,
    jitter: 0.004,
    envelope: 0.01,
    // The blade's own picture drives coverage: not hairs, but the coarse
    // patches where the roll of paint sits and where it has run out. That
    // patchiness is what lets the ground show through a knife stroke.
    bristleBias: 0.45,
    cut: 0.2,
    angleJitter: 0.015,
    soften: 0.14,
    // A steel blade does not lose paint the way bristles do, and a knife's
    // footprint along the direction of travel is only its thickness -- so a
    // loss charged per footprint-length is charged to it thirty times over one
    // pull down a mountain. At 0.09 the blade ran out after four inches and
    // spent the rest of the stroke lifting paint instead of laying it.
    dryOut: 0.02,
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
    splay: 0.0,
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
    flow: 0.0,
    pickup: 0.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 0.15,
    jitter: 0.004,
    envelope: 0.01,
    bristleBias: 0.4,
    cut: 0.15,
    angleJitter: 0.015,
    soften: 0.0,
    dryOut: 0.1,
    aspect: 0.2,
    spacing: 0.03,
    scrape: 0.55,
    followStroke: true,
  }),
  tool({
    id: 'util-blender',
    splay: 0.5,
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
    flow: 0.12,
    pickup: 1.2,
    knee: 0.4,
    soak: 0.9,
    bleed: 1.2,
    jitter: 0.09,
    envelope: 0.09,
    bristleBias: 0.1,
    cut: 0.05,
    angleJitter: 0.05,
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
    splay: 0.3,
    name: 'Rag / Wipe',
    short: 'Rag',
    rackName: 'Rag',
    blurb: 'Wipe back to bare canvas. Every happy accident has a way out.',
    category: 'utility',
    shape: ragMask(),
    inches: 1.8,
    range: [0.3, 4.5],
    hold: 1.0,
    flow: 0.0,
    pickup: 0.0,
    knee: 0.3,
    soak: 0.9,
    bleed: 1.0,
    jitter: 0.06,
    envelope: 0.07,
    bristleBias: 0.2,
    cut: 0.1,
    angleJitter: 0.3,
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
