// The studio: wires the engine to the panels, the pointer and the keyboard.

import { Engine } from '../core/engine.js';
import { StrokeRunner } from '../core/stroke.js';
import { TOOLS, TOOLS_BY_ID, TOOL_CATEGORIES, MASK_RES } from '../data/brushes.js';
import { PIGMENTS, MEDIUMS, PAINTS_BY_ID, hexToRgb, rgbToHex } from '../data/colors.js';
import { LESSONS } from '../data/lessons.js';

const $ = (id) => document.getElementById(id);

const CANVAS_PRESETS = [
  { label: '24 × 18 in — landscape', note: "Bob's usual canvas", w: 1440, h: 1080 },
  { label: '18 × 24 in — portrait', note: 'Tall scenes, waterfalls', w: 1080, h: 1440 },
  { label: '16 × 9 — widescreen', note: 'Sweeping vistas', w: 1600, h: 900 },
  { label: '12 × 9 in — small & fast', note: 'Easiest on an older GPU', w: 1024, h: 768 },
  { label: '32 × 24 in — large', note: 'Most detail, needs a strong GPU', w: 1920, h: 1440 },
];

const PALETTE_W = 640;
const PALETTE_H = 360;
const BACKDROP = hexToRgb('#14110c');

// ---------------------------------------------------------------- state ---

const state = {
  toolId: 'brush-2inch',
  paintId: 'titanium-white',
  sizes: Object.fromEntries(TOOLS.map((t) => [t.id, t.size])),
  angle: 0,
  pressure: 0.85,
  pressureCurve: 1.0,
  usePressure: true,
  useTilt: false,
  flowScale: 1,
  pickupScale: 1,
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
  paletteSurface.weaveDepth = 0.06;
  paletteSurface.weaveScale = 3.0;

  newCanvas(CANVAS_PRESETS[0]);

  buildToolRail();
  buildSwatches();
  buildToolSliders();
  buildSurfaceSliders();
  buildLessons();
  wireTopBar();
  wirePointer($('easel'), () => canvasSurface, { palette: false });
  wirePointer($('palette-slot'), () => paletteSurface, { palette: true });
  wireKeyboard();

  selectTool(state.toolId);
  selectPaint(state.paintId, { squeeze: false });

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
}

