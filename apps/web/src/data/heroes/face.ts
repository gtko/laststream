/* Calques du visage : tête, oreilles, yeux, sourcils, bouche, masques, coiffures, barbes, accessoires. */
import type { Ctx, HeadId, HairId } from './types';
import { circ, f, ln, mirror, p } from './svg';
import { darken, lighten, mix } from './util';

export const HEAD_PATHS: Record<HeadId, string> = {
  oval: 'M64 27C78 27 87 38 86.5 53C86 68 77 81 64 81C51 81 42 68 41.5 53C41 38 50 27 64 27Z',
  square: 'M64 28C79 28 87 34 86.5 48L85.5 63C84.5 74 76 81 64 81C52 81 43.5 74 42.5 63L41.5 48C41 34 49 28 64 28Z',
  round: 'M64 29C80 29 88 41 87.5 55C87 70 77 80 64 80C51 80 41 70 40.5 55C40 41 48 29 64 29Z',
  pointed: 'M64 27C79 27 87 37 86 51C85 63 78 72 70 78L64 83L58 78C50 72 43 63 42 51C41 37 49 27 64 27Z',
};

export function neckSvg(c: Ctx, color: string): string {
  return p(c, 'M56 68V90C60 95 68 95 72 90V68Z', color) +
    f('M64 68H72V90C70 92.5 67 94 64 94Z', darken(color, 0.16), 'opacity=".55"') +
    // Ombre portée du menton sur le cou.
    f('M56 74C59 82 69 82 72 74V68H56Z', darken(color, 0.28), 'opacity=".55"');
}

export function earsSvg(c: Ctx): string {
  if (c.android) {
    const ear = p(c, 'M40 52H44V64H40C37.5 64 36.5 62 36.5 58C36.5 54 37.5 52 40 52Z', c.skinD, 1.2) + circ(c, 40, 58, 1.6, c.neonColor, 0.8);
    return ear + mirror(ear);
  }
  if (c.elf) {
    const ear = p(c, 'M45 50C38 48 32 44 26 36C28 50 33 61 45 65Z', c.skin) + f('M40 50C36 48 33 46 31 43C33 51 36 56 41 58Z', c.skinD, 'opacity=".4"');
    return ear + mirror(ear);
  }
  const ear = p(c, 'M44 50C37 49 36 53 36.5 57.5C37 63 40 65 44 64Z', c.skin) + f('M42.5 54C40 54 39.5 56 40 58C40.5 60 41.5 61 43 61Z', c.skinD, 'opacity=".55"');
  return ear + mirror(ear);
}

/** Tête : peau, ombre plate côté droit, reflets, joues. */
export function headSvg(c: Ctx): string {
  const d = HEAD_PATHS[c.head];
  let s = p(c, d, c.skin, 1.5);
  s += `<g clip-path="url(#${c.id}h)">` +
    f('M80 26C92 42 92 68 74 84L100 92V20Z', c.skinD, 'opacity=".34"') +
    f('M42 66C46 78 56 86 64 86C56 80 48 76 42 66Z', c.skinD, 'opacity=".18"') +
    '</g>';
  if (!c.android) {
    s += `<ellipse cx="50" cy="66" rx="5" ry="3" fill="#ff5a6a" opacity=".13"/><ellipse cx="78" cy="66" rx="5" ry="3" fill="#ff5a6a" opacity=".1"/>`;
  }
  s += f('M50 35C54 31 60 30 64 30C60 32 55 34 52 40Z', c.skinL, 'opacity=".5"');
  if (c.android) {
    s += ln('M64 28V35', darken(c.skin, 0.35), 1.1) + ln('M45 62C47 70 52 76 58 79', darken(c.skin, 0.3), 1) + ln('M83 62C81 70 76 76 70 79', darken(c.skin, 0.3), 1);
  }
  return s;
}

