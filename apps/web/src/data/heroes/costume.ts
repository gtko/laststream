/* Calques du costume : buste, armure, cape / col, emblème de poitrine, casques et couvre-chefs. */
import type { ArmorId, Ctx, EmblemId } from './types';
import { circ, f, ln, p, both } from './svg';
import { darken, lighten, n2 } from './util';

export const TORSO_PATH = 'M6 128C6 106 24 94 46 91C52 96 58 99 64 99C70 99 76 96 82 91C104 94 122 106 122 128Z';

/** Buste en costume : ombre plate, reflet d'épaule, liseré de col. */
export function torsoSvg(c: Ctx): string {
  return p(c, TORSO_PATH, c.main, 1.5) +
    `<g clip-path="url(#${c.id}t)">` +
    f('M84 90C106 94 124 106 124 128H98C100 112 94 100 84 90Z', c.mainD, 'opacity=".55"') +
    f('M10 120C12 106 26 97 42 94L44 99C32 102 20 108 16 124Z', c.mainL, 'opacity=".4"') +
    '</g>' +
    p(c, 'M46 91C52 96 58 99 64 99C70 99 76 96 82 91L80 95.5C75 101 70 103 64 103C58 103 53 101 48 95.5Z', c.sec, 1.2);
}

const STEEL = (c: Ctx): string => `url(#${c.id}m)`;

const ARMOR: Record<ArmorId, (c: Ctx) => string> = {
  plain: (c) => ln('M42 104C40 112 40 120 42 128', c.mainD, 1.4, 'opacity=".7"') + ln('M86 104C88 112 88 120 86 128', c.mainD, 1.4, 'opacity=".7"') +
    ln('M20 112C26 108 32 106 38 106', c.mainL, 1.4, 'opacity=".6"'),
  pauldrons: (c) => both(
    p(c, 'M4 116C2 100 12 90 28 90C38 90 44 96 44 104C34 98 20 100 12 118Z', c.sec, 1.4) +
    f('M9 104C12 96 20 92 28 92C20 96 14 100 11 108Z', c.secL, 'opacity=".55"') + ln('M8 114C14 104 26 100 40 102', c.secD, 1.2, 'opacity=".7"')),
  spikes: (c) => both(
    p(c, 'M4 116C2 102 12 92 28 92C38 92 44 98 44 106C34 100 20 102 12 118Z', STEEL(c), 1.4) +
    p(c, 'M16 96L10 80L24 92Z', STEEL(c), 1.2) + p(c, 'M26 92L24 74L34 90Z', STEEL(c), 1.2) + p(c, 'M10 106L-1 96L13 98Z', STEEL(c), 1.2)),
  plate: (c) => p(c, 'M30 96C40 100 50 103 64 103C78 103 88 100 98 96L104 128H24Z', c.sec, 1.4) +
    f('M64 103L98 96L104 128H88Z', c.secD, 'opacity=".5"') +
    ln('M64 103V128', c.secD, 1.3) + ln('M40 104L36 128', c.secL, 1.3, 'opacity=".7"') + ln('M88 104L92 128', c.secD, 1.2, 'opacity=".7"'),
  harness: (c) => p(c, 'M28 94L44 91L100 128H80Z', c.sec, 1.3) + p(c, 'M100 94L84 91L28 128H48Z', c.secD, 1.3) +
    circ(c, 64, 111, 5, c.acc, 1.2) + circ(c, 64, 111, 2, c.secD, 0),
  scales: (c) => `<g clip-path="url(#${c.id}t)"><rect y="103" width="128" height="25" fill="url(#${c.id}s)"/></g>` +
    ln('M12 112C22 105 34 103 46 103', c.secL, 1.3, 'opacity=".5"'),
  gorget: (c) => p(c, 'M40 92C44 102 84 102 88 92L90 100C84 110 44 110 38 100Z', STEEL(c), 1.4) +
    ln('M44 98C54 105 74 105 84 98', lighten(c.steel, 0.5), 1.2, 'opacity=".7"') + circ(c, 64, 105, 2.2, c.acc, 0.9),
};

export const armorSvg = (c: Ctx): string => ARMOR[c.armor](c);

