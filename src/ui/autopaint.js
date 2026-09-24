// Paint a picture from a photograph, the way a person would paint it.
//
// autoplan.js decides WHAT to paint -- back to front, the brush that fits
// each shape, strokes that follow the forms, a dip mixed for each passage,
// taps for foliage, highlights last. This carries that plan out with the real
// tools and the real paint, through the same stroke runner a hand drives.
//
// How the brush is handled here was found by painting Bob's mountain picture
// and comparing, not by argument -- and the first idea was wrong:
//
//   * Letting one dip run down over several strokes, so the brush carries wet
//     paint from stroke to stroke, sounded like the essence of oil. On a wet
//     Liquid White ground it washed the whole picture out nearly to white:
//     the bristles take up the white faster than they lay colour. The brush
//     is refilled with its clean colour at every stroke instead; wet paint
//     still marries at every edge, because that happens on the canvas.
//   * No Liquid White. By hand you want it; here, a single pass of a dark
//     colour into it lands at about half its value, and nothing reads.
//   * Each stroke is laid back and forth, as a hand works an area. One pass
//     lays about a fifth of a layer, and paint only reads as solid at about
//     half a layer.
//   * A flat brush sweeps broadside. Edge-on, a 2" brush leaves a mark less
//     than half its width.
//
// Against the reference, mean colour error 0.38 with the old grid painter,
// 0.27 with this. Better, and still not good: bare canvas shows between the
// small-brush strokes, and a mountain of pale snow does not yet read.

import { planPainting } from './autoplan.js';

const STAGE_NAMES = {
  'block-in': 'blocking in with the big brushes',
  shapes: 'the shapes, with the smaller brushes',
  texture: 'tapping in the texture',
  highlights: 'the highlights',
};

/**
 * @param s       window.studio.script
 * @param target  {data: Float32Array rgb 0..1, width, height} at canvas size
 * @param opts    {onProgress(done, total, label), shouldStop(), baseCoat = false,
 *                 inchesWide, seed, refill = 'clean' | 'dirty' | 'none', passes = 2}
 */
export async function paintFromPicture(s, target, opts = {}) {
  const { width: w } = target;
  const onProgress = opts.onProgress || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const breathe = () => new Promise((r) => requestAnimationFrame(r));

  const plan = planPainting(target, { inchesWide: opts.inchesWide ?? 24, seed: opts.seed ?? 7 });

  s.design(w);
  if (opts.baseCoat === true) s.baseCoat('liquid-white');
  await breathe();

  // How the brush is kept between strokes of one dip. 'dirty' tops the load
  // back up at every stroke but keeps whatever colour the bristles picked up,
  // so the brush never runs dry yet still carries wet paint from stroke to
  // stroke; 'none' lets it run down.
  const refill = opts.refill ?? 'clean';
  const passes = opts.passes ?? 2;
  const heldDirty = s.state.dirtyBrush;
  const heldAngle = s.state.angle;
  s.state.dirtyBrush = refill === 'dirty';

  const stages = [...new Set(plan.loads.map((l) => l.stage))];
  const held = { tool: null, inches: null };
  let stage = null;
  let laid = 0;

  for (const load of plan.loads) {
    if (shouldStop()) { s.state.dirtyBrush = heldDirty; s.state.angle = heldAngle; return; }
    if (load.stage !== stage) {
      stage = load.stage;
      onProgress(stages.indexOf(stage), stages.length, STAGE_NAMES[stage] || stage);
      await breathe();
    }
    if (held.tool !== load.tool || held.inches !== load.inches) {
      s.tool(load.tool, load.inches);
      held.tool = load.tool;
      held.inches = load.inches;
    }
    s.set({ pressure: load.pressure });
    // One dip. Replacing what is on the bristles is the wipe a painter gives
    // the brush between colours.
    s.colour(load.rgb, { opacity: load.stage === 'highlights' ? 0.95 : 0.9 });

    for (const pts of load.strokes) {
      if (shouldStop()) { s.state.dirtyBrush = heldDirty; s.state.angle = heldAngle; return; }
      const autoReload = refill !== 'none';
      if (load.taps || pts.length === 1) s.tap(pts[0], { autoReload });
      else {
        // Back and forth, the way a hand works an area. One pass of a brush
        // lays about a fifth of a layer, and paint only reads as solid at
        // about half a layer, so a picture painted one stroke per place came
        // out as a pale stain of itself.
        // Hold a flat brush so it sweeps broadside. Pulled along its own long
        // edge, a 2" brush leaves a line 12px wide on a 360px canvas; turned
        // across the stroke, 26px. Painting at whatever angle the panel was
        // left at meant most strokes went edge-on and the picture came out as
        // thin ribbons with bare canvas between them. Measured convention:
        // angle 90 is broadside to horizontal travel, 0 to vertical. Screen y
        // runs down and the brush's angle is in GL space, hence the sign.
        const [x0, y0] = pts[0];
        const [x1, y1] = pts[pts.length - 1];
        const travel = (-Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
        s.set({ angle: (((travel + 90) % 180) + 180) % 180 });
        for (let k = 0; k < passes; k++) s.stroke(k % 2 ? [...pts].reverse() : pts, { autoReload });
      }
      laid++;
      if (laid % 20 === 0) await breathe();
    }
  }
  s.state.dirtyBrush = heldDirty; s.state.angle = heldAngle;
  onProgress(stages.length, stages.length, 'done');
}
