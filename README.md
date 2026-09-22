# The Joy of Painting — a digital oil studio

A wet-on-wet oil painting studio that runs in a browser. Bob Ross's thirteen
colours, his brushes and knives, Liquid White, real pigment mixing and paint
you can pile up thick enough to catch the light — with a pen, a mouse, or your
finger.

No build step, no dependencies, no server. Open `index.html` and paint.

![The studio: tool rail on the left, canvas in the middle, paints and mixing palette on the right](docs/screenshot.jpg)

## Why it isn't a normal paint program

Bob Ross painted **wet-on-wet**: prime the canvas with a thin coat of oily
white, then work the whole picture in one sitting while everything underneath
is still wet. Colours blend *on the canvas*, not on the palette. That one fact
decides how all the tools behave — so the app simulates paint rather than
drawing strokes.

The model follows Baxter's IMPaSTo and dAb work, which is the established
prior art for exactly this problem. Four rules do most of the work:

- **Transfer is unidirectional.** At any point under the bristles the tool is
  either laying paint down or picking it up, never both at once. Doing both is
  what made an earlier version wipe a pile of paint off the palette while
  barely loading the brush.
- **The palette is a paint source, not a picture.** Piles on it are deep, and
  they are never used up, so a mixture you made is still there to reload from.
  One pass through a pile fills a brush to about 80%; two fills it.
- **Load is a fill fraction.** One number, 0 to 100%, meaning what it says.
  Deposit and pickup both convert through a single per-tool constant, so brush
  units and canvas units never get added together.
- **Colour spreads sideways through the bristles.** Drag across two piles and
  the tool carries a genuine mixture rather than stripes of each — which is
  what makes the swatch in the corner tell the truth about what will land.

Blending happens because a bristle picks paint up at one dab and puts it down
over the dabs that follow, further along the stroke. Drag a clean brush across
a wet sky and it blends, because that is what is actually happening.

Three more things follow:

- **Pigments mix like pigments.** Blue over yellow gives green, not grey, via
  Kubelka–Munk spectral mixing. Each colour carries its real **tinting
  strength**: a touch of Phthalo Blue swallows a pile of Titanium White, while
  Yellow Ochre barely argues with anything. The masstone values are chosen so
  each pigment *mixes* like the real thing — the widely copied CSS value for
  Phthalo Blue has a green channel of exactly zero, and no amount of correct
  colour science gets green out of that.
- **Opacity is separate from colour.** One pass of Titanium White covers 94%
  of what is under it; the same pass of Alizarin Crimson covers 71% and mostly
  stains. This is why a highlight wants an opaque colour and a shadow is
  better transparent.
- **The canvas has tooth.** Press hard and paint floods the weave; barely
  touch and it catches only the peaks — which is how one stroke of white
  becomes a broken, sparkling highlight on a mountain instead of a stripe.

Brushes run out, and reload at the start of each stroke the way a real one
does. Thick paint builds real relief, lit by a studio light you can move.

## The tools

**Brushes** — 2" and 1" landscape, fan, round foliage, filbert, oval, #2 script
liner, detail round.
**Knives** — #10 and #5 painting knives, plus a scraper for taking paint off.
**Utility** — a clean blender (a dry brush with no paint, for softening edges
and misting the base of mountains) and a rag that wipes back to bare canvas.

Each tool is defined by its **footprint** — a picture of the bristles pressed
flat against the canvas. The gaps matter more than the bristles: the spaces
between a fan brush's clumps are what make it read as evergreen boughs, so a
fan is modelled as separate hair bundles with clear air between them rather
than one solid shell. How much those gaps show is per-tool: everything for a
fan brush, almost nothing for a flat brush laying a sky, where a gap would just
be bare canvas.

Which bristles catch the surface changes every time you set the tool down, and
holds for as long as you keep it there. Re-rolling that per dab averaged the
variation away and made a fan brush stamp the identical mark every touch.

Sizes are in **inches**, not pixels, and scale with the canvas. A 2" brush is
two inches wide on a 24" canvas at any resolution.