/** Cape ou col derrière le buste. */
export function capeBackSvg(c: Ctx): string {
  switch (c.cape) {
    case 'cape':
      return p(c, 'M30 94C14 104 3 116 0 128H128C125 116 114 104 98 94Z', c.acc, 1.5) +
        f('M98 94C114 104 125 116 128 128H112C110 116 106 104 98 94Z', c.accD, 'opacity=".6"') +
        ln('M18 108C14 114 10 120 8 128', c.accD, 1.3, 'opacity=".7"') + ln('M110 108C114 114 118 120 120 128', c.accD, 1.3, 'opacity=".7"');
    case 'highcollar':
      return both(p(c, 'M50 92L40 56L30 44C28 62 30 78 38 90Z', c.sec, 1.4) + f('M47 90L40 62L36 54C36 68 38 80 42 90Z', c.acc, 'opacity=".9"'));
    case 'cloak':
      return p(c, 'M26 94C12 104 4 118 4 128H124C124 118 116 104 102 94Z', c.secD, 1.5) + f('M102 94C116 104 124 118 124 128H110C110 114 108 104 102 94Z', darken(c.secD, 0.3), 'opacity=".5"');
    default:
      return '';
  }
}

/** Col / écharpe / fourrure par-dessus le buste. */
export function capeFrontSvg(c: Ctx): string {
  switch (c.cape) {
    case 'scarf':
      return p(c, 'M80 100L94 104L98 128L84 124Z', c.acc, 1.3) + f('M90 104L98 128L92 126Z', c.accD, 'opacity=".6"') +
        p(c, 'M44 88C54 99 74 99 84 88L86 96C74 108 54 108 42 96Z', c.acc, 1.4) + ln('M48 96C56 103 72 103 80 96', c.accD, 1.3, 'opacity=".7"');
    case 'fur': {
      const fur = '#f1ebdd';
      let d = 'M28 96Q64 84 100 96';
      const N = 9;
      for (let i = 1; i <= N; i += 1) {
        const t = i / N;
        const x = 100 - t * 72;
        const y = 96 + Math.sin(t * Math.PI) * 9;
        d += `A5.6 5.6 0 0 1 ${n2(x)} ${n2(y)}`;
      }
      return p(c, d + 'Z', fur, 1.4) + f('M30 97Q64 87 98 97Q64 94 30 97Z', darken(fur, 0.2), 'opacity=".6"') +
        ln('M40 103C52 108 76 108 88 103', darken(fur, 0.22), 1.1, 'opacity=".6"');
    }
    case 'turtleneck':
      return p(c, 'M52 80H76V92C72 97 56 97 52 92Z', c.sec, 1.4) + ln('M53 85C60 89 68 89 75 85', c.secD, 1.3, 'opacity=".7"') + ln('M53 90C60 94 68 94 75 90', c.secD, 1.2, 'opacity=".6"');
    case 'cloak':
      return p(c, 'M30 94C34 104 48 110 64 110C80 110 94 104 98 94L84 92C80 100 72 104 64 104C56 104 48 100 44 92Z', c.sec, 1.4) +
        circ(c, 64, 106, 3.8, c.acc, 1.1) + f('M62.4 104.4h3.2v3.2h-3.2Z', c.accD, 'opacity=".5"');
    default:
      return '';
  }
}

// ---------------------------------------------------------------- Emblèmes de poitrine (abstraits, originaux)

const star = (r1: number, r2: number): string => {
  let d = '';
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? r2 : r1;
    d += (i ? 'L' : 'M') + n2(Math.cos(a) * r) + ' ' + n2(Math.sin(a) * r);
  }
  return d + 'Z';
};
const hex = (r: number): string => {
  let d = '';
  for (let i = 0; i < 6; i += 1) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    d += (i ? 'L' : 'M') + n2(Math.cos(a) * r) + ' ' + n2(Math.sin(a) * r);
  }
  return d + 'Z';
};

