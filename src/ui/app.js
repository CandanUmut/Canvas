// The studio: wires the engine to the panels, the pointer and the keyboard.

import { Engine } from '../core/engine.js';
import { StrokeRunner } from '../core/stroke.js';
import { TOOLS, TOOLS_BY_ID, TOOL_CATEGORIES, MASK_RES } from '../data/brushes.js';
import { PIGMENTS, MEDIUMS, ALL_PAINTS, PAINTS_BY_ID, hexToRgb, rgbToHex } from '../data/colors.js';
import { LESSONS } from '../data/lessons.js';
import * as storage from '../core/storage.js';
import { paintFromPicture } from './autopaint.js';

const $ = (id) => document.getElementById(id);

// `wIn` is the canvas width in inches. Tools are sized in inches too, so a
// 2" brush stays a 2" brush whatever resolution the canvas is.
const CANVAS_PRESETS = [
  { label: '24 × 18 in — landscape', note: "Bob's usual canvas", w: 1440, h: 1080, wIn: 24 },
  { label: '18 × 24 in — portrait', note: 'Tall scenes, waterfalls', w: 1080, h: 1440, wIn: 18 },
  { label: '16 × 9 — widescreen', note: 'Sweeping vistas', w: 1600, h: 900, wIn: 24 },
  { label: '12 × 9 in — small & fast', note: 'Easiest on an older GPU', w: 1024, h: 768, wIn: 12 },
  { label: '32 × 24 in — large', note: 'Most detail, needs a strong GPU', w: 1920, h: 1440, wIn: 32 },
];

// The palette has to be large relative to a brush or there is no room to make
// a mixing motion, and the piles have to be DEEP -- a pile needs to hold
// several brush-loads. The old 640x360 board with shallow blobs held about a
// twenty-second of what one 2" brush can carry, which is why dragging through
// it could never load anything.
const PALETTE_W = 900;
const PALETTE_H = 520;
const BLOB_RADIUS = 46;
// Neutral, and slightly cool of neutral, so warm landscape paint next to it
// reads true. A warm brown surround made every painting look cold.
const BACKDROP = hexToRgb('#3a3a3d');

// ---------------------------------------------------------------- state ---

const state = {
  toolId: 'brush-2inch',
  paintId: 'titanium-white',
  sizes: Object.fromEntries(TOOLS.map((t) => [t.id, t.inches])),
  angle: 0,
  pressure: 0.85,
  pressureCurve: 1.0,
  usePressure: true,
  useTilt: false,
  flowScale: 1,
  blendScale: 1,
  autoReload: true,
  dirtyBrush: false,
  thinner: 0,
  zoomMode: 'fit',
  zoom: 1,
  panX: 0,
  panY: 0,
  squeezeSlot: 0,
  lessonId: LESSONS[0].id,
  lessonStep: -1,
};

let engine;
let canvasSurface;
let paletteSurface;
let stroke;
let needsRender = true;
let dpr = 1;
let scriptApi = null;

// ------------------------------------------------------------- saving ---

let saveTimer = null;
let restoring = false;

/** Writes the painting out a moment after you stop, not during a stroke. */
function scheduleSave(delay = 1800) {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (restoring || !engine || !canvasSurface) return;
  try {
    await storage.save({
      version: storage.SAVE_VERSION,
      widthInches: canvasSurface.widthInches,
      canvas: engine.captureState(canvasSurface),
      palette: engine.captureState(paletteSurface),
      squeezeSlot: state.squeezeSlot,
      toolId: state.toolId,
      paintId: state.paintId,
      sizes: state.sizes,
    });
  } catch {
    /* saving is best-effort; never let it interrupt painting */
  }
}

/** Returns true if a painting was found and put back. */
async function restoreSaved() {
  const saved = await storage.load();
  if (!saved || !saved.canvas) return false;
  const c = saved.canvas;
  if (canvasSurface.width !== c.width || canvasSurface.height !== c.height) {
    canvasSurface.dispose();
    canvasSurface = engine.createSurface(c.width, c.height);
    canvasSurface.widthInches = saved.widthInches || 24;
  }
  restoring = true;
  const ok = engine.restoreState(canvasSurface, c);
  if (saved.palette) engine.restoreState(paletteSurface, saved.palette);
  if (saved.sizes) Object.assign(state.sizes, saved.sizes);
  if (saved.squeezeSlot != null) state.squeezeSlot = saved.squeezeSlot;
  if (saved.toolId && TOOLS_BY_ID[saved.toolId]) state.toolId = saved.toolId;
  if (saved.paintId && PAINTS_BY_ID[saved.paintId]) state.paintId = saved.paintId;
  restoring = false;
  layout();
  needsRender = true;
  return ok;
}

// ------------------------------------------------------------ bootstrap ---

function fatal(err) {
  console.error(err);
  $('fatal-message').textContent = err && err.message ? err.message : String(err);
  $('fatal').hidden = false;
}

function boot() {
  try {
    engine = new Engine($('gl'));
  } catch (err) {
    fatal(err);
    return;
  }

  stroke = new StrokeRunner(engine);

  paletteSurface = engine.createSurface(PALETTE_W, PALETTE_H);
  paletteSurface.gesso = hexToRgb('#cdc6b8');
  paletteSurface.weaveDepth = 0.02;
  paletteSurface.weaveScale = 3.0;
  // Marks this surface as a source of paint rather than a picture being
  // painted: tools drink from it and it is never used up.
  paletteSurface.isPalette = true;

  newCanvas(CANVAS_PRESETS[0]);

  buildToolRail();
  buildPalette();
  buildToolSliders();
  buildSurfaceSliders();
  buildLessons();
  wireTopBar();
  wirePointer($('easel'), () => canvasSurface, { palette: false });
  wirePointer($('palette-slot'), () => paletteSurface, { palette: true });
  wireKeyboard();

  selectTool(state.toolId);
  selectPaint(state.paintId);

  new ResizeObserver(() => {
    layout();
    needsRender = true;
  }).observe($('stage'));
  window.addEventListener('resize', () => {
    resizeGL();
    layout();
  });

  resizeGL();
  layout();
  requestAnimationFrame(frame);

  // Bring back whatever was on the easel last time.
  restoreSaved().then((restored) => {
    if (!restored) return;
    $('firstrun').hidden = true;
    selectTool(state.toolId);
    for (const b of document.querySelectorAll('.dab')) {
      b.setAttribute('aria-pressed', b.dataset.paint === state.paintId ? 'true' : 'false');
    }
    $('board-hint').classList.add('gone');
    updateUndoButtons();
    needsRender = true;
    toast('Picked up where you left off.');
  });

  // A tab can be closed or hidden without warning; flush on the way out.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  window.addEventListener('pagehide', () => saveNow());
}

