// The paint simulation, as GLSL.
//
// Canvas state lives in two float textures:
//   paint : rgb = pigment colour, a = wet paint volume, in LAYERS
//           (1.0 = one fully covering layer)
//   surf  : r = impasto height, g = wetness, b = body/stiffness
//
// The tool carries a small texture, the "reservoir": rgb = the colour on the
// bristles, a = LOAD, a fill fraction in 0..1 where 1 means "as much paint as
// this tool can carry". Those two units are bridged by one per-tool number,
// `hold` -- how many layers deep a full tool's worth of paint is when spread
// over its own footprint. Keeping load as a fraction is what makes the load
// meter honest and what stops brush units and canvas units being added
// together, which they were.
//
// Blending happens because a bristle picks paint up at one dab and puts it
// down over the dabs that follow, which lie further along the stroke. That
// carry-forward is what smears a sky and drags a mountain's snow line.

import { SPECTRAL_GLSL } from '../vendor/spectral.glsl.js';

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUV;
`;

// Shared helpers: brush-space transforms, canvas weave, contact model.
const COMMON = /* glsl */ `
#define TAU 6.28318530718

uniform vec2  uCanvasSize;   // canvas in pixels
uniform vec2  uDabCenter;    // dab centre in pixels
uniform vec2  uDabSize;      // dab footprint (width, height) in pixels
uniform vec2  uDabDir;       // (cos, sin) of the brush angle
uniform float uPressure;     // 0..1 from the stylus (or 1 for mouse/finger)
uniform float uWeaveScale;   // canvas thread pitch, in pixels
uniform float uWeaveDepth;   // how toothy the canvas is
uniform vec2  uBristleOfs;   // per-dab shift of the bristle pattern
uniform float uBristleCut;   // per-dab: how many bristles fail to catch
uniform float uBristleBias;  // how much the streaks drive coverage, 0..1
uniform float uBristleSplay; // how far the bundle rearranges per contact
uniform float uSeed;         // one number per contact, held while it lasts

// Not every bristle picks up and lays down paint on every touch. Some are
// short of paint, some skip the surface entirely. Cutting a random share of
// them per dab is what stops a fan brush stamping the identical shell every
// time -- which is exactly what made foliage read as repeated clip-art
// instead of as a tree.
float catchBristle(float b) {
  return clamp((b - uBristleCut) / max(1.0 - uBristleCut, 0.05), 0.0, 1.0);
}

// How much paint this point of the footprint lays down. uBristleBias decides
// whether the bristle structure shows as real gaps (a fan brush tapping
// foliage, where the gaps ARE the effect) or is smoothed into continuous
// cover (a flat brush laying a sky, where gaps would just be bare canvas).
float layAmount(float cover, float bristle) {
  return cover * mix(1.0, bristle, uBristleBias);
}

// Bristles are not rigidly fixed: they splay and shift as you work. Sampling
// the mask at exactly the same offset every dab made each pass re-imprint the
// identical ribs, so repeated strokes stacked into hard corduroy and crossing
// strokes made a plaid.
// Where this point of the footprint reads from the tool's picture of itself.
//
// The picture is rasterised ONCE per tool, so without this every touch of a
// fan brush stamps the identical splay -- measured, one mark correlated 0.95
// with the next, and a knife 0.997 -- and a tree built out of them comes out
// as wallpaper. Real bristles do not do that. They are a loose bundle: press
// them down and they splay, clumps merge and separate, some bend away, some
// are short of paint. Set the same brush down twice and you get two different
// shapes.
//
// So the picture is re-arranged as it is read, per contact, by a seed that
// holds for as long as the tool is touching:
//
//   splay   the whole bundle spreads or gathers, more at the tips than at
//           the ferrule, which is what a brush does under pressure
//   comb    clumps slide sideways by different amounts, so they merge and
//           part differently every time
//   reach   clumps end at different lengths, so the silhouette is ragged
//
// Steel does none of this, so a knife passes uBristleSplay = 0 and reads its
// own picture straight.
float clumpNoise(float x, float seed) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin((i + seed) * 127.1) * 43758.5453);
  float b = fract(sin((i + 1.0 + seed) * 127.1) * 43758.5453);
  return mix(a, b, f) - 0.5;
}

vec2 bristleUV(vec2 b) {
  vec2 uv = b + uBristleOfs;
  if (uBristleSplay <= 0.0001) return uv;

  // Along the hairs: 0 at the ferrule, 1 at the tips. The bundle is held at
  // one end, so the far end moves and the held end does not.
  float along = clamp(uv.y, 0.0, 1.0);
  float lever = along * along;

  float t = uv.x - 0.5;
  // Splay: the whole bundle opens or closes about its middle.
  float splay = 1.0 + uBristleSplay * 0.55 * clumpNoise(uSeed * 0.37, 3.0) * lever;
  // Comb: neighbouring clumps slide by different amounts and merge.
  float comb = uBristleSplay * 0.22 * clumpNoise(t * 5.0 + uSeed, 11.0) * lever;
  // Reach: clumps end short or long, so the tips are never the same line.
  float reach = 1.0 + uBristleSplay * 0.30 * clumpNoise(t * 4.0 + uSeed * 1.7, 29.0);

  return vec2(0.5 + t * splay + comb, uv.y * reach);
}

vec2 brushToCanvas(vec2 b) {          // b in 0..1 brush space -> canvas pixels
  vec2 local = (b - 0.5) * uDabSize;
  return uDabCenter + vec2(
    local.x * uDabDir.x - local.y * uDabDir.y,
    local.x * uDabDir.y + local.y * uDabDir.x);
}

