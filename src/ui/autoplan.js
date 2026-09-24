// Planning a painting the way a person would paint it.
//
// The first picture-to-painting mode was a painterly *renderer*: a grid over
// the whole picture at five scales, a short straight stroke at every cell that
// was wrong, and every one of those strokes dipped fresh in the exact colour
// the photograph had at that spot. It could get the picture, but nobody paints
// like that, and it did not look like oil: six and a half thousand stubs, each
// a perfectly matched swatch, march across the picture like a filter. The
// starting idea here was that oil looks like oil because a person mixes for a
// passage, lays long strokes that follow the form, and lets the brush carry
// wet paint from stroke to stroke. The first two held up. The third, on a wet
// ground, washed the picture out -- see autopaint.js.
//
// This plans a painting the way Bob paints one instead:
//
//   * Block in with the big brush wherever it fits, then work down the rack
//     into what it had no room for. The brush fits the SHAPE -- a shape being
//     bounded by the edges in the picture -- so a sky is a 2" job and a twig
//     is a round's.
//   * Work back to front. For a landscape that is top to bottom, near enough.
//   * Strokes curve along the forms and stop at a hard edge, or when the
//     picture under them drifts off the colour they started on.
//   * Each dip is mixed for the passage it is about to paint, and covers a
//     run of neighbouring strokes that want roughly that colour. How the
//     brush is refilled between them is the executor's business: see
//     autopaint.js, where the first idea -- let it run down -- is recorded
//     along with why it washed the picture out.
//   * Tap the textured passages -- leaves, bushes, grass -- rather than drag.
//   * Highlights last, with a light touch.
//
// Everything here is pure arithmetic over the picture, no DOM and no GL, so a
// plan can be made and inspected in Node in a second or two. autopaint.js is
// what carries a plan out with the real brushes.

// --- colour -----------------------------------------------------------------

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB 0..1 -> OKLab. Distances in OKLab track what an eye calls "different". */
export function oklab(r, g, b) {
  r = toLin(r); g = toLin(g); b = toLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// A small deterministic generator, so the same picture plans the same painting
// and a change to the planner can be compared against the last one.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// --- image helpers ------------------------------------------------------------

function boxBlur(src, w, h, ch, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = Math.round(r);
  for (let c = 0; c < ch; c++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      let n = 0;
      for (let x = -k; x <= k; x++) if (x >= 0 && x < w) { acc += src[(y * w + x) * ch + c]; n++; }
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * ch + c] = acc / n;
        const xo = x - k;
        const xi = x + k + 1;
        if (xo >= 0) { acc -= src[(y * w + xo) * ch + c]; n--; }
        if (xi < w) { acc += src[(y * w + xi) * ch + c]; n++; }
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      let n = 0;
      for (let y = -k; y <= k; y++) if (y >= 0 && y < h) { acc += tmp[(y * w + x) * ch + c]; n++; }
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * ch + c] = acc / n;
        const yo = y - k;
        const yi = y + k + 1;
        if (yo >= 0) { acc -= tmp[(yo * w + x) * ch + c]; n--; }
        if (yi < h) { acc += tmp[(yi * w + x) * ch + c]; n++; }
      }
    }
  }
  return out;
}

