// The paint simulation, as GLSL.
//
// Canvas state lives in two float textures:
//   paint : rgb = pigment colour, a = wet paint volume
//   surf  : r = impasto height, g = wetness, b = body/stiffness, a = unused
//
// The brush carries its own small texture, the "reservoir": rgb = the colour
// currently on the bristles, a = how much paint is loaded. Every dab runs two
// passes -- the brush first picks paint UP off the canvas, then puts paint
// DOWN a few pixels further along the stroke. That displacement is the whole
// trick: it is what smears a sky, drags a mountain's snow line, and lets a
// dirty brush pull the colour underneath it into whatever you paint next.

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
float contactAmount(vec2 px, float bristle, float volume, float height) {
  float weave = canvasWeave(px);
  // Wet paint fills the canvas tooth, but never all of it -- paint has a
  // surface of its own. Without this floor a light touch over an already
  // painted area covered like a full press, and "barely touch it so the
  // highlight breaks up" stopped working after the first layer.
  float tooth = weave * uWeaveDepth * max(0.30, 1.0 - volume * 1.2);
  tooth += height * 0.55 * weave;          // ridges of impasto stick up
  float press = uPressure * bristle;
  float soft = 0.05 + uPressure * 0.26;
  return smoothstep(tooth - soft, tooth + soft, press);
}
`;

// Wet paint laid on wet paint does two things at once: some of it merges with
// what is underneath, and some of it simply sits on top and hides it. Spectral
// mixing alone only models the merging, which is why an opaque colour would
// otherwise refuse to cover -- Titanium White over Van Dyke Brown came out
// beige instead of white, because a dark pigment's low luminance dominates the
// Kubelka-Munk weighting. This is the covering half.
const COVERAGE = /* glsl */ `
uniform float uOpacity;   // 0 = pure glaze, 1 = buries what is underneath

float hidingPower(float give) {
  // Squared, so the palette spreads properly: one pass of Titanium White
  // buries what is under it, the same pass of Alizarin Crimson barely stains
  // it, and Van Dyke Brown sits in between. A linear term put everything in
  // the middle and made a whisper of Phthalo Blue cover like housepaint.
  float o = uOpacity * uOpacity;
  return 1.0 - exp(-give * o * 3.0);
}
`;

// Both the pickup and deposit passes must agree on how much paint moves, or
// the canvas gains or loses paint out of nowhere. One formula, used twice.
//
// Everything is expressed per unit of distance travelled, not per dab, via
// uDeplete -- the share of the footprint that is fresh canvas this dab. Dabs
// overlap heavily, so a pixel is hit 1/uDeplete times as the tool passes over
// it, and the two factors cancel: what lands on the canvas depends only on the
// tool and its load, never on how finely the stroke happened to be sampled.
// Without this a knife (dabs 3px apart) behaves nothing like a 2" brush.
const TRANSFER = /* glsl */ `
uniform float uPickup;    // how much of the existing paint a pass lifts
uniform float uFlow;      // volume laid down per pass at full load
uniform float uDeplete;   // fresh share of the footprint, 0..1

float takeAmount(float bristle, float contact, float volume, float wetness) {
  return uPickup * uDeplete * bristle * contact * min(volume, 1.5) * wetness;
}