vec2 canvasToBrush(vec2 px) {         // canvas pixels -> 0..1 brush space
  vec2 d = px - uDabCenter;
  vec2 local = vec2(
     d.x * uDabDir.x + d.y * uDabDir.y,
    -d.x * uDabDir.y + d.y * uDabDir.x);
  return local / max(uDabSize, vec2(1.0)) + 0.5;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Smooth value noise. hash12 alone is blocky, and blocky irregularity reads
// as digital; a brush skipping across it needs the surface to rise and fall.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

// A cotton-duck weave: two thread directions, alternating which lies on top.
// The peaks of this are what a dry brush skips across, and that skipping is
// how Bob got sparkling highlights on a mountain with one stroke.
float weaveThreads(vec2 px) {
  vec2 t = px / max(uWeaveScale, 1.0);
  float over = step(0.5, fract((floor(t.x) + floor(t.y)) * 0.5));
  float warp = cos(fract(t.x) * TAU);
  float weft = cos(fract(t.y) * TAU);
  return mix(weft, warp, over) * 0.5 + 0.5;
}

float canvasWeave(vec2 px) {
  vec2 t = px / max(uWeaveScale, 1.0);
  float h = weaveThreads(px);

  // Threads alone are a perfect grid, and a perfect grid makes a dry stroke
  // break into machine stripes -- the same rows skip for the stroke's whole
  // length. Real cloth is never that even: it is stretched unevenly, the yarn
  // is slubby, and the ground is brushed on in ridges. These coarser swells
  // are what scatter a light stroke into irregular patches with bare gaps
  // between them, which is the whole look of scumbled colour.
  //
  // One octave of real noise for the broad swells, and a cosine whose phase
  // that noise drags around for the middle scale -- this runs for every pixel
  // of every dab, so it has to stay cheap.
  float swell = vnoise(t * 0.09);
  float mid = 0.5 + 0.5 * cos(t.x * 0.83 + t.y * 1.27 + swell * 6.2);
  float slub = hash12(floor(t)) * 0.10;

  return clamp(h * 0.42 + (swell * 0.68 + mid * 0.32) * 0.52 + slub + 0.04, 0.0, 1.0);
}

// How much of this bristle actually reaches the surface here. Light pressure
// only touches the weave peaks; heavy pressure floods the valleys too.
float contactAmount(vec2 px, float bristle, float volume, float height, float wetness) {
  float weave = canvasWeave(px);

  // How much relief the surface has: the canvas tooth, progressively filled in
  // as paint builds up, plus the ridges the paint itself is standing in.
  // Wet paint used to erase the relief almost entirely (a 0.22 floor), which
  // left the tooth smaller than the contact softness -- so on a wet ground
  // nothing but the bristle pattern decided contact, and since that pattern is
  // fixed for the length of a stroke, every drag came out as ruler-straight
  // bars. A loaded ground is not smooth: it is full of the ridges the last
  // brush left, and those ridges are exactly what the next stroke skips on.
  // The height term is a feedback loop -- a ridge laid by one stroke makes the
  // next stroke bite harder over it, which compounds into ruled lines -- so it
  // stays small. A wet ground does flatten the tooth, but not to nothing.
  float relief = uWeaveDepth * max(0.40, 1.0 - volume * 0.8) + height * 0.45;

  // GAP is how far BELOW the highest points this spot sits. A tool skimming a
  // surface meets the peaks first and only reaches the hollows when pressed.
  // This was inverted: relief was compared directly against pressure, so a
  // light touch painted the hollows and missed the peaks -- the exact opposite
  // of a dry brush, and the reason a stroke never broke up no matter how
  // lightly it was laid. "Just touch the top" depends entirely on this sign.
  float gap = (1.0 - weave) * relief;

  float press = uPressure * bristle;
  float soft = 0.035 + uPressure * 0.18;
  return smoothstep(gap - soft, gap + soft, press);
}
`;

// --- colour ----------------------------------------------------------------
//
// spectral.js weights each paint in a mixture by `factor^2 * tint^2 * Y`,
// where Y is the colour's luminance. Two consequences had to be undone:
//
//  * The squared factor. Passing a mixing weight w straight in makes the
//    effective weight w^2, so a brush holding paint picked up almost nothing:
//    at a realistic ratio it was 200x weaker than a plain linear blend. We
//    pass sqrt of the intended weights so the result is linear in w.
//  * The luminance term. Titanium White has Y = 1.0 and Phthalo Blue has
//    Y = 0.028, so colour on a brush only ever moved *lighter* -- white
//    picking up blue was 2400x weaker than blue picking up white. Dividing
//    the tint by sqrt(Y) cancels it, which finally lets the `tint` column in
//    colors.js mean what it claims: a pinhead of Phthalo Blue swallows a pile
//    of white, instead of the other way round.
const MIXING = /* glsl */ `
float tintKS(vec3 c, float tint) {
  float Y = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.004);
  // Cancelling the luminance term completely (exponent 0.5) made strong dark
  // pigments so dominant that Cadmium Yellow could never pull Phthalo Blue
  // towards green -- one part blue buried eight parts yellow. 0.4 leaves
  // Phthalo about four times the strength of the yellow, which is roughly
  // true of the real pigment and still lets you mix a green.
  return tint / pow(Y, 0.40);
}

// A symmetric subtractive blend, for spreading paint sideways through the
// bristle bed. Diffusion must not favour either side: mixPaint deliberately
// weights by tinting strength, and iterating that drove the whole brush to
// whichever pigment was strongest instead of averaging. Single-constant
// Kubelka-Munk in RGB is symmetric, still gives blue + yellow = green, and is
// about forty times cheaper than the spectral path.
//
// The floor matters. Clamping reflectance to 0.004 makes a zero channel blow
// up to K/S = 124 and drags every mix to mud; 0.03 keeps it well behaved.
float ksFwd(float c) {
  float r = clamp(c, 0.03, 1.0);
  return (1.0 - r) * (1.0 - r) / (2.0 * r);
}
float ksInv(float ks) {
  return clamp(1.0 + ks - sqrt(ks * ks + 2.0 * ks), 0.0, 1.0);
}
vec3 mixEven(vec3 a, vec3 b, float w) {
  w = clamp(w, 0.0, 1.0);
  if (w <= 0.0005) return a;
  vec3 ka = vec3(ksFwd(a.r), ksFwd(a.g), ksFwd(a.b));
  vec3 kb = vec3(ksFwd(b.r), ksFwd(b.g), ksFwd(b.b));
  vec3 k = mix(ka, kb, w);
  return vec3(ksInv(k.r), ksInv(k.g), ksInv(k.b));
}

// Mix two paints. w is the share of the second one, and the blend is linear.
vec3 mixPaint(vec3 a, float ta, vec3 b, float tb, float w) {
  w = clamp(w, 0.0, 1.0);
  if (w <= 0.0015) return a;
  if (w >= 0.9985) return b;
  return spectral_mix(a, tintKS(a, ta), sqrt(1.0 - w), b, tintKS(b, tb), sqrt(w));
}
`;

// Wet paint laid on wet paint does two things at once: some of it merges with
// what is underneath, and some of it simply sits on top and hides it. Spectral
// mixing alone only models the merging, which is why an opaque colour would
// otherwise refuse to cover -- Titanium White over Van Dyke Brown came out
// beige, because a dark pigment's low luminance dominates the weighting.
const COVERAGE = /* glsl */ `
uniform float uOpacity;   // 0 = pure glaze, 1 = buries what is underneath

