// Turns pointer input into dabs.
//
// A stroke is not a line -- it is a run of overlapping footprints, spaced by a
// fraction of the tool's size. Spacing is what separates a smooth blended sky
// (tight spacing, light pressure) from a broken dry-brush highlight (the same
// stroke, less paint, the canvas weave doing the rest).

const MAX_DABS_PER_EVENT = 600;

// Painting must never be able to run ahead of the GPU. If a device cannot keep
// up, the stroke thins its dabs out rather than queueing seconds of work behind
// the user's finger -- which is exactly what "it gets stuck" was.
const DEFAULT_DAB_BUDGET = 140;

export class StrokeRunner {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.surface = null;
    this.last = null;
    this.residue = 0;
    this.dabCount = 0;
    this.covered = 0;
    this.frameDabs = 0;
    this.dabBudget = DEFAULT_DAB_BUDGET;
    this.bristles = null;
    this.sinceRoll = 0;
    this.heldAngle = null;
  }

  /**
   * How the bristles happen to be sitting right now: which of them are short
   * of paint, how the bed has splayed, how the tool is being held. This has to
   * PERSIST while the tool is in contact and only change as it travels -- a
   * single touch is one mark, not forty. Re-rolling it per dab averaged all
   * the variation away and left a fan brush stamping the identical shell every
   * time, which is what made foliage read as repeated clip-art.
   */
  _rollBristles(t, force) {
    if (!force && this.bristles && this.sinceRoll < 0.8) return this.bristles;
    this.sinceRoll = 0;
    this.bristles = {
      cut: Math.random() * (t.cut ?? 0),
      ofs: [
        (Math.random() - 0.5) * (t.jitter ?? 0),
        (Math.random() - 0.5) * (t.jitter ?? 0) * 0.5,
      ],
      wobble: (Math.random() - 0.5) * (t.angleJitter ?? 0),
    };
    return this.bristles;
  }

  /** Called once per rendered frame; resets this frame's dab allowance. */
  beginFrame(budget) {
    this.frameDabs = 0;
    if (budget) this.dabBudget = budget;
  }

  /**
   * @param surface  the Surface being painted on
   * @param pt       {x, y} already converted to surface pixels, GL origin
   * @param input    {pressure, tiltX, tiltY, pointerType}
   * @param settings live tool/paint settings from the app
   */
  begin(surface, pt, input, settings) {
    this.active = true;
    this.surface = surface;
    this.residue = 0;
    this.dabCount = 0;
    this.covered = 0;
    this.sinceRoll = 0;
    this.heldAngle = null;
    this._rollBristles(settings.tool, true);
    this.last = { ...pt, pressure: this._pressure(input, settings), angle: null };
    this.settings = settings;
    // Lay one ordinary dab now so the mark appears under the pointer at once.
    // A full tap's worth would be ~30 ordinary dabs, which is why pressing and
    // dragging used to leave a heavy blob where the stroke started; if the
    // pointer never moves, end() fills the tap in instead.
    this._emit(this.last, this.last.pressure, settings, null, this._restDeplete(settings), 1);
  }

  extend(pt, input, settings) {
    if (!this.active) return;
    this.settings = settings;
    const pressure = this._pressure(input, settings);
    const prev = this.last;
    let dx = pt.x - prev.x;
    let dy = pt.y - prev.y;
    const dist = Math.hypot(dx, dy);

    const size = this._size(settings, pressure);
    let step = Math.max(0.8, settings.tool.spacing * Math.max(size, size * settings.tool.aspect));

    if (dist < 1e-4) return;

    const ux = dx / dist;
    const uy = dy / dist;
    let strokeAngle = Math.atan2(-ux, uy);
    // Ease the tool round a corner instead of snapping it: rotating instantly
    // at every change of direction stamps a staircase of rectangles down a
    // mountain rather than pulling a continuous face. But easing at a fixed
    // rate is just as wrong at a hairpin -- a long blade then pivots through
    // every angle on the way round and sweeps out a fan. So the sharper the
    // turn, the more of it is taken at once: gentle arcs stay smooth, and a
    // corner is treated as what it is, a change of direction rather than a
    // pirouette.
    if (this.heldAngle !== null && this.heldAngle !== undefined) {
      let d = strokeAngle - this.heldAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const sharp = Math.min(1, Math.abs(d) / 0.7);
      strokeAngle = this.heldAngle + d * (0.3 + 0.65 * sharp * sharp);
    }
    this.heldAngle = strokeAngle;

    // How far the footprint reaches along the direction of travel. A dab only
    // meets that much fresh canvas, which is what governs how fast the tool
    // runs dry -- a knife dragged edge-first empties far quicker than a flat
    // brush swept broadside.
    const angle = settings.tool.followStroke ? strokeAngle : settings.angle;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const along =
      size * Math.abs(ca * ux + sa * uy) + size * settings.tool.aspect * Math.abs(-sa * ux + ca * uy);

    // Under load, thin the dabs out rather than emitting more than the frame
    // can afford -- but never so far apart that the stroke stops being a
    // stroke. Half a footprint still lays continuous paint, and because the
    // per-dab amount scales with spacing, coverage is unchanged; only the
    // smoothness of the edge suffers.
    const room = Math.max(4, this.dabBudget - this.frameDabs);
    const wanted = Math.ceil((dist + this.residue) / step);
    if (wanted > room) step = Math.min(step * (wanted / room), Math.max(step, along * 0.5));

    const deplete = Math.min(1, step / Math.max(along, 1));

    let travelled = -this.residue;
    let emitted = 0;
    while (travelled + step <= dist && emitted < MAX_DABS_PER_EVENT) {
      travelled += step;
      const t = travelled / dist;
      const p = prev.pressure + (pressure - prev.pressure) * t;
      this._emit({ x: prev.x + dx * t, y: prev.y + dy * t }, p, settings, strokeAngle, deplete, 1);
      emitted++;
    }
    this.residue = Math.max(0, Math.min(step, dist - travelled));
    this.last = { x: pt.x, y: pt.y, pressure, angle: strokeAngle };
  }

  end() {
    // A press with no travel is a tap -- foliage, cloud, a dot of foam. Build
    // it up to a full footprint's worth of paint.
    // A press that barely moved is a tap -- foliage, a cloud, a dot of foam.
    // Top it up to a full footprint's worth. Keyed on distance covered, not on
    // the dab count, so a small hand tremor does not cancel the whole mark.
    if (this.active && this.covered < 0.92 && this.settings) {
      const deplete = this._restDeplete(this.settings);
      const extra = Math.min(40, Math.round((1 - this.covered) / deplete));
      for (let i = 0; i < extra; i++) {
        this._emit(this.last, this.last.pressure, this.settings, this.last.angle, deplete, 1);
      }
    }
    this.active = false;
    this.surface = null;
    const n = this.dabCount;
    this.dabCount = 0;
    return n;
  }

  /** The fresh-canvas share of a dab that is not (yet) going anywhere. */
  _restDeplete(settings) {
    const t = settings.tool;
    const size = settings.size;
    const step = Math.max(0.8, t.spacing * Math.max(size, size * t.aspect));
    const along = Math.max(1, (size + size * t.aspect) * 0.5);
    return Math.min(1, step / along);
  }

  _pressure(input, settings) {
    if (!settings.usePressure) return settings.pressure;
    // Mouse always reports 0.5 while a button is down, and plenty of
    // touchscreens report 0 or 1 with nothing in between. Only trust a pen.
    if (input.pointerType === 'pen' && input.pressure > 0) {
      const curve = settings.pressureCurve ?? 1;
      return Math.pow(Math.min(1, input.pressure), curve) * settings.pressure + 0.04;
    }
    return settings.pressure;
  }

  _size(settings, pressure) {
    const t = settings.tool;
    return settings.size * (1 - t.pressureSize * (1 - pressure));
  }

  _emit(pt, pressure, settings, strokeAngle, deplete, moving) {
    const t = settings.tool;
    const paint = settings.paint;
    const size = this._size(settings, pressure);

    const bristles = this._rollBristles(t, false);
    let angle = t.followStroke ? (strokeAngle ?? settings.angle) : settings.angle;
    angle += bristles.wobble;
    if (settings.tiltAngle !== null && settings.tiltAngle !== undefined && !t.followStroke) {
      angle = settings.tiltAngle;
    }

    // Odorless thinner cuts the paint: it flows more freely, covers less, and
    // stops holding a ridge. It is how you get a liner brush to make a twig.
    const thinner = settings.thinner;
    const press = 1 - t.pressureFlow * (1 - pressure);

    this.engine.dab(this.surface, {
      tool: t,
      x: pt.x,
      y: pt.y,
      size,
      angle,
      pressure,
      deplete,
      moving,
      bristleCut: bristles.cut,
      bristleOfs: bristles.ofs,
      flow: t.flow * settings.flowScale * press * (1 + thinner * 0.4),
      pickup: t.pickup * settings.blendScale,
      soften: t.soften * settings.blendScale,
      dryOut: t.dryOut,
      scrape: t.scrape * settings.flowScale,
      smudge: (t.smudge ?? 0) * settings.blendScale,
      // Thinner makes paint flow; it should not erase the pigment. A thinned
      // liner stroke of Van Dyke Brown is still a dark line.
      // The tool's own opacity, not the tube's. They are the same the moment
      // you pick a colour off the palette board, but a mixture you made, or a
      // colour picked up off the canvas, carries its own -- and the engine has
      // been tracking that all along and then throwing it away in favour of
      // whichever tube happened to be selected in the panel.
      opacity: (this.engine.brush.opacity ?? paint.opacity ?? 1) * (1 - thinner * 0.45),
      body: paint.body * (1 - thinner * 0.7),
      wetness: paint.wetness ?? 1,
      clearMix: paint.clear ? 1 : 0,
      canvasTint: 1.0,
    });
    this.dabCount++;
    this.frameDabs++;
    this.covered += deplete;
    this.sinceRoll += deplete;
  }
}
