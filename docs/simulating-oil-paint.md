# Simulating oil paint in a browser

### What we re-implemented, what we had to add, and what only measurement could have told us

*A technical report on the paint model behind this studio. Notes from building
it, in the hope they save someone else the same bugs.*

---

## 0. What this is, and what it is not

This is a real-time wet-on-wet oil paint simulator that runs in a browser tab
on WebGL2. It is built on published work — IMPaSTo, Baxter's dissertation,
WetBrush, Stuyck et al. — and most of what is in it is a re-implementation of
theirs, not an invention of ours.

It is **not** a validated physical model. We have no photometric ground truth.
We never measured real paint. Our reference is a photograph of a painting,
which confounds three things we cannot separate — how the paint behaves, how
well the painter used it, and what the camera did to both. Any claim below of
the form "this looks right" means *it looked right to us, and a number we chose
went the way we wanted*. That is weaker than it sounds and we would rather say
so than dress it up.

What we think is worth contributing is narrower and, we hope, more useful:

1. **Fourteen specific ways an implementation of these papers can be wrong** while
   still compiling, still running at 60fps, and still looking broadly like
   paint. Each one we shipped. Each one we found by measuring, not by reading.
2. **A measurement methodology** for a painting simulator, where the output is
   a picture and the usual graphics error metrics do not obviously apply.
3. One observation we have not seen stated: **the unidirectionality rule is a
   property of the task, not of the paint** (§3.1).

If you are implementing one of these papers, §3 and §6 are the sections that
will save you time. If you are building any interactive simulation judged by
eye, §5 is the one we would most want you to read.

---

## 1. The model in one page

Per painting surface, two RGBA16F textures, ping-ponged:

| texture | rgb | a |
|---|---|---|
| `paint` | pigment colour | volume, in *layers* |
| `surf` | height, wetness, body | — |

Plus one small texture for the tool itself: a **reservoir**, 112×112, in the
tool's own footprint space, holding what each part of the bristle bed is
carrying (`rgb`) and how full it is (`a`, a fill fraction 0..1).

Each tool has a **footprint mask** rasterised once at 192×192 into two
channels: the raw bristle pattern, and a blurred envelope of it. The two
channels answer two different questions and conflating them is one of the bugs
below (§6).

A dab is three passes:

1. **pickup** — update the reservoir from the canvas under the footprint.
2. **bleed** — diffuse along the bristle bed, so a brush dragged through two
   colours comes back carrying a mixture rather than stripes.
3. **deposit** — update the canvas from the reservoir.

Colour mixing is Kubelka–Munk, via a GLSL port of spectral.js: RGB is upsampled
to a smooth reflectance curve, mixed there, and brought back. It is not a
measured pigment set like IMPaSTo's eight-basis data — it is an inference from
three channels, and it is the single largest gap between this and the paper.

Sixteen tools: eight brushes, three knives, a blender, a rag, and three
generic fallbacks.

Everything below is about the parts that were not obvious from the papers.

---

## 2. Two volume units, and why it matters

This is the thing we would put first in a letter to ourselves six weeks ago.

There are two quantities that both want to be called "how much paint is on the
brush", they are not the same quantity, and almost every transfer bug we had
came from using one where the other belonged.

- **Load** — the reservoir's fill fraction, 0..1. How full the bristle bed is.
- **Tip film** — the depth of paint actually present at the point of contact,
  in canvas layers.

They are bridged by `uHold`, the number of layers a full tool carries:

```glsl
float tipFilm(float load) {
  return clamp(load * uHold / max(uSoak, 1e-4), 0.0, 1.0);
}
```

A brush can be *full* (load 1.0) and still have a *thin* film at the tip,
because the paint is spread across the whole bed. It can be nearly empty and
still have a thick film, if what is left is bunched at the point.

Which one gates a given rule is not a matter of taste. It depends on the
physical question:

- **How much room is left to take more paint on?** On a painting, only the tip
  touches, so it is the film there that has room — *tip film*. But press a
  brush into a **pile** on a palette and the whole bristle bed fills; that is
  what a pile is for. So it is *load*.
- **Is the tool laying or lifting?** The taper from laying to lifting is about
  what is at the contact — *tip film*.