// How deep the wet paint a fresh mark actually mixes into. Oil paint blends at
// the surface the brush meets, not through the full body of everything laid
// before it, and a layer is defined here as "fully covering" -- so the film
// that takes part is a good fraction of one.
#define MIX_FILM 0.55
// A pile is deeper than any mark a tool makes, so it gets its own ceiling.
#define PALETTE_MAX_VOLUME 6.0

// "under" is how much paint is already there. A thin film cannot bury a
// thick pile -- without that term one pass of a white brush turned a pile of
// Phthalo Blue on the palette 88% white, so mixing ran backwards.
// Churn is how much the tool stirs wet paint into what it lays. Bristles
// churn: they drag through the wet film and the two intermix, which is the
// whole of wet-on-wet. A knife does not: it presses stiff paint ON TOP of the
// wet film and slides off. The 0.70 below used to be a single figure trying to
// serve both -- a compromise between brushes blending into Liquid White and a
// knife getting snow onto a mountain -- and it served neither: midnight black
// pulled on with a knife came out mid-grey, [0.58], because it was being
// blended into the white as if bristles had worked it in.
float hidingPowerChurn(float give, float under, float wet, float churn) {
  // Hiding power is what a film of paint does to a layer that has SET. Over
  // paint that is still wet the two do not stack, they intermix -- which is
  // the whole of wet-on-wet, and the reason a coat of Liquid White goes down
  // before anything else. Without this, one pass of Titanium White over a wet
  // dark blue sky left it 93% white although it laid barely a quarter of a
  // layer, so every stroke sat on the picture like a decal and "let it dry"
  // changed nothing about how much the next layer covered.
  // Not all the way to nothing. An opaque pigment laid on THICKLY -- a knife
  // pressing a roll of Titanium White onto a wet dark mountain -- does sit on
  // top of what is under it, and at 0.85 snow could not be got onto a mountain
  // at all: one pull moved it 18% towards white and the peak stayed navy.
  float o = uOpacity * uOpacity * (1.0 - 0.70 * churn * clamp(wet, 0.0, 1.0));
  // A thin film cannot bury a thick pile. Without this, one pass of a white
  // brush turned a whole pile of Phthalo Blue on the palette 88% white and
  // mixing ran backwards. But the reference depth matters: a canvas carries
  // about one layer, while a squeezed pile is five deep, so comparing against
  // the raw depth also stopped paint covering the canvas and left every
  // stroke looking like coloured glass.
  // Only a genuinely DEEP bed of paint -- a squeezed pile on the palette, which
  // is several layers thick -- can resist being covered. A canvas carries about
  // one layer, and charging that as resistance stopped opaque paint covering
  // anything, which is why white never read as white and nothing was ever dark.
  float resist = max(0.0, under - 1.6) * 0.45;
  return (1.0 - exp(-give * o * 4.5)) * (give / (give + resist + 1e-4));
}

// Everything that is not a tool laying paint -- the base coat, a squeezed pile
// -- keeps the behaviour it was calibrated with.
float hidingPower(float give, float under, float wet) {
  return hidingPowerChurn(give, under, wet, 1.0);
}
`;

// How paint moves between the bristles and the surface.
//
// Deposit scales with what the tool holds; pickup scales with what is on the
// surface AND with the room left on the bristles. That `(1 - load)` headroom
// term is what makes dipping work: loading saturates fast instead of creeping
// up, so one pass through a pile fills a brush to about 80% and two fills it.
//
// Everything is per unit of distance travelled rather than per dab, via
// uDeplete -- the share of the footprint that is fresh surface this dab. Dabs
// overlap heavily, so a point is touched 1/uDeplete times as the tool passes
// and the two factors cancel. Without it a knife (dabs 3px apart) behaves
// nothing like a 2" brush.
const TRANSFER = /* glsl */ `
uniform float uDeplete;   // footprint-lengths travelled this dab
uniform float uFlow;      // layers laid per footprint-length at full load
uniform float uPickup;    // fill-fraction gained per footprint-length
uniform float uHold;      // layers a full tool carries: the unit bridge
uniform float uKnee;      // load below which the tool starts to run dry
uniform float uSoak;      // surface volume at which pickup runs at full rate
uniform float uPalette;   // 1 on the mixing palette: an endless paint source
uniform float uSoften;    // colour taken on per pass regardless of load

// How fast colour crosses into a tool too full to take any more paint. This
// lives in TRANSFER, not in COVERAGE: PICKUP_FRAG does not include COVERAGE,
// and putting it there cost a round of "why will the app not boot" -- a GLSL
// compile failure surfaces as window.studio never appearing, which looks
// nothing like a missing #define.
#define PALETTE_SWAP 0.40
// How much faster a pile fills a brush than a painting's surface film does.
#define PALETTE_LOAD 1.0
// How far past uSoak a palette keeps rewarding depth, so a pile outweighs a
// smear instead of being averaged with it.
#define PALETTE_DEPTH 6.0

// A light touch only meets the top of what is already there, which is how you
// lay paint onto a thickly covered canvas without dragging up everything
// underneath.
float penetrated(float volume, float contact) {
  return min(volume, volume * contact + 0.05);
}

// IMPaSTo's unidirectionality rule, which the rest of the model rests on: at
// any point under the tool it is either laying paint down or lifting it, never
// both, with a dead zone between so the two cannot oscillate. A tool with paint
// on it lays; a tool that has run down lifts, which is what a clean brush
// dragged across a wet sky is doing. uKnee -- already "the load at which the
// tool starts to run dry" -- is where it turns over.
//
// Running both at once meant a tool that had run out went on laying a trace
// while it lifted at the maximum rate, so one pull of a knife came out THINNER
// than the wet ground it was pulled across: -0.18 layers where it should have
// left about a third of one.
// What the tool is carrying where it touches, in CANVAS LAYERS rather than as
// a fraction of its own capacity -- capped at one covering layer, because only
// the film at the tip is in contact and the rest is further up the bristles.
//
// Load is a fill fraction, and the two are not the same question. A 2" brush
// holds about sixteen layers, so half a layer -- plenty to paint with, and far
// more than a wet sky carries -- reads as three per cent full. Judged on the
// fraction, a clean brush could lift an entire sky and still count as empty:
// it never laid any of it back down, so blending scrubbed a lattice of tracks
// through the sky where the criss-cross strokes crossed and lifted twice.
float tipFilm(float load) {
  return clamp(load * uHold / max(uSoak, 1e-4), 0.0, 1.0);
}

