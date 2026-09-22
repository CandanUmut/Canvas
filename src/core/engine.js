// The painting engine: owns the GL context, the shader passes, the brush's
// paint reservoir, and every painting surface (the canvas and the mixing
// palette are both just surfaces, which is why you can load a brush on one and
// paint with it on the other).

import { createContext, Program, RenderTarget, drawQuad, FULL_RECT, createTexture } from './gl.js';
import {
  PICKUP_FRAG,
  DEPOSIT_FRAG,
  FILL_FRAG,
  DRY_FRAG,
  COPY_FRAG,
  LOAD_BRUSH_FRAG,
  RENDER_FRAG,
  BLOB_FRAG,
  BLEED_FRAG,
} from './shaders.js';
import { MASK_RES } from '../data/brushes.js';
import { hexToRgb, CANVAS_GESSO } from '../data/colors.js';

// Deliberately smaller than the bristle mask. The mask is smooth, so this
// loses no visible detail, and every dab runs at least one full-reservoir
// pass -- at 192 those fixed passes were most of the cost of painting.
const RESERVOIR_RES = 112;

// Surface state packs into 8-bit for undo snapshots. Volume and height exceed
// 1.0, so they are scaled down on the way in and back up on the way out.
const PACK_SCALE = 2.5;

const BLEED_EVERY = 3;

const sameColour = (a, b) =>
  Math.abs(a[0] - b[0]) < 0.004 && Math.abs(a[1] - b[1]) < 0.004 && Math.abs(a[2] - b[2]) < 0.004;

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** One painting surface: the canvas, or the mixing palette. */
export class Surface {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    const opts = { internalFormat: gl.RGBA16F, count: 2, filter: gl.LINEAR };
    // `main` is canonical; `scratch` is where a pass writes before the changed
    // rectangle is blitted back. Only the dab's footprint ever moves, so cost
    // scales with the brush, not the canvas.
    this.main = new RenderTarget(gl, width, height, opts);
    this.scratch = new RenderTarget(gl, width, height, opts);
    this.history = [];
    this.future = [];
    // The pixel box touched since the last history step, so an old step can be
    // boiled down to just the patch it is responsible for.
    this.touched = null;
    // Only the most recent steps stay on the GPU as whole-canvas snapshots.
    // Everything older is kept as the patch it changed, which is usually a
    // sliver of the canvas -- that is what makes the history effectively
    // unlimited instead of the four-to-fourteen steps a full-frame history
    // could afford.
    this.gpuSteps = Math.max(3, Math.min(8, Math.round(50e6 / (width * height * 8))));
    // Patches are small, but a base coat changes every pixel, so the total is
    // still worth watching. This much holds many hundreds of ordinary strokes
    // -- far past any real session -- and only ever drops the very oldest.
    this.historyBytes = 0;
    this.historyBudget = 480e6;
  }

  get paintTex() {
    return this.main.textures[0];
  }

  get surfTex() {
    return this.main.textures[1];
  }

  dispose() {
    this.main.dispose();
    this.scratch.dispose();
    for (const e of [...this.history, ...this.future]) {
      if (e.gpu) e.gpu.dispose();
    }
    this.history = [];
    this.future = [];
  }
}