function newCanvas(preset) {
  if (canvasSurface) canvasSurface.dispose();
  canvasSurface = engine.createSurface(preset.w, preset.h);
  engine.clear(canvasSurface);
  state.zoomMode = 'fit';
  state.panX = 0;
  state.panY = 0;
  updateUndoButtons();
  layout();
  needsRender = true;
  setHint('Fresh canvas. Start with a Liquid White base coat — it is what makes everything blend.');
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

/** DOM element rect -> GL viewport rect (device pixels, bottom-left origin). */
function glRect(el) {
  const r = el.getBoundingClientRect();
  return [r.left * dpr, (window.innerHeight - r.bottom) * dpr, r.width * dpr, r.height * dpr];
}

// ----------------------------------------------------------- render loop ---

let frameTimes = [];
let lastPerf = 0;

function frame(t) {
  if (needsRender) {
    needsRender = false;
    // The palette borrows a corner of the GL canvas, so copy it out first and
    // let the backdrop clear wipe the borrowed pixels.
    drawPalette();
    engine.clearScreen(engine.gl.canvas.width, engine.gl.canvas.height, BACKDROP);
    engine.renderTo(canvasSurface, glRect($('easel')), glRect($('stage')));
  }

  frameTimes.push(t);
  if (frameTimes.length > 40) frameTimes.shift();
  if (t - lastPerf > 500 && frameTimes.length > 8) {
    lastPerf = t;
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    const fps = Math.round(((frameTimes.length - 1) / span) * 1000);
    $('status-perf').textContent = `${canvasSurface.width}×${canvasSurface.height} · ${fps} fps`;
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------- tool rail ---

function toolPreview(tool) {
  const c = document.createElement('canvas');
  c.width = 104;
  c.height = 68;
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

  let w = 94;
  let h = w * tool.aspect;
  if (h > 62) {
    h = 62;
    w = h / tool.aspect;
  }
  ctx.drawImage(m, (104 - w) / 2, (68 - h) / 2, w, h);
  return c;
}

function buildToolRail() {
  const rail = $('tool-rail');
  rail.innerHTML = '';
  for (const cat of TOOL_CATEGORIES) {
    const tools = TOOLS.filter((t) => t.category === cat.id);
    if (!tools.length) continue;
    const label = document.createElement('div');
    label.className = 'rail-group-label';
    label.textContent = cat.label;
    rail.appendChild(label);
    for (const tool of tools) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn';
      btn.dataset.tool = tool.id;
      btn.title = `${tool.name}\n\n${tool.blurb}`;
      btn.appendChild(toolPreview(tool));
      const span = document.createElement('span');
      span.textContent = tool.short;
      btn.appendChild(span);
      btn.addEventListener('click', () => selectTool(tool.id));
      rail.appendChild(btn);
    }
  }
}

function selectTool(id) {
  state.toolId = id;
  const tool = TOOLS_BY_ID[id];
  engine.setTool(tool);
  for (const b of document.querySelectorAll('.tool-btn')) {
    b.classList.toggle('active', b.dataset.tool === id);
  }
  $('tool-title').textContent = tool.name;
  $('tool-blurb').textContent = tool.blurb;
  $('status-tool').textContent = tool.name;
  refreshToolSliders();
}

// -------------------------------------------------------------- swatches ---

function paintChip(paint, host, isMedium) {
  const btn = document.createElement('button');
  btn.className = 'swatch';
  btn.dataset.paint = paint.id;
  btn.style.background = paint.clear
    ? 'repeating-linear-gradient(45deg,#e9e6df 0 5px,#cfcbc2 5px 10px)'
    : paint.hex;
  btn.title = `${paint.name}\n${paint.note}`;
  if (isMedium) {
    btn.textContent = paint.name.replace('Liquid ', '');
    const [r, g, b] = hexToRgb(paint.hex);
    btn.style.color = 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? '#1a1a1a' : '#e8e2d6';
  }
  btn.addEventListener('click', (e) => selectPaint(paint.id, { squeeze: e.shiftKey }));
  host.appendChild(btn);
}

function buildSwatches() {
  const s = $('swatches');
  const m = $('mediums');
  s.innerHTML = '';
  m.innerHTML = '';
  for (const p of PIGMENTS) paintChip(p, s, false);
  for (const p of MEDIUMS) paintChip(p, m, true);
}

/** Click a tube: load the brush with it. Shift-click: squeeze it on the palette. */
function selectPaint(id, { squeeze = false } = {}) {
  state.paintId = id;
  const paint = PAINTS_BY_ID[id];
  for (const b of document.querySelectorAll('.swatch')) {
    b.classList.toggle('active', b.dataset.paint === id);
  }

  if (squeeze) {
    squeezeOntoPalette(paint);
    return;
  }

  const tool = TOOLS_BY_ID[state.toolId];
  if (tool.noLoad) {
    setHint(`${tool.name} carries no paint of its own — it works with what is already on the canvas.`);
    return;
  }
  // A pigment this strong goes on the brush in a whisper, not a scoop --
  // otherwise one touch of Phthalo Blue is the whole sky.
  const load = (tool.capacity * 0.95) / Math.max(1, paint.tint);
  engine.loadBrush(hexToRgb(paint.hex), paint.tint, load, true, paint.opacity);
  updateBrushState({ colour: hexToRgb(paint.hex), load });
  setHint(paint.note);
}

function squeezeOntoPalette(paint) {
  const cols = 6;
  const i = state.squeezeSlot % (cols * 2);
  state.squeezeSlot++;
  const x = ((i % cols) + 0.5) * (PALETTE_W / cols);
  const y = PALETTE_H - (Math.floor(i / cols) + 0.5) * (PALETTE_H / 4.4);
  engine.blob(paletteSurface, {
    x,
    y,
    radius: PALETTE_W * 0.052,
    colour: hexToRgb(paint.hex),
    tint: paint.tint,
    amount: paint.fluid ? 0.9 : 1.6,
    body: paint.body,
    wetness: 1,
    clearMix: paint.clear ? 1 : 0,
    opacity: paint.opacity,
  });
  needsRender = true;
  setHint(`${paint.name} on the palette. Drag a brush through it to load up, or through two of them to mix.`);
}

function updateBrushState({ colour, load }) {
  $('brush-chip').style.background = rgbToHex(colour);
  const cap = TOOLS_BY_ID[state.toolId].capacity;
  const pct = Math.max(0, Math.min(1, load / cap));
  $('load-fill').style.width = `${pct * 100}%`;
  $('load-text').textContent = load < 0.03 ? 'empty' : `${Math.round(pct * 100)}%`;
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
  const host = $('tool-sliders');
  host.innerHTML = '';
  toolSliderEls = [
    slider(host, {
      key: 'size',
      label: 'Brush size',
      min: 3,
      max: 520,
      step: 1,
      get: () => state.sizes[state.toolId],
      set: (v) => {
        state.sizes[state.toolId] = v;
      },
      format: (v) => `${Math.round(v)} px`,
    }),
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
      key: 'pickup',
      label: 'Pickup — how much it lifts wet paint',
      min: 0,
      max: 2,
      step: 0.01,
      get: () => state.pickupScale,
      set: (v) => (state.pickupScale = v),
      format: (v) => `${Math.round(v * 100)}%`,
    }),
    slider(host, {
      key: 'thinner',
      label: 'Odorless thinner',
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
      set: (v) => (state.angle = v),
      format: (v) => `${Math.round(v)}°`,
    }),
  ];
  toolSliderEls.push(
    checkbox(host, {
      label: 'Use stylus pressure',
      title: 'Only a pen reports real pressure; a mouse always says 50%.',
      get: () => state.usePressure,
      set: (v) => (state.usePressure = v),
    }),
    checkbox(host, {
      label: 'Pen tilt rotates the brush',
      get: () => state.useTilt,
      set: (v) => (state.useTilt = v),
    })
  );
  refreshToolSliders();
}