float layShare(float load) {
  return smoothstep(uKnee * 0.5, uKnee * 1.5, tipFilm(load));
}

// Volume this dab lays onto one surface pixel.
// layShare carries the taper as well as the direction: above the knee the tool
// lays at full rate, below it the mark thins out and then turns over into
// lifting. This is the mechanism blending works by -- a bristle picks paint up
// at one dab and puts it down over the dabs that follow, further along.
float giveVolume(float bristle, float contact, float load) {
  return uFlow * uDeplete * bristle * contact * layShare(load);
}

// Pickup, as a change in the bristle's fill fraction. A texel's own holding is
// uHold * footprintArea/RES^2 * bristle, so bristle cancels and the fill
// fraction comes out independent of mask and resolution. A pass touches a
// given pixel 1/uDeplete times, so the per-dab amount is capped such that one
// pass can never lift more than 90% of what is there.
float takeLoad(float contact, float volume, float wetness, float load) {
  float here = penetrated(volume, contact);
  float avail = clamp(here / max(uSoak, 1e-4), 0.0, 1.0);
  // How much room is left. On a painting surface only the tip is in contact,
  // so it is the film there that has room or has not. A brush pressed into a
  // PILE fills its whole bristle bed -- that is what a pile is -- and going by
  // the tip film there stopped it loading at about six per cent, so whatever
  // it crossed first swamped the mixture and every colour came off the board
  // nearly black.
  float room = 1.0 - mix(tipFilm(load), load, uPalette);

  // One-way transfer is a rule about a PAINTING, where a tool laying paint
  // must not scrub at the same time. A palette is not a painting: a pile
  // always gives, whether or not the tool is also laying paint down, and the
  // tool must be able to lay paint down or there is nowhere to mix. Gating
  // the board by the same rule made it pickup-only -- you could load a single
  // pigment off a pile and nothing else, and dragging two colours together
  // left the board untouched, because the brush could not put anything on it.
  float oneWay = mix(1.0 - layShare(load), 1.0, uPalette);
  // Pressing bristles into a PILE floods the bed: the paint is deep, it is
  // soft, and it goes up between the hairs at once. uPickup is scaled for the
  // other thing entirely -- lifting a thin film off a painting, a hair at a
  // time -- and using that rate on a pile meant a clean 2" brush dragged
  // right through a full pile of phthalo blue came away with 0.008 of a load,
  // under one per cent, when clicking the swatch gives 0.99. The colour was
  // correct and the quantity was nil, which from outside looks exactly like a
  // pile that has run dry.
  float flood = 1.0 + uPalette * PALETTE_LOAD * avail;

  // How much a tool takes should go with how much is THERE. avail saturates
  // at uSoak, which is right on a painting -- past a certain film depth a
  // bristle is simply in contact and more underneath changes nothing. A
  // palette is the opposite case: a pile five layers deep and a stray smear
  // two tenths deep are not the same offer, and saturating made them
  // identical. A brush is wide, a pile is not, and the footprint almost
  // always spans both -- so dipping into a pile beside your mixing picked the
  // mixing straight back up, and going back for a bit more blue handed you
  // green. Measured: pile 5.02 pure blue, smear 0.20 green, brush came away
  // 0.28,0.48,0.27.
  float depth = clamp(here / max(uSoak, 1e-4), 0.0, PALETTE_DEPTH);
  float draw = mix(avail, depth, uPalette);
  float amt = uPickup * uDeplete * contact * draw * wetness * room * oneWay * flood;
  // A pass can lift at most this share of the film it crosses. A dry brush
  // dragged over wet paint takes some of it up; it does not take nearly all
  // of it, and letting it meant a tool that had run out left a track scraped
  // back past the base coat.
  // The 45%-of-the-film cap is a rule about a PAINTING: a tool may lift some
  // of a thin film, never nearly all of it, or a brush that has run out
  // scrapes a track back past the base coat. A pile is not a film. It is a
  // reservoir deeper than the brush, and the room term above already stops it
  // from overfilling, so the cap has nothing left to protect there -- it just
  // throttles. Its value works out at 0.45 * here * uDeplete / uHold, and for
  // a 2" brush that is about two per cent of a load per pass NO MATTER how
  // deep the pile is, which is why raising the flooding rate changed nothing
  // until this came off: the cap, not the rate, was the binding constraint.
  float cap = 0.45 * here * uDeplete / max(uHold, 1e-4);
  return mix(min(amt, cap), amt, uPalette);
}

// The SAME transfer, said in the canvas's units. It has to be derived from the
// bristle's gain rather than computed again, or the two disagree: with an
// independent cap the canvas lost far more than the tool took on, so a second
// pass came out thinner than the first and a white brush scrubbed a blue band
// off a wet canvas instead of painting over it.
float takeVolume(float bristle, float contact, float volume, float wetness, float load) {
  return takeLoad(contact, volume, wetness, load) * uHold * bristle;
}

float giveLoad(float contact, float load) {
  return uFlow * uDeplete * contact * layShare(load) / max(uHold, 1e-4);
}
`;

// ---------------------------------------------------------------------------
// Pass 1 -- the bristles. Updates what the tool is carrying.
// ---------------------------------------------------------------------------
export const PICKUP_FRAG =
  HEAD +
  SPECTRAL_GLSL +
  MIXING +
  COMMON +
  TRANSFER +
  /* glsl */ `
uniform sampler2D uReservoir;
uniform sampler2D uBristle;
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform float uCanvasTint;
uniform float uBrushTint;
uniform float uDryOut;

out vec4 outReservoir;