/** Nez et bouche. */
export function noseMouthSvg(c: Ctx): string {
  if (c.covered || c.mask === 'full') return '';
  const lip = mix(c.skin, '#5a1d22', 0.62);
  let s = ln('M64.5 57C63 61 62 63 64 64.2C65.4 64.8 66.6 64.4 67 63.4', darken(c.skin, 0.32), 1.3);
  if (c.android) {
    return s + ln('M57 71H71', darken(c.skin, 0.4), 1.3) + ln('M59 73.5H69', darken(c.skin, 0.4), 1.1);
  }
  if (c.beard === 'full') return s;
  switch (c.mouth) {
    case 'smile': s += ln('M57.5 70C61 73.5 67 73.5 70.5 70', lip, 1.8); break;
    case 'flat': s += ln('M58.5 71.5H69.5', lip, 1.8); break;
    case 'smirk': s += ln('M58 72C62 72.5 67 71.5 71 68.5', lip, 1.8) + ln('M71 68.5L72 67.5', lip, 1.4); break;
    case 'grin':
      s += p(c, 'M56 69C60 77 68 77 72 69C66 71 62 71 56 69Z', '#ffffff', 1.1) + ln('M56 69C62 71 66 71 72 69', c.ink, 1.3);
      break;
    default:
      s += p(c, 'M60 71C61 77 67 77 68 71C65 72 63 72 60 71Z', mix(lip, '#000000', 0.2), 1) + f('M61.5 72.4C63 73 65 73 66.5 72.4L66 73.4C64.5 74 63.5 74 62 73.4Z', '#ffffff');
  }
  return s;
}

const EYE_Y = 54;
const EYE_X = 53.5;