function newCanvas(preset) {
  if (canvasSurface) canvasSurface.dispose();
  canvasSurface = engine.createSurface(preset.w, preset.h);
  canvasSurface.widthInches = preset.wIn || 24;
  engine.clear(canvasSurface);
  state.zoomMode = 'fit';
  state.panX = 0;
  state.panY = 0;
  updateUndoButtons();
  layout();
  needsRender = true;
  scheduleSave(400);
  toast('Fresh canvas. Start with a Liquid White base coat — it is what makes everything blend.');
}

// --------------------------------------------------------------- layout ---

function resizeGL() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const gl = engine.gl;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (gl.canvas.width !== w || gl.canvas.height !== h) {
    gl.canvas.width = w;
    gl.canvas.height = h;
  }
  needsRender = true;
}

/** Sizes the easel div; the GL canvas underneath draws into the same box. */
function layout() {
  if (!canvasSurface) return;
  const stage = $('stage');
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw <= 0 || sh <= 0) return;

  const fit = Math.min(sw / canvasSurface.width, sh / canvasSurface.height) * 0.93;
  const scale = state.zoomMode === 'fit' ? fit : state.zoom;
  state.zoom = scale;

  const dw = canvasSurface.width * scale;
  const dh = canvasSurface.height * scale;

  if (state.zoomMode === 'fit') {
    state.panX = 0;
    state.panY = 0;
  } else {
    // Keep at least a corner of the painting reachable.
    const limX = Math.max(0, (dw - sw) / 2 + 80);
    const limY = Math.max(0, (dh - sh) / 2 + 80);
    state.panX = Math.max(-limX, Math.min(limX, state.panX));
    state.panY = Math.max(-limY, Math.min(limY, state.panY));
  }

  const easel = $('easel');
  easel.style.width = `${dw}px`;
  easel.style.height = `${dh}px`;
  easel.style.left = `${(sw - dw) / 2 + state.panX}px`;
  easel.style.top = `${(sh - dh) / 2 + state.panY}px`;

  $('btn-zoom-fit').textContent = state.zoomMode === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`;
  needsRender = true;
}

/**
 * The side panel is opaque, so the GL canvas cannot simply show through the
 * palette slot the way it does through the easel. Instead the palette is
 * rendered into the bottom-left corner of the GL canvas -- hidden behind the
 * tool rail -- and that corner is copied into a 2D canvas inside the slot.
 */
function drawPalette() {
  const slot = $('palette-slot');
  const out = $('palette-canvas');
  const w = Math.round(slot.clientWidth * dpr);
  const h = Math.round(slot.clientHeight * dpr);
  const gl = engine.gl;
  if (w < 2 || h < 2 || w > gl.canvas.width || h > gl.canvas.height) return;
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  engine.renderTo(paletteSurface, [0, 0, w, h]);
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // GL drew into the bottom-left; in image space that is the last h rows.
  ctx.drawImage(gl.canvas, 0, gl.canvas.height - h, w, h, 0, 0, w, h);
}

/** How many canvas pixels there are to the inch, for the current canvas. */
function pxPerInch() {
  return canvasSurface ? canvasSurface.width / (canvasSurface.widthInches || 24) : 60;
}

/** The active tool's size, in canvas pixels. */
function toolSizePx() {
  return Math.max(2, state.sizes[state.toolId] * pxPerInch());
}

/** DOM element rect -> GL viewport rect (device pixels, bottom-left origin). */
function glRect(el) {
  const r = el.getBoundingClientRect();
  return [r.left * dpr, (window.innerHeight - r.bottom) * dpr, r.width * dpr, r.height * dpr];
}

// ----------------------------------------------------------- render loop ---

let lastFrameAt = 0;
let slowFrames = 0;
let dabBudget = 140;

function frame(t) {
  // Watch how long frames are actually taking and hand the stroke runner a
  // matching allowance. A tablet that cannot manage 140 dabs a frame gets a
  // coarser stroke instead of a frozen one.
  if (lastFrameAt) {
    const dt = t - lastFrameAt;
    if (dt > 34) slowFrames = Math.min(slowFrames + 1, 40);
    else if (dt < 20) slowFrames = Math.max(slowFrames - 1, 0);
    dabBudget = slowFrames > 8 ? Math.max(24, Math.round(140 * (8 / slowFrames))) : 140;
  }
  lastFrameAt = t;
  if (stroke) stroke.beginFrame(dabBudget);

  if (needsRender) {
    needsRender = false;
    // The palette borrows a corner of the GL canvas, so copy it out first and
    // let the backdrop clear wipe the borrowed pixels.
    drawPalette();
    engine.clearScreen(engine.gl.canvas.width, engine.gl.canvas.height, BACKDROP);
    engine.renderTo(canvasSurface, glRect($('easel')), glRect($('stage')));
  }

  requestAnimationFrame(frame);
}

// ------------------------------------------------------------- tool rail ---

function toolPreview(tool) {
  const c = document.createElement('canvas');
  c.width = 132;
  c.height = 60;
  const ctx = c.getContext('2d');

  const m = document.createElement('canvas');
  m.width = m.height = MASK_RES;
  const mc = m.getContext('2d');
  const img = mc.createImageData(MASK_RES, MASK_RES);
  const isKnife = tool.category === 'knife';
  for (let i = 0; i < tool.mask.length; i++) {
    img.data[i * 4] = isKnife ? 196 : 226;
    img.data[i * 4 + 1] = isKnife ? 202 : 204;
    img.data[i * 4 + 2] = isKnife ? 210 : 168;
    img.data[i * 4 + 3] = tool.mask[i];
  }
  mc.putImageData(img, 0, 0);

  // Draw each tool at its true size relative to the others. Normalising every
  // footprint to fill the cell threw away the one property that tells a 2"
  // brush from a detail round at a glance, and left thirteen identical smudges.
  const maxIn = Math.max(...TOOLS.map((t) => t.inches));
  const k = 0.3 + 0.7 * Math.sqrt(tool.inches / maxIn);
  let w = 122 * k;
  let h = w * tool.aspect;
  if (h > 54) {
    h = 54;
    w = h / tool.aspect;
  }
  ctx.drawImage(m, (132 - w) / 2, (60 - h) / 2, w, h);
  return c;
}

function buildToolRail() {
  const rail = $('tool-rail');
  rail.innerHTML = '';
  let index = 0;
  for (const cat of TOOL_CATEGORIES) {
    const tools = TOOLS.filter((t) => t.category === cat.id);
    if (!tools.length) continue;
    const label = document.createElement('div');
    label.className = 'rail-group-label';
    label.textContent = cat.label;
    rail.appendChild(label);
    for (const tool of tools) {
      const btn = document.createElement('button');
      btn.className = 'tool';
      btn.dataset.tool = tool.id;
      btn.setAttribute('aria-pressed', 'false');
      btn.title = `${tool.name}\n\n${tool.blurb}`;
      btn.appendChild(toolPreview(tool));
      const span = document.createElement('span');
      span.textContent = tool.rackName || tool.short;
      btn.appendChild(span);
      if (index < 10) {
        const kbd = document.createElement('kbd');
        kbd.textContent = String((index + 1) % 10);
        btn.appendChild(kbd);
      }
      index++;
      btn.addEventListener('click', () => selectTool(tool.id));
      rail.appendChild(btn);
    }
  }
}

function selectTool(id) {
  state.toolId = id;
  const tool = TOOLS_BY_ID[id];
  engine.setTool(tool);
  for (const b of document.querySelectorAll('.tool')) {
    b.setAttribute('aria-pressed', b.dataset.tool === id ? 'true' : 'false');
  }
  $('tool-title').textContent = tool.name;
  $('tool-blurb').textContent = tool.blurb;
  refreshToolSliders();
  updateBrushCursor();
}

// --------------------------------------------------------------- palette ---

/** A dab of squeezed paint sitting on the board. */
function paintDab(paint, host) {
  const btn = document.createElement('button');
  btn.className = 'dab';
  btn.dataset.paint = paint.id;
  btn.style.setProperty('--c', paint.hex);
  btn.setAttribute('aria-pressed', 'false');
  // Transparent pigments look like glazes rather than solid buttons.
  if (paint.opacity < 0.45) btn.dataset.glaze = '1';
  btn.title = `${paint.name}\n${paint.note}\n\nTinting strength ${paint.tint.toFixed(1)}x`;
  btn.setAttribute('aria-label', paint.name);
  btn.addEventListener('click', (e) => selectPaint(paint.id, { squeezeOnly: e.shiftKey }));
  host.appendChild(btn);
}

function buildPalette() {
  const lights = $('dabs-lights');
  const darks = $('dabs-darks');
  lights.innerHTML = '';
  darks.innerHTML = '';
  // Bob's own layout: darks up the left, lights across the top. colors.js is
  // already ordered that way.
  for (const pig of PIGMENTS) paintDab(pig, pig.dark === false ? lights : darks);

  const meds = $('mediums');
  meds.innerHTML = '';
  for (const m of MEDIUMS) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = m.name.replace('Liquid ', '');
    b.title = `${m.name}\n${m.note}`;
    b.addEventListener('click', () => applyBaseCoat(m.id));
    meds.appendChild(b);
  }
}

function selectPaint(id, { squeezeOnly = false } = {}) {
  state.paintId = id;
  const paint = PAINTS_BY_ID[id];
  for (const b of document.querySelectorAll('.dab')) {
    b.setAttribute('aria-pressed', b.dataset.paint === id ? 'true' : 'false');
  }
  $('board-hint').classList.add('gone');

  squeezeOntoPalette(paint);
  if (squeezeOnly) {
    toast(`${paint.name} squeezed out. Drag a tool through it to load up.`);
    return;
  }

  const tool = TOOLS_BY_ID[state.toolId];
  if (tool.noLoad) {
    toast(`${tool.name} carries no paint of its own -- it works with what is already there.`);
    return;
  }
  engine.loadBrush(hexToRgb(paint.hex), paint.tint, 1, true, paint.opacity);
  engine.setStock(hexToRgb(paint.hex), paint.tint, paint.opacity);
  updateBrushState({ colour: hexToRgb(paint.hex), load: 1 });
  toast(paint.note);
}

function squeezeOntoPalette(paint) {
  // Darks up the left edge, lights across the top -- Bob's own palette layout,
  // and it keeps the middle of the board clear to mix in.
  const i = state.squeezeSlot % 12;
  state.squeezeSlot++;
  const m = BLOB_RADIUS * 1.35;
  let x;
  let y;
  if (i < 5) {
    x = m + (i + 0.5) * ((PALETTE_W - m * 2) / 5);
    y = PALETTE_H - m;
  } else {
    x = m;
    y = PALETTE_H - m * 2 - (i - 5 + 0.5) * ((PALETTE_H - m * 3) / 7);
  }
  engine.blob(paletteSurface, {
    x,
    y,
    radius: BLOB_RADIUS,
    colour: hexToRgb(paint.hex),
    tint: paint.tint,
    // Deep. A pile has to hold several brush-loads to be worth dipping into.
    amount: paint.fluid ? 2.5 : 5.0,
    body: paint.body,
    wetness: 1,
    clearMix: paint.clear ? 1 : 0,
    opacity: paint.opacity,
  });
  needsRender = true;
}

function updateBrushState({ colour, load }) {
  $('brush-chip').style.background = rgbToHex(colour);
  // Load is a fill fraction now, so the meter needs no per-tool scaling and
  // finally reads true.
  const pct = Math.max(0, Math.min(1, load));
  $('load-fill').style.width = `${pct * 100}%`;
  $('load-text').textContent = pct < 0.02 ? 'empty' : `${Math.round(pct * 100)}%`;
}

// --------------------------------------------------------------- sliders ---

function slider(host, { key, label, min, max, step, get, set, format }) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  wrap.dataset.key = key;

  const lab = document.createElement('label');
  lab.textContent = label;
  const out = document.createElement('output');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = step;

  const sync = () => {
    const v = get();
    input.value = v;
    out.textContent = format ? format(v) : v;
  };
  input.addEventListener('input', () => {
    set(parseFloat(input.value));
    out.textContent = format ? format(parseFloat(input.value)) : input.value;
  });

  wrap.append(lab, out, input);
  host.appendChild(wrap);
  wrap._sync = sync;
  sync();
  return wrap;
}

function checkbox(host, { label, get, set, title }) {
  const row = document.createElement('label');
  row.className = 'checkrow';
  if (title) row.title = title;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  row.append(input, document.createTextNode(label));
  host.appendChild(row);
  row._sync = () => {
    input.checked = get();
  };
  return row;
}

let toolSliderEls = [];

function buildToolSliders() {
  // Size is the one control a painter reaches for constantly, so it stays
  // visible. Everything else lives behind a disclosure.
  toolSliderEls = [
    slider($('size-slider'), {
      key: 'size',
      label: 'Size',
      min: 0.02,
      max: 5,
      step: 0.01,
      get: () => state.sizes[state.toolId],
      set: (v) => {
        state.sizes[state.toolId] = v;
        updateBrushCursor();
      },
      format: fmtSize,
    }),
  ];

  const host = $('tool-sliders');
  host.innerHTML = '';
  toolSliderEls.push(
    slider(host, {
      key: 'flow',
      label: 'Paint flow',
      min: 0,
      max: 2,
      step: 0.01,
      get: () => state.flowScale,
      set: (v) => (state.flowScale = v),
      format: (v) => `${Math.round(v * 100)}%`,
    }),
    slider(host, {
      key: 'blend',
      label: 'Blending — how much wet paint it lifts',
      min: 0,
      max: 2,
      step: 0.01,
      get: () => state.blendScale,
      set: (v) => (state.blendScale = v),
      format: (v) => `${Math.round(v * 100)}%`,
    }),
    slider(host, {
      key: 'thinner',
      label: 'Thin the paint',
      min: 0,
      max: 1,
      step: 0.01,
      get: () => state.thinner,
      set: (v) => (state.thinner = v),
      format: (v) => (v < 0.02 ? 'none' : `${Math.round(v * 100)}%`),
    }),
    slider(host, {
      key: 'pressure',
      label: 'Pressure',
      min: 0.05,
      max: 1,
      step: 0.01,
      get: () => state.pressure,
      set: (v) => (state.pressure = v),
      format: (v) => `${Math.round(v * 100)}%`,
    }),
    slider(host, {
      key: 'angle',
      label: 'Brush angle',
      min: 0,
      max: 359,
      step: 1,
      get: () => state.angle,
      set: (v) => {
        state.angle = v;
        updateBrushCursor();
      },
      format: (v) => `${Math.round(v)}°`,
    }),
    checkbox(host, {
      label: 'Reload the brush at the start of each stroke',
      title: 'How real brushes work. Turn it off to make the paint run out for good.',
      get: () => state.autoReload,
      set: (v) => (state.autoReload = v),
    }),
    checkbox(host, {
      label: 'Keep a dirty brush between strokes',
      title:
        'Off: each stroke starts with the colour you picked. On: the tool keeps whatever it ' +
        'dragged up off the canvas, the way it would if you never wiped it.',
      get: () => state.dirtyBrush,
      set: (v) => (state.dirtyBrush = v),
    })
  );
  refreshToolSliders();
}

function fmtSize(v) {
  return v < 0.35 ? `${(v * 25.4).toFixed(1)} mm` : `${v.toFixed(2)}"`;
}