/** Downsample an rgb image by an integer-ish factor, averaging. */
function shrink(rgb, w, h, sw, sh) {
  const out = new Float32Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) {
    const y0 = Math.floor((y * h) / sh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / sh));
    for (let x = 0; x < sw; x++) {
      const x0 = Math.floor((x * w) / sw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / sw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * w + xx) * 3;
        r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; n++;
      }
      const o = (y * sw + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

/**
 * Stretch the picture's values to the full range, keeping its hues.
 *
 * A photograph of a painting is lit, and the light eats the ends of the value
 * range: in the photo of Bob's mountain the brightest snow measures #c9d0bb, a
 * warm light grey, and the eye only reads it as white because of what is next
 * to it. Paint that faithfully and the snow comes out grey and the whole
 * picture comes out muddy. A painter working from that photo paints the snow
 * WHITE -- they know it is white -- and that is a levels adjustment: the
 * brightest half a per cent goes to near-white, the darkest to near-black.
 * Luminance only, so a warm picture stays warm.
 */
function levels(rgb, n) {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  const sorted = Float32Array.from(L).sort();
  const lo = sorted[Math.floor(n * 0.005)];
  const hi = sorted[Math.floor(n * 0.995)];
  if (hi - lo < 0.05) return;
  const targetLo = 0.04;
  const targetHi = 0.96;
  for (let i = 0; i < n; i++) {
    const l = L[i];
    const t = Math.max(0, Math.min(1, (l - lo) / (hi - lo)));
    const want = targetLo + t * (targetHi - targetLo);
    // Scale the colour so its luminance becomes `want`, then pull any channel
    // that overflowed back towards grey rather than clipping it -- clipping
    // shifts hue, and a sky clipped in its blue channel turns cyan.
    const k = l > 1e-4 ? want / l : 1;
    let r = rgb[i * 3] * k, g = rgb[i * 3 + 1] * k, b = rgb[i * 3 + 2] * k;
    const m = Math.max(r, g, b);
    if (m > 1) {
      const f = (1 - want) / Math.max(1e-4, m - want);
      r = want + (r - want) * f; g = want + (g - want) * f; b = want + (b - want) * f;
    }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
}

/**
 * How far each pixel is from the nearest wall -- a strong edge in the picture,
 * or the picture's own border. This is the one number a painter judges before
 * choosing a brush: a 2" brush needs an inch of room either side of its
 * centre, a twig needs a liner. Chamfer distance, two passes, small-image px.
 */
function roomMap(wall, w, h) {
  const d = new Float32Array(w * h).fill(1e6);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (wall[i] || x === 0 || y === 0 || x === w - 1 || y === h - 1) d[i] = 0.5;
  }
  const A = 1, B = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + A);
    if (y > 0) {
      d[i] = Math.min(d[i], d[i - w] + A);
      if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + B);
      if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + B);
    }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + A);
    if (y < h - 1) {
      d[i] = Math.min(d[i], d[i + w] + A);
      if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + B);
      if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + B);
    }
  }
  return d;
}

const percentile = (arr, q) => Float32Array.from(arr).sort()[Math.min(arr.length - 1, Math.floor(arr.length * q))];

// The brushes a person would reach for, biggest first, and the room each needs.
const RACK = [
  { tool: 'brush-2inch', inches: 2.0, pressure: 0.62, maxLen: 10, perLoad: 6 },
  { tool: 'brush-1inch', inches: 1.0, pressure: 0.56, maxLen: 8, perLoad: 6 },
  { tool: 'brush-filbert', inches: 0.5, pressure: 0.52, maxLen: 6, perLoad: 8 },
  { tool: 'brush-round', inches: 0.22, pressure: 0.5, maxLen: 5, perLoad: 10 },
];

// --- the plan ----------------------------------------------------------------

/**
 * @param target  {data: Float32Array rgb 0..1, width, height}
 * @param opts    {inchesWide = 24, seed = 7, highlights = 90}
 * @returns {loads: [{stage, rgb, tool, inches, pressure, strokes: [[x,y]...][], taps: bool}]}
 *          Coordinates are in target pixels, y down.
 *
 * SHAPES are bounded by the picture's edges, not by colour. A first version
 * cut the picture into colour clusters and let each brush work only inside
 * one; on Bob's painting a smooth sky gradient became a stack of thin bands
 * of different clusters, none with room for a big brush, and the plan had
 * not one 2" stroke in it. A painter sees the sky as one shape whose colour
 * changes, paints it with a big brush, and dips a slightly different colour
 * as they go down. So: room is distance to the nearest EDGE, strokes stop at
 * a hard edge or when the picture under them drifts too far from where they
 * started, and each dip takes its colour from the passage it is about to
 * paint.
 */