Our transfer code therefore carries an explicit substrate term:

```glsl
float room = 1.0 - mix(tipFilm(load), load, uPalette);
```

We got this wrong in the obvious way first — tip film everywhere, because a
painting is the case you think about. On the palette that capped loading at
about **six per cent**, so whatever pigment the brush crossed first swamped the
mixture, and every colour mixed on the board came off nearly black: a grey that
should have been `#6294a5` came out `#162933`.

**The lesson generalises past this code.** Any brush model with a bristle bed
has these two units. If your implementation has only one, it is silently
assuming the tool is always in the same kind of contact, and the place it will
break is wherever that assumption is false.

---

## 3. Three rules that are not properties of paint

### 3.1 The unidirectionality rule belongs to the task, not to the medium

IMPaSTo's unidirectionality rule — at any instant a tool either deposits or
picks up, never both — is what stops transfer oscillating. Paint is not
supposed to flow both ways across the same interface at once. We implemented it
faithfully and applied it everywhere.

**Applying it to a palette makes mixing impossible.**

Mixing *is* simultaneous give-and-take. You press a brush carrying white into a
pile of blue and drag: the white goes into the blue, the blue goes into the
white, at the same time, at the same place. That is the entire operation. A
tool that must choose a direction cannot do it.

We shipped this. On the palette, a tool that was laying paint could not pick
any up, so the board became pickup-only: you could load one pigment off one
pile and nothing else. Drag two colours together and the board stayed bare,
because the brush could not put anything down to mix *into*. A user reported it
as "the mixing is completely gone" and they were exactly right.

The fix is a substrate term, same shape as `room` above:

```glsl
float oneWay = mix(1.0 - layShare(load), 1.0, uPalette);
```

We think the general statement is worth saying plainly, because we have not
seen it said:

> Unidirectionality is a numerical stabiliser for the case where a tool is
> making a mark on a surface it is also disturbing. It is not a conservation
> law. On a surface whose *purpose* is bidirectional transfer, it is not an
> approximation to the physics — it is a contradiction of the task, and it must
> be switched off.

The same caution probably applies to any "dead zone" or hysteresis term
borrowed from the painting case: check what it does on the palette before
assuming it generalises.

### 3.2 Mass/colour decoupling has to be live where a *full* tool meets paint

WetBrush's decoupling — mass transfer and colour transfer are separate
channels, so a full brush still picks up colour — reads like a refinement. It
is not. It is load-bearing, and the place it bears most load is exactly the
place we had it switched off.

We disabled the colour-crossover term on the palette for a real reason: it is a
tinting-strength-weighted mix applied afresh every dab, so on a colour that is
already moving it compounds, and mixtures drifted toward whichever pigment was
strongest. Three parts Sap Green to one of black came off the board nearly
black.

But disabling it, combined with `room = 1 - load` on the palette, sealed a full
brush completely shut: no mass in, because it was full; no colour in, because
we had turned that off. And since clicking a pigment in our UI both squeezes a
pile *and* fills the brush, **every brush arrived at the palette already full**.
The result was a palette you could not mix on at all.

Measured: dragging a yellow-loaded brush straight through a pile of phthalo
blue laid down `rgb 1.00, 0.93, 0.03` — pure yellow, not a trace of blue.

The fix is to reinstate colour transfer on the palette but as an **exchange at
constant mass** rather than a tinting-strength mix, gated on how *sealed* the
tool is rather than how much room it has:

```glsl
float sealed = mix(tipFilm(res.a), res.a, uPalette);
float swap   = uPalette * uPickup * uDeplete * contact * lay * avail * sealed;
```

Gating on `sealed` — the complement of `room` — is what makes this compose
properly: it contributes exactly where mass transfer cannot act, and vanishes
where mass transfer already carries the colour, so nothing is double-counted.
Going by volume in contact rather than tinting strength is what stops it
drifting toward the strongest pigment. After: `rgb 0.43, 0.75, 0.15`, a green.

**The general form:** when you decouple two channels, check the corner where
one channel is saturated. That is the corner the decoupling exists for, and
it is the one least likely to come up while you are testing.

### 3.3 Paint mixes at the interface, not through the bulk