function refreshToolSliders() {
  const tool = TOOLS_BY_ID[state.toolId];
  for (const el of toolSliderEls) el._sync && el._sync();
  const sizeEl = toolSliderEls.find((e) => e.dataset && e.dataset.key === 'size');
  if (sizeEl) {
    const input = sizeEl.querySelector('input');
    input.min = tool.range[0];
    input.max = tool.range[1];
    input.value = state.sizes[tool.id];
    const v = state.sizes[tool.id];
    sizeEl.querySelector('output').textContent = fmtSize(v);
  }
  const angleEl = toolSliderEls.find((e) => e.dataset && e.dataset.key === 'angle');
  if (angleEl) {
    angleEl.style.opacity = tool.followStroke ? 0.4 : 1;
    angleEl.querySelector('input').disabled = tool.followStroke;
    angleEl.querySelector('label').textContent = tool.followStroke
      ? 'Brush angle — follows the stroke'
      : 'Brush angle';
  }
}

let surfaceSliderEls = [];

function buildSurfaceSliders() {
  const host = $('surface-sliders');
  surfaceSliderEls = [];
  host.innerHTML = '';
  const v = engine.view;
  const mark = () => (needsRender = true);
  const presets = document.createElement('div');
  presets.className = 'mediums';
  for (const [name, scale, depth] of [['Fine linen', 3.4, 0.28], ['Cotton duck', 5.5, 0.4], ['Rough', 8.5, 0.62]]) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = name;
    b.addEventListener('click', () => {
      v.weaveScale = scale;
      v.weaveDepth = depth;
      for (const el of surfaceSliderEls) el._sync && el._sync();
      mark();
    });
    presets.appendChild(b);
  }
  host.appendChild(presets);
  surfaceSliderEls.push(slider(host, {
    key: 'weaveDepth',
    label: 'Canvas tooth — how much a dry brush skips',
    min: 0,
    max: 1.2,
    step: 0.01,
    get: () => v.weaveDepth,
    set: (x) => {
      v.weaveDepth = x;
      mark();
    },
    format: (x) => `${Math.round(x * 100)}%`,
  }));
  surfaceSliderEls.push(slider(host, {
    key: 'relief',
    label: 'Impasto relief',
    min: 0,
    max: 2.5,
    step: 0.01,
    get: () => v.relief,
    set: (x) => {
      v.relief = x;
      mark();
    },
    format: (x) => `${Math.round(x * 100)}%`,
  }));
  surfaceSliderEls.push(slider(host, {
    key: 'gloss',
    label: 'Wet paint gloss',
    min: 0,
    max: 1.5,
    step: 0.01,
    get: () => v.gloss,
    set: (x) => {
      v.gloss = x;
      mark();
    },
    format: (x) => `${Math.round(x * 100)}%`,
  }));
  surfaceSliderEls.push(slider(host, {
    key: 'light',
    label: 'Studio light direction',
    min: 0,
    max: 359,
    step: 1,
    get: () => (Math.atan2(v.lightDir[1], v.lightDir[0]) * 180) / Math.PI + 180,
    set: (deg) => {
      const a = ((deg - 180) * Math.PI) / 180;
      v.lightDir = [Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.65];
      mark();
    },
    format: (x) => `${Math.round(x)}°`,
  }));
}

