// Regenerates og-image.png from an inline SVG.
// Run with: NODE_PATH=/tmp/node_modules node scripts/generate-og-image.js
// (sharp is not a project dependency — install locally if you need to re-run.)
const sharp = require('sharp');
const path = require('path');

const W = 1200, H = 630;
const ACCENT = '#1a6b4a';
const INK    = '#0f172a';
const MUTED  = '#475569';
const PAPER  = '#fafaf5';
const PANEL  = '#ffffff';
const BORDER = '#e2e8f0';
const RED    = '#dc2626';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>

  <!-- subtle diagonal grid mark in the background -->
  <g opacity="0.04" stroke="${INK}" stroke-width="1" fill="none">
    <path d="M0 80 L1200 80 M0 160 L1200 160 M0 240 L1200 240 M0 320 L1200 320 M0 400 L1200 400 M0 480 L1200 480 M0 560 L1200 560"/>
  </g>

  <!-- Logo + wordmark -->
  <g transform="translate(72,72)">
    <rect width="56" height="56" rx="10" fill="${ACCENT}"/>
    <rect x="11" y="11" width="34" height="34" fill="none" stroke="#ffffff" stroke-width="2.5"/>
    <line x1="11" y1="45" x2="45" y2="11" stroke="#ffffff" stroke-width="2.5"/>
    <text x="74" y="38" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="34" fill="${INK}" letter-spacing="-0.5">ClashControl</text>
  </g>

  <text x="72" y="158" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="14" fill="${MUTED}" letter-spacing="2">FREE  ·  OPEN SOURCE  ·  BROWSER-NATIVE</text>

  <!-- Headline -->
  <text x="72" y="252" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="68" fill="${INK}" letter-spacing="-2">IFC Clash Detection.</text>
  <text x="72" y="332" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="68" fill="${INK}" letter-spacing="-2">Free. In your browser.</text>

  <!-- Subline -->
  <text x="72" y="388" font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="26" fill="${MUTED}">No install. No licence fee. No Navisworks.</text>

  <!-- Feature pills -->
  <g font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="500" fill="${INK}">
    <g transform="translate(72,442)">
      <rect width="170" height="42" rx="21" fill="${PANEL}" stroke="${BORDER}"/>
      <circle cx="20" cy="21" r="5" fill="${ACCENT}"/>
      <text x="34" y="27">Clash detection</text>
    </g>
    <g transform="translate(254,442)">
      <rect width="140" height="42" rx="21" fill="${PANEL}" stroke="${BORDER}"/>
      <circle cx="20" cy="21" r="5" fill="${ACCENT}"/>
      <text x="34" y="27">BCF export</text>
    </g>
    <g transform="translate(406,442)">
      <rect width="120" height="42" rx="21" fill="${PANEL}" stroke="${BORDER}"/>
      <circle cx="20" cy="21" r="5" fill="${ACCENT}"/>
      <text x="34" y="27">AI triage</text>
    </g>
    <g transform="translate(538,442)">
      <rect width="135" height="42" rx="21" fill="${PANEL}" stroke="${BORDER}"/>
      <circle cx="20" cy="21" r="5" fill="${ACCENT}"/>
      <text x="34" y="27">Walk mode</text>
    </g>
    <g transform="translate(72,498)">
      <rect width="190" height="42" rx="21" fill="${PANEL}" stroke="${BORDER}"/>
      <circle cx="20" cy="21" r="5" fill="${ACCENT}"/>
      <text x="34" y="27">Floor plan + DXF</text>
    </g>
    <g transform="translate(274,498)">
      <rect width="190" height="42" rx="21" fill="${PANEL}" stroke="${BORDER}"/>
      <circle cx="20" cy="21" r="5" fill="${ACCENT}"/>
      <text x="34" y="27">Natural language</text>
    </g>
    <g transform="translate(476,498)">
      <rect width="155" height="42" rx="21" fill="${PANEL}" stroke="${BORDER}"/>
      <circle cx="20" cy="21" r="5" fill="${ACCENT}"/>
      <text x="34" y="27">Offline PWA</text>
    </g>
  </g>

  <!-- Pricing comparison card (right side) -->
  <g transform="translate(770,210)">
    <rect width="360" height="240" rx="14" fill="${PANEL}" stroke="${BORDER}" stroke-width="1.5"/>
    <text x="24" y="42" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="600" fill="${MUTED}" letter-spacing="1.5">COST PER YEAR</text>
    <line x1="24" y1="58" x2="336" y2="58" stroke="${BORDER}"/>
    <text x="24" y="106" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="500" fill="${INK}">Navisworks</text>
    <text x="336" y="106" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="${RED}" text-anchor="end">$6,600 / seat</text>
    <line x1="24" y1="132" x2="336" y2="132" stroke="${BORDER}"/>
    <text x="24" y="178" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="${INK}">ClashControl</text>
    <text x="336" y="178" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="800" fill="${ACCENT}" text-anchor="end">$0</text>
    <text x="180" y="216" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="${MUTED}" text-anchor="middle">No credit card. No trial.</text>
  </g>

  <!-- Footer URL -->
  <text x="1128" y="588" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="600" fill="${MUTED}" text-anchor="end">clashcontrol.io</text>
  <text x="72" y="588" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="${MUTED}">Open source on GitHub · github.com/clashcontrol-io</text>
</svg>`;

(async () => {
  await sharp(Buffer.from(svg)).png().toFile(path.join(__dirname, '..', 'og-image.png'));
  console.log('wrote og-image.png (1200x630)');
})();
