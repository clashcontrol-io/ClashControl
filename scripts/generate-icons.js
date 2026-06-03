// Regenerates PWA icons from the brand SVG.
// Run once with: NODE_PATH=/tmp/node_modules node scripts/generate-icons.js
// (sharp is not a dependency of the project — install it locally if you need to re-run.)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ACCENT = '#1a6b4a';
const WHITE  = '#ffffff';

// Standard icon: full-bleed, viewBox 0..48
function makeSvg(size, padding) {
  const inset = padding * 48;
  const inner = 48 - inset * 2;
  const innerStart = inset;
  const innerEnd   = inset + inner;
  const sqStart = inset + inner * (10 / 48);
  const sqEnd   = inset + inner * (38 / 48);
  const sqSize  = sqEnd - sqStart;
  const stroke  = Math.max(1.5, inner * (2 / 48));
  const radius  = inner * (8 / 48);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
    <rect x="${innerStart}" y="${innerStart}" width="${inner}" height="${inner}" rx="${radius}" fill="${ACCENT}"/>
    <rect x="${sqStart}" y="${sqStart}" width="${sqSize}" height="${sqSize}" fill="none" stroke="${WHITE}" stroke-width="${stroke}"/>
    <line x1="${sqStart}" y1="${sqEnd}" x2="${sqEnd}" y2="${sqStart}" stroke="${WHITE}" stroke-width="${stroke}"/>
  </svg>`;
}

const outDir = path.join(__dirname, '..', 'icons');
const variants = [
  { file: 'icon-192.png',          size: 192, padding: 0     },
  { file: 'icon-512.png',          size: 512, padding: 0     },
  // Maskable: ~20% safe zone around the logo so Android masks don't crop the mark.
  { file: 'icon-192-maskable.png', size: 192, padding: 0.18  },
  { file: 'icon-512-maskable.png', size: 512, padding: 0.18  },
];

(async () => {
  for (const v of variants) {
    const svg = Buffer.from(makeSvg(v.size, v.padding));
    await sharp(svg).png().toFile(path.join(outDir, v.file));
    console.log('wrote', v.file);
  }
})();
