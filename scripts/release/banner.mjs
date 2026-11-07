// Bannière PNG de release (LAST-1617) : SVG 1280x640 au style Laststream, rendu en PNG par @resvg/resvg-js.
// Usage : node scripts/release/banner.mjs --version 1.0.33 --date 2026-11-07 --highlights highlights.json --out banner.png
// --highlights : fichier JSON contenant un tableau de chaînes (optionnel). Seuls les 5 premiers points sont gardés.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';

const WIDTH = 1280;
const HEIGHT = 640;
const ACCENT = '#ff5a36';
const BACKGROUND = '#0c0b11';
const FONT_FAMILY = 'Plus Jakarta Sans';
const FONT_FILE = fileURLToPath(new URL('../../apps/mobile/android/app/src/main/assets/fonts/PlusJakartaSans.ttf', import.meta.url));
const MAX_HIGHLIGHTS = 5;
const MAX_CHARS = 60;
const FALLBACK_HIGHLIGHT = 'Corrections et améliorations';
const LEFT = 80;
const HIGHLIGHTS_Y = 400;
const HIGHLIGHT_GAP = 42;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Au-delà de max caractères (points de code, pour ne pas couper un caractère composé), garde max - 1 caractères et ajoute « … ».
export function truncate(text, max = MAX_CHARS) {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function formatDateFr(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!month) return String(date);
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function pickHighlights(highlights) {
  const points = (Array.isArray(highlights) ? highlights : [])
    .filter((point) => typeof point === 'string')
    .map((point) => point.trim())
    .filter((point) => point.length > 0)
    .slice(0, MAX_HIGHLIGHTS)
    .map((point) => truncate(point));
  return points.length > 0 ? points : [FALLBACK_HIGHLIGHT];
}

// font-weight : la police embarquée est variable (axe wght 200-800, défaut 400) et resvg 2.6 n'applique que le poids par défaut.
// Les graisses restent indiquées pour un rendu renforcé si le moteur gère l'axe ; le rendu actuel est en graisse 400.
export function buildSvg({ version, date, highlights } = {}) {
  const items = pickHighlights(highlights)
    .map((point, index) => {
      const y = HIGHLIGHTS_Y + index * HIGHLIGHT_GAP;
      return [
        `<circle cx="${LEFT + 7}" cy="${y - 9}" r="6" fill="${ACCENT}"/>`,
        `<text class="highlight" x="${LEFT + 34}" y="${y}" font-size="26" fill="#e9e7f0">${escapeXml(point)}</text>`,
      ].join('\n  ');
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="${FONT_FAMILY}, sans-serif">
  <defs>
    <radialGradient id="halo" cx="1000" cy="170" r="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="${BACKGROUND}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow" cx="0" cy="${HEIGHT}" r="600" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${BACKGROUND}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BACKGROUND}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#halo)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <g fill="none" stroke="${ACCENT}" stroke-opacity="0.22" stroke-width="2">
    <path d="M760 120 C 900 40, 1040 220, 1280 110"/>
    <path d="M760 170 C 920 90, 1060 270, 1280 160"/>
    <path d="M760 220 C 930 140, 1080 320, 1280 210"/>
  </g>
  <rect x="0" y="0" width="${WIDTH}" height="6" fill="${ACCENT}"/>
  <text x="${LEFT}" y="110" font-size="40" font-weight="700" letter-spacing="1" fill="#ffffff">Laststream</text>
  <text x="${LEFT}" y="250" font-size="150" font-weight="800" letter-spacing="-3" fill="#ffffff">v${escapeXml(String(version).replace(/^v/, ''))}</text>
  <text x="${LEFT}" y="300" font-size="30" font-weight="600" fill="${ACCENT}">${escapeXml(formatDateFr(date))}</text>
  <line x1="${LEFT}" y1="345" x2="${WIDTH - LEFT}" y2="345" stroke="#2a2735" stroke-width="2"/>
  ${items}
  <text x="${LEFT}" y="610" font-size="22" font-weight="600" fill="#8c889c">Windows · Android</text>
</svg>`;
}

export function renderPng(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  return Buffer.from(resvg.render().asPng());
}

function readHighlights(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((point) => typeof point === 'string')) {
    throw new Error(`${path} doit contenir un tableau JSON de chaînes.`);
  }
  return parsed;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string' },
      date: { type: 'string' },
      highlights: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  if (!values.version || !values.out) {
    throw new Error('Usage : node scripts/release/banner.mjs --version <x.y.z> --out <fichier.png> [--date AAAA-MM-JJ] [--highlights <fichier.json>]');
  }
  const highlights = values.highlights ? readHighlights(values.highlights) : [];
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  writeFileSync(values.out, renderPng(buildSvg({ version: values.version, date, highlights })));
  console.log(`Bannière écrite : ${resolve(values.out)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { FONT_FILE };