const EMBLEM: Record<EmblemId, (c: Ctx) => string> = {
  bolt: (c) => p(c, 'M3 -10L-6 1.5H-.5L-3 10L7 -2.5H1.5Z', c.acc, 1.2),
  star: (c) => p(c, star(10, 4.4), c.acc, 1.2),
  flame: (c) => p(c, 'M0 -11C3.5 -5.5 8 -2 8 3.5C8 8 4.5 11 0 11C-4.5 11 -8 8 -8 3.5C-8 .5 -6 -2 -4.5 -4C-3.5 -2 -2.5 -1 -1.2 -.8C-1.4 -5 -1 -8 0 -11Z', c.acc, 1.2) +
    f('M0 2C2.4 4 3.6 6 3.6 7.6C3.6 9.4 2 10.4 0 10.4C-2 10.4 -3.6 9.4 -3.6 7.6C-3.6 6 -2.4 4 0 2Z', c.accD, 'opacity=".6"'),
  wave: (c) => ln('M-10 -5C-7 -9 -4 -9 -1 -5S5 -1 10 -5', c.acc, 3) + ln('M-10 2C-7 -2 -4 -2 -1 2S5 6 10 2', c.acc, 3) + ln('M-10 9C-7 5 -4 5 -1 9S5 13 10 9', c.acc, 3, 'opacity=".75"'),
  diamond: (c) => p(c, 'M0 -11L9 0L0 11L-9 0Z', c.acc, 1.2) + f('M0 -5L4.2 0L0 5L-4.2 0Z', c.accD, 'opacity=".75"'),
  rings: (c) => `<circle r="9" fill="none" stroke="${c.ink}" stroke-width="5.4"/><circle r="9" fill="none" stroke="${c.acc}" stroke-width="3.4"/>` + circ(c, 0, 0, 3.2, c.acc, 1),
  triangle: (c) => p(c, 'M0 -10L10 8H-10Z', c.acc, 1.2) + f('M0 -2.5L4.2 5H-4.2Z', c.accD, 'opacity=".75"'),
  hexagon: (c) => p(c, hex(10.5), c.acc, 1.2) + f(hex(5), c.accD, 'opacity=".75"'),
  crescent: (c) => p(c, 'M3 -10A10.5 10.5 0 1 0 3 10A8 8 0 1 1 3 -10Z', c.acc, 1.2),
  sparkle: (c) => p(c, 'M0 -12C1 -4 3.5 -1.5 12 0C3.5 1.5 1 4 0 12C-1 4 -3.5 1.5 -12 0C-3.5 -1.5 -1 -4 0 -12Z', c.acc, 1.2),
  chevrons: (c) => ln('M-9 -8L0 -1L9 -8', c.acc, 3.2) + ln('M-9 0L0 7L9 0', c.acc, 3.2) + ln('M-9 8L0 15L9 8', c.acc, 3.2, 'opacity=".5"'),
  orbit: (c) => ['0', '60', '-60'].map((a) => `<ellipse rx="11" ry="4.4" fill="none" stroke="${c.acc}" stroke-width="1.9" transform="rotate(${a})"/>`).join('') + circ(c, 0, 0, 3, c.acc, 1),
  blades: (c) => p(c, 'M-11 -3L-1.5 0L-11 3Z', c.acc, 1) + p(c, 'M11 -3L1.5 0L11 3Z', c.acc, 1) + p(c, 'M-3 -11L0 -1.5L3 -11Z', c.acc, 1) + p(c, 'M-3 11L0 1.5L3 11Z', c.acc, 1),
};

export function emblemSvg(c: Ctx): string {
  const back = c.backing ? circ(c, 0, 0, 13.5, c.mainD, 1.3) + `<circle r="11.4" fill="none" stroke="${c.acc}" stroke-width=".9" opacity=".7"/>` : '';
  const k = c.backing ? 0.8 : 0.95;
  return `<g transform="translate(64 114) scale(${k})">${back}<g transform="scale(${c.backing ? 0.78 : 1})">${EMBLEM[c.emblem](c)}</g></g>`;
}

// ---------------------------------------------------------------- Couvre-chefs

/** Éléments derrière la tête (capuche). */
export function headgearBackSvg(c: Ctx): string {
  if (c.headgear === 'hood' || c.headgear === 'archerhood') {
    const col = c.headgear === 'hood' ? c.main : c.sec;
    return p(c, 'M32 98C26 72 28 40 48 24C56 18 72 18 80 24C100 40 102 72 96 98Z', darken(col, 0.08), 1.5) +
      f('M80 24C100 40 102 72 96 98L88 98C94 72 92 44 80 24Z', darken(col, 0.4), 'opacity=".45"');
  }
  if (c.headgear === 'wizhat') return '';
  return '';
}