/**
 * Draws the tool at its true size under the pointer. Cheap, and it is most of
 * the difference between a cursor and something you feel you are holding.
 */
function updateBrushCursor(clientX, clientY) {
  if (clientX !== undefined) {
    cursorAt.x = clientX;
    cursorAt.y = clientY;
  }
  drawCursor($('brush-cursor'), $('stage'), state.zoom);
}

/**
 * The palette needs the same mark as the canvas. Mixing is done by feel, and
 * on a touchscreen your finger hides the very paint you are working into, so
 * without this you are guessing where the tool actually is.
 */
function updatePaletteCursor(clientX, clientY) {
  if (clientX !== undefined) {
    paletteAt.x = clientX;
    paletteAt.y = clientY;
  }
  const slot = $('palette-slot');
  // The palette is drawn to fit its slot, so the tool's true size scales too.
  const scale = slot.clientWidth / PALETTE_W;
  drawCursor($('palette-cursor'), slot, scale, paletteAt);
}

function drawCursor(el, host, zoom, at = cursorAt) {
  const tool = TOOLS_BY_ID[state.toolId];
  const rect = host.getBoundingClientRect();
  const over = at.x >= rect.left && at.x <= rect.right &&
    at.y >= rect.top && at.y <= rect.bottom;
  if (!over) {
    el.hidden = true;
    return;
  }
  const w = toolSizePx() * zoom;
  const h = w * tool.aspect;
  const angle = tool.followStroke ? strokeAngleDeg : state.angle;
  el.hidden = false;
  el.classList.toggle('round', tool.aspect > 0.75 && tool.aspect < 1.4 && tool.category !== 'knife');
  el.style.width = `${Math.max(3, w)}px`;
  el.style.height = `${Math.max(3, h)}px`;
  el.style.transform =
    `translate(${at.x - rect.left - w / 2}px, ${at.y - rect.top - h / 2}px) rotate(${-angle}deg)`;
}

// --------------------------------------------------------------- pointer ---

