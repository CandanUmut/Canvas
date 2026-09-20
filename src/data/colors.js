// Bob Ross's palette: the same 13 oil colors in every episode, in the order he
// laid them out on the palette (darks up the left, lights across the top).
//
// `tint` is tinting strength -- how hard the pigment fights back when mixed.
// Phthalos are monsters: a pinhead of Phthalo Blue will swallow a pile of
// Titanium White. Earth colors like Yellow Ochre are meek. This single number
// is what makes digital mixing feel like real paint instead of averaging.
//
// `body` is how stiff the paint is out of the tube, which drives how much it
// holds an impasto ridge vs. flowing flat.
//
// The hex values are the pigment's masstone, chosen so that it MIXES like the
// real thing rather than merely looking right in a swatch. The widely-copied
// CSS value for Phthalo Blue, #0c0040, has a green channel of exactly zero --
// no amount of correct Kubelka-Munk can get green out of that, so yellow and
// blue made mud. Real PB15 is intensely cyan in undertone, and the value below
// reflects that.
//
// `opacity` is whether the pigment covers or glazes, and in oil painting it
// matters as much as the hue. Titanium White buries whatever is under it;
// Alizarin Crimson laid over the same spot just stains it. It is why a
// highlight has to be an opaque colour and a shadow is better transparent.

export const PIGMENTS = [
  // --- darks, up the left edge of the board -------------------------------
  {
    id: 'midnight-black',
    name: 'Midnight Black',
    hex: '#090909',
    tint: 0.9,
    opacity: 0.80,
    body: 1.0,
    note: 'Almost never used alone. Darkens without going muddy.',
  },
  {
    id: 'van-dyke-brown',
    name: 'Van Dyke Brown',
    hex: '#221b15',
    tint: 0.85,
    opacity: 0.70,
    body: 1.0,
    note: 'The workhorse dark. Tree trunks, soil, base of everything.',
  },
  {
    id: 'dark-sienna',
    name: 'Dark Sienna',
    hex: '#5b2d1c',
    tint: 0.8,
    opacity: 0.35,
    body: 0.95,
    note: 'Warm transparent brown. Underpainting and cabin wood.',
  },
  {
    id: 'alizarin-crimson',
    name: 'Alizarin Crimson',
    hex: '#4b0d20',
    tint: 1.15,
    opacity: 0.28,
    body: 0.85,
    note: 'Transparent, staining red. Sunset glow and shadow warmth.',
  },
  {
    id: 'sap-green',
    name: 'Sap Green',
    hex: '#0a3410',
    tint: 1.0,
    opacity: 0.60,
    body: 0.95,
    note: 'Foliage green. Almost always cut with yellow for highlights.',
  },
  {
    id: 'phthalo-green',
    name: 'Phthalo Green',
    hex: '#0b3d33',
    tint: 2.2,
    opacity: 0.40,
    body: 0.8,
    note: 'Ferocious. Water, deep evergreens. Use the tiniest touch.',
  },
  {
    id: 'phthalo-blue',
    name: 'Phthalo Blue',
    hex: '#0a3560',
    tint: 2.8,
    opacity: 0.40,
    body: 0.8,
    note: "Bob's sky blue. Brilliant and staining -- barely touch it.",
  },
  {
    id: 'prussian-blue',
    name: 'Prussian Blue',
    hex: '#11304c',
    tint: 1.45,
    opacity: 0.55,
    body: 0.85,
    note: 'Greyer, softer blue. Distant mountains and winter skies.',
  },
  // --- lights, across the top ---------------------------------------------
  {
    id: 'bright-red',
    name: 'Bright Red',
    hex: '#db0000',
    tint: 1.1,
    opacity: 0.90,
    body: 1.0,
    note: 'Opaque warm red for flowers and sunset punch.',
  },
  {
    id: 'indian-yellow',
    name: 'Indian Yellow',
    hex: '#ffb800',
    tint: 1.0,
    opacity: 0.30,
    body: 0.85,
    note: 'Transparent glowing yellow. Sunlight through leaves.',
  },
  {
    id: 'yellow-ochre',
    name: 'Yellow Ochre',
    hex: '#c79b00',
    tint: 0.7,
    opacity: 0.85,
    body: 1.0,
    note: 'Dusty earth yellow. Grasses, sand, muted highlights.',
  },
  {
    id: 'cadmium-yellow',
    name: 'Cadmium Yellow',
    hex: '#ffec00',
    tint: 1.0,
    opacity: 0.95,
    body: 1.05,
    note: 'Opaque bright yellow. The loudest highlight on the palette.',
  },
  {
    id: 'titanium-white',
    name: 'Titanium White',
    hex: '#ffffff',
    tint: 1.0,
    opacity: 1.00,
    body: 1.15,
    note: 'Half the palette by volume. Stiff, opaque, covers anything.',
  },
];

// The mediums. These are not colors -- they change how the paint behaves, and
// they are the entire reason the wet-on-wet method works at all.
export const MEDIUMS = [
  {
    id: 'liquid-white',
    name: 'Liquid White',
    hex: '#fdfdfb',
    tint: 0.55,
    opacity: 0.50,
    body: 0.18,
    fluid: 1.0,
    note: 'Thin oily white base coat. Keeps the canvas wet so everything blends. Start almost every painting with it.',
  },
  {
    id: 'liquid-clear',
    name: 'Liquid Clear',
    hex: '#ffffff',
    tint: 0.0,
    opacity: 0.00,
    body: 0.12,
    fluid: 1.0,
    clear: true,
    note: 'Wets the canvas without lightening it. Use over dark areas so colors stay dark.',
  },
  {
    id: 'liquid-black',
    name: 'Liquid Black',
    hex: '#0b0b0d',
    tint: 0.6,
    opacity: 0.50,
    body: 0.18,
    fluid: 1.0,
    note: 'Dark wet base coat. Night skies and dramatic seascapes.',
  },
];

// The first eight are the darks that go up the left of the palette; the last
// five are the lights that go across the top. Bob laid his out this way every
// single episode.
const LIGHT_FROM = 8;
PIGMENTS.forEach((p, i) => {
  p.dark = i < LIGHT_FROM;
});

export const ALL_PAINTS = [...PIGMENTS, ...MEDIUMS];

export const PAINTS_BY_ID = Object.fromEntries(ALL_PAINTS.map((p) => [p.id, p]));

// The gesso a double-primed cotton canvas actually is: not pure white, a touch warm.
export const CANVAS_GESSO = '#f2efe7';

/** '#rrggbb' -> [r, g, b] in 0..1. */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** [r, g, b] in 0..1 -> '#rrggbb'. */
export function rgbToHex(rgb) {
  const c = (v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