function eyeShape(c: Ctx, maskedEye: boolean, led: boolean): string {
  const neon = c.neonColor;
  if (led) {
    return `<circle r="6.4" fill="${neon}" opacity=".28"/><circle r="3.5" fill="${neon}" stroke="${c.ink}" stroke-width=".9"/><circle cx="-1" cy="-1.1" r="1.1" fill="#fff"/>`;
  }
  if (maskedEye) {
    const slit = 'M-7 1.2C-3.4 -3.8 3.4 -3.8 7 -.2C3.2 3 -3.4 3.2 -7 1.2Z';
    if (c.neon) return `<ellipse rx="9" ry="5.6" fill="${neon}" opacity=".3"/><path d="${slit}" fill="${neon}" stroke="${c.ink}" stroke-width=".9"/><path d="M-3.4 -.6C-1 -2 2 -2 4 -1" stroke="#fff" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;
    return `<path d="${slit}" fill="#fff" stroke="${c.ink}" stroke-width=".9"/><circle cx="0.6" cy=".1" r="1.9" fill="${c.ink}"/><circle cx="-.1" cy="-.6" r=".7" fill="#fff"/>`;
  }
  const almond = 'M-6.4 .6C-3.6 -4.6 3.6 -4.6 6.4 .6C3.6 4.2 -3.6 4.2 -6.4 .6Z';
  if (c.neon) {
    return `<ellipse rx="9.5" ry="6.4" fill="${neon}" opacity=".26"/><path d="${almond}" fill="${lighten(neon, 0.3)}" stroke="${c.ink}" stroke-width=".9"/><circle r="2.5" fill="${neon}"/><circle cx="-.9" cy="-1" r="1" fill="#fff"/>` +
      `<path d="M-7 .6C-4 -5 4 -5 7 .6" fill="none" stroke="${c.ink}" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  return `<path d="${almond}" fill="#fff" stroke="${c.ink}" stroke-width=".9"/><circle cx=".4" cy=".2" r="2.9" fill="${c.iris}"/><circle cx=".4" cy=".2" r="1.35" fill="${c.ink}"/><circle cx="-.7" cy="-1" r=".95" fill="#fff"/>` +
    `<path d="M-7 .6C-4 -5 4 -5 7 .6" fill="none" stroke="${c.ink}" stroke-width="1.6" stroke-linecap="round"/>`;
}

/** Yeux (et sourcils si le visage est à découvert). */
export function eyesSvg(c: Ctx): string {
  if (c.covered || c.mask === 'visor' || c.mask === 'full') return '';
  const masked = c.mask !== 'none';
  const led = c.android;
  const tilt = c.angry ? 9 : c.mask !== 'none' ? 4 : 0;
  const one = (x: number, flip: boolean): string =>
    `<g transform="translate(${x} ${EYE_Y})${flip ? ' scale(-1 1)' : ''} rotate(${tilt})">${eyeShape(c, masked, led)}</g>`;
  let s = one(EYE_X, false) + one(128 - EYE_X, true);
  if (c.mask === 'none' && !c.android) {
    const col = c.fam === 'vilains' || c.angry ? darken(c.hair, 0.1) : c.hairD;
    if (c.angry) {
      const brow = `<path d="M-8 -7.2L8 -3.4L7.4 -1L-8 -5Z" fill="${col}" stroke="${c.ink}" stroke-width=".8" stroke-linejoin="round"/>`;
      s += `<g transform="translate(${EYE_X} ${EYE_Y})">${brow}</g><g transform="translate(${128 - EYE_X} ${EYE_Y}) scale(-1 1)">${brow}</g>`;
    } else {
      const brow = ln('M-7.5 -7C-4 -9.4 2.5 -9.4 7.5 -7.4', col, 2.6);
      s += `<g transform="translate(${EYE_X} ${EYE_Y})">${brow}</g><g transform="translate(${128 - EYE_X} ${EYE_Y}) scale(-1 1)">${brow}</g>`;
    }
  }
  if (c.android) {
    s += ln('M46 47.5H60', darken(c.skin, 0.35), 1) + ln('M68 47.5H82', darken(c.skin, 0.35), 1);
  }
  return s;
}

/** Masques : loup, demi-masque, cagoule intégrale, visière. */
export function maskSvg(c: Ctx): string {
  const fill = c.maskC;
  const hi = lighten(fill, 0.35);
  switch (c.mask) {
    case 'wolf':
      return p(c, 'M41 37L52 46C57 44.5 61 46 64 49.5C67 46 71 44.5 76 46L87 37L88 56C85 63.5 77 65 70.5 61C67.5 59 66 57.5 64 57.5C62 57.5 60.5 59 57.5 61C51 65 43 63.5 40 56Z', fill, 1.5) +
        f('M44 40.5L50 46.5C53 46 55 46 57 46.5L47 41Z', hi, 'opacity=".55"') +
        f('M76 46.5L84 40L86.5 46L81 54Z', darken(fill, 0.3), 'opacity=".35"');
    case 'half':
      return `<g clip-path="url(#${c.id}h)">` + p(c, 'M30 30H98V63C88 69.5 77 63 64 68.5C51 63 40 69.5 30 63Z', fill, 1.5) +
        f('M44 40C52 37 62 36.5 70 38C60 39 52 42 46 46Z', hi, 'opacity=".5"') +
        f('M84 36C88 44 88 56 86 63C82 66 78 66 74 64.5Z', darken(fill, 0.3), 'opacity=".4"') + '</g>';
    case 'full': {
      const fins = c.fins
        ? p(c, 'M44 40L35 22L52 32Z', fill, 1.4) + p(c, 'M84 40L93 22L76 32Z', fill, 1.4)
        : '';
      return fins + p(c, HEAD_PATHS[c.head], fill, 1.6) +
        `<g clip-path="url(#${c.id}h)">` + f('M80 26C92 42 92 68 74 84L100 92V20Z', darken(fill, 0.35), 'opacity=".45"') + '</g>' +
        f('M48 34C54 30 60 29.5 66 30C58 32 52 36 49 42Z', hi, 'opacity=".5"') +
        ln('M57 72C61 74 67 74 71 72', darken(fill, 0.45), 1.3, 'opacity=".75"') +
        f('M64 55L60.5 65C62.5 66.6 65.5 66.6 67.5 65Z', darken(fill, 0.25), 'opacity=".45"') +
        ln('M47 46C52 43 58 43 62 46', darken(fill, 0.45), 1.4, 'opacity=".7"') + ln('M81 46C76 43 70 43 66 46', darken(fill, 0.45), 1.4, 'opacity=".7"') +
        p(c, 'M44 52C48 47 58 46 62 50L61 58C55 62 47 61 44 56Z', darken(fill, 0.5), 1.1) +
        p(c, 'M84 52C80 47 70 46 66 50L67 58C73 62 81 61 84 56Z', darken(fill, 0.5), 1.1) +
        // Yeux en fente lumineuse dans la cagoule.
        eyeSlot(c, 53, 54, false) + eyeSlot(c, 75, 54, true);
    }
    case 'visor': {
      // Visière enveloppante teintée avec barre lumineuse.
      const tint = c.neonColor;
      return p(c, 'M40 44.5C40 40.5 48 39.5 64 39.5C80 39.5 88 40.5 88 44.5L87.5 56C86.5 62.5 80 64.5 74 62.5C70 61 67.5 58.5 64 58.5C60.5 58.5 58 61 54 62.5C48 64.5 41.5 62.5 40.5 56Z', darken(tint, 0.62), 1.5) +
        f('M43 44.5C44 42.5 52 42 64 42C76 42 84 42.5 85 44.5C84 46 76 46.8 64 46.8C52 46.8 44 46 43 44.5Z', tint, 'opacity=".28"') +
        `<rect x="44.5" y="50.5" width="39" height="4.2" rx="2.1" fill="${tint}" opacity=".35"/>` +
        `<rect x="46" y="51.5" width="36" height="2.4" rx="1.2" fill="${lighten(tint, 0.45)}"/>` +
        f('M44 59.5C46 62 50 62.6 54 61.5L52 58.5C49 59.5 46 59.5 44 59.5Z', lighten(tint, 0.3), 'opacity=".3"') +
        ln('M47 41.8C51 41 55 40.8 59 41', '#ffffff', 1.4, 'opacity=".8"');
    }
    default:
      return '';
  }
}


function eyeSlot(c: Ctx, x: number, y: number, flip: boolean): string {
  const col = c.neon ? c.neonColor : '#ffffff';
  const slit = 'M-6.4 1.2C-3 -3.2 3 -3.2 6.4 -.4C3 2.6 -3 2.8 -6.4 1.2Z';
  return `<g transform="translate(${x} ${y})${flip ? ' scale(-1 1)' : ''} rotate(${c.angry ? 10 : 5})">` +
    (c.neon ? `<ellipse rx="9" ry="5.4" fill="${col}" opacity=".3"/>` : '') +
    `<path d="${slit}" fill="${col}" stroke="${c.ink}" stroke-width=".9"/>` +
    (c.neon ? '' : `<circle cx=".6" cy=".1" r="1.8" fill="${c.ink}"/><circle cx="-.1" cy="-.6" r=".7" fill="#fff"/>`) + '</g>';
}

const SHINE = (c: Ctx, d: string): string => ln(d, c.hairL, 1.4, 'opacity=".7"');

/** Cheveux derrière la tête (et par-dessus le buste : longs, afro, queue de cheval). */
export function hairBackSvg(c: Ctx): string {
  switch (c.hairStyle) {
    case 'long':
      return p(c, 'M40 48C32 68 33 94 42 112L50 106L84 106L88 112C96 94 97 68 88 48Z', c.hairD, 1.4) +
        f('M82 60C88 76 88 96 86 108L90 112C96 94 97 74 90 54Z', darken(c.hair, 0.55), 'opacity=".5"');
    case 'afro':
      return [[64, 33, 26], [41, 42, 14], [87, 42, 14], [49, 22, 14], [79, 22, 14], [64, 14, 14]]
        .map(([x, y, r]) => circ(c, x as number, y as number, r as number, c.hair, 1.3)).join('') +
        f('M86 30C94 36 96 48 88 56C92 46 91 38 86 30Z', c.hairD, 'opacity=".5"');
    case 'ponytail':
      return p(c, 'M80 36C100 36 108 56 100 82C98 90 92 94 90 100C94 86 90 74 84 60Z', c.hairD, 1.4) +
        f('M84 40C98 42 103 58 98 76C97 64 92 52 84 44Z', c.hair, 'opacity=".9"') +
        p(c, 'M80 36L88 40L86 46L78 42Z', c.acc, 1);
    default:
      return '';
  }
}

const HAIR_FRONT: Record<HairId, (c: Ctx) => string> = {
  crop: (c) => p(c, 'M41 52C37 31 50 20 64 20C79 20 91 32 87 52C86 46 84 41 80 38C70 42 58 41 49 36C45 40 43 45 41 52Z', c.hair, 1.4) + SHINE(c, 'M52 27C57 24 63 23.5 68 24'),
  quiff: (c) => p(c, 'M41 52C36 36 42 18 60 13C70 10 84 13 87 25C90 33 89 44 87 52C85 44 82 38 78 35C68 38 56 36 49 33C45 38 43 45 41 52Z', c.hair, 1.4) +
    SHINE(c, 'M52 22C58 17 66 15.5 74 17') + f('M80 20C86 22 88 28 87 34C85 28 83 24 80 20Z', c.hairD, 'opacity=".5"'),
  spiky: (c) => p(c, 'M41 52C38 41 39 33 43 29L40 16L51 24L55 8L62 21L72 6L76 21L88 14L85 29C89 35 89 44 87 52C85 45 83 41 80 38C70 42 58 41 49 36C45 40 43 46 41 52Z', c.hair, 1.4) +
    SHINE(c, 'M50 28C56 24 62 22 68 22'),
  long: (c) => p(c, 'M41 56C36 34 47 18 64 18C81 18 92 34 87 56C86 47 83 40 78 37C72 42 60 42 52 35C47 40 43 46 41 56Z', c.hair, 1.4) + SHINE(c, 'M50 26C56 21 64 20 71 21'),
  sweep: (c) => p(c, 'M40 56C35 34 46 17 64 17C81 17 92 31 87 54C85 44 80 36 70 33C64 41 52 42 42 48Z', c.hair, 1.4) +
    SHINE(c, 'M48 27C54 21 62 19 70 20') + ln('M62 24C58 30 52 35 46 38', c.hairD, 1.1, 'opacity=".6"'),
  mohawk: (c) => f('M44 42C50 29 60 27 64 27C68 27 78 29 84 42C80 36 72 32 64 32C56 32 48 36 44 42Z', c.hairD, 'opacity=".55"') +
    p(c, 'M55 30C52 18 54 8 64 3C74 8 76 18 73 30C70 27 58 27 55 30Z', c.hair, 1.4) + SHINE(c, 'M60 22C60 16 62 11 64 8'),
  afro: (c) => f('M44 46C48 36 58 33 64 33C70 33 80 36 84 46C80 42 72 39 64 39C56 39 48 42 44 46Z', c.hair),
  bun: (c) => circ(c, 64, 14, 9, c.hair, 1.4) + p(c, 'M41 52C37 31 50 20 64 20C79 20 91 32 87 52C86 46 84 41 80 38C70 42 58 41 49 36C45 40 43 45 41 52Z', c.hair, 1.4) +
    p(c, 'M55 22C60 25 68 25 73 22L72 26C68 28 60 28 56 26Z', c.acc, 1) + SHINE(c, 'M60 11C62 9.5 66 9.5 68 11'),
  buzz: (c) => f('M42 50C40 34 50 26 64 26C78 26 88 34 86 50C84 42 80 38 76 36C68 38 60 38 52 36C48 38 44 44 42 50Z', c.hair, 'opacity=".78"'),
  bald: (c) => f('M52 33C57 29.5 63 29 68 29.6C62 31 57 34 54 38Z', '#ffffff', 'opacity=".28"'),
  ponytail: (c) => p(c, 'M41 52C37 31 50 20 64 20C79 20 91 32 87 52C86 46 84 41 80 38C70 42 58 41 49 36C45 40 43 45 41 52Z', c.hair, 1.4) + SHINE(c, 'M52 27C57 24 63 23.5 68 24'),
};

export const hairFrontSvg = (c: Ctx): string => HAIR_FRONT[c.hairStyle](c);

/** Barbes : bouc (méchants) ou grande barbe blanche (mages). */
export function beardSvg(c: Ctx): string {
  if (c.beard === 'none' || c.covered || c.mask === 'full') return '';
  const col = c.beard === 'full' ? c.hair : c.hairD;
  if (c.beard === 'goatee') {
    return p(c, 'M55 67.5C60 65 63 68 64 68C65 68 68 65 73 67.5C70 71.5 66 70.5 64 70.5C62 70.5 58 71.5 55 67.5Z', col, 1) +
      p(c, 'M59 74C60 81 68 81 69 74C67 76.5 61 76.5 59 74Z', col, 1);
  }
  return p(c, 'M43 56C42 74 52 92 64 101C76 92 86 74 85 56C82 67 74 71 64 71C54 71 46 67 43 56Z', col, 1.4) +
    f('M64 72C70 72 78 70 83 62C80 78 74 92 64 100Z', darken(col, 0.18), 'opacity=".5"') +
    p(c, 'M53 67C58 64.5 62 67.5 64 67.5C66 67.5 70 64.5 75 67C71 72 67 70 64 70C61 70 57 72 53 67Z', col, 1) +
    ln('M56 82C58 88 61 91 64 93', lighten(col, 0.4), 1.1, 'opacity=".6"');
}

/** Accessoires : oreillette, cicatrice, lunettes, lunettes de soleil, boucle d'oreille. */
export function accessorySvg(c: Ctx): string {
  switch (c.accessory) {
    case 'headset':
      return p(c, 'M44 50C38 50 36 54 36.5 58C37 63 40 65 44 64Z', c.sec, 1.3) + circ(c, 40.5, 57, 1.6, c.acc, 0.8) +
        ln('M40 64C41 73 50 77 58 74', c.ink, 1.8) + circ(c, 58.5, 74, 2.1, c.acc, 1);
    case 'scar': {
      const col = mix(c.skin, '#b0303a', 0.5);
      const y = c.mask === 'none' ? 0 : 18;
      return ln(`M73 ${42 + y}L80 ${62 + y}`, col, 1.9) + ln(`M71.5 ${49 + y}L76.5 ${47 + y}`, col, 1.3) + ln(`M74.5 ${56 + y}L79.5 ${54 + y}`, col, 1.3);
    }
    case 'glasses': {
      const frame = c.ink;
      return `<circle cx="53.5" cy="54" r="7.6" fill="${c.acc}" fill-opacity=".22" stroke="${frame}" stroke-width="1.8"/><circle cx="74.5" cy="54" r="7.6" fill="${c.acc}" fill-opacity=".22" stroke="${frame}" stroke-width="1.8"/>` +
        ln('M61 53C63 51.5 65 51.5 67 53', frame, 1.8) + ln('M46 53L42 51.5', frame, 1.6) + ln('M82 53L86 51.5', frame, 1.6) +
        ln('M49 50.5C50.5 49.2 52.5 49 54 49.4', '#ffffff', 1.1, 'opacity=".8"');
    }
    case 'shades':
      return p(c, 'M43 48.5C43 46.8 46 46.4 53 46.4C58 46.4 61 47 64 48.5C67 47 70 46.4 75 46.4C82 46.4 85 46.8 85 48.5C85 57 80 62 73 62C68 62 66.5 58 64 58C61.5 58 60 62 55 62C48 62 43 57 43 48.5Z', '#151823', 1.4) +
        ln('M47 49.5L52 54.5', c.acc, 1.5, 'opacity=".85"') + ln('M70 49.5L75 54.5', c.acc, 1.5, 'opacity=".85"');
    case 'earring':
      return `<circle cx="40.2" cy="64.6" r="2.6" fill="none" stroke="#f5b700" stroke-width="1.5"/>`;
    default:
      return '';
  }
}
