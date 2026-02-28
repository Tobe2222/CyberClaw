/**
 * CyberClaw Companion Sprite Generator
 * Generates unique Pokémon-style pixel art companions from input parameters.
 * 
 * Each companion is composed of layered parts:
 *   body → face → eyes → ears/horns → tail → accessories
 * 
 * Rendered on HTML5 Canvas, exported as PNG data URL.
 */

const SpriteGenerator = (() => {
  const SPRITE_SIZE = 64;  // 64x64 pixel canvas
  const PIXEL = 4;         // each "pixel" is 4x4 real pixels → 16x16 grid

  // ─── Color Palettes by Element ───
  const PALETTES = {
    cyber:    { primary: '#00d4ff', secondary: '#0088aa', accent: '#ff6b35', dark: '#004466', light: '#66eeff', skin: '#00b8d9' },
    fire:     { primary: '#ff6b35', secondary: '#cc4400', accent: '#ffaa00', dark: '#662200', light: '#ff9966', skin: '#ff5722' },
    electric: { primary: '#ffdd00', secondary: '#ccaa00', accent: '#ff6b35', dark: '#665500', light: '#ffee66', skin: '#ffd600' },
    nature:   { primary: '#4ade80', secondary: '#22aa44', accent: '#88ff88', dark: '#115522', light: '#88ffaa', skin: '#2ecc71' },
    shadow:   { primary: '#9966ff', secondary: '#6633cc', accent: '#ff66ff', dark: '#331166', light: '#bb99ff', skin: '#7c4dff' },
    ice:      { primary: '#88ddff', secondary: '#4499cc', accent: '#ffffff', dark: '#224466', light: '#bbeeFF', skin: '#64b5f6' },
    steel:    { primary: '#aabbcc', secondary: '#778899', accent: '#ff6b35', dark: '#445566', light: '#ddeeff', skin: '#90a4ae' },
    toxic:    { primary: '#66ff66', secondary: '#33cc33', accent: '#ffff00', dark: '#116611', light: '#99ff99', skin: '#00e676' },
  };

  // ─── Body Shapes (16x16 grid, 0=empty, 1=primary, 2=secondary, 3=dark, 4=light, 5=accent, 6=skin, 7=eye white, 8=eye pupil, 9=mouth) ───
  const BODIES = {
    round: [
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,6,6,6,6,1,1,0,0,0,0],
      [0,0,0,1,1,6,6,6,6,6,6,1,1,0,0,0],
      [0,0,0,1,6,6,7,8,6,7,8,6,1,0,0,0],
      [0,0,0,1,6,6,6,6,6,6,6,6,1,0,0,0],
      [0,0,0,1,6,6,6,9,9,6,6,6,1,0,0,0],
      [0,0,0,1,1,6,6,6,6,6,6,1,1,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
      [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
      [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,1,0,0,1,1,1,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ],
    angular: [
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,1,1,6,6,6,6,6,6,1,1,0,0,0],
      [0,0,1,1,6,6,6,6,6,6,6,6,1,1,0,0],
      [0,0,1,6,6,7,8,6,6,7,8,6,6,1,0,0],
      [0,0,1,6,6,6,6,6,6,6,6,6,6,1,0,0],
      [0,0,1,6,6,6,9,9,9,9,6,6,6,1,0,0],
      [0,0,1,1,6,6,6,6,6,6,6,6,1,1,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,1,2,2,2,2,2,2,1,0,0,0,0],
      [0,0,0,0,1,2,2,2,2,2,2,1,0,0,0,0],
      [0,0,0,0,1,2,2,1,1,2,2,1,0,0,0,0],
      [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,1,0,0,1,1,1,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ],
    slim: [
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,1,6,6,6,6,6,6,1,0,0,0,0],
      [0,0,0,0,1,6,7,8,6,7,8,1,0,0,0,0],
      [0,0,0,0,1,6,6,6,6,6,6,1,0,0,0,0],
      [0,0,0,0,1,6,6,9,9,6,6,1,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,1,2,2,2,2,1,0,0,0,0,0],
      [0,0,0,0,0,1,2,2,2,2,1,0,0,0,0,0],
      [0,0,0,0,0,1,2,2,2,2,1,0,0,0,0,0],
      [0,0,0,0,0,1,2,1,1,2,1,0,0,0,0,0],
      [0,0,0,0,0,0,1,0,0,1,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ],
    bulky: [
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,1,1,1,6,6,6,6,1,1,1,0,0,0],
      [0,0,1,1,6,6,6,6,6,6,6,6,1,1,0,0],
      [0,1,1,6,6,7,8,6,6,7,8,6,6,1,1,0],
      [0,1,6,6,6,6,6,6,6,6,6,6,6,6,1,0],
      [0,1,6,6,6,6,9,9,9,9,6,6,6,6,1,0],
      [0,1,1,6,6,6,6,6,6,6,6,6,6,1,1,0],
      [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
      [0,0,1,2,2,2,2,2,2,2,2,2,2,1,0,0],
      [0,0,1,2,2,2,2,2,2,2,2,2,2,1,0,0],
      [0,0,1,2,2,2,1,1,1,1,2,2,2,1,0,0],
      [0,0,0,1,1,1,1,0,0,1,1,1,1,0,0,0],
      [0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    ],
  };

  // ─── Ear/Horn Overlays (applied on top of body) ───
  const EARS = {
    pointy: [
      { x: 4, y: 0, pixels: [[1],[3],[3]] },
      { x: 11, y: 0, pixels: [[1],[3],[3]] },
    ],
    round_ears: [
      { x: 3, y: 1, pixels: [[1,1],[1,6]] },
      { x: 11, y: 1, pixels: [[1,1],[6,1]] },
    ],
    horns: [
      { x: 4, y: 0, pixels: [[5],[5],[1]] },
      { x: 11, y: 0, pixels: [[5],[5],[1]] },
    ],
    antenna: [
      { x: 7, y: 0, pixels: [[4],[3],[0]] },
      { x: 8, y: 0, pixels: [[4],[3],[0]] },
    ],
    spikes: [
      { x: 3, y: 0, pixels: [[5],[1]] },
      { x: 7, y: 0, pixels: [[5],[1]] },
      { x: 12, y: 0, pixels: [[5],[1]] },
    ],
    none: [],
  };

  // ─── Tail Overlays ───
  const TAILS = {
    long: [
      { x: 13, y: 8, pixels: [[1],[1],[0,1],[0,0,5]] },
    ],
    stubby: [
      { x: 13, y: 9, pixels: [[1],[5]] },
    ],
    flame: [
      { x: 13, y: 7, pixels: [[5],[5],[5,5],[0,5]] },
    ],
    lightning: [
      { x: 13, y: 7, pixels: [[4],[0,4],[4],[0,4]] },
    ],
    none: [],
  };

  // ─── Accessories ───
  const ACCESSORIES = {
    scarf: (grid) => {
      // Draw a scarf around neck area
      const y = 8;
      for (let x = 4; x <= 11; x++) {
        if (grid[y] && grid[y][x] !== 0) grid[y][x] = 5;
      }
    },
    glasses: (grid) => {
      // Draw glasses over eyes
      const y = 5;
      if (grid[y]) {
        for (let x = 5; x <= 10; x++) grid[y][x] = grid[y][x] === 8 ? 8 : 3;
      }
    },
    hat: (grid) => {
      // Draw a hat on top
      const y = 1;
      if (grid[y]) {
        for (let x = 5; x <= 10; x++) grid[y][x] = 5;
      }
      if (grid[y+1]) {
        for (let x = 4; x <= 11; x++) grid[y+1][x] = grid[y+1][x] || 5;
      }
    },
    bowtie: (grid) => {
      const y = 8;
      if (grid[y]) {
        grid[y][7] = 5;
        grid[y][8] = 5;
      }
    },
    none: () => {},
  };

  // ─── Eye Styles ───
  const EYES = {
    normal: { white: 7, pupil: 8 },
    angry: { white: 7, pupil: 8, brow: true },
    cute: { white: 7, pupil: 4, big: true },
    sleepy: { white: 3, pupil: 8 },
    glowing: { white: 5, pupil: 5 },
  };

  // ─── Mouth Styles ───
  const MOUTHS = {
    smile: 9,
    neutral: 3,
    grin: 5,
    fang: 7,
  };

  // ─── Seed-based random (deterministic from companion name/id) ───
  function seededRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    }
    return function() {
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      return (h >> 16) / 32768;
    };
  }

  function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  // ─── Main Generate Function ───
  function generate(options = {}) {
    const {
      name = 'Companion',
      element = null,
      body = null,
      ears = null,
      tail = null,
      accessory = null,
      eyeStyle = null,
      mouthStyle = null,
      seed = null,
    } = options;

    const rng = seededRandom(seed || name);

    // Pick attributes (use provided or random)
    const el = element || pick(rng, Object.keys(PALETTES));
    const palette = PALETTES[el];
    const bodyType = body || pick(rng, Object.keys(BODIES));
    const earType = ears || pick(rng, Object.keys(EARS));
    const tailType = tail || pick(rng, Object.keys(TAILS));
    const accType = accessory || pick(rng, Object.keys(ACCESSORIES));
    const eyeType = eyeStyle || pick(rng, Object.keys(EYES));
    const mouthType = mouthStyle || pick(rng, Object.keys(MOUTHS));

    // Deep copy the body grid
    const grid = BODIES[bodyType].map(row => [...row]);

    // Apply ear overlays
    const earParts = EARS[earType];
    earParts.forEach(part => {
      part.pixels.forEach((row, dy) => {
        row.forEach((val, dx) => {
          if (val && grid[part.y + dy]) {
            grid[part.y + dy][part.x + dx] = val;
          }
        });
      });
    });

    // Apply tail overlays
    const tailParts = TAILS[tailType];
    tailParts.forEach(part => {
      part.pixels.forEach((row, dy) => {
        row.forEach((val, dx) => {
          if (val && grid[part.y + dy] && part.x + dx < 16) {
            grid[part.y + dy][part.x + dx] = val;
          }
        });
      });
    });

    // Apply accessory
    if (ACCESSORIES[accType]) {
      ACCESSORIES[accType](grid);
    }

    // Render to canvas
    const canvas = document.createElement('canvas');
    canvas.width = SPRITE_SIZE;
    canvas.height = SPRITE_SIZE;
    const ctx = canvas.getContext('2d');

    // Color map
    const colorMap = {
      0: null,           // transparent
      1: palette.primary,
      2: palette.secondary,
      3: palette.dark,
      4: palette.light,
      5: palette.accent,
      6: palette.skin,
      7: '#ffffff',       // eye white
      8: '#111111',       // eye pupil
      9: '#ff4466',       // mouth
    };

    // Apply eye style overrides
    const eye = EYES[eyeType];
    colorMap[7] = eye.white === 7 ? '#ffffff' : (typeof eye.white === 'string' ? eye.white : colorMap[eye.white]);
    colorMap[8] = eye.pupil === 8 ? '#111111' : (typeof eye.pupil === 'string' ? eye.pupil : colorMap[eye.pupil]);

    // Apply mouth style
    colorMap[9] = typeof MOUTHS[mouthType] === 'string' ? MOUTHS[mouthType] : colorMap[MOUTHS[mouthType]];

    // Draw pixels
    ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const val = grid[y][x];
        const color = colorMap[val];
        if (color) {
          ctx.fillStyle = color;
          ctx.fillRect(x * PIXEL, y * PIXEL, PIXEL, PIXEL);
        }
      }
    }

    // Add subtle outline/shadow for depth
    ctx.globalCompositeOperation = 'destination-over';
    ctx.shadowColor = palette.primary;
    ctx.shadowBlur = 2;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (grid[y][x] !== 0) {
          ctx.fillStyle = palette.dark;
          ctx.fillRect(x * PIXEL + 1, y * PIXEL + 1, PIXEL, PIXEL);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    return {
      canvas,
      dataUrl: canvas.toDataURL('image/png'),
      attributes: {
        element: el,
        body: bodyType,
        ears: earType,
        tail: tailType,
        accessory: accType,
        eyes: eyeType,
        mouth: mouthType,
      },
      palette,
    };
  }

  // ─── Generate from companion data ───
  function generateForCompanion(companion) {
    return generate({
      name: companion.name || companion.id || 'Unknown',
      seed: companion.id || companion.name,
    });
  }

  // ─── Get all available options ───
  function getOptions() {
    return {
      elements: Object.keys(PALETTES),
      bodies: Object.keys(BODIES),
      ears: Object.keys(EARS),
      tails: Object.keys(TAILS),
      accessories: Object.keys(ACCESSORIES),
      eyes: Object.keys(EYES),
      mouths: Object.keys(MOUTHS),
    };
  }

  return { generate, generateForCompanion, getOptions, PALETTES };
})();

// Export for Node.js (preload) or browser
if (typeof module !== 'undefined') module.exports = SpriteGenerator;