export function planPainting(target, opts = {}) {
  const { width: W, height: H, data } = target;
  const rand = rng(opts.seed ?? 7);
  const pxPerInch = W / (opts.inchesWide ?? 24);

  // Work at a modest resolution: plenty to find shapes, cheap enough to plan
  // in a second. Everything is scaled back to target pixels at the end.
  const sw = Math.min(W, 240);
  const sh = Math.max(1, Math.round((H * sw) / W));
  const S = W / sw;
  const n = sw * sh;
  const small = shrink(data, W, H, sw, sh);
  levels(small, n);

  const lab = new Float32Array(n * 3);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = oklab(small[i * 3], small[i * 3 + 1], small[i * 3 + 2]);
    lab[i * 3] = o[0]; lab[i * 3 + 1] = o[1]; lab[i * 3 + 2] = o[2];
    lum[i] = o[0];
  }
  const labSoft = boxBlur(lab, sw, sh, 3, 1);

  // Edges, from the unsoftened picture. The top tenth bound the shapes a
  // brush has to fit inside; the top two per cent stop a stroke outright.
  const edge = new Float32Array(n);
  for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
    const i = y * sw + x;
    edge[i] = Math.hypot(lum[i + 1] - lum[i - 1], lum[i + sw] - lum[i - sw]);
  }
  const wallAt = percentile(edge, 0.90);
  const stopAt = percentile(edge, 0.98);
  const wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) wall[i] = edge[i] > wallAt ? 1 : 0;
  const room = roomMap(wall, sw, sh);

  // Texture: how busy the picture is at each spot. Sky and water are quiet;
  // foliage and grass are loud, and the loud passages get tapped.
  const lumBlur = boxBlur(lum, sw, sh, 1, 2);
  const lumSq = new Float32Array(n);
  for (let i = 0; i < n; i++) lumSq[i] = lum[i] * lum[i];
  const lumSqBlur = boxBlur(lumSq, sw, sh, 1, 2);
  const tex = new Float32Array(n);
  for (let i = 0; i < n; i++) tex[i] = Math.sqrt(Math.max(0, lumSqBlur[i] - lumBlur[i] * lumBlur[i]));
  const texCut = percentile(tex, 0.72);

  // Flow: along the forms, from a softened picture so strokes follow shapes
  // rather than every blade of grass.
  const soft = boxBlur(lum, sw, sh, 1, 3);
  const flowAt = (x, y) => {
    const xi = Math.min(sw - 2, Math.max(1, x | 0));
    const yi = Math.min(sh - 2, Math.max(1, y | 0));
    const i = yi * sw + xi;
    const gx = soft[i + 1] - soft[i - 1];
    const gy = soft[i + sw] - soft[i - sw];
    const m = Math.hypot(gx, gy);
    // Where nothing much is happening -- a sky, a lake -- Bob's strokes are
    // horizontal. That is not a fallback, it is the convention.
    if (m < 0.004) return null;
    return [-gy / m, gx / m];
  };

  // How far the picture may drift from where a stroke started before the
  // stroke stops: one stroke is one colour of paint, and dragging it from a
  // blue passage into a cream one lays blue where cream belongs.
  const DRIFT = 0.09;
  const at = (x, y) => Math.min(sh - 1, Math.max(0, y | 0)) * sw + Math.min(sw - 1, Math.max(0, x | 0));

  // Draw a stroke from a seed, both ways, following the flow. Points in
  // small-image pixels.
  const streamline = (x0, y0, stepPx, maxSteps, lean, need = 0) => {
    const i0 = at(x0, y0);
    const L0 = labSoft[i0 * 3], A0 = labSoft[i0 * 3 + 1], B0 = labSoft[i0 * 3 + 2];
    const walk = (sign) => {
      const pts = [];
      let x = x0, y = y0;
      let dir = null;
      for (let k = 0; k < maxSteps; k++) {
        let f = flowAt(x, y);
        if (!f) f = [Math.cos(lean), Math.sin(lean)];
        if (dir && f[0] * dir[0] + f[1] * dir[1] < 0) f = [-f[0], -f[1]];
        if (!dir) f = [f[0] * sign, f[1] * sign];
        // A brush cannot turn on a pin.
        if (dir && f[0] * dir[0] + f[1] * dir[1] < 0.55) break;
        const nx = x + f[0] * stepPx;
        const ny = y + f[1] * stepPx;
        if (nx < -1 || ny < -1 || nx > sw || ny > sh) break;
        const i = at(nx, ny);
        if (edge[i] > stopAt) break;
        if (need > 0 && room[i] < need * 0.7) break;
        const dl = labSoft[i * 3] - L0, da = labSoft[i * 3 + 1] - A0, db = labSoft[i * 3 + 2] - B0;
        if (dl * dl + da * da + db * db > DRIFT * DRIFT) break;
        pts.push([nx, ny]);
        dir = f; x = nx; y = ny;
      }
      return pts;
    };
    const fwd = walk(1);
    const back = walk(-1);
    return [...back.reverse(), [x0, y0], ...fwd];
  };

  const toTarget = (pts) => pts.map(([x, y]) => [x * S + S * 0.5, y * S + S * 0.5]);

  // What colour to mix for ONE dip: the picture under the strokes that dip is
  // about to paint. A painter mixes for the passage in front of them. The
  // number of dips stays small; each one is right where it goes.
  const dipColour = (strokes) => {
    let r = 0, g = 0, b = 0, c = 0;
    for (const st of strokes) for (const [tx, ty] of st) {
      const i = at(tx / S, ty / S);
      r += small[i * 3]; g += small[i * 3 + 1]; b += small[i * 3 + 2]; c++;
    }
    return c ? [r / c, g / c, b / c] : [0.5, 0.5, 0.5];
  };

  // Group strokes into dips the way a hand works: a dip goes on painting
  // while the next stroke wants roughly the same colour, and a new dip is
  // mixed when it does not. Averaging a fixed run of strokes instead mixed a
  // dip for a band right across the foreground -- a green tree, orange bushes
  // and blue water -- and every one of those dips came out mud.
  const TOL = 0.13;   // OKLab distance a dip will stretch to cover
  const toDips = (strokes, maxPer) => {
    const dips = [];
    let cur = null;
    for (const st of strokes) {
      const rgb = dipColour([st]);
      const lab1 = oklab(rgb[0], rgb[1], rgb[2]);
      if (cur && cur.strokes.length < maxPer) {
        const d = Math.hypot(lab1[0] - cur.lab[0], lab1[1] - cur.lab[1], lab1[2] - cur.lab[2]);
        if (d < TOL) {
          cur.strokes.push(st);
          const k = 1 / cur.strokes.length;
          cur.lab = cur.lab.map((v, j) => v + (lab1[j] - v) * k);
          continue;
        }
      }
      cur = { strokes: [st], lab: lab1 };
      dips.push(cur);
    }
    return dips.map((d) => d.strokes);
  };

  // The order a hand moves in: across the picture in bands, back and forth,
  // top band first. Consecutive strokes are then neighbours, so a dip's
  // strokes are near each other as well as alike.
  const handOrder = (items, band, key = (it) => it) => {
    return items
      .map((it) => { const [x, y] = key(it); const b = Math.floor(y / band); return [b, b % 2 ? -x : x, it]; })
      .sort((p, q) => p[0] - q[0] || p[1] - q[1])
      .map((t) => t[2]);
  };

  // One coverage map for the whole painting, so a smaller brush fills in what
  // a bigger one had no room for, and nothing is left bare.
  const covered = new Uint8Array(n);
  const cover = (pts, r) => {
    const rr = Math.max(0.5, r);
    const ri = Math.ceil(rr);
    for (const [px, py] of pts) {
      const cx = Math.round(px), cy = Math.round(py);
      for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy > rr * rr) continue;
        const xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && yy >= 0 && xx < sw && yy < sh) covered[yy * sw + xx] = 1;
      }
    }
  };

  const loads = [];

  // Stages 1-2 -- block in with the big brush wherever it fits, then work
  // down the rack into what it had no room for. Within each brush, back to
  // front: top of the picture first, which for a landscape is the sky.
  for (const [ti, b] of RACK.entries()) {
    const r = (b.inches * pxPerInch) / S / 2; // brush half-width, small px
    const last = ti === RACK.length - 1;
    const need = last ? 0 : r * 0.85;
    // The smallest brush is for what is genuinely THIN -- twigs, trunks, the
    // edge of a roof -- not for chasing every sliver along every edge. Those
    // close up on their own when wet paint meets wet paint.
    const prevNeed = ti > 0 ? ((RACK[ti - 1].inches * pxPerInch) / S / 2) * 0.85 : Infinity;
    const cell = Math.max(1.2, r * (last ? 1.7 : 1.1));
    const seeds = [];
    for (let y = cell * 0.5; y < sh; y += cell) for (let x = cell * 0.5; x < sw; x += cell) {
      const jx = x + (rand() - 0.5) * cell * 0.8, jy = y + (rand() - 0.5) * cell * 0.8;
      const i = at(jx, jy);
      if (covered[i] || room[i] < need) continue;
      // A small brush in the open middle of a shape is the big brush's job.
      if (ti > 0 && room[i] >= prevNeed * 1.4) continue;
      seeds.push([jx, jy]);
    }
    const ordered = handOrder(seeds, cell * 2.5);
    const strokes = [];
    for (const [x, y] of ordered) {
      const i = at(x, y);
      if (covered[i]) continue;
      // Quiet passages -- sky, water -- lean near horizontal, with a little
      // wobble so no two strokes are parallel.
      const lean = tex[i] < texCut ? (rand() - 0.5) * 0.5 : (rand() - 0.5) * 0.3;
      let pts = streamline(x, y, Math.max(0.8, r * 0.9), b.maxLen, lean, need);
      if (pts.length < 2) pts = [[x, y], [x + 0.6, y]];
      cover(pts, r * 1.05);
      strokes.push(toTarget(pts));
    }
    for (const group of toDips(strokes, b.perLoad)) {
      loads.push({
        stage: ti < 2 ? 'block-in' : 'shapes', rgb: dipColour(group),
        tool: b.tool, inches: b.inches, pressure: b.pressure, strokes: group, taps: false,
      });
    }
  }

  // Stage 3 -- texture. The loud passages get tapped with the fan brush,
  // darks before lights, so light leaves sit on top of shadowed ones.
  const fanIn = 0.9;
  const fanPx = (fanIn * pxPerInch) / S;
  const spacing = Math.max(1.2, fanPx * 0.7);
  const taps = [];
  for (let y = spacing * 0.5; y < sh; y += spacing) for (let x = spacing * 0.5; x < sw; x += spacing) {
    const jx = x + (rand() - 0.5) * spacing * 0.9;
    const jy = y + (rand() - 0.5) * spacing * 0.9;
    const i = at(jx, jy);
    if (tex[i] < texCut) continue;
    // Tap more where the picture is busiest.
    if (rand() > 0.5 + 0.5 * Math.min(1, tex[i] / (texCut * 2))) continue;
    taps.push([lum[i], toTarget([[jx, jy]])]);
  }
  // Darks first, so the light leaves sit on top of the shadowed ones; each
  // half in the order a hand would tap across the picture.
  const midL = taps.length ? percentile(taps.map((t) => t[0]), 0.5) : 0;
  const tapPt = (t) => t[1][0];
  for (const half of [taps.filter((t) => t[0] < midL), taps.filter((t) => t[0] >= midL)]) {
    const ordered = handOrder(half, spacing * S * 3, tapPt).map((t) => t[1]);
    for (const group of toDips(ordered, 10)) {
      loads.push({ stage: 'texture', rgb: dipColour(group), tool: 'brush-fan', inches: fanIn, pressure: 0.5, strokes: group, taps: true });
    }
  }

  // Stage 4 -- highlights. The brightest spots that stand out from their
  // surroundings, laid last and light: snow catching the sun, the top of a
  // bush, a glint on the water. Capped, because a highlight that is
  // everywhere is not a highlight.
  const hi = [];
  for (let y = 2; y < sh - 2; y++) for (let x = 2; x < sw - 2; x++) {
    const i = y * sw + x;
    const lift = lum[i] - lumBlur[i];
    if (lift > 0.06 && lum[i] > 0.7) hi.push([lift, x, y, i]);
  }
  hi.sort((p, q) => q[0] - p[0]);
  const taken = new Uint8Array(n);
  const hiStrokes = [];
  for (const [, x, y, i] of hi) {
    if (hiStrokes.length >= (opts.highlights ?? 90)) break;
    if (taken[i]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && xx >= 0 && yy < sh && xx < sw) taken[yy * sw + xx] = 1;
    }
    hiStrokes.push([y, toTarget(streamline(x, y, 1.0, 3, 0))]);
  }
  const hiOrdered = handOrder(hiStrokes, 12 * S, (h) => h[1][0]).map((h) => h[1]);
  for (const group of toDips(hiOrdered, 12)) {
    // A touch lighter than what is there: the light is what a highlight is FOR.
    const base = dipColour(group);
    const rgb = base.map((v) => Math.min(1, v * 0.6 + 0.4));
    loads.push({ stage: 'highlights', rgb, tool: 'brush-filbert', inches: 0.3, pressure: 0.3, strokes: group, taps: false });
  }

  return { loads };
}
