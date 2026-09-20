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
} from './shaders.js';
import { MASK_RES } from '../data/brushes.js';
import { hexToRgb, CANVAS_GESSO } from '../data/colors.js';

const RESERVOIR_RES = MASK_RES;

// Surface state packs into 8-bit for undo snapshots. Volume and height exceed
// 1.0, so they are scaled down on the way in and back up on the way out.
const PACK_SCALE = 2.5;

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
    // Each snapshot is two full-size 8-bit textures; cap the history by
    // memory rather than count so a big canvas does not eat all of VRAM.
    this.historyCap = Math.max(4, Math.min(14, Math.round(90e6 / (width * height * 8))));
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
    for (const s of [...this.history, ...this.future]) s.dispose();
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
    };

    // The brush reservoir: what is actually on the bristles right now.
    this.reservoir = {
      a: new RenderTarget(gl, RESERVOIR_RES, RESERVOIR_RES, { internalFormat: gl.RGBA16F, count: 1 }),
      b: new RenderTarget(gl, RESERVOIR_RES, RESERVOIR_RES, { internalFormat: gl.RGBA16F, count: 1 }),
    };
    this.brush = { colour: [1, 1, 1], tint: 1, opacity: 1, load: 0, dirty: false };

    this.maskTextures = new Map();
    this.tool = null;

    this.view = {
      gesso: hexToRgb(CANVAS_GESSO),
      lightDir: [-0.45, 0.62, 0.65],
      relief: 1.0,
      gloss: 0.38,
      varnish: 0.08,
      weaveScale: 5.5,
      weaveDepth: 0.40,
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
      const tex = createTexture(gl, MASK_RES, MASK_RES, gl.R8, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MASK_RES, MASK_RES, gl.RED, gl.UNSIGNED_BYTE, toolDef.mask);
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
      this.loadBrush(b.colour, b.tint, Math.min(b.load, toolDef.capacity), true, b.opacity);
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
    this.brush.load = load;
    this.brush.dirty = false;
  }

  /** "Beat the devil out of it." */
  cleanBrush() {
    this.loadBrush([1, 1, 1], 1, 0, true, 1);
    this.brush.load = 0;
    this.brush.dirty = false;
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

    const common = {
      uCanvasSize: [surface.width, surface.height],
      uDabCenter: [d.x, d.y],
      uDabSize: [w, h],
      uDabDir: dir,
      uPressure: d.pressure,
      uWeaveScale: this.view.weaveScale,
      uWeaveDepth: this.view.weaveDepth,
      uPickup: d.pickup,
      uFlow: d.flow,
      uDeplete: d.deplete,
    };

    // Pass 1: update the bristles -- take paint off the canvas, and subtract
    // what pass 2 is about to lay down.
    const updatesReservoir = d.pickup > 0 || d.flow > 0;
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
        uCapacity: tool.capacity,
        uDryOut: tool.dryOut * tool.spacing,
      });
      drawQuad(gl);
      this.brush.dirty = true;
    }

    // Pass 2: what goes back down, offset along the stroke. It reads the same
    // reservoir state pass 1 read, so both passes agree on how much moved --
    // hence the swap only happens once both are done.
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
      });
      drawQuad(gl);
      this._blitBack(surface, rect);
    }

    if (updatesReservoir) this._swapReservoir();
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
    });
    drawQuad(gl);
    this._blitBack(surface, FULL_RECT);
  }

  pushHistory(surface) {
    surface.history.push(this._snapshot(surface));
    if (surface.history.length > surface.historyCap) surface.history.shift().dispose();
    for (const f of surface.future) f.dispose();
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
    surface.future.push(this._snapshot(surface));
    const snap = surface.history.pop();
    this._restore(surface, snap);
    snap.dispose();
    return true;
  }

  redo(surface) {
    if (!surface.future.length) return false;
    surface.history.push(this._snapshot(surface));
    const snap = surface.future.pop();
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
    const n = 9;
    const buf = new Float32Array(n * n * 4);
    const x0 = Math.floor((res.width - n) / 2);
    const y0 = Math.floor((res.height - n) / 2);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, res.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x0, y0, n, n, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

    // Weight by load, so bristles holding nothing do not wash out the colour.
    let r = 0, g = 0, b = 0, load = 0, weight = 0;
    for (let i = 0; i < n * n; i++) {
      const a = buf[i * 4 + 3];
      r += buf[i * 4] * a;
      g += buf[i * 4 + 1] * a;
      b += buf[i * 4 + 2] * a;
      load += a;
      weight += a;
    }
    const avgLoad = load / (n * n);
    if (weight < 1e-5) return { colour: this.brush.colour, load: avgLoad };
    const colour = [r / weight, g / weight, b / weight];
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
