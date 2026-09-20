// Guided lessons, in the order Bob actually worked: wet base coat first, then
// back-to-front. Sky, then the mountains behind, then the foothills, then the
// trees in front, then the water, then the land you are standing on, then the
// little sticks and twigs, then your name in the corner.
//
// Each step can hand you the right tool and the right colours -- click it and
// the studio sets itself up.

export const LESSONS = [
  {
    id: 'mountain-lake',
    title: 'Mountain & Lake',
    subtitle: 'The classic. Sky, a mighty mountain, evergreens and a still lake.',
    steps: [
      {
        title: 'Liquid White the canvas',
        tool: 'brush-2inch',
        baseCoat: 'liquid-white',
        text:
          'Thin, even coat over the whole canvas, criss-crossing then smoothing. This is what keeps everything wet so the colours blend on the canvas instead of on the palette. Do not skip it.',
      },
      {
        title: 'Lay in the sky',
        tool: 'brush-2inch',
        colours: ['phthalo-blue', 'titanium-white'],
        text:
          'The tiniest touch of Phthalo Blue -- it is ferocious. Criss-cross little Xs across the top of the canvas and let it fade out as you come down toward the horizon. Leave the lower sky nearly white.',
      },
      {
        title: 'Happy little clouds',
        tool: 'brush-round',
        colours: ['titanium-white'],
        text:
          'Load the round brush and tap in cloud shapes with circular motions. Make them uneven -- nature has no straight lines. Then blend the bottom of each cloud with a clean brush and fluff it gently upward.',
      },
      {
        title: 'Cut in the mountain',
        tool: 'knife-10',
        colours: ['phthalo-blue', 'van-dyke-brown', 'titanium-white'],
        text:
          'Mix a dark blue-brown. Load a roll of paint on the long edge of the knife and cut in the mountain shape -- firm, confident, uneven peaks. Then pull the paint down to fill the body.',
      },
      {
        title: 'Snow on the sunlit side',
        tool: 'knife-10',
        colours: ['titanium-white'],
        text:
          'Decide where your light comes from and stay with it. Barely touch the canvas with white on the knife edge so it breaks up over the texture -- that broken edge is rock face. Shadow side gets white with a touch of blue.',
      },
      {
        title: 'Mist the base',
        tool: 'util-blender',
        text:
          'With a clean dry brush, tap the bottom of the mountain gently, then lift straight up. The mountain disappears into the mist and sits back where it belongs.',
      },
      {
        title: 'Foothills',
        tool: 'brush-round',
        colours: ['van-dyke-brown', 'sap-green', 'titanium-white'],
        text:
          'Tap in a soft, darker mass under the mountain. Keep it hazy -- it is far away. Mist its base the same way.',
      },
      {
        title: 'Evergreens',
        tool: 'brush-fan',
        colours: ['sap-green', 'van-dyke-brown', 'phthalo-blue'],
        text:
          'Dark mix. Touch in a centre line with the liner, then use the corner of the fan brush: start at the top with tiny touches and work down, pushing in and letting the bristles bend. Wider as you go. Each tree gets its own personality.',
      },
      {
        title: 'Tree highlights',
        tool: 'brush-fan',
        colours: ['sap-green', 'cadmium-yellow'],
        text:
          'Lighter green, and only on the side facing your light. Barely touch -- you want the highlight to catch on the texture, not cover the dark.',
      },
      {
        title: 'Water',
        tool: 'brush-2inch',
        colours: ['phthalo-blue', 'titanium-white'],
        text:
          'Reflections fall straight down. Pull the colour of everything above straight down into the water, then gently stroke straight across to settle it. Leave a light path where the sky reflects.',
      },
      {
        title: 'Bank and foreground',
        tool: 'knife-5',
        colours: ['van-dyke-brown', 'dark-sienna', 'cadmium-yellow'],
        text:
          'Cut in a land line with the small knife. Dark under the bank, warm highlights on top where the light hits. Let it come forward -- big shapes in front, small ones behind.',
      },
      {
        title: 'Sticks, twigs and your name',
        tool: 'brush-liner',
        colours: ['van-dyke-brown'],
        text:
          'Thin the paint right down with the thinner slider until it runs off the brush. Little branches, a few grasses. Then sign it in the corner -- you earned it.',
      },
    ],
  },
  {
    id: 'winter-woods',
    title: 'A Walk in the Woods',
    subtitle: 'Snow, bare trees and a warm winter sky.',
    steps: [
      {
        title: 'Liquid White, then a warm sky',
        tool: 'brush-2inch',
        baseCoat: 'liquid-white',
        colours: ['alizarin-crimson', 'indian-yellow', 'titanium-white'],
        text:
          'Base coat first. Then a soft warm glow near the horizon -- crimson and a touch of yellow -- fading up into cool light grey.',
      },
      {
        title: 'Distant treeline',
        tool: 'brush-fan',
        colours: ['van-dyke-brown', 'phthalo-blue', 'titanium-white'],
        text:
          'A pale hazy mix. Tap in a soft band of distant trees along the horizon. The further back, the lighter and greyer it goes.',
      },
      {
        title: 'Snow on the ground',
        tool: 'brush-2inch',
        colours: ['titanium-white', 'phthalo-blue'],
        text:
          'Horizontal strokes, left to right. Snow is not white -- it picks up blue in the shadows and warm light on top. Vary it.',
      },
      {
        title: 'Bare trees',
        tool: 'brush-liner',
        colours: ['van-dyke-brown', 'midnight-black'],
        text:
          'Thinned dark paint. Start at the trunk and flick outward and upward. Branches get thinner as they go. Let the brush do the work.',
      },
      {
        title: 'Snow on the branches',
        tool: 'brush-fan',
        colours: ['titanium-white'],
        text: 'Barely touch the tops of the branches. Just a whisper.',
      },
      {
        title: 'Foreground and footprints',
        tool: 'knife-5',
        colours: ['titanium-white', 'phthalo-blue', 'dark-sienna'],
        text:
          'Cut in some drifts with the knife. A few dark sticks poking through. Sign it.',
      },
    ],
  },
  {
    id: 'seascape',
    title: 'Ocean Sunset',
    subtitle: 'Waves, foam and a sky on fire. Liquid Black underneath.',
    steps: [
      {
        title: 'Liquid Black base',
        tool: 'brush-2inch',
        baseCoat: 'liquid-black',
        text: 'A dark wet base keeps the deep water deep. Thin and even.',
      },
      {
        title: 'Burning sky',
        tool: 'brush-2inch',
        colours: ['alizarin-crimson', 'bright-red', 'indian-yellow', 'titanium-white'],
        text:
          'Brightest at the horizon where the sun is, cooling and darkening as you go up. Criss-cross, then smooth horizontally.',
      },
      {
        title: 'The water plane',
        tool: 'brush-2inch',
        colours: ['phthalo-blue', 'alizarin-crimson', 'titanium-white'],
        text:
          'Dark at the horizon, and pull the sunset colour straight down the middle as a light path. Stroke horizontally to settle it.',
      },
      {
        title: 'Build the wave',
        tool: 'brush-1inch',
        colours: ['phthalo-blue', 'phthalo-green', 'titanium-white'],
        text:
          'Shape the curl of the wave. The back of the wave is dark; the thin part where the light comes through is bright and transparent.',
      },
      {
        title: 'Foam and spray',
        tool: 'brush-liner',
        colours: ['titanium-white'],
        text:
          'Thin the white. Tap and flick the foam where the wave breaks -- irregular, never a line. Let some fly.',
      },
      {
        title: 'Rocks and sand',
        tool: 'knife-10',
        colours: ['van-dyke-brown', 'dark-sienna', 'titanium-white'],
        text:
          'Big dark shapes in front. Highlight the tops facing the light. Wet sand reflects the sky -- pull a little of it down.',
      },
    ],
  },
];