function refreshToolSliders() {
  const tool = TOOLS_BY_ID[state.toolId];
  for (const el of toolSliderEls) el._sync && el._sync();
  const sizeEl = toolSliderEls.find((e) => e.dataset && e.dataset.key === 'size');
  if (sizeEl) {
    const input = sizeEl.querySelector('input');
    input.min = tool.sizeRange[0];
    input.max = tool.sizeRange[1];
    input.value = state.sizes[tool.id];
    sizeEl.querySelector('output').textContent = `${Math.round(state.sizes[tool.id])} px`;
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

function buildSurfaceSliders() {
  const host = $('surface-sliders');
  host.innerHTML = '';
  const v = engine.view;
  const mark = () => (needsRender = true);
  slider(host, {
    key: 'weaveScale',
    label: 'Canvas weave — thread size',
    min: 2,
    max: 16,
    step: 0.1,
    get: () => v.weaveScale,
    set: (x) => {
      v.weaveScale = x;
      mark();
    },
    format: (x) => `${x.toFixed(1)} px`,
  });
  slider(host, {
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
  });
  slider(host, {
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
  });
  slider(host, {
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
  });
  slider(host, {
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
  });

  $('surface-toggle').addEventListener('click', () => {
    $('panel-surface').classList.toggle('collapsed');
  });
}

// --------------------------------------------------------------- pointer ---

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

function settingsFor(ev, isPalette) {
  const tool = TOOLS_BY_ID[state.toolId];
  let tiltAngle = null;
  if (state.useTilt && ev.pointerType === 'pen' && (ev.tiltX || ev.tiltY)) {
    tiltAngle = Math.atan2(-ev.tiltY, ev.tiltX);
  }
  return {
    tool,
    paint: PAINTS_BY_ID[state.paintId],
    size: state.sizes[state.toolId],
    angle: (state.angle * Math.PI) / 180,
    tiltAngle,
    pressure: state.pressure,
    pressureCurve: state.pressureCurve,
    usePressure: state.usePressure,
    // On the palette you mostly want to LOAD the brush, not spread paint
    // around, so it grabs harder and gives less.
    flowScale: state.flowScale * (isPalette ? 0.55 : 1),
    pickupScale: state.pickupScale * (isPalette ? 2.0 : 1),
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
        engine.loadBrush(s.colour, 1.0, TOOLS_BY_ID[state.toolId].capacity * 0.8, true, 0.85);
        updateBrushState({ colour: s.colour, load: 1 });
        setHint(`Picked up ${rgbToHex(s.colour)} off the canvas.`);
      }
      return;
    }

    activePointer = ev.pointerId;
    el.setPointerCapture(ev.pointerId);
    engine.pushHistory(surface);
    updateUndoButtons();
    stroke.begin(surface, pt, inputFrom(ev), settingsFor(ev, palette));
    needsRender = true;
    ev.preventDefault();
  });

  el.addEventListener('pointermove', (ev) => {
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
    const settings = settingsFor(ev, palette);
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
    const r = engine.sampleReservoir();
    updateBrushState(r);
    needsRender = true;
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
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
  setHint(`${m.name} down. Work quickly while it is wet — that is the whole idea.`);
}

function wireTopBar() {
  $('btn-new').addEventListener('click', (e) =>
    showMenu(e.currentTarget, [
      ...CANVAS_PRESETS.map((p) => ({
        label: p.label,
        note: p.note,
        action: () => newCanvas(p),
      })),
    ])
  );

  $('btn-basecoat').addEventListener('click', (e) =>
    showMenu(e.currentTarget, [
      ...MEDIUMS.map((m) => ({ label: m.name, note: m.note, action: () => applyBaseCoat(m.id) })),
      '-',
      {
        label: 'Back to bare canvas',
        note: 'Wipes everything off',
        action: () => {
          engine.pushHistory(canvasSurface);
          engine.clear(canvasSurface);
          updateUndoButtons();
          needsRender = true;
        },
      },
    ])
  );

  $('btn-dry').addEventListener('click', () => {
    engine.pushHistory(canvasSurface);
    engine.dry(canvasSurface, 1);
    updateUndoButtons();
    needsRender = true;
    setHint('Dry. The next layer will sit on top instead of blending in — good for highlights over a finished sky.');
  });

  $('btn-undo').addEventListener('click', () => doUndo());
  $('btn-redo').addEventListener('click', () => doRedo());

  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  $('btn-zoom-fit').addEventListener('click', () => {
    state.zoomMode = 'fit';
    layout();
  });

  $('btn-save').addEventListener('click', savePNG);
  $('btn-squeeze').addEventListener('click', () => squeezeOntoPalette(PAINTS_BY_ID[state.paintId]));
  $('btn-wipe-palette').addEventListener('click', () => {
    engine.clear(paletteSurface);
    state.squeezeSlot = 0;
    needsRender = true;
  });
  $('btn-clean-brush').addEventListener('click', () => {
    engine.cleanBrush();
    updateBrushState({ colour: [0.45, 0.42, 0.38], load: 0 });
    setHint('Beat the devil out of it. Clean brush, ready for the next colour.');
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
  }
}

function doRedo() {
  if (engine.redo(canvasSurface)) {
    updateUndoButtons();
    needsRender = true;
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

function setHint(text) {
  $('status-hint').textContent = text;
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
        for (const cid of step.colours) squeezeOntoPalette(PAINTS_BY_ID[cid]);
        selectPaint(step.colours[0], { squeeze: false });
      }
      setHint(step.title);
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
        const next = Math.max(tool.sizeRange[0], Math.min(tool.sizeRange[1], state.sizes[tool.id] * f));
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
window.studio = {
  get engine() {
    return engine;
  },
  get canvas() {
    return canvasSurface;
  },
  get palette() {
    return paletteSurface;
  },
  state,
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