A dab of wet paint onto wet paint mixes with the paint *at the surface*, not
with the whole accumulated depth of everything underneath.

Weighing a dab against total volume seems natural — it is the obvious reading
of a volume-based model — and it produces a specific, recognisable wrongness:
**the more paint a canvas carries, the less any further mark can say.** A fan
brush tapped onto a sky that had been worked to a layer and a half moved it
about a seventh of the way toward the colour on the bristles. So a tree went on
as a translucent haze with the sky showing through it, however many times you
touched it.

That is not what wet-on-wet looks like. Bob Ross's trees go on dark in one or
two touches, because the paint on the bristles sits *on* the sky. It does not
homogenise with every coat underneath.

The fix is one line and costs nothing:

```glsl
#define MIX_FILM 0.55
float film = min(remain, MIX_FILM);
// mix against `film`, not against `remain`
```

Cap the mixing partner at a fixed film depth. Above that, further depth is
buried and takes no part. We have no measurement justifying 0.55 specifically;
it is the value at which our trees stopped being transparent.

A related one: **hiding power depends on how wet the ground is.** Opaque paint
laid on wet paint does not cover as well as on dry — it gets carried into what
is underneath rather than sitting on it.

```glsl
float o = uOpacity * uOpacity * (1.0 - 0.70 * clamp(wet, 0.0, 1.0));
```

---

## 4. Conservation must be derived, not computed twice

A GPU implementation splits the two sides of a transfer across two textures in
two different unit systems — the reservoir in fill fraction, the canvas in
layers. It is very natural to write two functions, one for each side.

Do not. They will disagree, and the disagreement is invisible until you measure
it.

We had `takeLoad` (what the brush gains) and `takeVolume` (what the canvas
loses) computed independently, with a saturation cap applied to one of them.
The canvas lost more than the brush gained. Nothing looked obviously wrong —
until we measured a second pass over the same ground and found it came out
*thinner* than the first (`laidByOnePass: -0.261`), and a brush that had run
dry left a track scraped back past the base coat.

The fix is structural, not numerical: one side is *defined in terms of* the
other.

```glsl
float takeVolume(float bristle, float contact, float volume, float wetness, float load) {
  return takeLoad(contact, volume, wetness, load) * uHold * bristle;
}
```

Any cap, any clamp, any nonlinearity now applies to both sides by construction.
**If your two sides of a transfer are two functions, they are two models.**

---

## 5. The mark is the thing

A painting simulator can have correct colour, correct volume, correct wetness,
and still look unmistakably digital. What gives it away is not the colour. It
is that every mark is the same mark.

Two findings here.

**Footprints are clusters, not shapes.** The intuitive way to author a fan
brush is a fan-shaped alpha mask. This is wrong, and wrong in a way you can see
instantly once you know. A fan brush is not a fan. It is about eleven separate
clusters of bristles that happen to be splayed into a fan arrangement, each
coming to its own ragged needle tip. The gaps between clusters are the entire
character of the tool — they are what makes fan-brush evergreens look like
evergreens. A fan-shaped mask with a smooth gradient makes mush.

Same for a round: it is a rosette of separate elongated lobes, not a disc with
spokes cut out of it.

**Bristles must move per contact.** A rasterised mask is identical at every
dab. Real bristles splay under pressure, comb against what they are dragged
through, and reach differently as the tool rolls. We warp the footprint's
sample coordinates per contact, driven by a per-stroke random seed:

```glsl
vec2 bristleUV(vec2 b)   // splay / comb / reach, from clumpNoise() and uSeed
```

This cost us one texture lookup's worth of arithmetic and did more for how the
output reads as paint than any change to the colour model.

**We measured it.** A "sameness" score — the autocorrelation between marks made
by the same tool under the same conditions — went from **0.946 to 0.771** for
the fan brush. 0.946 means *the tool is a rubber stamp*. You can see that
number in a painting without being able to name it.

---

## 6. How to measure a painting simulator

This is the section we would most like other people to take, because it is the
part that actually produced every fix above.

**Every bug in this document was found by measurement. Not one was found by
reading the code.** Several of them we had read past many times, including
lines we had written ourselves that week, including lines with comments
correctly describing behaviour the code did not have.