export class Engine {
  constructor(canvasEl) {
    const gl = createContext(canvasEl);
    this.gl = gl;
    this.canvasEl = canvasEl;

    this.programs = {
      pickup: new Program(gl, PICKUP_FRAG, 'pickup'),
      deposit: new Program(gl, DEPOSIT_FRAG, 'deposit'),
      fill: new Program(gl, FILL_FRAG, 'fill'),
      dry: new Program(gl, DRY_FRAG, 'dry'),
      copy: new Program(gl, COPY_FRAG, 'copy'),
      loadBrush: new Program(gl, LOAD_BRUSH_FRAG, 'loadBrush'),
      render: new Program(gl, RENDER_FRAG, 'render'),
      blob: new Program(gl, BLOB_FRAG, 'blob'),
      bleed: new Program(gl, BLEED_FRAG, 'bleed'),
    };

    // The brush reservoir: what is actually on the bristles right now.
    this.reservoir = {
      a: new RenderTarget(gl, RESERVOIR_RES, RESERVOIR_RES, { internalFormat: gl.RGBA16F, count: 1 }),
      b: new RenderTarget(gl, RESERVOIR_RES, RESERVOIR_RES, { internalFormat: gl.RGBA16F, count: 1 }),
    };
    // `stock` is the paint the user actually chose -- a tube, or whatever they
    // mixed on the palette. `colour` drifts as the tool picks things up off the
    // canvas. Reloading has to come from stock: refilling from the drifted
    // colour meant a brush that ran dry over Liquid White came back loaded with
    // white, and every stroke after the first painted white on white.
    this.brush = { colour: [1, 1, 1], tint: 1, opacity: 1, load: 0, dirty: false };
    this.brush.stock = { colour: [1, 1, 1], tint: 1, opacity: 1 };

    this.maskTextures = new Map();
    this.tool = null;

    this.view = {
      gesso: hexToRgb(CANVAS_GESSO),
      lightDir: [-0.45, 0.62, 0.65],
      relief: 0.46,
      gloss: 0.22,
      varnish: 0.08,
      squint: 0,
      weaveScale: 5.5,
      weaveDepth: 0.30,
    };

    this.readBuffer = new Float32Array(4);
    this.pixelFbo = gl.createFramebuffer();
  }

  createSurface(width, height) {
    return new Surface(this.gl, width, height);
  }

  // --- tools --------------------------------------------------------------

  /** Uploads a tool's bristle footprint once, then keeps it around. */
  maskTexture(toolDef) {
    if (!this.maskTextures.has(toolDef.id)) {
      const gl = this.gl;
      const tex = createTexture(gl, MASK_RES, MASK_RES, gl.RG8, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MASK_RES, MASK_RES, gl.RG, gl.UNSIGNED_BYTE, toolDef.mask);
      this.maskTextures.set(toolDef.id, tex);
    }
    return this.maskTextures.get(toolDef.id);
  }

  setTool(toolDef) {
    const previous = this.tool;
    this.tool = toolDef;
    const tex = this.maskTexture(toolDef);
    // The reservoir is shaped by whichever tool last touched it, so picking up
    // a knife after a fan brush would leave the knife carrying the fan's gaps.
    // Re-lay the paint into the new tool's bristle pattern.
    if (previous && previous.id !== toolDef.id && !toolDef.noLoad) {
      const b = this.brush;
      this.loadBrush(b.colour, b.tint, b.load, true, b.opacity);
    }
    return tex;
  }

  // --- brush reservoir ----------------------------------------------------

  /** Dip the brush. `replace` wipes what was there; otherwise it mixes in. */
  loadBrush(colour, tint, load, replace = true, opacity = 1) {
    const gl = this.gl;
    const mask = this.maskTexture(this.tool);
    this.reservoir.b.bind();
    this.programs.loadBrush.use().set({
      uRect: FULL_RECT,
      uReservoir: this.reservoir.a.texture,
      uBristle: mask,
      uColour: colour,
      uLoad: load,
      uReplace: replace ? 1 : 0,
    });
    drawQuad(gl);
    this._swapReservoir();
    this.brush.colour = colour;
    this.brush.tint = tint;
    this.brush.opacity = opacity;
    this.brush.load = Math.min(load, 1);
    this.brush.dirty = false;
  }

  /** Remember the paint the user picked, so reloads come back to it. */
  setStock(colour, tint, opacity) {
    this.brush.stock = { colour: colour.slice(), tint, opacity };
  }