const cursorAt = { x: -1e4, y: -1e4 };
const paletteAt = { x: -1e4, y: -1e4 };
let strokeAngleDeg = 0;
let activePointer = null;
let penIsDown = false;
let panning = null;

function surfacePoint(ev, el, surface) {
  const r = el.getBoundingClientRect();
  return {
    x: ((ev.clientX - r.left) / r.width) * surface.width,
    // GL textures start at the bottom-left; the DOM starts at the top-left.
    y: (1 - (ev.clientY - r.top) / r.height) * surface.height,
  };
}

function inputFrom(ev) {
  return { pressure: ev.pressure, pointerType: ev.pointerType, tiltX: ev.tiltX, tiltY: ev.tiltY };
}

function settingsFor(ev) {
  const tool = TOOLS_BY_ID[state.toolId];
  let tiltAngle = null;
  if (state.useTilt && ev.pointerType === 'pen' && (ev.tiltX || ev.tiltY)) {
    tiltAngle = Math.atan2(-ev.tiltY, ev.tiltX);
  }
  return {
    tool,
    paint: PAINTS_BY_ID[state.paintId],
    size: toolSizePx(),
    angle: (state.angle * Math.PI) / 180,
    tiltAngle,
    pressure: state.pressure,
    pressureCurve: state.pressureCurve,
    usePressure: state.usePressure,
    // The palette handles itself now: the simulation treats it as a source of
    // paint rather than a surface being painted.
    flowScale: state.flowScale,
    blendScale: state.blendScale,
    thinner: state.thinner,
  };
}

function wirePointer(el, getSurface, { palette }) {
  el.addEventListener('pointerdown', (ev) => {
    if (activePointer !== null) return;
    // Palm rejection: once a pen is in play, ignore stray touches.
    if (penIsDown && ev.pointerType === 'touch') return;
    if (ev.pointerType === 'pen') penIsDown = true;

    if (!palette && (ev.button === 1 || ev.shiftKey)) {
      panning = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
      el.setPointerCapture(ev.pointerId);
      el.classList.add('panning');
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;

    const surface = getSurface();
    const pt = surfacePoint(ev, el, surface);

    if (ev.altKey) {
      // Eyedropper: pick the paint right off the canvas.
      const s = engine.samplePaint(surface, pt.x, pt.y);
      if (s.volume > 0.01) {
        engine.loadBrush(s.colour, 1.0, 1, true, 0.85);
        engine.setStock(s.colour, 1.0, 0.85);
        updateBrushState({ colour: s.colour, load: 1 });
        toast(`Picked up ${rgbToHex(s.colour)} off the canvas.`);
      }
      return;
    }

    activePointer = ev.pointerId;
    if (palette) updatePaletteCursor(ev.clientX, ev.clientY);
    el.setPointerCapture(ev.pointerId);
    // Real brushes get recharged before every stroke. Not doing this was the
    // main reason the tool felt permanently empty. It tops the load back up
    // without changing the colour, so a mixture you made survives.
    if (state.autoReload && !palette && !TOOLS_BY_ID[state.toolId].noLoad) {
      engine.rechargeBrush(state.dirtyBrush);
    }
    engine.pushHistory(surface);
    updateUndoButtons();
    stroke.begin(surface, pt, inputFrom(ev), settingsFor(ev));
    needsRender = true;
    ev.preventDefault();
  });

  el.addEventListener('pointermove', (ev) => {
    if (palette) updatePaletteCursor(ev.clientX, ev.clientY);
    else updateBrushCursor(ev.clientX, ev.clientY);
    if (panning && panning.id === ev.pointerId) {
      state.panX += ev.clientX - panning.x;
      state.panY += ev.clientY - panning.y;
      panning.x = ev.clientX;
      panning.y = ev.clientY;
      if (state.zoomMode === 'fit') state.zoomMode = 'manual';
      layout();
      return;
    }
    if (ev.pointerId !== activePointer) return;

    const surface = getSurface();
    const settings = settingsFor(ev);
    // Coalesced events carry every sample the digitiser took between frames,
    // which is what keeps a fast stroke smooth instead of polygonal.
    const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const e of events.length ? events : [ev]) {
      stroke.extend(surfacePoint(e, el, surface), inputFrom(e), settings);
    }
    needsRender = true;
  });

  const finish = (ev) => {
    if (panning && panning.id === ev.pointerId) {
      panning = null;
      el.classList.remove('panning');
      return;
    }
    if (ev.pointerId !== activePointer) return;
    activePointer = null;
    if (ev.pointerType === 'pen') penIsDown = false;
    stroke.end();
    scheduleSave();
    const r = engine.sampleReservoir();
    // Mixing on the palette is how you choose a colour, so whatever comes off
    // the board becomes the charged colour for the canvas.
    if (palette) engine.stockFromBrush();
    updateBrushState(r);
    needsRender = true;
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerleave', () => {
    if (activePointer !== null) return;
    $(palette ? 'palette-cursor' : 'brush-cursor').hidden = true;
  });
}

// -------------------------------------------------------------- top bar ---

function showMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = 'open-menu';
  for (const item of items) {
    if (item === '-') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    b.textContent = item.label;
    if (item.note) {
      const s = document.createElement('small');
      s.textContent = item.note;
      b.appendChild(s);
    }
    b.addEventListener('click', () => {
      closeMenu();
      item.action();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, { once: true }), 0);
}

function onDocDown(ev) {
  const menu = $('open-menu');
  if (menu && !menu.contains(ev.target)) closeMenu();
}

function closeMenu() {
  const menu = $('open-menu');
  if (menu) menu.remove();
}

function applyBaseCoat(mediumId) {
  const m = PAINTS_BY_ID[mediumId];
  engine.pushHistory(canvasSurface);
  engine.fill(canvasSurface, {
    colour: hexToRgb(m.hex),
    tint: m.tint,
    amount: 0.42,
    wetness: 1,
    body: m.body,
    clearMix: m.clear ? 1 : 0,
    opacity: m.opacity,
  });
  updateUndoButtons();
  needsRender = true;
  toast(`${m.name} down. Work quickly while it is wet — that is the whole idea.`);
}

// ----------------------------------------------------- painting a picture ---

let painting = null;

/**
 * Paint from a photograph, with the real tools and the real wet paint. It is
 * not a filter over the image: every stroke goes through the same simulation
 * your own hand does, so it blends into what is wet, runs out, and picks up
 * what it is dragged through.
 */