The obstacle is that the output is a picture and a picture painted by hand
cannot be painted twice. So:

### Scripted paintings

A painting is ordinary code driving the same stroke runner the pointer drives.

```js
s.baseCoat('liquid-white');
s.tool('brush-2inch', 2.0).set({ pressure: 0.6 });
s.mix([['titanium-white', 12], ['phthalo-blue', 1]]);   // mixed on the board, for real
s.stroke([[-60, 40], [1500, 40]]);
```

Coordinates are written once against a 24-inch canvas and scale to whatever
size the run uses, so the same painting can be tried small and fast, then
painted at size without moving a number. A full painting replays in 12–30
minutes at half size in headless Chromium on SwiftShader; a single tree takes
about a minute, which is the loop you actually iterate in.

### Five kinds of measurement, in increasing order of usefulness

**1. Whole-picture difference against a reference.** Mean absolute difference
took us from 0.228 to 0.162 over a sprint. It is the metric that sounds most
scientific and it is the least useful of the five: it is dominated by
composition, it rewards blur, and it cannot tell you *what* to change.

**2. Structured difference — band by band, scale by scale.** Split the picture
into horizontal bands and report value range, where the values sit, and colour
balance per band. Separately, local contrast at three scales (σ2, σ8, σ32).
This is where diagnosis lives. "Texture at σ8 is half the reference across the
whole lower third" is actionable in a way that a single number never is. It
caught that our paint was too smooth long before we could see it.

**3. Direct questions about the model, in numbers.** A probe harness that asks
what a wet-on-wet painter would ask, and answers numerically:

- What does a loaded brush come back holding after one pass across wet white?
- Does a clean brush stay clean?
- How many layers does one pass lay? Does a second pass lay the same?
- Does a light touch break up?
- What does a given mixture actually come out as?

This is the one that found the real bugs. The conservation bug (§4) is a
two-line answer to "does a second pass lay as much as the first". You are not
going to see that in a painting; you are going to see a vague sense that
something is wrong with the darks.

**4. Offline replays of the parts that are pure arithmetic.** Stroke placement
and extension do not need the simulator to run — they are arithmetic over the
target picture. Lifting that out into a harness that answers in seconds rather
than painting a whole picture for half an hour is the difference between trying
one idea and trying twelve, and twelve is what it took. (That harness measured
the first picture-to-painting planner; its successor is `tools/plan.mjs`.)

**5. Mark sheets.** Render every tool's mark under a standard set of
conditions into a single contact sheet, and score the sameness of repeated
marks. This is the only measurement that catches the "looks digital" failure
in §5, and it is the one we added last, which was a mistake.

### One more trap: an average over unlike things

Our picture-to-painting mode lays strokes in coarse-to-fine passes,
Hertzmann-style. We wanted strokes to stop at a boundary rather than drag sky
colour across a mountain, added two tests for it, and measured the share of
strokes that cross a region boundary — with regions defined by colour
quantisation, so that neither test could mark its own homework.

The aggregate said the change did **nothing**: 35.6% of strokes strayed before,
33.9% after. We nearly threw it away on that number.

Split by pass, the same run says:

| pass | strokes | strayed, before | after |
|---|---|---|---|
| 2" blocking in | 42 | 66.7% | **35.7%** |
| 2" second pass | 140 | 65.7% | 50.7% |
| 1" | 432 | 55.6% | 47.0% |
| filbert | 1529 | 50.8% | 49.7% |
| round, detail dabs | 4800 | 21.5% | 21.5% |

The effect is large, and it is exactly where it was designed to be — the coarse
passes, the ones that can see least. The aggregate was worthless because the
final pass contributes 4800 of the 6943 strokes, and those are single dabs *by
design* — grid 9, length 1, deliberately exempt from both tests. Nearly 70% of
the population could not respond to the treatment, and they drowned the 42
strokes that mattered most.

Nothing was wrong with the metric's arithmetic. It averaged over a population
whose members were not doing the same job.