  /** Whatever is on the bristles right now becomes the charged colour. */
  stockFromBrush() {
    const b = this.brush;
    b.stock = { colour: b.colour.slice(), tint: b.tint, opacity: b.opacity };
  }

  /** "Beat the devil out of it." */
  cleanBrush() {
    this.loadBrush([0.97, 0.96, 0.94], 1, 0, true, 1);
    this.brush.load = 0;
    this.brush.dirty = false;
    // A brush you have beaten the devil out of is EMPTY, and has to stay empty
    // until you dip it again. Leaving the charged colour behind meant the next
    // stroke's reload filled it straight back up, so cleaning it did nothing at
    // all -- and cleaning it is how a sky gets blended, how the base of a
    // mountain gets misted, and how any edge gets softened.
    this.brush.stock = null;
  }

  /**
   * Top the tool back up to full without changing what colour it is carrying.
   * Real brushes get recharged at the start of every stroke; not doing this
   * was the single biggest reason the brush felt permanently empty.
   */
  rechargeBrush(keepDirty = false) {
    const b = this.brush;
    // Nothing to come back to: the tool was deliberately cleaned.
    if (!b.stock) return false;
    if (keepDirty) {
      // Keep whatever the tool dragged up; just top the amount back up.
      if (b.load >= 0.92) return false;
      this.loadBrush(b.colour, b.tint, 1, true, b.opacity);
      return true;
    }
    // Auto-clean: every stroke starts with the colour you chose. Gating this
    // on the load running down meant a big tool -- whose load barely moves --
    // never got its colour back, so one stroke turned it to whatever it had
    // been dragged through and it stayed that way.
    const s = b.stock;
    // `dirty` is set by the first dab of any stroke, so it says "this tool has
    // been used since it was last filled" without reading anything back off
    // the GPU. Deciding on the cached load alone meant the decision was only
    // right if something had happened to call sampleReservoir in between: a
    // caller that did not -- a replayed painting, say -- left the load reading
    // 1.0 for ever, so the tool was never topped up again, ran itself down and
    // started lifting paint instead of laying it.
    if (!b.dirty && b.load >= 0.99 && sameColour(b.colour, s.colour)) return false;
    this.loadBrush(s.colour, s.tint, 1, true, s.opacity);
    return true;
  }

  _swapReservoir() {
    const t = this.reservoir.a;
    this.reservoir.a = this.reservoir.b;
    this.reservoir.b = t;
  }

  // --- painting -----------------------------------------------------------