async function paintPicture(file) {
  if (painting) {
    painting.stop = true;
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('could not read that picture'));
      im.src = url;
    });

    // Fit the picture to the canvas, covering it.
    const w = canvasSurface.width;
    const h = canvasSurface.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    const px = ctx.getImageData(0, 0, w, h).data;
    const data = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      data[i * 3] = px[i * 4] / 255;
      data[i * 3 + 1] = px[i * 4 + 1] / 255;
      data[i * 3 + 2] = px[i * 4 + 2] / 255;
    }

    painting = { stop: false };
    $('btn-picture').textContent = 'Stop painting';
    $('btn-picture').classList.add('busy');
    engine.pushHistory(canvasSurface);

    await paintFromPicture(window.studio.script, { data, width: w, height: h }, {
      shouldStop: () => painting.stop,
      onProgress: (done, total, label) => {
        toast(done >= total ? 'Finished.' : `Painting — pass ${done + 1} of ${total}, ${label}`);
        needsRender = true;
      },
    });
  } catch (err) {
    toast(err.message || String(err));
  } finally {
    URL.revokeObjectURL(url);
    painting = null;
    $('btn-picture').textContent = 'Paint a picture';
    $('btn-picture').classList.remove('busy');
    updateUndoButtons();
    scheduleSave();
    needsRender = true;
  }
}

function wireTopBar() {
  $('btn-canvas').addEventListener('click', (e) =>
    showMenu(e.currentTarget, [
      ...MEDIUMS.map((m) => ({
        label: `Base coat — ${m.name}`,
        note: m.note,
        action: () => applyBaseCoat(m.id),
      })),
      '-',
      ...CANVAS_PRESETS.map((preset) => ({
        label: `New canvas — ${preset.label}`,
        note: preset.note,
        action: () => newCanvas(preset),
      })),
      '-',
      {
        label: 'Scrape back to bare canvas',
        note: 'Wipes the painting off',
        action: () => {
          engine.pushHistory(canvasSurface);
          engine.clear(canvasSurface);
          updateUndoButtons();
          needsRender = true;
        },
      },
    ])
  );

  $('btn-picture').addEventListener('click', () => $('picture-file').click());
  $('picture-file').addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (file) paintPicture(file);
  });

  $('btn-dry').addEventListener('click', () => {
    engine.pushHistory(canvasSurface);
    engine.dry(canvasSurface, 1);
    updateUndoButtons();
    needsRender = true;
    toast('Dry. The next layer will sit on top instead of blending in.');
  });

  $('btn-undo').addEventListener('click', () => doUndo());
  $('btn-redo').addEventListener('click', () => doRedo());

  $('btn-zoom-fit').addEventListener('click', () => {
    state.zoomMode = 'fit';
    layout();
  });

  // The squint test every painter does: values are easier to judge without
  // hue in the way.
  const squint = $('btn-squint');
  const setSquint = (on) => {
    if (engine.view.squint === (on ? 1 : 0)) return;
    engine.view.squint = on ? 1 : 0;
    squint.classList.toggle('active', on);
    needsRender = true;
  };
  squint.addEventListener('pointerdown', () => setSquint(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    squint.addEventListener(ev, () => setSquint(false));
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'v' || e.key === 'V') setSquint(true);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'v' || e.key === 'V') setSquint(false);
  });

  $('btn-save').addEventListener('click', savePNG);
  $('side').addEventListener('keydown', (e) => e.stopPropagation());

  $('btn-wipe-palette').addEventListener('click', () => {
    engine.clear(paletteSurface);
    state.squeezeSlot = 0;
    needsRender = true;
    toast('Palette scraped clean.');
  });
  $('btn-clean-brush').addEventListener('click', () => {
    engine.cleanBrush();
    updateBrushState({ colour: [0.85, 0.84, 0.81], load: 0 });
    toast('Beat the devil out of it. Clean brush.');
  });

  $('btn-panels').addEventListener('click', () => {
    $('side').classList.toggle('open');
    $('lessons').hidden = true;
  });
  $('btn-lessons').addEventListener('click', () => {
    const el = $('lessons');
    el.hidden = !el.hidden;
    $('side').classList.remove('open');
  });
  $('btn-lessons-close').addEventListener('click', () => ($('lessons').hidden = true));

  $('stage').addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey && Math.abs(ev.deltaY) < 1) return;
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );

  // First run: the one thing a newcomer has to be told, said where they are
  // already looking rather than in small grey text at the bottom of the window.
  const fr = $('firstrun');
  const dismiss = () => {
    fr.hidden = true;
    try {
      localStorage.setItem('jop.seen', '1');
    } catch {}
  };
  for (const b of fr.querySelectorAll('[data-basecoat]')) {
    b.addEventListener('click', () => {
      applyBaseCoat(b.dataset.basecoat);
      dismiss();
    });
  }
  $('firstrun-skip').addEventListener('click', dismiss);
  $('firstrun-lesson').addEventListener('click', () => {
    dismiss();
    $('lessons').hidden = false;
  });
  let seen = false;
  try {
    seen = !!localStorage.getItem('jop.seen');
  } catch {}
  fr.hidden = seen;
  // Clicking the dimmed canvas behind the card should get you painting too --
  // the card sits above the easel, so a stroke aimed at the canvas would
  // otherwise land on the scrim and do nothing.
  fr.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('.card')) dismiss();
  });
}

function zoomBy(f) {
  state.zoom = Math.max(0.05, Math.min(8, state.zoom * f));
  state.zoomMode = 'manual';
  layout();
}

function doUndo() {
  if (engine.undo(canvasSurface)) {
    updateUndoButtons();
    needsRender = true;
    scheduleSave();
  }
}

function doRedo() {
  if (engine.redo(canvasSurface)) {
    updateUndoButtons();
    needsRender = true;
    scheduleSave();
  }
}

function updateUndoButtons() {
  $('btn-undo').disabled = !engine.canUndo(canvasSurface);
  $('btn-redo').disabled = !engine.canRedo(canvasSurface);
}