void main() {
  vec4 res = texture(uReservoir, vUV);
  vec2 mask = texture(uBristle, bristleUV(vUV)).rg;
  float bristle = catchBristle(mask.r);
  float cover = mask.g;

  // Paint does not dry on a palette while you are mixing on it -- the whole
  // board is wet, and the tool is in it. Charging dryOut there made a longer
  // drag end with LESS on the brush than a short one: +/-20px gave 0.008 and
  // +/-110px gave 0.000, because the extra distance was spent off the pile
  // losing what had just been picked up.
  res.a = max(res.a - uDryOut * (1.0 - uPalette), 0.0);
  if (cover <= 0.003) { outReservoir = res; return; }

  vec2 px = brushToCanvas(vUV);
  vec2 cuv = px / uCanvasSize;
  if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) {
    outReservoir = res;
    return;
  }

  vec4 paint = texture(uPaint, cuv);
  vec4 surf = texture(uSurf, cuv);
  // Contact asks whether the TOOL is touching the canvas here, so it goes by
  // the footprint's envelope, with only a little of the hair pattern in it.
  // Feeding it the raw streaks made every fixed bristle gap cut a hard line
  // that the next overlapping dab reinforced instead of softening, and a sky
  // came out ruled like notepaper. How much paint leaves each hair is a
  // separate question, and layAmount below is where it belongs.
  float contact = contactAmount(px, mix(cover, bristle, 0.35), paint.a, surf.r, surf.g);
  if (contact <= 0.001) { outReservoir = res; return; }
  float lay = layAmount(cover, bristle);

  // A palette is a paint source, not a surface being painted: the bristles
  // drink from it and lose nothing back.
  float wet = max(surf.g, uPalette);
  float tk = takeLoad(contact, paint.a, wet, res.a) * lay;
  float gv = giveLoad(contact, res.a) * lay;

  float remain = max(res.a - gv, 0.0);
  float total = clamp(remain + tk, 0.0, 1.0);

  // Colour crosses over even when no paint does. A brush that is already full
  // still takes on what it is dragged through -- that is what makes wet-on-wet
  // work at all, and without it a freshly loaded brush stayed at tube strength
  // no matter how much wet Liquid White it was pulled across.
  //
  // Both sides of this ratio have to be VOLUMES. Weighing paint picked up (in
  // layers) against the load (a fill fraction at most 1.0) overstated the
  // pickup by a factor of uHold -- thirty times for a knife, which turned a
  // brown blade pure white inside one pull down a mountain.
  // Mass first: what the bristle actually took, against what it was holding.
  float held = remain * uHold;
  float gained = tk * uHold;
  float weight = gained / max(held + gained, 1e-5);
  // Then colour, which crosses the boundary even when no paint does. Only the
  // film at the very tip is in contact, so what the tool takes on is not
  // diluted by the whole load it is carrying -- weighing it against the full
  // reservoir made uSoften, which is written as a share taken on per pass,
  // worth about a thousandth of that. This is the decoupling WetBrush is
  // about, and it is what lets a brush already full of white come back
  // holding a pale blue after one pass across a wet sky.
  // Not on the palette. A board is a paint SOURCE: what the bristles come away
  // with there should be the proportion of each pile they crossed, by mass.
  // Letting the thin-film term run on the palette too made mixing drift to
  // whichever pigment was darkest -- three parts Sap Green to one of black
  // came off the board very nearly black -- because the tinting-strength
  // weighting compounds when it is applied over and over to a colour that is
  // already moving.
  float touch = uSoften * uDeplete * contact * min(paint.a, 1.0) * (1.0 - uPalette);
  weight = clamp(weight + touch * (1.0 - weight), 0.0, 1.0);

  // ...and on the palette, by exchange. Mass and colour are separate channels,
  // which is the whole point of WetBrush's decoupling, and the palette is
  // where ignoring it hurts most. Room above is 1 - load on a board, so a
  // brush at full load gains no mass there; with the thin-film term switched
  // off for the palette as well, a full brush was sealed shut -- no mass in,
  // no colour in. And since clicking a pigment swatch FILLS the brush, every
  // brush arrived at the palette already full. The result was a palette you
  // could not mix on at all: whatever you last clicked was the only colour you
  // could lay down, dragging through a second pile picked up nothing, and the
  // piles just sat there. Which is exactly what it looked like from outside.
  //
  // Pressing full bristles into a pile still moves paint: what is on the hairs
  // and what is in the pile interpenetrate and trade places. That is an
  // EXCHANGE at constant mass, not a pickup, so it is not gated by room -- it
  // is gated by the opposite, by how sealed the tool is, and it fills in
  // exactly the case mass transfer cannot reach. An empty brush gets its
  // colour by taking paint on and needs none of this; a full one gets it all
  // this way.
  //
  // Going by mass in contact rather than by tinting strength is also what
  // keeps this from drifting: the thin-film term is a tinting-strength mix
  // applied afresh every dab, so on a colour that is already moving it
  // compounds towards whichever pigment is strongest, and three parts Sap
  // Green to one of black came off the board nearly black. A volume swap is
  // symmetric and stays put.
  float avail = clamp(paint.a / max(uSoak, 1e-4), 0.0, 1.0);
  float sealed = mix(tipFilm(res.a), res.a, uPalette);
  float swap = PALETTE_SWAP * uPalette * uPickup * uDeplete * contact * lay * avail * sealed;
  weight = clamp(weight + swap * (1.0 - weight), 0.0, 1.0);

  vec3 colour = res.rgb;
  if (weight > 0.00001 && paint.a > 0.0001) {
    colour = (remain <= 0.0005)
      ? paint.rgb
      : mixPaint(res.rgb, uBrushTint, paint.rgb, uCanvasTint, weight);
  }

  outReservoir = vec4(colour, total);
}
`;

// ---------------------------------------------------------------------------
// Pass 2 -- the bristles again, sideways. Paint spreads along the bristle bed,
// so a brush dragged through two colours ends up carrying a mixture rather
// than stripes of each. Without this the reservoir stayed two-tone: measured
// across 3,244 loaded texels there were 1,566 pure white and 1,678 pure blue
// and not one texel in between, so the swatch promised a mix the brush could
// not actually paint.
// ---------------------------------------------------------------------------
export const BLEED_FRAG =
  HEAD +
  SPECTRAL_GLSL +
  MIXING +
  /* glsl */ `
uniform sampler2D uReservoir;
uniform sampler2D uBristle;
uniform vec2  uStep;       // one tap, in uv -- horizontal then vertical
uniform float uStrength;   // 0..0.6
uniform float uTint;

out vec4 outReservoir;