  /**
   * One dab. Pickup runs first against the canvas as it is now, then deposit
   * lays paint down a few pixels along the stroke -- that offset is the smear.
   */
  dab(surface, d) {
    const gl = this.gl;
    const tool = d.tool;
    const mask = this.maskTexture(tool);
    const w = d.size;
    const h = d.size * tool.aspect;
    const dir = [Math.cos(d.angle), Math.sin(d.angle)];
    const palette = surface.isPalette ? 1 : 0;

    const common = {
      uCanvasSize: [surface.width, surface.height],
      uDabCenter: [d.x, d.y],
      uDabSize: [w, h],
      uDabDir: dir,
      uPressure: d.pressure,
      // Supplied by the stroke, which keeps one bristle configuration for as
      // long as the tool is travelling less than a footprint.
      uBristleOfs: d.bristleOfs || [0, 0],
      uBristleCut: d.bristleCut || 0,
      uBristleBias: tool.bristleBias ?? 0.25,
      uBristleSplay: tool.splay ?? 0,
      uSeed: d.seed ?? 0,
      uWeaveScale: surface.weaveScale ?? this.view.weaveScale,
      uWeaveDepth: surface.weaveDepth ?? this.view.weaveDepth,
      uDeplete: d.deplete,
      uFlow: d.flow,
      uPickup: d.pickup,
      uHold: tool.hold,
      uKnee: tool.knee,
      uSoak: tool.soak,
      uPalette: palette,
      uSoften: d.soften,
    };

    // Both passes read the reservoir as it was at the start of the dab, so
    // they agree about how much paint moved. The swap happens after both.
    const updatesReservoir = d.scrape <= 0;
    if (updatesReservoir) {
      this.reservoir.b.bind();
      this.programs.pickup.use().set({
        ...common,
        uRect: FULL_RECT,
        uReservoir: this.reservoir.a.texture,
        uBristle: mask,
        uPaint: surface.paintTex,
        uSurf: surface.surfTex,
        uCanvasTint: d.canvasTint,
        uBrushTint: this.brush.tint,
        uDryOut: d.dryOut * d.deplete,
      });
      drawQuad(gl);
      this.brush.dirty = true;
    }

    const rect = this._footprintRect(surface, d.x, d.y, w, h);
    if (rect) {
      surface.scratch.bind();
      this.programs.deposit.use().set({
        ...common,
        uRect: rect,
        uPaint: surface.paintTex,
        uSurf: surface.surfTex,
        uReservoir: this.reservoir.a.texture,
        uBristle: mask,
        uCanvasTint: d.canvasTint,
        uBrushTint: this.brush.tint,
        uBody: d.body,
        uWetness: d.wetness,
        uMaxVolume: tool.maxVolume,
        uLevel: tool.level,
        uScrape: d.scrape,
        uClearMix: d.clearMix,
        uOpacity: d.opacity,
        uSmudge: d.smudge,
        uSmudgeR: Math.max(1, d.size * 0.055),
      });
      drawQuad(gl);
      this._blitBack(surface, rect);
    }

    if (updatesReservoir) {
      this._swapReservoir();
      // Diffusion does not need to run every dab: the same spreading happens
      // if it runs a third as often with three times the strength, at a third
      // of the cost.
      this._bleedDue = (this._bleedDue || 0) + 1;
      if (this._bleedDue >= BLEED_EVERY) {
        this._bleed(mask, tool, d.deplete * this._bleedDue);
        this._bleedDue = 0;
      }
    }
  }

  /**
   * Lets paint spread sideways through the bristle bed. Two separable taps.
   * Without it the reservoir stays striped -- drag a brush through blue and
   * yellow and half the bristles hold pure blue and half pure yellow, so the
   * brush lays a striped stroke and never a green one.
   */
  _bleed(mask, tool, deplete) {
    // 0.6 was a violent blur of the whole bristle bed in one step.
    const strength = Math.min(0.32, (tool.bleed ?? 1) * deplete * 4);
    if (strength <= 0.0005) return;
    const gl = this.gl;
    const r = 7 / this.reservoir.a.width;
    // One direction per invocation, alternating. Separable diffusion works
    // just as well spread across successive dabs and costs half as much.
    // One direction per invocation, alternating. Separable diffusion works
    // just as well spread across successive dabs and costs half as much.
    this._bleedAxis = this._bleedAxis ? 0 : 1;
    for (const step of [this._bleedAxis ? [r, 0] : [0, r]]) {
      this.reservoir.b.bind();
      this.programs.bleed.use().set({
        uRect: FULL_RECT,
        uReservoir: this.reservoir.a.texture,
        uBristle: mask,
        uStep: step,
        uStrength: strength,
        uTint: this.brush.tint,
      });
      drawQuad(gl);
      this._swapReservoir();
    }
  }