function savePNG() {
  const img = engine.exportImage(canvasSurface);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  c.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `painting-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}

let toastTimer = null;

/** A short message over the stage that fades on its own. */
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('fading');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => {
      el.hidden = true;
    }, 400);
  }, 4200);
}

// -------------------------------------------------------------- lessons ---

function buildLessons() {
  const picker = $('lesson-picker');
  picker.innerHTML = '';
  for (const lesson of LESSONS) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = lesson.title;
    b.dataset.lesson = lesson.id;
    b.addEventListener('click', () => {
      state.lessonId = lesson.id;
      state.lessonStep = -1;
      renderLesson();
    });
    picker.appendChild(b);
  }
  renderLesson();
}

function renderLesson() {
  const lesson = LESSONS.find((l) => l.id === state.lessonId) || LESSONS[0];
  for (const b of $('lesson-picker').children) {
    b.classList.toggle('active', b.dataset.lesson === lesson.id);
  }
  const list = $('lesson-steps');
  list.innerHTML = '';
  lesson.steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.classList.toggle('active', i === state.lessonStep);
    const b = document.createElement('b');
    b.textContent = step.title;
    const p = document.createElement('p');
    p.textContent = step.text;
    li.append(b, p);

    const chips = document.createElement('div');
    chips.className = 'chips';
    if (step.tool) {
      const em = document.createElement('em');
      em.textContent = TOOLS_BY_ID[step.tool].name;
      chips.appendChild(em);
    }
    for (const cid of step.colours || []) {
      const dot = document.createElement('i');
      dot.style.background = PAINTS_BY_ID[cid].hex;
      dot.title = PAINTS_BY_ID[cid].name;
      chips.appendChild(dot);
    }
    if (chips.children.length) li.appendChild(chips);

    li.addEventListener('click', () => {
      state.lessonStep = i;
      if (step.tool) selectTool(step.tool);
      if (step.baseCoat) applyBaseCoat(step.baseCoat);
      if (step.colours && step.colours.length) {
        // Put the whole step's palette out, and load the first colour.
        for (const cid of step.colours.slice(1)) squeezeOntoPalette(PAINTS_BY_ID[cid]);
        selectPaint(step.colours[0]);
      }
      toast(step.title);
      renderLesson();
    });
    list.appendChild(li);
  });
}

// ------------------------------------------------------------- keyboard ---

const TOOL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function wireKeyboard() {
  window.addEventListener('keydown', (ev) => {
    // ev.target is the Window when nothing has focus, and Window has no
    // .matches -- which threw before any shortcut could run.
    const t = ev.target;
    if (t instanceof Element && t.matches('input, textarea, select, [contenteditable]')) return;
    const meta = ev.ctrlKey || ev.metaKey;

    if (meta && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      ev.shiftKey ? doRedo() : doUndo();
      return;
    }
    if (meta && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      doRedo();
      return;
    }
    if (meta && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      savePNG();
      return;
    }
    if (meta) return;

    const tool = TOOLS_BY_ID[state.toolId];
    switch (ev.key) {
      case '[':
      case ']': {
        const f = ev.key === '[' ? 1 / 1.12 : 1.12;
        const next = Math.max(tool.range[0], Math.min(tool.range[1], state.sizes[tool.id] * f));
        state.sizes[tool.id] = next;
        refreshToolSliders();
        break;
      }
      case 'c':
      case 'C':
        $('btn-clean-brush').click();
        break;
      case 'D':
        $('btn-dry').click();
        break;
      case '+':
      case '=':
        zoomBy(1.25);
        break;
      case '-':
        zoomBy(1 / 1.25);
        break;
      case 'f':
      case 'F':
        state.zoomMode = 'fit';
        layout();
        break;
      default: {
        const i = TOOL_KEYS.indexOf(ev.key);
        if (i >= 0 && TOOLS[i]) selectTool(TOOLS[i].id);
      }
    }
  });
}

// A small handle on the running studio, for poking at the simulation from the
// browser console and for automated checks.
// Handy for calibrating the palette from the console or a test harness.
window.__tools = TOOLS;
window.__paints = ALL_PAINTS.map((p) => ({ ...p, rgb: hexToRgb(p.hex) }));

/**
 * A scripted painter. Everything the pointer does, done from code: the same
 * StrokeRunner, the same settings, the same tool and paint selection. It
 * exists so a painting can be written down, replayed exactly, and compared
 * against the last run -- which is the only way to tell whether a change to
 * the simulation made the picture better or just different.
 *
 * Coordinates are in canvas pixels with the origin at the TOP LEFT, because
 * that is how a reference photograph is measured. They are flipped to GL's
 * bottom-left origin on the way in.
 */
function makeScript() {
  // A painting is written in one fixed set of coordinates -- 1440 across a
  // 24 in canvas -- and scaled to whatever canvas it is replayed on. That is
  // what lets the same script be tried quickly on a small canvas and then
  // painted properly on a big one. Tool sizes need no scaling: they are in
  // inches already.
  let designWidth = 1440;
  const k = () => canvasSurface.width / designWidth;
  const pt = (p) => ({ x: p[0] * k(), y: canvasSurface.height - p[1] * k() });

  // A scripted stroke is not racing a display, so it never thins its dabs out
  // to keep a frame rate. Replaying the same script has to give the same
  // picture on a fast machine and a slow one.
  const UNLIMITED = 1e9;

  const settings = () =>
    settingsFor({ pointerType: 'mouse', pressure: 0.5, tiltX: 0, tiltY: 0 });

  /** Walk a polyline, subdividing so the runner sees a smooth path. */
  function path(points, { step = 6, close = false } = {}) {
    const list = close ? [...points, points[0]] : points;
    const out = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(d / step));
      for (let k = 1; k <= n; k++) {
        out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
      }
    }
    return out;
  }

  return {
    get state() {
      return state;
    },
    get size() {
      return { w: canvasSurface.width, h: canvasSurface.height, scale: k() };
    },
    /** The width the coordinates in this script are written against. */
    design(width) {
      designWidth = width;
      return this;
    },
    /** Start again on a canvas of a given size, in pixels and inches. */
    canvas(w, h, inches = 24) {
      newCanvas({ w, h, wIn: inches });
      return this;
    },
    tool(id, inches) {
      // Say so plainly. A bad id used to reach the engine and die there with
      // "cannot read properties of undefined", twelve stages into a painting.
      if (!TOOLS_BY_ID[id]) throw new Error(`no such tool: ${JSON.stringify(id)}`);
      selectTool(id);
      if (inches) {
        state.sizes[id] = inches;
        refreshToolSliders();
      }
      return this;
    },
    paint(id, opts) {
      selectPaint(id, opts || {});
      return this;
    },
    /** Set any of pressure, thinner, flowScale, blendScale, angle, dirtyBrush. */
    set(props) {
      Object.assign(state, props);
      refreshToolSliders();
      return this;
    },
    baseCoat(mediumId) {
      applyBaseCoat(mediumId);
      return this;
    },
    dry(amount = 1) {
      engine.dry(canvasSurface, amount);
      needsRender = true;
      return this;
    },
    clean() {
      engine.cleanBrush();
      updateBrushState({ colour: [0.97, 0.96, 0.94], load: 0 });
      return this;
    },
    /** Reload the tool with the charged colour, as a stroke start would. */
    reload() {
      engine.rechargeBrush(state.dirtyBrush);
      return this;
    },
    /**
     * One stroke along a polyline. `step` is the distance between the samples
     * handed to the runner -- the equivalent of how fast a hand moved.
     */
    stroke(points, opts = {}) {
      const s = settings();
      // Subdivide finely enough for the canvas actually being painted.
      const pts = path(points, { ...opts, step: (opts.step ?? 6) / Math.max(k(), 0.35) });
      const input = { pointerType: 'mouse', pressure: 0.5, tiltX: 0, tiltY: 0 };
      if (opts.autoReload !== false && state.autoReload && !s.tool.noLoad) {
        engine.rechargeBrush(state.dirtyBrush);
      }
      // A replay has nothing to undo back to, and a snapshot per stroke is by
      // far the most expensive thing in a script that lays thousands of them.
      if (opts.history) engine.pushHistory(canvasSurface);
      stroke.beginFrame(UNLIMITED);
      stroke.begin(canvasSurface, pt(pts[0]), input, s);
      for (let i = 1; i < pts.length; i++) {
        stroke.beginFrame(UNLIMITED);
        stroke.extend(pt(pts[i]), input, s);
      }
      stroke.end();
      // Reading the bristles back stalls the pipeline, and a script lays
      // hundreds of strokes with nothing between them, so it is done only when
      // asked for. The reload decision does not need it: the engine goes by
      // whether the tool has been used, not by a cached number.
      if (opts.sample) updateBrushState(engine.sampleReservoir());
      needsRender = true;
      return this;
    },
    /** A press with no travel: foliage, a cloud, a dot of foam. */
    tap(p, opts = {}) {
      return this.stroke([p, [p[0] + 0.01, p[1]]], opts);
    },
    /**
     * Mix a colour the way it is actually mixed: lay the pigments out on the
     * board in the proportions you want and drag a tool through them. Parts
     * are areas, so `[['titanium-white', 8], ['phthalo-blue', 1]]` is eight
     * times as much white as blue, and the bristles do the mixing.
     *
     * Returns what ended up on the tool, so a script can check its colour
     * instead of hoping.
     */
    mix(parts, { passes = 3, tool } = {}) {
      if (tool) selectTool(tool);
      const t = TOOLS_BY_ID[state.toolId];
      const total = parts.reduce((n, p) => n + p[1], 0);
      // Scrape the board first, the way you would before mixing a new colour.
      // This used to try to do it with a blob of nothing -- which lays nothing
      // and therefore removes nothing, so every mixture went down on top of
      // all the ones before it and the colours drifted darker as the painting
      // went on. The cloud grey came off the board at #1c343d where the same
      // ratio on a clean board gives #839a9e.
      engine.clear(paletteSurface);
      state.squeezeSlot = 0;
      const y = PALETTE_H * 0.52;
      const x0 = PALETTE_W * 0.14;
      const x1 = PALETTE_W * 0.86;
      const span = x1 - x0;
      let at = x0;
      for (const [id, n] of parts) {
        const paint = PAINTS_BY_ID[id];
        const w = (span * n) / total;
        // Enough piles side by side to fill that share of the strip, so the
        // width a bristle crosses really is the proportion asked for. The
        // floor has to stay small: almost every landscape colour is a pile of
        // white with a touch of something in it, and a floor of half an inch
        // turned "thirty parts white to one of Phthalo Blue" into about six to
        // one -- which is the difference between a sky and a swimming pool.
        const r = Math.max(4, Math.min(46, w * 0.55));
        const count = Math.max(1, Math.round(w / (r * 1.2)));
        for (let i = 0; i < count; i++) {
          engine.blob(paletteSurface, {
            x: at + ((i + 0.5) * w) / count,
            y,
            radius: r,
            colour: hexToRgb(paint.hex),
            tint: paint.tint,
            amount: paint.fluid ? 2.5 : 5.0,
            body: paint.body,
            wetness: 1,
            clearMix: paint.clear ? 1 : 0,
            opacity: paint.opacity,
          });
        }
        at += w;
      }
      engine.cleanBrush();
      // Press into the piles. Mixing was running at whatever pressure the last
      // stroke happened to leave on the slider, so a colour mixed after a light
      // blending pass came off the board quite different from the same ratio
      // mixed after a firm one -- the cloud grey moved from #8d999b to #566367
      // on nothing but that.
      const heldPressure = state.pressure;
      state.pressure = 0.85;
      const input = { pointerType: 'mouse', pressure: 0.5, tiltX: 0, tiltY: 0 };
      const set = settings();
      for (let pass = 0; pass < passes; pass++) {
        const yy = y + (pass % 2 ? 1 : -1) * 10;
        const fwd = pass % 2 === 0;
        const from = fwd ? x0 : x1;
        const to = fwd ? x1 : x0;
        stroke.beginFrame(UNLIMITED);
        stroke.begin(paletteSurface, { x: from, y: yy }, input, set);
        const n = 40;
        for (let i = 1; i <= n; i++) {
          stroke.beginFrame(UNLIMITED);
          stroke.extend({ x: from + ((to - from) * i) / n, y: yy }, input, set);
        }
        stroke.end();
      }
      state.pressure = heldPressure;
      // Read the bristles FIRST: stockFromBrush copies engine.brush.colour,
      // which only becomes the mixture once the reservoir has been sampled.
      // The other way round it stored the colour the brush was cleaned to and
      // every stroke afterwards reloaded with that.
      const r = engine.sampleReservoir();
      engine.stockFromBrush();
      updateBrushState(r);
      needsRender = true;
      return { colour: r.colour, hex: rgbToHex(r.colour), load: r.load, tool: t.id };
    },
    /**
     * Dip the tool in a colour directly, the way the eyedropper does. `region`
     * dips only part of the bristle bed -- {x0, y0, x1, y1} in 0..1 -- so a
     * tool can carry two colours at once: dark on one corner of a fan brush
     * and the highlight on the other, laying a bough and its light in one
     * touch.
     */
    colour(rgb, { opacity = 0.92, tint = 1, region = null, replace = true } = {}) {
      engine.loadBrush(rgb.slice(), tint, 1, replace, opacity, region);
      if (!region) engine.setStock(rgb.slice(), tint, opacity);
      updateBrushState({ colour: rgb, load: 1 });
      return this;
    },
    /** Whatever is on the bristles right now, as an sRGB triple. */
    brush() {
      return engine.sampleReservoir();
    },
    /** What is on the canvas at a point, in the same coordinates as a stroke. */
    at(x, y) {
      return engine.samplePaint(canvasSurface, x * k(), canvasSurface.height - y * k());
    },
    /** The finished picture as raw RGBA, top-down. */
    pixels() {
      const img = engine.exportImage(canvasSurface);
      return { width: img.width, height: img.height, data: Array.from(img.data) };
    },
  };
}

window.studio = {
  get engine() {
    return engine;
  },
  get script() {
    if (!scriptApi) scriptApi = makeScript();
    return scriptApi;
  },
  get canvas() {
    return canvasSurface;
  },
  get palette() {
    return paletteSurface;
  },
  state,
  get tool() {
    return TOOLS_BY_ID[state.toolId];
  },
  sizePx: toolSizePx,
  save: saveNow,
  restore: restoreSaved,
  forget: () => storage.clear(),
  /** Mean wet-paint volume along a horizontal line, v given as 0..1 top-down. */
  coverageAt(v, samples = 16) {
    const y = (1 - v) * canvasSurface.height;
    let total = 0;
    for (let i = 0; i < samples; i++) {
      const x = ((i + 0.5) / samples) * canvasSurface.width;
      total += engine.samplePaint(canvasSurface, x, y).volume;
    }
    return +(total / samples).toFixed(3);
  },
};

boot();