**If a measurement says a change does nothing, check what the measurement is
averaging over before believing it.** We also, in the same session, "improved"
one of the two tests on a plausible theoretical argument and made it measurably
worse at its job (47.6% against 38.1%), and caught that only because the
per-pass harness was by then fast enough to re-run on a whim. Both mistakes
came from the same place: reasoning about the mechanism instead of measuring
the outcome.

### The harness is not the hand

Every measurement above drives the simulator through a script: a stroke is a
list of points handed straight to the stroke runner. That is fast, repeatable,
and blind to everything a person goes through on the way there — where a press
lands, what refills the brush, what pressure a mouse reports, which controls are
even visible. We only found this by painting the same reference through the real
interface: clicking the tool rail and the paint swatches, mixing by dragging on
the palette, pointer events on the easel.

The first twenty minutes of a Bob Ross painting could not be done by hand. None
of the following showed up in any scripted test, because scripts step around
every one of them:

- **Strokes that start off the canvas never began.** Sweeping in from the edge
  is how a sky, a lake or a knife pull is normally started; the easel ignored a
  press outside itself, so sixteen blending passes changed not one pixel.
- **The brush refilled itself at every press**, so it could never run down as
  it came down the canvas — and running down is where Bob's sky gradient comes
  from. Scripts refill deliberately, so they never noticed.
- **Every knife ran dry after one stroke and never refilled.** A knife loads
  along its edge; an edge load was bookkept as a deliberate two-colour dip; a
  two-tone brush is never reloaded. Scripts dip the knife explicitly before
  each stroke.
- **Pressure was hidden** in a collapsed panel — the one control a mouse user
  has for "barely touch" versus "firm".

And one that scripts *did* suffer from but masked with their refills: **every
bristle brush lost at least half its load to a per-footprint "evaporation"**
set as high as the laying rate itself. The fan brush lost more paint to nothing
than it put on the canvas. A script that refills every stroke never runs a
brush long enough to see it.

The lesson generalises: **a harness that bypasses the input layer tests the
engine, not the instrument.** For an instrument, the input layer is where half
the failures live.

### Calibrate against the gesture that would break it

We also made a change tonight that measured well and was wrong. A sky test built
from short criss-cross strokes improved markedly when the 2" brush was made to
take up the wet ground strongly as it laid. We shipped it. The next test painted
a long horizontal band, and the same change made the colour fade to white by
halfway across while the brush still held most of its paint — worse than before
we started. The short-stroke test could not have caught it, because a short
stroke never runs long enough for the uptake to compound.

Three other hypotheses tonight were tested and rejected before anything was
changed, and are worth recording as negative results: that a rigid knife needed
a harder contact threshold to make snow break (no measurable effect at three
settings); that a sparse brush footprint was being under-pressed (none); that a
brush's "knee" throttled light loads (every brush lays at full rate above a load
of about 0.11). Each was plausible from the code. None was true of the output.

### The rule we would actually write down

> Build the measurement before you touch the model. Every hour we spent on the
> harness came back several times over. Every change we made by reasoning about
> the code, without a number in front of us, was either wrong or neutral.