**Colours** — the same thirteen Bob used, in his palette order: Midnight Black,
Van Dyke Brown, Dark Sienna, Alizarin Crimson, Sap Green, Phthalo Green,
Phthalo Blue, Prussian Blue, Bright Red, Indian Yellow, Yellow Ochre, Cadmium
Yellow, Titanium White.

**Mediums** — Liquid White, Liquid Clear and Liquid Black as base coats or on
the brush, plus an odorless thinner slider that turns any paint into something
that flows off a liner brush.

## Painting with it

1. **Base coat first.** *Base coat → Liquid White.* Almost every painting
   starts here; it is what keeps the canvas wet so everything blends. Use
   Liquid Clear instead when you want to keep an area dark.
2. **Pick a colour.** Click a pigment on the palette board. That squeezes a
   fresh pile onto the board *and* loads your tool with it — one gesture.
   Shift-click to squeeze without loading.
3. **Mix for real.** Drag a brush through two piles. The board runs the same
   simulation as the canvas, so the mix on your bristles is a real mix, and it
   comes with you to the painting. The swatch under the board is what you are
   actually holding.
4. **Work back to front.** Sky, then the mountains behind, then foothills, then
   trees, then water, then the land you are standing on, then the little sticks
   and twigs, then sign it. The **Lessons** panel walks three paintings through
   this and sets up the tool and colours for each step.
5. **Let it dry** when you want the next layer to sit on top instead of
   blending in.

**Your painting is kept.** Close the tab and come back whenever you like — the
canvas, the palette and the tool you were holding are all still there. It is
stored in your own browser (IndexedDB; a painting is about 12MB, well past what
localStorage takes), nothing is uploaded anywhere, and clearing site data
clears it. *New canvas* replaces what is saved.

Pressure comes from a stylus if you have one; with a mouse or finger the
**Pressure** slider does the same job, and it is the control that turns a
covering stroke into a broken dry-brush highlight.

### Keyboard

| | |
|---|---|
| `1`–`0` | pick a tool |
| `[` `]` | brush size |
| `C` | clean the brush ("beat the devil out of it") |
| `Shift`+`D` | let it dry |
| `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` | undo / redo |
| `Ctrl`+`S` | save a PNG |
| `+` `−` `F` | zoom in, out, fit |
| `Alt`+click | pick a colour off the canvas |
| `V` (hold) | see it in grey — the squint test |
| `Shift`+drag / middle-drag | pan |

## Running it

It is a static site with no build step.

```sh
python -m http.server 8000      # or any static server
# then open http://localhost:8000
```

A server is needed only because the code uses ES modules, which browsers
refuse to load over `file://`.

### GitHub Pages

`.github/workflows/pages.yml` publishes the repository root on every push to
`main`. Enable it once under **Settings → Pages → Build and deployment →
Source → GitHub Actions**. Nothing to build or configure.

## Requirements

A browser with **WebGL2** and floating-point render targets — current Chrome,
Edge, Firefox or Safari. The simulation runs on the GPU; if WebGL2 is missing
the app says so plainly instead of failing silently.

Larger canvases cost more GPU memory and time. *New canvas* offers
12×9 in through 32×24 in; 24×18 in is Bob's usual size and the default.

## How it fits together

```
index.html            the page; the panels are a DOM overlay on one GL canvas
styles.css
src/
  core/
    gl.js             WebGL2 helpers: programs, render targets, ping-pong
    shaders.js        the simulation: pickup, deposit, base coat, lighting
    engine.js         surfaces, the brush's paint reservoir, undo, export
    stroke.js         pointer input to dabs: spacing, pressure, stroke angle
  data/
    colors.js         the thirteen pigments and the mediums
    brushes.js        the tools, and the maths that draws each footprint
    lessons.js        three guided paintings
    storage.js        keeping the painting between visits, in IndexedDB
  ui/app.js           panels, pointer and keyboard wiring
  vendor/             spectral.glsl.js — Kubelka–Munk mixing (MIT)
paintings/            paintings written down, to be replayed
tools/                the bench: replay, probe, compare
```