float giveAmount(float bristle, float contact, float load) {
  return uFlow * uDeplete * bristle * contact * min(load, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 1 -- pickup. Runs at reservoir resolution, updating what is on the
// bristles from what they are currently sitting on.
// ---------------------------------------------------------------------------
export const PICKUP_FRAG =
  HEAD +
  SPECTRAL_GLSL +
  COMMON +
  TRANSFER +
  /* glsl */ `
uniform sampler2D uReservoir;
uniform sampler2D uBristle;
uniform sampler2D uPaint;
uniform sampler2D uSurf;
uniform float uCanvasTint;
uniform float uBrushTint;
uniform float uCapacity;   // how much paint the bristles hold before dripping
uniform float uDryOut;     // paint leaving the brush by evaporation/spread

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
  float contact = contactAmount(px, bristle, paint.a, surf.r);
  float take = takeAmount(bristle, contact, paint.a, surf.g);

  // Subtract what the deposit pass is about to lay down. Without this the
  // bristles are an infinite paint supply, every stroke stays at full tube
  // strength, and nothing ever blends -- a brush has to run out.
  float give = giveAmount(bristle, contact, res.a);
  float remain = max(res.a - give, 0.0);
  float total = remain + take;

  if (total <= 0.00001) { outReservoir = vec4(res.rgb, 0.0); return; }

  vec3 mixed = res.rgb;
  if (remain <= 0.0001) {
    mixed = paint.rgb;
  } else if (take > 0.0001) {
    mixed = spectral_mix(res.rgb, uBrushTint, remain, paint.rgb, uCanvasTint, take);
  }

  outReservoir = vec4(mixed, min(total, uCapacity));
}
`;

// ---------------------------------------------------------------------------
// Pass 2 -- deposit. Runs over the dab's bounding box on the canvas.
// ---------------------------------------------------------------------------
export const DEPOSIT_FRAG =
  HEAD +
  SPECTRAL_GLSL +
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
uniform float uBody;      // stiffness of the paint being laid down
uniform float uWetness;   // how wet this paint leaves the surface
uniform float uMaxVolume;
uniform float uLevel;     // knives flatten what they pass over
uniform float uScrape;    // >0 removes paint instead of adding it
uniform float uClearMix;  // 1 for Liquid Clear: adds body, no colour

layout(location = 0) out vec4 outPaint;
layout(location = 1) out vec4 outSurf;

void main() {
  vec4 paint = texture(uPaint, vUV);
  vec4 surf = texture(uSurf, vUV);

  vec2 px = vUV * uCanvasSize;
  vec2 b = canvasToBrush(px);

  if (b.x < 0.0 || b.x > 1.0 || b.y < 0.0 || b.y > 1.0) {
    outPaint = paint;
    outSurf = surf;
    return;
  }

  float bristle = texture(uBristle, b).r;
  if (bristle <= 0.001) { outPaint = paint; outSurf = surf; return; }

  float contact = contactAmount(px, bristle, paint.a, surf.r);
  if (contact <= 0.001) { outPaint = paint; outSurf = surf; return; }

  vec4 res = texture(uReservoir, b);
  float take = takeAmount(bristle, contact, paint.a, surf.g);
  float give = giveAmount(bristle, contact, res.a);

  if (uScrape > 0.0) {
    // A knife edge or a rag: lift paint off without putting any back.
    float lift = uScrape * bristle * contact;
    outPaint = vec4(paint.rgb, max(paint.a - lift, 0.0));
    outSurf = vec4(max(surf.r - lift * 1.5, 0.0), surf.g, surf.b, surf.a);
    return;
  }

  float remain = max(paint.a - take, 0.0);
  float colourGive = give * (1.0 - uClearMix);

  vec3 colour = paint.rgb;
  if (colourGive > 0.0001) {
    colour = (remain <= 0.0001)
      ? res.rgb
      : spectral_mix(paint.rgb, uCanvasTint, remain, res.rgb, uBrushTint, colourGive);
    // ...and the share of the new paint that simply covers.
    colour = mix(colour, res.rgb, hidingPower(colourGive));
  }

  float volume = clamp(remain + give, 0.0, uMaxVolume);

  // Impasto: stiff paint builds a ridge, thin mediums level out.
  float height = surf.r - take * 0.9 + give * uBody * 0.85;
  height = mix(height, height * 0.35, uLevel * contact);
  height = clamp(height, 0.0, 2.5);

  float wetness = max(surf.g, uWetness * step(0.0001, give));
  float body = mix(surf.b, uBody, clamp(give * 2.0, 0.0, 1.0));

  outPaint = vec4(colour, volume);
  outSurf = vec4(height, wetness, body, surf.a);
}
`;

// ---------------------------------------------------------------------------
// Whole-canvas operations.
// ---------------------------------------------------------------------------

/** Flood the surface -- new canvas, or a Liquid White / Black base coat. */
export const FILL_FRAG =
  HEAD +
  SPECTRAL_GLSL +
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
    colour = (paint.a <= 0.0001)
      ? uColour
      : spectral_mix(paint.rgb, uCanvasTint, paint.a, uColour, uColourTint, give);
    colour = mix(colour, uColour, hidingPower(give));
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
  if (uReplace > 0.5) {
    outReservoir = vec4(uColour, uLoad * mix(0.55, 1.0, bristle));
  } else {
    outReservoir = vec4(uColour, min(res.a + uLoad * bristle, 2.0));
  }
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

out vec4 fragColour;

float heightAt(vec2 uv) {
  vec4 p = texture(uPaint, uv);
  vec4 s = texture(uSurf, uv);
  float cover = clamp(p.a * 1.6, 0.0, 1.0);
  float weave = canvasWeave(uv * uCanvasSize) * uWeaveDepth;
  return s.r * uRelief + weave * (1.0 - cover * 0.75) * 0.16;
}

void main() {
  vec4 paint = texture(uPaint, vUV);
  vec4 surf = texture(uSurf, vUV);

  float weave = canvasWeave(vUV * uCanvasSize) * uWeaveDepth;
  float cover = clamp(paint.a * 1.6, 0.0, 1.0);

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
    colour = (paint.a <= 0.0001)
      ? uColour
      : spectral_mix(paint.rgb, uCanvasTint, paint.a, uColour, uColourTint, give);
    colour = mix(colour, uColour, hidingPower(give));
  }

  float dome = pow(m, 0.55);
  outPaint = vec4(colour, min(paint.a + uAmount * m, 2.4));
  outSurf = vec4(min(surf.r + dome * uBody * 0.9, 2.5), max(surf.g, uWetness), uBody, surf.a);
}
`;