We can be precise about this because we have the record. Of the first seven
bugs, three were introduced by changes motivated by reading the shader and
thinking hard about it. Measurement is not a guarantee either: one change was
motivated by a measurement and was still wrong, because the measurement did not
include the gesture that broke it (see "Calibrate against the gesture that would
break it"). What measurement buys is that the error is caught at all, and
quickly — that one was reverted within the hour.

---

## 7. What we got wrong, in order

For anyone implementing these papers, the compressed version. Each row is a bug
we shipped and the measurement that caught it.

| # | The bug | What it looked like | What caught it |
|---|---|---|---|
| 1 | Cleaning the brush undone by the next stroke | Colours crept between strokes | Probe: "does a clean brush stay clean?" |
| 2 | Hiding power ignored substrate wetness | Wet paint buried anything laid on it | Probe: layers laid vs. covered |
| 3 | Transfer computed twice, capped once | Second pass thinner than first; dry brush scraped past the base coat | Probe: `laidByOnePass: -0.261` |
| 4 | Tip film used as "room" on the palette | Loading capped at 6%; mixtures came off near-black (`#162933` for `#6294a5`) | Mix calibration: measured swatch vs. intended |
| 5 | Unidirectionality applied to the palette | Palette became pickup-only; could not mix at all | A user. Then a scripted pointer-event reproduction |
| 6 | Colour decoupling disabled where the tool is full | A full brush sealed shut; only ever paints the last colour clicked | Probe: drag a loaded brush through a contrasting pile, sample what it lays |
| 7 | Colour exchange over-counted whatever the brush crossed while full | Every mixture in the app drifted toward whichever pigment was crossed last | Mix calibration: intended hex vs. measured, swept over the exchange rate |
| 8 | Bristle brushes lost more paint to "drying out" than they laid | A 2" brush empty after one stroke; fan-brush trees impossible | Painting by hand: a sky that could not grade |
| 9 | Brushes refilled at every press | A phthalo sky came out as flat tube colour | Painting by hand, then a probe with refilling on and off |
| 10 | The easel ignored presses off its edge | Blending strokes started off the canvas did nothing at all | Painting by hand: before and after were pixel-identical |
| 11 | An edge-loaded knife was bookkept as a two-colour dip | Every knife dry after one stroke, forever | Painting by hand: the mountain's body stayed bare |
| 12 | One wet-hiding constant for bristles and blades | A knife blended into wet white like a brush | Probe: knife on wet white, per-tool churn |
| 13 | Pressure cut a knife's paint as well as its contact | Snow a grey veil instead of breaking bright | Probe: brightness and break-up of snow at three pressures |
| 14 | The fan's flow was set as if its footprint were dense | Evergreens nearly invisible on wet ground | Probe: one branch pull, fan against the 2" |

Bug 7 deserves its own note, because it was the one with the widest blast
radius, and because our first fix for it was wrong in an instructive way.

We had pinned the palette so a pile never lost paint — `take = 0`, plus a floor
under the volume. The visible symptom was that nothing could be pulled *out* of
a pile. The invisible one was that every mixture in the application came out far
too light, and consistently so.

We removed the floor, and both symptoms went away. Mixture error against the
values the paintings are written to fell from 277 to 51, summed over channels.
We wrote it up as "a pile that cannot be depleted cannot honour a ratio", which
is a tidy explanation, and we shipped it.

**It was the wrong lever, and the explanation was wrong too.** A painter using
the tool reported the obvious consequence immediately: the paint now ran out,
and they had to keep squeezing more. Which in a simulation buys nothing — nobody
here is short of cadmium yellow, and being made to re-stock mid-mixture is pure
friction in the one place the tool should feel generous. Baxter's dissertation
says as much: the palette is a source that refills the brush and never runs out.

Going back with a probe instead of an argument: the ratio does not come from
depletion at all. Our mixing routine lays each pigment as a band whose *width*
is its share and drags a brush across the strip, so the ratio comes from how far
a bristle travels over each pigment. Depletion was never the mechanism. What had
actually been distorting the ratio was the colour-exchange term from §3.2 — the
brush fills up on the wide white band first, then crosses the narrow dark bands
while *full*, which is precisely when that term is strongest. The darks were
being counted twice.

Calibrating that term instead, against the same two mixtures, with the piles
bottomless:

| exchange rate | summed channel error |
|---|---|
| 0.00 | 277 (the original bug — far too light) |
| 0.25 | 153 |
| **0.50** | **43** |
| 1.00 | 192 (too dark) |

A real optimum rather than a fudge: too little and the brush cannot pick the
darks up at all, too much and they swamp the white. It also beats the
depleting-pile version we had shipped, which measured 51 — so the right fix was
better than the wrong one on the wrong fix's own metric, while removing the
symptom the wrong one introduced.

Two lessons, and the second is the one we would keep:

- A measurement that improves is not proof that the mechanism you believe in is
  the one that moved it. 277 → 51 was real, and our account of *why* was wrong.
  We had changed two things — depletion and a volume ceiling — and measured only
  the sum, then narrated a cause for it.
- **The symptom a user reports is evidence about the model, not just about the
  UI.** "The paint runs out too fast" was not a complaint about convenience. It
  was a correct observation that the palette had been given a property a palette
  should not have, and chasing it led to the actual defect.

Bugs 4, 5, 6 and 7 are all the same underlying mistake: **treating the palette as
a canvas**. Every rule tuned for making a mark on a painting was applied, by
default, to a surface whose purpose is the opposite. If we were starting again
we would make the substrate an explicit parameter of the transfer model from
the first line rather than a `uPalette` flag bolted on later, and we would
write the palette test suite before the canvas one.

Note also that bugs 5 and 6 both reached a user. Our measurement was good at
the canvas and had almost nothing pointed at the palette, and that is exactly
where the shipped bugs were. **A test suite's blind spot and a product's bug
distribution are the same map.**

---

## 8. Limitations

Stated plainly, because §0 promised it.

- **No bristle dynamics.** WetBrush simulates bristle geometry. We warp a
  rasterised 2D footprint. Our brush cannot buckle, cannot splay
  asymmetrically under a real load, and does not know its own history beyond a
  per-stroke seed.
- **Three-channel Kubelka–Munk.** We infer a reflectance curve from RGB rather
  than using measured pigment data. Mixtures of saturated complements are the
  obvious place this shows.
- **No impasto light transport.** We shade a height field. There is no
  self-shadowing between ridges, no subsurface scattering, no view-dependent
  gloss. Thick paint looks thick from one angle only.
- **No photometric validation.** We never compared against a measured swatch of
  real paint under known illuminant. Every constant in §3 was set by eye.
- **The reference confounds three variables.** A photograph of a Bob Ross
  painting tells you about the paint, the painter, and the camera together. We
  cannot separate them, so "closer to the reference" partly means "closer to
  being a good painter", which is not what we were tuning.
- **No user study.** The strongest claim we can honestly make is that one
  painter reported specific things as broken, we measured them, and they
  measure differently now.

---

## 9. What we would do next

- **Photometric validation.** Paint real swatches, measure them, fit the KM
  parameters. This is the single change that would move the work from "looks
  right" to "is right", and it needs a spectrophotometer, not more code.
- **Put painters in front of it.** Not to ask whether they like it, but to ask
  which marks they cannot make. Every real finding in this document started
  with someone saying a specific thing was impossible.
- **Substrate as a first-class concept.** Canvas, palette, knife edge and rag
  are four different contact regimes, and we model them with one flag and some
  `mix()` calls. A model that took the contact regime as an input from the
  start would be cleaner and would have prevented four of the first seven bugs.
- **Measured pigment basis.** IMPaSTo's eight-basis approach with real pigment
  data, if the performance can be found on a GPU we do not control.

---

## References

- Baxter, Wendt & Lin, **IMPaSTo: A Realistic, Interactive Model for Paint**
  (NPAR 2004) — bidirectional transfer, the unidirectionality rule, and the
  dead zone that stops transfer oscillating.
  <http://gamma.cs.unc.edu/IMPASTO/publications/Baxter-IMPaSTo_Web-NPAR04.pdf>
- Baxter, **Physically-based Modeling Techniques for Interactive Digital
  Painting** (UNC dissertation, 2004) — the palette as a paint source that
  refills the brush and never runs out, and the deep reservoir.
  <http://gamma-web.iacs.umd.edu/papers/documents/dissertations/baxter04.pdf>
- Chen, Kim, Ito & Wang, **WetBrush: GPU-based 3D Painting Simulation at the
  Bristle Level** (SIGGRAPH Asia 2015) — mass transfer and colour transfer are
  decoupled, so a full brush still picks up colour.
  <https://wanghmin.github.io/publication/chen-2015-wgb/Chen-2015-WGB.pdf>
- Stuyck, Da & Dutré, **Real-Time Oil Painting on Mobile Hardware** (CGF 2017).
  <https://tuurstuyck.github.io/assets/oilpaint_low_res.pdf>
- Hertzmann, **Painterly Rendering with Curved Brush Strokes of Multiple
  Sizes** (SIGGRAPH 1998) — the coarse-to-fine pass structure our
  picture-to-painting mode uses to drive the simulator.
- van Wijnen, **spectral.js** (MIT) — the Kubelka–Munk implementation we
  vendored and ported to GLSL.

---

*Corrections and disagreement are welcome, particularly from anyone who has
measured real paint. Where this document states a number, the harness that
produced it is in `tools/`.*