Canvas state lives in two floating-point textures: colour and wet-paint volume
in one, impasto height and wetness in the other. The tool carries a third,
small texture — the reservoir — holding what is on the bristles right now, with
a separate pass that lets colour spread sideways through it. Only the dab's own
footprint is ever recomputed, so cost scales with the brush, not the canvas.

`window.studio` exposes the engine, the surfaces and a `coverageAt()` probe for
poking at the simulation from the browser console.

## Judging a change to the paint

A change to the simulation is only worth making if the pictures come out
better, and a picture painted by hand cannot be painted twice. So a painting
can be written down — ordinary browser code driving the same `StrokeRunner`
the pointer drives, through `window.studio.script`:

```js
s.baseCoat('liquid-white');
s.tool('brush-2inch', 2.0).set({ pressure: 0.6 });
s.mix([['titanium-white', 12], ['phthalo-blue', 1]]);   // on the board, for real
s.stroke([[-60, 40], [1500, 40]]);
s.clean();
```

Coordinates are written once, against a 24 in canvas 1440 across, and scale to
whatever canvas the run uses — so a painting can be tried quickly on a small
canvas and then painted at size without moving a number. Tool sizes need no
scaling; they are in inches already.

```sh
python -m http.server 8000 &
node tools/paint.mjs paintings/mountain-lake.js out/run-01 --size=half
node tools/probe.mjs                    # what the simulation does, in numbers
python3 tools/compare.py out/run-01/final.png reference.jpg out/cmp
```

`paint.mjs` replays a painting in a real browser and writes each stage out as
it is painted. `probe.mjs` asks the questions a wet-on-wet painter cares about
and answers them in numbers — what a loaded brush comes back holding, whether
a clean brush stays clean, how many layers a pass lays, whether a light touch
breaks up, what a mixture actually comes out as — so a change to the model can
be measured before and after instead of argued about. `compare.py` holds a run
up against a photograph of a real painting: value range and where the values
sit, colour balance, and local contrast at three scales, band by band down the
picture.

It needs Chromium, which Playwright will already have, plus Pillow and NumPy
for the comparison.

## Where the model comes from

There is a longer write-up of what we built on top of these papers, what we got
wrong along the way, and how a painting simulator can be measured at all, in
[docs/simulating-oil-paint.md](docs/simulating-oil-paint.md).


- Baxter, Wendt & Lin, **IMPaSTo: A Realistic, Interactive Model for Paint**
  (NPAR 2004) — bidirectional transfer, the unidirectionality rule, and the
  dead zone that stops transfer oscillating.
  <http://gamma.cs.unc.edu/IMPASTO/publications/Baxter-IMPaSTo_Web-NPAR04.pdf>
- Baxter, **Physically-based Modeling Techniques for Interactive Digital
  Painting** (UNC dissertation, 2004) — the palette as a paint source that
  refills the brush and never runs out, and the deep reservoir.
  <http://gamma-web.iacs.umd.edu/papers/documents/dissertations/baxter04.pdf>
- Chen, Kim, Ito & Wang, **WetBrush** (SIGGRAPH Asia 2015) — mass transfer and
  colour transfer are decoupled, so a full brush still picks up colour.
  <https://wanghmin.github.io/publication/chen-2015-wgb/Chen-2015-WGB.pdf>
- Stuyck, Da & Dutré, **Real-Time Oil Painting on Mobile Hardware** (CGF 2017).
  <https://tuurstuyck.github.io/assets/oilpaint_low_res.pdf>

## Credits

Pigment mixing uses [spectral.js](https://github.com/rvanwijnen/spectral.js) by
Ronald van Wijnen (MIT) — see `src/vendor/LICENSE-spectral.txt`. The GLSL port
is vendored as `src/vendor/spectral.glsl.js`.

The palette, tools and method follow Bob Ross's own materials and the wet-on-wet
technique he learned from Bill Alexander. This project is an homage and is not
affiliated with or endorsed by Bob Ross Inc.
