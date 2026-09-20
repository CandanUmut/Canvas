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

// A cotton-duck weave: two thread directions, alternating which lies on top.
// The peaks of this are what a dry brush skips across, and that skipping is
// how Bob got sparkling highlights on a mountain with one stroke.
float canvasWeave(vec2 px) {
  vec2 t = px / max(uWeaveScale, 1.0);
  float over = step(0.5, fract((floor(t.x) + floor(t.y)) * 0.5));
  float warp = cos(fract(t.x) * TAU);
  float weft = cos(fract(t.y) * TAU);
  float h = mix(weft, warp, over) * 0.5 + 0.5;
  float slub = hash12(floor(t)) * 0.16 + hash12(floor(t * 0.25)) * 0.10;
  return clamp(h * 0.72 + slub + 0.06, 0.0, 1.0);
}

// How much of this bristle actually reaches the surface here. Light pressure
// only touches the weave peaks; heavy pressure floods the valleys too.
float contactAmount(vec2 px, float bristle, float volume, float height, float wetness) {
  float weave = canvasWeave(px);
  // Wet paint fills the canvas tooth, but never all of it -- paint has a
  // surface of its own. Without this floor a light touch over an already
  // painted area covered like a full press, and "barely touch it so the
  // highlight breaks up" stopped working after the first layer.
  float tooth = weave * uWeaveDepth * max(0.30, 1.0 - volume * 1.2);
  // Ridges resist the tool only once they have set up. Wet impasto is soft,
  // and charging it as tooth made a fresh pile of paint HARDER to pick up
  // than bare canvas -- exactly backwards on the palette.
  tooth += height * 0.55 * weave * (1.0 - wetness);
  float press = uPressure * bristle;
  float soft = 0.05 + uPressure * 0.26;
  return smoothstep(tooth - soft, tooth + soft, press);
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

// Mix two paints. w is the share of the second one, and the blend is linear.
vec3 mixPaint(vec3 a, float ta, vec3 b, float tb, float w) {
  w = clamp(w, 0.0, 1.0);
  if (w <= 0.0005) return a;
  if (w >= 0.9995) return b;
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

// "under" is how much paint is already there. A thin film cannot bury a
// thick pile -- without that term one pass of a white brush turned a pile of
// Phthalo Blue on the palette 88% white, so mixing ran backwards.
float hidingPower(float give, float under) {
  float o = uOpacity * uOpacity;
  // A thin film cannot bury a thick pile. Without this, one pass of a white
  // brush turned a whole pile of Phthalo Blue on the palette 88% white and
  // mixing ran backwards. But the reference depth matters: a canvas carries
  // about one layer, while a squeezed pile is five deep, so comparing against
  // the raw depth also stopped paint covering the canvas and left every
  // stroke looking like coloured glass.
  float resist = under * 0.22;
  return (1.0 - exp(-give * o * 3.0)) * (give / (give + resist + 1e-4));
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

// A light touch only meets the top of what is already there, which is how you
// lay paint onto a thickly covered canvas without dragging up everything
// underneath.
float penetrated(float volume, float contact) {
  return min(volume, volume * contact + 0.05);
}

// Volume this dab lays onto one surface pixel.
float giveVolume(float bristle, float contact, float load) {
  return uFlow * uDeplete * bristle * contact * min(load / max(uKnee, 1e-4), 1.0);
}

// Volume this dab lifts off one surface pixel. A pass touches a given pixel
// 1/uDeplete times, so the per-dab amount is capped such that one pass can
// never lift more than 90% of what is there -- otherwise a well-loaded knife
// (which holds a lot, so uHold is large) scrapes the canvas bare on contact.
float takeVolume(float bristle, float contact, float volume, float wetness, float load) {
  float here = penetrated(volume, contact);
  float avail = clamp(here / max(uSoak, 1e-4), 0.0, 1.0);
  float amt = uPickup * uDeplete * bristle * contact * avail * wetness * uHold * (1.0 - load);
  return min(amt, 0.9 * here * uDeplete);
}

// The same two transfers, as a change in the bristle's fill fraction. A
// texel's own holding is uHold * footprintArea/RES^2 * bristle, so bristle
// cancels and the fill fraction ends up independent of mask and resolution.
float giveLoad(float contact, float load) {
  return uFlow * uDeplete * contact * min(load / max(uKnee, 1e-4), 1.0) / max(uHold, 1e-4);
}
float takeLoad(float contact, float volume, float wetness, float load) {
  float avail = clamp(penetrated(volume, contact) / max(uSoak, 1e-4), 0.0, 1.0);
  return uPickup * uDeplete * contact * avail * wetness * (1.0 - load);
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
  float bristle = texture(uBristle, vUV).r;

  res.a = max(res.a - uDryOut, 0.0);
  if (bristle <= 0.001) { outReservoir = res; return; }

  vec2 px = brushToCanvas(vUV);
  vec2 cuv = px / uCanvasSize;
  if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) {
    outReservoir = res;
    return;
  }

  vec4 paint = texture(uPaint, cuv);
  vec4 surf = texture(uSurf, cuv);
  float contact = contactAmount(px, bristle, paint.a, surf.r, surf.g);
  if (contact <= 0.001) { outReservoir = res; return; }

  // A palette is a paint source, not a surface being painted: the bristles
  // drink from it and lose nothing back.
  float wet = max(surf.g, uPalette);
  float tk = takeLoad(contact, paint.a, wet, res.a);
  float gv = uPalette > 0.5 ? 0.0 : giveLoad(contact, res.a);

  float remain = max(res.a - gv, 0.0);
  float total = clamp(remain + tk, 0.0, 1.0);

  // Colour crosses over even when no paint does. A brush that is already full
  // still takes on what it is dragged through -- that is what makes wet-on-wet
  // work at all, and without it a freshly loaded brush stayed at tube strength
  // no matter how much wet Liquid White it was pulled across.
  float soften = uSoften * uDeplete * contact * min(paint.a, 1.0);
  float weight = (tk + soften) / max(remain + tk + soften, 1e-5);

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
    colour = mixPaint(colour, uTint, a.rgb, uTint, wa / total);
    colour = mixPaint(colour, uTint, b.rgb, uTint, wb / (wc + wa + wb));
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

uniform float uCanvasTint;
uniform float uBrushTint;
uniform float uBody;
uniform float uWetness;
uniform float uMaxVolume;
uniform float uLevel;
uniform float uScrape;
uniform float uClearMix;

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

  float bristle = texture(uBristle, b).r;
  if (bristle <= 0.001) { outPaint = paint; outSurf = surf; return; }

  float contact = contactAmount(px, bristle, paint.a, surf.r, surf.g);
  if (contact <= 0.001) { outPaint = paint; outSurf = surf; return; }

  vec4 res = texture(uReservoir, b);

  if (uScrape > 0.0) {
    float lift = uScrape * bristle * contact;
    outPaint = vec4(paint.rgb, max(paint.a - lift, 0.0));
    outSurf = vec4(max(surf.r - lift * 1.5, 0.0), surf.g, surf.b, surf.a);
    return;
  }

  float wet = max(surf.g, uPalette);
  float give = giveVolume(bristle, contact, res.a);
  float take = takeVolume(bristle, contact, paint.a, wet, res.a);

  // A mixture you made on the palette has to stay there to reload from.
  if (uPalette > 0.5) take = 0.0;

  float remain = max(paint.a - take, 0.0);
  float colourGive = give * (1.0 - uClearMix);

  vec3 colour = paint.rgb;
  if (colourGive > 0.00001) {
    colour = (remain <= 0.0005)
      ? res.rgb
      : mixPaint(paint.rgb, uCanvasTint, res.rgb, uBrushTint, colourGive / (remain + colourGive));
    colour = mix(colour, res.rgb, hidingPower(colourGive, remain));
  }

  float volume = clamp(remain + give, 0.0, uMaxVolume);
  if (uPalette > 0.5) volume = max(volume, paint.a);

  float height = surf.r - take * 0.9 + give * uBody * 0.85;
  height = mix(height, height * 0.35, uLevel * contact);
  height = clamp(height, 0.0, 2.5);

  float wetness = max(surf.g, uWetness * step(0.00001, give));
  float body = mix(surf.b, uBody, clamp(give * 2.0, 0.0, 1.0));

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
    colour = mix(colour, uColour, hidingPower(give, paint.a));
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
layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outSurf;
void main() {
  vec4 p = texture(uPaint, vUV);
  vec4 s = texture(uSurf, vUV);
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
uniform float uReplace;   // 1 = wipe first, 0 = add to what is there
out vec4 outReservoir;
void main() {
  float bristle = texture(uBristle, vUV).r;
  vec4 res = texture(uReservoir, vUV);
  outReservoir = vec4(uColour, clamp(uLoad * step(0.001, bristle), 0.0, 1.0));
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
  float weave = canvasWeave(uv * uCanvasSize) * uWeaveDepth;
  return s.r * uRelief + weave * (1.0 - cover * 0.75) * 0.16;
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
  float hL = heightAt(vUV - vec2(uTexel.x, 0.0));
  float hR = heightAt(vUV + vec2(uTexel.x, 0.0));
  float hD = heightAt(vUV - vec2(0.0, uTexel.y));
  float hU = heightAt(vUV + vec2(0.0, uTexel.y));
  vec3 n = normalize(vec3((hL - hR) * 12.0, (hD - hU) * 12.0, 1.0));

  vec3 L = normalize(uLightDir);
  float diffuse = 0.80 + 0.45 * dot(n, L);

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float sheen = uVarnish + surf.g * uGloss;
  float spec = pow(max(dot(n, H), 0.0), 26.0) * sheen * cover;

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

  float give = uAmount * m * (1.0 - uClearMix);
  vec3 colour = paint.rgb;
  if (give > 0.0001) {
    colour = (paint.a <= 0.0005)
      ? uColour
      : mixPaint(paint.rgb, uCanvasTint, uColour, uColourTint, give / (paint.a + give));
    colour = mix(colour, uColour, hidingPower(give, paint.a));
  }

  float dome = pow(m, 0.55);
  // A squeezed pile is DEEP. It has to hold many brush-loads, or dipping into
  // it can never fill a brush -- the old ceiling of 2.4 meant one pile held a
  // twenty-second of what a 2" brush carries.
  outPaint = vec4(colour, min(paint.a + uAmount * m, 8.0));
  outSurf = vec4(min(surf.r + dome * uBody * 0.9, 2.5), max(surf.g, uWetness), uBody, surf.a);
}
`;