void main() {
  vec4 c = texture(uReservoir, vUV);
  if (uStrength <= 0.0005) { outReservoir = c; return; }

  vec4 a = texture(uReservoir, vUV - uStep);
  vec4 b = texture(uReservoir, vUV + uStep);

  float wa = a.a * uStrength * 0.5;
  float wb = b.a * uStrength * 0.5;
  float wc = max(c.a, 1e-5);
  float total = wc + wa + wb;

  vec3 colour = c.rgb;
  if (wa + wb > 1e-5) {
    colour = mixEven(colour, a.rgb, wa / total);
    colour = mixEven(colour, b.rgb, wb / total);
  }
  float load = c.a + (a.a + b.a - 2.0 * c.a) * uStrength * 0.5;
  outReservoir = vec4(colour, clamp(load, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------
// Pass 3 -- the surface. Lays paint down over the dab's bounding box.
// ---------------------------------------------------------------------------
export const DEPOSIT_FRAG =
  HEAD +
  SPECTRAL_GLSL +
  MIXING +
  COMMON +
  TRANSFER +
  COVERAGE +
  /* glsl */ `
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform sampler2D uReservoir;
uniform sampler2D uBristle;
uniform float uChurn;     // how much the tool stirs wet paint in: 1 bristles, low for a knife

uniform float uCanvasTint;
uniform float uBrushTint;
uniform float uBody;
uniform float uWetness;
uniform float uMaxVolume;
uniform float uLevel;
uniform float uScrape;
uniform float uClearMix;
uniform float uSmudge;   // isotropic diffusion: a real blender, not a smear
uniform float uSmudgeR;  // radius of the diffusion kernel, in canvas pixels

layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outSurf;

void main() {
  vec4 paint = texture(uPaint, vUV);
  vec4 surf = texture(uSurf, vUV);

  vec2 px = vUV * uCanvasSize;
  vec2 b = canvasToBrush(px);
  if (b.x < 0.0 || b.x > 1.0 || b.y < 0.0 || b.y > 1.0) {
    outPaint = paint; outSurf = surf; return;
  }

  vec2 mask = texture(uBristle, bristleUV(b)).rg;
  float bristle = catchBristle(mask.r);
  float cover = mask.g;       // the footprint's envelope
  if (cover <= 0.003) { outPaint = paint; outSurf = surf; return; }

  // Contact asks whether the TOOL is touching the canvas here, so it goes by
  // the footprint's envelope, with only a little of the hair pattern in it.
  // Feeding it the raw streaks made every fixed bristle gap cut a hard line
  // that the next overlapping dab reinforced instead of softening, and a sky
  // came out ruled like notepaper. How much paint leaves each hair is a
  // separate question, and layAmount below is where it belongs.
  float contact = contactAmount(px, mix(cover, bristle, 0.35), paint.a, surf.r, surf.g);
  if (contact <= 0.001) { outPaint = paint; outSurf = surf; return; }

  vec4 res = texture(uReservoir, b);

  if (uScrape > 0.0) {
    float lift = uScrape * cover * contact;
    outPaint = vec4(paint.rgb, max(paint.a - lift, 0.0));
    outSurf = vec4(max(surf.r - lift * 1.5, 0.0), surf.g, surf.b, surf.a);
    return;
  }

  float wet = max(surf.g, uPalette);
  float lay = layAmount(cover, bristle);
  float give = giveVolume(lay, contact, res.a);
  float take = takeVolume(lay, contact, paint.a, wet, res.a);

  // The palette gives paint up freely -- that is how a streak gets pulled out
  // of a pile and how the brush loads. What it does NOT do is get smaller for
  // it. See the volume floor below.

  float remain = max(paint.a - take, 0.0);
  float colourGive = give * (1.0 - uClearMix);

  // Paint laid on wet paint mixes at the INTERFACE, not through the whole
  // depth of what is already there. Weighing a dab against the entire
  // accumulated volume meant the more paint a canvas carried, the less any
  // further mark could say: a fan brush tapped onto a sky that had been worked
  // to a layer and a half moved it a seventh of the way to the colour on the
  // bristles, so a tree went on as a translucent haze with the sky showing
  // through it, however many times it was tapped. Bob's trees go on dark in
  // one or two touches, because the paint on the bristles sits ON the sky --
  // it does not homogenise with every coat underneath.
  float film = min(remain, MIX_FILM);
  vec3 colour = paint.rgb;
  if (colourGive > 0.00001) {
    colour = (remain <= 0.0005)
      ? res.rgb
      : mixPaint(paint.rgb, uCanvasTint, res.rgb, uBrushTint, colourGive / (film + colourGive));
    colour = mix(colour, res.rgb, hidingPowerChurn(colourGive, film, surf.g, uChurn));
  }

  // uMaxVolume is how much paint a MARK can hold -- a property of the tool
  // making it. A pile squeezed from a tube is deeper than any mark, so capping
  // it at the tool's figure snapped a fresh pile from 5 layers down to 1.9 the
  // instant a brush first touched it.
  float ceiling = max(uMaxVolume, uPalette * PALETTE_MAX_VOLUME);
  float volume = clamp(remain + give, 0.0, ceiling);


  float height = surf.r - take * 0.9 + give * uBody * 0.85 * (0.78 + 0.38 * bristle);
  height = mix(height, height * 0.35, uLevel * contact);
  // Wet paint sags. Without this, every overlapping pass leaves a ridge at its
  // edge and a blocked-in sky turns into corduroy of stroke-spaced lines.
  float settle = clamp(surf.g * 0.35 * contact, 0.0, 0.5);
  height = mix(height, height * 0.72, settle);
  height = clamp(height, 0.0, 1.6);

  float wetness = max(surf.g, uWetness * step(0.00001, give));
  float body = mix(surf.b, uBody, clamp(give * 2.0, 0.0, 1.0));

  // A blender does not push paint along a line -- dragging a footprint in
  // parallel passes is exactly what leaves corduroy. It softens what is
  // already there, equally in every direction, and it has to soften the
  // impasto with it or you get a blurred colour field with a crisp lit ridge
  // still sitting on top of it, which is a dead giveaway.
  if (uSmudge > 0.0001) {
    vec2 r = uSmudgeR / uCanvasSize;
    vec4 pa = texture(uPaint, vUV + vec2( r.x, 0.0));
    vec4 pb = texture(uPaint, vUV + vec2(-r.x, 0.0));
    vec4 pc = texture(uPaint, vUV + vec2(0.0,  r.y));
    vec4 pd = texture(uPaint, vUV + vec2(0.0, -r.y));
    vec4 sa = texture(uSurf,  vUV + vec2( r.x, 0.0));
    vec4 sb = texture(uSurf,  vUV + vec2(-r.x, 0.0));
    vec4 sc = texture(uSurf,  vUV + vec2(0.0,  r.y));
    vec4 sd = texture(uSurf,  vUV + vec2(0.0, -r.y));

    float wa = pa.a, wb = pb.a, wc = pc.a, wd = pd.a;
    float wsum = wa + wb + wc + wd;
    float k = clamp(uSmudge * cover * contact * uDeplete * 14.0, 0.0, 0.85);
    if (wsum > 1e-4 && k > 0.0005) {
      // Volume-weighted, so thin paint does not drag a thick neighbour around.
      vec3 avg = (pa.rgb * wa + pb.rgb * wb + pc.rgb * wc + pd.rgb * wd) / wsum;
      colour = mixEven(colour, avg, k);
      volume = mix(volume, wsum * 0.25, k * 0.7);
      height = mix(height, (sa.r + sb.r + sc.r + sd.r) * 0.25, k);
    }
  }

  // A palette does not run out. This is a simulation, and having to squeeze
  // more paint because you used some buys nothing: nobody here is short of
  // cadmium yellow, and being made to re-stock mid-mixture is pure friction
  // in the one place the tool should feel generous.
  //
  // This has to come AFTER the softening above, not before it. Every brush
  // carries a little soften, and that step averages volume with its
  // neighbours -- so at the edge of a pile, where the neighbours are bare
  // board, it pulled the pile down again a few passes later and the floor
  // above it did nothing. Measured: a pile at depth 5 was down to 4.07 after
  // eight passes with the floor supposedly holding it.
  if (uPalette > 0.5) volume = max(volume, paint.a);

  outPaint = vec4(colour, volume);
  outSurf = vec4(height, wetness, body, surf.a);
}
`;

export const FILL_FRAG =
  HEAD +
  SPECTRAL_GLSL +
  MIXING +
  COVERAGE +
  /* glsl */ `
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform vec3  uColour;
uniform float uColourTint;
uniform float uCanvasTint;
uniform float uAmount;    // volume laid down
uniform float uWetness;
uniform float uBody;
uniform float uReplace;   // 1 = wipe to bare canvas first
uniform float uClearMix;

layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outSurf;

void main() {
  vec4 paint = texture(uPaint, vUV);
  vec4 surf = texture(uSurf, vUV);

  if (uReplace > 0.5) {
    outPaint = vec4(uColour, uAmount);
    outSurf = vec4(0.0, uWetness, uBody, 0.0);
    return;
  }

  float give = uAmount * (1.0 - uClearMix);
  vec3 colour = paint.rgb;
  if (give > 0.0001) {
    colour = (paint.a <= 0.0005)
      ? uColour
      : mixPaint(paint.rgb, uCanvasTint, uColour, uColourTint, give / (paint.a + give));
    colour = mix(colour, uColour, hidingPower(give, paint.a, surf.g));
  }
  outPaint = vec4(colour, min(paint.a + uAmount, 2.5));
  outSurf = vec4(surf.r * 0.7, max(surf.g, uWetness), mix(surf.b, uBody, 0.5), surf.a);
}
`;

/** Let the paint set up, so later strokes sit on top instead of blending in. */
export const DRY_FRAG =
  HEAD +
  /* glsl */ `
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform float uAmount;   // 1 = bone dry

layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outSurf;

void main() {
  vec4 paint = texture(uPaint, vUV);
  vec4 surf = texture(uSurf, vUV);
  outPaint = paint;
  outSurf = vec4(surf.r, max(surf.g - uAmount, 0.0), surf.b, surf.a);
}
`;

/**
 * Copy, used for undo snapshots. Snapshots live in 8-bit textures to keep the
 * history from eating hundreds of megabytes, so volume and height are scaled
 * into 0..1 on the way in and scaled back out on the way in reverse.
 * Colour is left alone; only the alpha/height channels need the squeeze.
 */
export const COPY_FRAG =
  HEAD +
  /* glsl */ `
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform float uScale;
// Which part of the source stands for the rectangle being drawn. Full-frame
// copies pass 0,0,1,1; an undo step that only stored the patch it changed
// passes that patch, so a small texture lands in the right place.
uniform vec4 uSrcRect;
layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outSurf;
void main() {
  vec2 uv = (vUV - uSrcRect.xy) / max(uSrcRect.zw, vec2(1e-6));
  vec4 p = texture(uPaint, uv);
  vec4 s = texture(uSurf, uv);
  outPaint = vec4(p.rgb, p.a * uScale);
  outSurf = vec4(s.r * uScale, s.g, s.b * uScale, s.a);
}
`;

/** Fill the reservoir: dip the brush in a colour, or wipe it clean. */
export const LOAD_BRUSH_FRAG =
  HEAD +
  /* glsl */ `
uniform sampler2D uReservoir;
uniform sampler2D uBristle;
uniform vec3  uColour;
uniform float uLoad;
uniform float uReplace;   // 1 = wipe what is there, 0 = dip only part of it
uniform vec4  uRegion;    // x0, y0, x1, y1 in bristle space: which part to dip
uniform float uRegionSoft;
out vec4 outReservoir;

void main() {
  float bristle = texture(uBristle, vUV).r;
  vec4 res = texture(uReservoir, vUV);

  // Which part of the bristle bed is going into the paint. Dipping only a
  // corner, an edge or one side is not a flourish -- it is how a fan brush
  // lays a bough and its highlight in ONE touch, how the edge of a cloud is
  // caught, and how a mountain's lit side goes on. Without it the reservoir
  // could only ever hold one flat colour, whatever the tool.
  float k = uRegionSoft;
  float inX = smoothstep(uRegion.x - k, uRegion.x + k, vUV.x)
            * smoothstep(uRegion.z + k, uRegion.z - k, vUV.x);
  float inY = smoothstep(uRegion.y - k, uRegion.y + k, vUV.y)
            * smoothstep(uRegion.w + k, uRegion.w - k, vUV.y);
  float take = inX * inY * step(0.001, bristle);

  float load = mix(res.a, uLoad, take);
  vec3 colour = mix(res.rgb, uColour, take);
  // A full wipe still clears the hairs this dip does not reach.
  if (uReplace > 0.5) {
    load = mix(0.0, uLoad, take) + mix(0.0, 0.0, 1.0 - take);
    colour = mix(vec3(0.97, 0.96, 0.94), uColour, take);
    load = uLoad * take * step(0.001, bristle);
  }
  outReservoir = vec4(colour, clamp(load, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------
// Final render: paint over gesso, lit so impasto reads as real ridges.
// ---------------------------------------------------------------------------
export const RENDER_FRAG =
  HEAD +
  COMMON +
  /* glsl */ `
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform vec2  uTexel;
uniform vec3  uGesso;
uniform vec3  uLightDir;   // normalised, pointing at the light
uniform float uRelief;     // impasto exaggeration
uniform float uGloss;
uniform float uVarnish;    // overall sheen even where dry
uniform float uSquint;     // 1 = show values only, the squint test

out vec4 fragColour;

float heightAt(vec2 uv) {
  vec4 p = texture(uPaint, uv);
  vec4 s = texture(uSurf, uv);
  float cover = clamp(p.a * 1.9, 0.0, 1.0);
  // Twelve of these are taken per pixel to build the lighting normal, so it
  // uses only the thread pattern. The broad swells are far too gentle to show
  // in a normal anyway, and paying for them twelve times over was costing
  // more frame time than the painting itself.
  float weave = weaveThreads(uv * uCanvasSize) * uWeaveDepth;
  return s.r * uRelief + weave * (1.0 - cover * 0.80) * 0.16;
}

void main() {
  vec4 paint = texture(uPaint, vUV);
  vec4 surf = texture(uSurf, vUV);

  float weave = canvasWeave(vUV * uCanvasSize) * uWeaveDepth;
  float cover = clamp(paint.a * 1.9, 0.0, 1.0);

  // Bare canvas is not flat white -- the weave shades itself.
  vec3 base = uGesso * (0.93 + 0.07 * weave);
  vec3 albedo = mix(base, paint.rgb, cover);

  // Normal from the height field, so thick paint catches the light.
  // Sample a couple of texels out, and average a small cross, so the normal
  // comes from the shape of the paint rather than from single-pixel steps.
  vec2 e = uTexel * 1.8;
  float hL = (heightAt(vUV - vec2(e.x, 0.0)) + heightAt(vUV - vec2(e.x, e.y)) + heightAt(vUV - vec2(e.x, -e.y))) / 3.0;
  float hR = (heightAt(vUV + vec2(e.x, 0.0)) + heightAt(vUV + vec2(e.x, e.y)) + heightAt(vUV + vec2(e.x, -e.y))) / 3.0;
  float hD = (heightAt(vUV - vec2(0.0, e.y)) + heightAt(vUV - vec2(e.x, e.y)) + heightAt(vUV + vec2(e.x, -e.y))) / 3.0;
  float hU = (heightAt(vUV + vec2(0.0, e.y)) + heightAt(vUV + vec2(e.x, e.y)) + heightAt(vUV - vec2(e.x, -e.y))) / 3.0;
  // Shallow. A steep normal turns every brush mark into embossed plastic.
  vec3 n = normalize(vec3((hL - hR) * 5.5, (hD - hU) * 5.5, 1.0));

  vec3 L = normalize(uLightDir);
  float diffuse = 0.88 + 0.26 * dot(n, L);

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float sheen = uVarnish + surf.g * uGloss;
  float spec = pow(max(dot(n, H), 0.0), 34.0) * sheen * cover;

  vec3 colour = albedo * diffuse + vec3(spec);
  // Squinting at a painting is how you check its values without hue getting
  // in the way. This is that, as a view transform.
  if (uSquint > 0.0) {
    float y = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    colour = mix(colour, vec3(y), uSquint);
  }
  fragColour = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

/**
 * A blob of paint squeezed straight from the tube onto the palette: round,
 * thick in the middle, with a real ridge you can drag a brush through.
 */
export const BLOB_FRAG =
  HEAD +
  SPECTRAL_GLSL +
  MIXING +
  COVERAGE +
  /* glsl */ `
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform vec2  uCanvasSize;
uniform vec2  uCentre;    // pixels
uniform float uRadius;    // pixels
uniform vec3  uColour;
uniform float uColourTint;
uniform float uCanvasTint;
uniform float uAmount;
uniform float uBody;
uniform float uWetness;
uniform float uClearMix;
uniform float uSeed;
uniform float uReplace;   // 1 = re-assert a tube pile rather than mix into it

layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outSurf;

void main() {
  vec4 paint = texture(uPaint, vUV);
  vec4 surf = texture(uSurf, vUV);

  vec2 px = vUV * uCanvasSize;
  vec2 d = px - uCentre;
  // Squeezed paint is never a perfect circle.
  float wob = 1.0 + 0.16 * sin(atan(d.y, d.x) * 3.0 + uSeed) + 0.08 * sin(atan(d.y, d.x) * 7.0 - uSeed * 2.0);
  float r = length(d) / (uRadius * wob);

  float m = smoothstep(1.0, 0.72, r);
  if (m <= 0.001) { outPaint = paint; outSurf = surf; return; }

  // Re-asserting a pile rather than squeezing a fresh one onto what is there.
  // A tube pile is a SOURCE: you go back to it for more of that colour, and
  // it has to still be that colour when you do. Dragging a loaded brush
  // through one contaminates it -- measured, a phthalo blue pile came back
  // 0.35,0.70,0.18, which is a green -- so after a stroke the piles are laid
  // down again. Mixing into it is exactly what must NOT happen here, or the
  // restore inherits the contamination it is meant to undo.
  //
  // Only within the pile's own footprint, and only upward in depth, so a
  // mixture worked up next to a pile is never touched.
  if (uReplace > 0.5) {
    outPaint = vec4(mix(paint.rgb, uColour, m), max(paint.a, uAmount * m));
    outSurf = vec4(max(surf.r, pow(m, 0.55) * uBody * 0.9), max(surf.g, uWetness),
                   mix(surf.b, uBody, m), surf.a);
    return;
  }

  float give = uAmount * m * (1.0 - uClearMix);
  vec3 colour = paint.rgb;
  if (give > 0.0001) {
    colour = (paint.a <= 0.0005)
      ? uColour
      : mixPaint(paint.rgb, uCanvasTint, uColour, uColourTint, give / (paint.a + give));
    colour = mix(colour, uColour, hidingPower(give, paint.a, 0.0));
  }

  float dome = pow(m, 0.55);
  // A squeezed pile is DEEP. It has to hold many brush-loads, or dipping into
  // it can never fill a brush -- the old ceiling of 2.4 meant one pile held a
  // twenty-second of what a 2" brush carries.
  outPaint = vec4(colour, min(paint.a + uAmount * m, 8.0));
  outSurf = vec4(min(surf.r + dome * uBody * 0.9, 2.5), max(surf.g, uWetness), uBody, surf.a);
}
`;