  /** Bounding box of a rotated dab, in 0..1 target coords, clipped to canvas. */
  _footprintRect(surface, cx, cy, w, h) {
    const hw = w * 0.5;
    const hh = h * 0.5;
    const r = Math.hypot(hw, hh) + 2; // conservative: covers any rotation
    let x0 = Math.floor(cx - r);
    let y0 = Math.floor(cy - r);
    let x1 = Math.ceil(cx + r);
    let y1 = Math.ceil(cy + r);
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(surface.width, x1);
    y1 = Math.min(surface.height, y1);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0 / surface.width, y0 / surface.height, (x1 - x0) / surface.width, (y1 - y0) / surface.height];
  }

  /** Copies the changed rectangle from scratch back into the canonical target. */
  _blitBack(surface, rect) {
    const gl = this.gl;
    const x0 = Math.round(rect[0] * surface.width);
    const y0 = Math.round(rect[1] * surface.height);
    const x1 = Math.round((rect[0] + rect[2]) * surface.width);
    const y1 = Math.round((rect[1] + rect[3]) * surface.height);

    // Every write to the surface comes through here, so this is the one place
    // that can say what a step actually changed.
    const t = surface.touched;
    surface.touched = t
      ? { x0: Math.min(t.x0, x0), y0: Math.min(t.y0, y0),
          x1: Math.max(t.x1, x1), y1: Math.max(t.y1, y1) }
      : { x0, y0, x1, y1 };

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, surface.scratch.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, surface.main.fbo);
    for (let i = 0; i < 2; i++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
      const buffers = [gl.NONE, gl.NONE];
      buffers[i] = gl.COLOR_ATTACHMENT0 + i;
      gl.drawBuffers(buffers);
      gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  // --- whole-surface operations -------------------------------------------

  /** Base coat: Liquid White, Liquid Black, or a flat wash of any colour. */
  fill(surface, { colour, tint = 1, amount = 0.6, wetness = 1, body = 0.2, replace = false, clearMix = 0, canvasTint = 1, opacity = 1 }) {
    const gl = this.gl;
    surface.scratch.bind();
    this.programs.fill.use().set({
      uRect: FULL_RECT,
      uPaint: surface.paintTex,
      uSurf: surface.surfTex,
      uColour: colour,
      uColourTint: tint,
      uCanvasTint: canvasTint,
      uAmount: amount,
      uWetness: wetness,
      uBody: body,
      uReplace: replace ? 1 : 0,
      uClearMix: clearMix,
      uOpacity: opacity,
    });
    drawQuad(gl);
    this._blitBack(surface, FULL_RECT);
  }

  /** Squeeze a blob straight from the tube onto the palette. */
  blob(surface, { x, y, radius, colour, tint = 1, amount = 1.4, body = 1.0, wetness = 1, clearMix = 0, opacity = 1 }) {
    const gl = this.gl;
    const rect = this._footprintRect(surface, x, y, radius * 2.6, radius * 2.6);
    if (!rect) return;
    surface.scratch.bind();
    this.programs.blob.use().set({
      uRect: rect,
      uPaint: surface.paintTex,
      uSurf: surface.surfTex,
      uCanvasSize: [surface.width, surface.height],
      uCentre: [x, y],
      uRadius: radius,
      uColour: colour,
      uColourTint: tint,
      uCanvasTint: 1.0,
      uAmount: amount,
      uBody: body,
      uWetness: wetness,
      uClearMix: clearMix,
      uOpacity: opacity,
      uSeed: (x * 0.137 + y * 0.311) % 6.283,
    });
    drawQuad(gl);
    this._blitBack(surface, rect);
  }

  /** Bare canvas. */
  clear(surface) {
    this.fill(surface, { colour: this.view.gesso, amount: 0, wetness: 0, body: 0, replace: true });
  }

  /** Let it set up, so the next layer sits on top instead of blending in. */
  dry(surface, amount = 1) {
    const gl = this.gl;
    surface.scratch.bind();
    this.programs.dry.use().set({
      uRect: FULL_RECT,
      uPaint: surface.paintTex,
      uSurf: surface.surfTex,
      uAmount: amount,
    });
    drawQuad(gl);
    this._blitBack(surface, FULL_RECT);
  }

  // --- undo ---------------------------------------------------------------

  _snapshot(surface) {
    const gl = this.gl;
    const snap = new RenderTarget(gl, surface.width, surface.height, {
      internalFormat: gl.RGBA8,
      count: 2,
      filter: gl.NEAREST,
    });
    snap.bind();
    this.programs.copy.use().set({
      uRect: FULL_RECT,
      uPaint: surface.paintTex,
      uSurf: surface.surfTex,
      uScale: 1 / PACK_SCALE,
      uSrcRect: FULL_RECT,
    });
    drawQuad(gl);
    return snap;
  }

  _restore(surface, snap) {
    const gl = this.gl;
    surface.scratch.bind();
    this.programs.copy.use().set({
      uRect: FULL_RECT,
      uPaint: snap.textures[0],
      uSurf: snap.textures[1],
      uScale: PACK_SCALE,
      uSrcRect: FULL_RECT,
    });
    drawQuad(gl);
    this._blitBack(surface, FULL_RECT);
  }

  /**
   * Turns a whole-canvas GPU snapshot into just the patch it is responsible
   * for. A step's patch is whatever changed *after* it was taken, because
   * putting that patch back is the only thing undoing to it has to do.
   */
  _demote(surface, entry) {
    if (!entry.gpu || !entry.rect) return;
    const gl = this.gl;
    const { x0, y0, x1, y1 } = entry.rect;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) {
      // Nothing changed after this step, so it holds nothing worth keeping.
      entry.gpu.dispose();
      entry.gpu = null;
      entry.empty = true;
      return;
    }
    const paint = new Uint8Array(w * h * 4);
    const surf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, entry.gpu.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, paint);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, surf);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    entry.gpu.dispose();
    entry.gpu = null;
    entry.patch = { w, h, paint, surf };
    surface.historyBytes += paint.length * 2;
  }

  /** Frees a step whichever form it is in. */
  _dropStep(surface, entry) {
    if (entry.gpu) entry.gpu.dispose();
    if (entry.patch) surface.historyBytes -= entry.patch.paint.length * 2;
    entry.gpu = null;
    entry.patch = null;
  }

  /** Drops the oldest steps if the patches have piled up too far. */
  _trim(surface) {
    while (surface.historyBytes > surface.historyBudget && surface.history.length > surface.gpuSteps) {
      this._dropStep(surface, surface.history.shift());
    }
  }

  /** Pushes the newest steps off the GPU, oldest first. */
  _spill(surface, list) {
    for (let i = list.length - 1 - surface.gpuSteps; i >= 0; i--) {
      if (!list[i].gpu) break;
      this._demote(surface, list[i]);
    }
  }

  /** Puts a step back, whether it is a full snapshot or a single patch. */
  _apply(surface, entry) {
    if (entry.empty) return;
    if (entry.gpu) {
      this._restore(surface, entry.gpu);
      return;
    }
    const gl = this.gl;
    const { w, h, paint, surf } = entry.patch;
    const { x0, y0 } = entry.rect;
    const tex = new RenderTarget(gl, w, h, {
      internalFormat: gl.RGBA8,
      count: 2,
      filter: gl.NEAREST,
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const [i, src] of [[0, paint], [1, surf]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex.textures[i]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    const rect = [x0 / surface.width, y0 / surface.height,
                  w / surface.width, h / surface.height];
    surface.scratch.bind();
    this.programs.copy.use().set({
      uRect: rect,
      uPaint: tex.textures[0],
      uSurf: tex.textures[1],
      uScale: PACK_SCALE,
      uSrcRect: rect,
    });
    drawQuad(gl);
    this._blitBack(surface, rect);
    tex.dispose();
  }

  pushHistory(surface) {
    // The step below now knows what changed while it was the current state.
    const prev = surface.history[surface.history.length - 1];
    if (prev && !prev.rect) prev.rect = surface.touched || { x0: 0, y0: 0, x1: 0, y1: 0 };
    surface.history.push({ gpu: this._snapshot(surface), rect: null });
    surface.touched = null;
    this._spill(surface, surface.history);
    this._trim(surface);
    for (const f of surface.future) this._dropStep(surface, f);
    surface.future = [];
  }

  canUndo(surface) {
    return surface.history.length > 0;
  }

  canRedo(surface) {
    return surface.future.length > 0;
  }

  undo(surface) {
    if (!surface.history.length) return false;
    const step = surface.history.pop();
    // The step being left behind changed exactly the same patch, so redo can
    // be stored the same cheap way.
    if (!step.rect) step.rect = surface.touched || { x0: 0, y0: 0, x1: 0, y1: 0 };
    surface.future.push({ gpu: this._snapshot(surface), rect: step.rect });
    this._spill(surface, surface.future);
    this._apply(surface, step);
    this._dropStep(surface, step);
    surface.touched = null;
    return true;
  }

  redo(surface) {
    if (!surface.future.length) return false;
    const step = surface.future.pop();
    surface.history.push({ gpu: this._snapshot(surface), rect: step.rect });
    this._spill(surface, surface.history);
    this._apply(surface, step);
    this._dropStep(surface, step);
    surface.touched = null;
    return true;
  }

  // --- saving and restoring -----------------------------------------------

  /**
   * Reads a surface back as two 8-bit images, the same packing the undo
   * history uses. Volume and height run past 1.0, so they are scaled down on
   * the way out and back up on the way in.
   */
  captureState(surface) {
    const gl = this.gl;
    const snap = this._snapshot(surface);
    const n = surface.width * surface.height * 4;
    const paint = new Uint8Array(n);
    const surf = new Uint8Array(n);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, snap.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, surface.width, surface.height, gl.RGBA, gl.UNSIGNED_BYTE, paint);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, surface.width, surface.height, gl.RGBA, gl.UNSIGNED_BYTE, surf);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    snap.dispose();
    return { width: surface.width, height: surface.height, paint, surf };
  }

  /** Puts a captured surface back. */
  restoreState(surface, data) {
    if (!data || data.width !== surface.width || data.height !== surface.height) return false;
    const gl = this.gl;
    const snap = new RenderTarget(gl, surface.width, surface.height, {
      internalFormat: gl.RGBA8,
      count: 2,
      filter: gl.NEAREST,
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const [i, src] of [[0, data.paint], [1, data.surf]]) {
      gl.bindTexture(gl.TEXTURE_2D, snap.textures[i]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, surface.width, surface.height,
        gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(src));
    }
    this._restore(surface, snap);
    snap.dispose();
    return true;
  }

  // --- output -------------------------------------------------------------

  /**
   * Draws a surface into a rectangle of the on-screen GL canvas. `rect` may
   * extend past `clip` when the canvas is zoomed in; scissoring keeps the
   * painting inside the stage instead of spilling over the panels.
   * All coordinates are device pixels with a bottom-left origin.
   */
  renderTo(surface, rect, clip = rect) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.SCISSOR_TEST);
    gl.viewport(Math.round(rect[0]), Math.round(rect[1]), Math.round(rect[2]), Math.round(rect[3]));
    gl.scissor(Math.round(clip[0]), Math.round(clip[1]), Math.round(clip[2]), Math.round(clip[3]));
    this._renderPass(surface);
  }

  /** Clears the whole GL canvas to the studio backdrop. */
  clearScreen(width, height, colour) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, width, height);
    gl.clearColor(colour[0], colour[1], colour[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _renderPass(surface) {
    const v = this.view;
    this.programs.render.use().set({
      uRect: FULL_RECT,
      uPaint: surface.paintTex,
      uSurf: surface.surfTex,
      uTexel: [1 / surface.width, 1 / surface.height],
      uCanvasSize: [surface.width, surface.height],
      uGesso: surface.gesso ?? v.gesso,
      uLightDir: v.lightDir,
      uRelief: v.relief,
      uGloss: v.gloss,
      uVarnish: v.varnish,
      uSquint: v.squint,
      uWeaveScale: surface.weaveScale ?? v.weaveScale,
      uWeaveDepth: surface.weaveDepth ?? v.weaveDepth,
      // The render pass includes the shared chunk, so these must be present.
      uDabCenter: [0, 0],
      uDabSize: [1, 1],
      uDabDir: [1, 0],
      uPressure: 0,
    });
    drawQuad(this.gl);
  }

  /** Renders a surface into an offscreen RGBA8 target and reads it back. */
  exportImage(surface) {
    const gl = this.gl;
    const out = new RenderTarget(gl, surface.width, surface.height, {
      internalFormat: gl.RGBA8,
      count: 1,
      filter: gl.NEAREST,
    });
    out.bind();
    this._renderPass(surface);
    const pixels = new Uint8Array(surface.width * surface.height * 4);
    gl.readPixels(0, 0, surface.width, surface.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    out.dispose();

    // GL origin is bottom-left; canvas image data is top-down.
    const w = surface.width;
    const h = surface.height;
    const flipped = new Uint8ClampedArray(pixels.length);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      flipped.set(pixels.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes);
    }
    return new ImageData(flipped, w, h);
  }

  /**
   * Reads back what is actually on the bristles right now, for the little
   * swatch in the corner. This stalls the pipeline, so it is called when a
   * stroke ends, never inside one.
   */
  sampleReservoir() {
    const gl = this.gl;
    const res = this.reservoir.a;
    const n = res.width;
    if (!this._resBuf || this._resBuf.length !== n * n * 4) {
      this._resBuf = new Float32Array(n * n * 4);
    }
    const buf = this._resBuf;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, res.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

    // Weight by the bristle mask, over the WHOLE bed -- the old version read
    // 81 texels out of 36,864 from the dead centre, which for a knife is a
    // sparse corner of the blade, so the meter dropped by a third the instant
    // you lifted the tool without using any paint.
    // The bristle mask is stored at MASK_RES; the reservoir is smaller, so
    // index into the mask by proportion rather than assuming they match.
    const mask = this.tool ? this.tool.mask : null;
    const mscale = MASK_RES / n;
    let load = 0;
    let bristleTotal = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < n * n; i++) {
      let bristle = 1;
      if (mask) {
        const mx = Math.min(MASK_RES - 1, ((i % n) * mscale) | 0);
        const my = Math.min(MASK_RES - 1, (((i / n) | 0) * mscale) | 0);
        bristle = mask[(my * MASK_RES + mx) * 2 + 1] / 255;
      }
      if (bristle <= 0.004) continue;
      const a = buf[i * 4 + 3];
      bristleTotal += bristle;
      load += a * bristle;
      const w = a * bristle;
      // Average in linear light; averaging sRGB skews every mix dark.
      r += srgbToLinear(buf[i * 4]) * w;
      g += srgbToLinear(buf[i * 4 + 1]) * w;
      b += srgbToLinear(buf[i * 4 + 2]) * w;
      weight += w;
    }
    const avgLoad = bristleTotal > 0 ? load / bristleTotal : 0;
    if (weight < 1e-6) {
      this.brush.load = avgLoad;
      return { colour: this.brush.colour, load: avgLoad };
    }
    const colour = [
      linearToSrgb(r / weight),
      linearToSrgb(g / weight),
      linearToSrgb(b / weight),
    ];
    this.brush.colour = colour;
    this.brush.load = avgLoad;
    return { colour, load: avgLoad };
  }

  /** Samples the paint under a point -- the eyedropper, and palette pickup. */
  samplePaint(surface, x, y) {
    const gl = this.gl;
    const px = Math.max(0, Math.min(surface.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(surface.height - 1, Math.round(y)));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, surface.main.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.FLOAT, this.readBuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return {
      colour: [this.readBuffer[0], this.readBuffer[1], this.readBuffer[2]],
      volume: this.readBuffer[3],
    };
  }
}