export function headgearFrontSvg(c: Ctx): string {
  const metal = STEEL(c);
  switch (c.headgear) {
    case 'headband':
      return p(c, 'M41 44C48 38 80 38 87 44L87.5 49.5C80 44 48 44 40.5 49.5Z', c.acc, 1.3) + p(c, 'M86 43L98 40L94 48L99 56L87 49Z', c.acc, 1.1) + ln('M45 45C54 41.5 74 41.5 83 45', c.accD, 1, 'opacity=".6"');
    case 'goggles':
      return ln('M41 38C52 31 76 31 87 38', c.ink, 3.4) + ln('M41 38C52 31 76 31 87 38', c.sec, 1.8) +
        both(`<circle cx="54" cy="34.4" r="6.6" fill="${c.ink}"/><circle cx="54" cy="34.4" r="5" fill="${c.acc}"/><path d="M50.6 32.6C52 31 54 30.6 55.6 31" stroke="#fff" stroke-width="1.1" fill="none" stroke-linecap="round" opacity=".85"/>`);
    case 'crest':
      return p(c, 'M40 56C35 30 48 15 64 15C80 15 93 30 88 56L83 56C83.5 45 80 36 75 33C68 37.5 60 37.5 53 33C48 36 44.5 45 45 56Z', c.main, 1.5) +
        p(c, 'M60.5 15L67.5 15L66 33C65 35 63 35 62 33Z', c.acc, 1.2) +
        both(p(c, 'M39 46H46.5L47 64C44 66 41 65 39.5 62Z', c.sec, 1.3)) +
        f('M50 24C55 19 61 18 66 18.4C58 20 53 25 51 31Z', c.mainL, 'opacity=".55"');
    case 'horns':
      return both(p(c, 'M47 38C34 36 26 24 28 6C32 17 41 22 54 25Z', '#efe4c6', 1.4) + f('M44 33C37 31 31 25 29.5 14C34 22 40 26 47 28Z', '#c9b98e', 'opacity=".75"'));
    case 'crown':
      return p(c, 'M43 38L45 21L54 31L58 17L64 29L70 17L74 31L83 21L85 38C77 42 51 42 43 38Z', '#f5b700', 1.4) +
        f('M44 37C52 40.5 76 40.5 84 37L84.6 34C76 38 52 38 43.4 34Z', '#d18f00', 'opacity=".8"') +
        circ(c, 64, 36, 2.4, c.accD === c.acc ? '#ff3b3b' : c.acc, 1) + ln('M50 26L54 31', '#fff2b0', 1.1, 'opacity=".7"');
    case 'hood':
    case 'archerhood': {
      const col = c.headgear === 'hood' ? c.main : c.sec;
      const feather = c.headgear === 'archerhood'
        ? p(c, 'M82 28C94 16 104 8 114 4C110 16 102 26 88 36Z', c.acc, 1.2) + ln('M84 32C96 22 104 14 112 7', c.accD, 1.1)
        : '';
      return p(c, 'M40.5 58C36 36 46 20 64 20C82 20 92 36 87.5 58C87 48 83.5 40 78 36C72 40 56 40 50 36C44.5 40 41 48 40.5 58Z', col, 1.5) +
        f('M78 36C83.5 40 87 48 87.5 58C89 44 86 30 78 24Z', darken(col, 0.4), 'opacity=".45"') +
        ln('M50 26C56 22 62 21 68 21.4', lighten(col, 0.4), 1.3, 'opacity=".6"') + feather;
    }
    case 'astro': {
      return `<circle cx="64" cy="52" r="34" fill="#9fd8ff" fill-opacity=".14"/>` +
        `<circle cx="64" cy="52" r="34" fill="none" stroke="${c.ink}" stroke-width="7"/><circle cx="64" cy="52" r="34" fill="none" stroke="${c.steelL}" stroke-width="4.6"/>` +
        ln('M42 32A28 28 0 0 1 58 24', '#ffffff', 3, 'opacity=".75"') + ln('M62 22.5A29 29 0 0 1 66 22.4', '#ffffff', 2.4, 'opacity=".6"') +
        f('M80 76C88 70 92 62 92 52C95 64 90 76 80 82Z', '#9fd8ff', 'opacity=".28"') +
        p(c, 'M91 40L102 36L104 50L93 52Z', c.acc, 1.1) + circ(c, 98, 43, 1.6, c.accD, 0);
    }
    case 'cyber':
      return `<g clip-path="url(#${c.id}h)">` + p(c, 'M66 24L98 24L98 92L62 92L66 79L60 68L69 60L62 50L71 42L64 34Z', metal, 1.4) +
        f('M70 26L94 26L94 40L72 40Z', '#ffffff', 'opacity=".22"') +
        ln('M74 66L84 70', c.steelD, 1.2) + ln('M76 74L86 77', c.steelD, 1.2) + ln('M70 40V32', c.steelD, 1.1) + '</g>' +
        `<circle cx="74.5" cy="54" r="7" fill="${c.ink}"/><circle cx="74.5" cy="54" r="5.2" fill="${c.neonColor}"/><circle cx="74.5" cy="54" r="2.2" fill="${lighten(c.neonColor, 0.7)}"/>` +
        circ(c, 83, 38, 1.4, c.steelD, 0.7) + circ(c, 83, 70, 1.4, c.steelD, 0.7) +
        ln('M86 46L93 24', c.steelD, 1.5) + circ(c, 93, 23, 2.6, c.neonColor, 1);
    case 'antenna':
      return ln('M64 28V15', c.ink, 3.6) + ln('M64 28V15', c.steel, 1.8) + circ(c, 64, 12, 4.2, c.neonColor, 1.2) + circ(c, 62.8, 10.8, 1.2, '#ffffff', 0) +
        ln('M60 29H68', c.skinD, 1.1);
    case 'greathelm':
      return p(c, 'M40 56C37 30 49 17 64 17C79 17 91 30 88 56L88 70C88 79 77 85 64 85C51 85 40 79 40 70Z', metal, 1.6) +
        f('M76 18C88 28 90 50 88 70C88 79 80 84 72 85C80 74 82 40 76 18Z', c.steelD, 'opacity=".5"') +
        f('M48 28C52 22 58 19.5 64 19.5C57 22 52 28 50 36Z', '#ffffff', 'opacity=".45"') +
        p(c, 'M44 49H84V57H44Z', '#10131c', 1.2) + (c.neon ? `<rect x="49" y="50.5" width="12" height="4.4" rx="2.2" fill="${c.neonColor}"/><rect x="67" y="50.5" width="12" height="4.4" rx="2.2" fill="${c.neonColor}"/>` : '<circle cx="55" cy="53" r="1.7" fill="#fff"/><circle cx="73" cy="53" r="1.7" fill="#fff"/>') +
        ln('M64 20V49', c.steelD, 1.3) + ln('M64 57V85', c.steelD, 1.3) +
        [66, 70, 74, 78].map((y) => `<circle cx="${y - 7}" cy="${y + 1}" r="1" fill="${c.steelD}"/>`).join('') +
        p(c, 'M54 17C48 4 70 -1 84 8C76 8 72 12 72 17Z', c.acc, 1.3);
    case 'openhelm':
      return p(c, 'M40 56C37 30 49 17 64 17C79 17 91 30 88 56L83.5 56C83.5 45 79 35 64 34.5C49 35 44.5 45 44.5 56Z', metal, 1.5) +
        p(c, 'M61.4 33H66.6V57C65.5 59 62.5 59 61.4 57Z', metal, 1.2) +
        both(p(c, 'M40 46H46L47.4 66C44.4 68 41.4 66.4 40.4 63Z', metal, 1.3)) +
        f('M48 26C52 21 58 19.5 64 19.5C57 22 52 27 50 34Z', '#ffffff', 'opacity=".45"') +
        p(c, 'M56 17C54 6 70 2 80 8C74 9 71 12 70 17Z', c.acc, 1.3);
    case 'wizhat': {
      const hat = c.main;
      return p(c, 'M23 41C23 33 42 29 64 29C86 29 105 33 105 41C105 48 86 51 64 51C42 51 23 48 23 41Z', hat, 1.5) +
        f('M23 41C23 48 42 51 64 51C86 51 105 48 105 41C102 46 86 47 64 47C42 47 26 46 23 41Z', c.mainD, 'opacity=".5"') +
        p(c, 'M44 34C48 20 56 8 74 0C70 10 74 16 84 33C74 36 56 36 44 34Z', hat, 1.5) +
        f('M74 0C70 10 74 16 84 33C82 34 80 35 78 35C78 22 76 12 74 0Z', c.mainD, 'opacity=".55"') +
        p(c, 'M45 31.5C56 36 74 36 83 31.5L84 35C74 40 54 40 44 35Z', c.acc, 1.2) +
        `<g transform="translate(64 24)">${p(c, star(5.2, 2.3), c.acc, 0.9)}</g>`;
    }
    default:
      return '';
  }
}
