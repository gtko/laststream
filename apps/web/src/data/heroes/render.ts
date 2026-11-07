/*
 * Générateur maison « laststream-heroes » : portraits de héros originaux en SVG vectoriel (viewBox 0 0 128 128), composés
 * par calques (fond, cape, buste, armure, emblème, tête, masque, yeux, coiffure, casque, accessoires) à partir d'une
 * graine. Déterministe : famille + graine donnent toujours le même dessin. Aucune ressource externe, aucun réseau.
 * Tout est original : emblèmes abstraits, aucun personnage ni logo de franchise.
 */
import {
  ALIEN_SKINS, ANDROID_SKINS, COSTUMES, FANCY_HAIRS, HAIRS, IRISES, NEONS, SKINS, VILLAIN_NEONS, type HeroFamily,
} from './palettes';
import type {
  AccessoryId, ArmorId, BeardId, CapeId, Ctx, EmblemId, HairId, HeadId, HeadgearId, MaskId, MouthId,
} from './types';
import { colorDist, darken, hashStr, lighten, mix, mulberry32, vividness } from './util';
import { HEAD_PATHS, accessorySvg, beardSvg, earsSvg, eyesSvg, hairBackSvg, hairFrontSvg, headSvg, maskSvg, neckSvg, noseMouthSvg } from './face';
import { TORSO_PATH, armorSvg, capeBackSvg, capeFrontSvg, emblemSvg, headgearBackSvg, headgearFrontSvg, torsoSvg } from './costume';

export type { HeroFamily } from './palettes';

export const HERO_FAMILIES: ReadonlyArray<{ id: HeroFamily; label: string }> = [
  { id: 'heros', label: 'Héros' },
  { id: 'vilains', label: 'Vilains' },
  { id: 'scifi', label: 'Sci-fi' },
  { id: 'fantasy', label: 'Fantasy' },
];
export const HERO_FAMILY_IDS: readonly HeroFamily[] = HERO_FAMILIES.map((f) => f.id);

const INK = '#12141d';
const at = <T>(list: readonly T[], u: number): T => list[Math.min(list.length - 1, Math.floor(u * list.length))] as T;

const ALL_HAIR: readonly HairId[] = ['crop', 'quiff', 'spiky', 'long', 'sweep', 'mohawk', 'afro', 'bun', 'buzz', 'bald', 'ponytail'];
const ALL_ARMOR: readonly ArmorId[] = ['plain', 'pauldrons', 'spikes', 'plate', 'harness', 'scales', 'gorget'];
const ALL_EMBLEM: readonly EmblemId[] = ['bolt', 'star', 'flame', 'wave', 'diamond', 'rings', 'triangle', 'hexagon', 'crescent', 'sparkle', 'chevrons', 'orbit', 'blades'];
const HEADS: readonly HeadId[] = ['oval', 'square', 'round', 'pointed'];

/** Hasard : 40 tirages consommés dans un ordre fixe, pour que chaque trait reste stable quand un autre change. */
function draws(fam: HeroFamily, seed: string): number[] {
  const r = mulberry32(hashStr(fam + ':' + seed));
  return Array.from({ length: 40 }, () => r());
}

export function buildHero(fam: HeroFamily, seed: string): Ctx {
  const u = draws(fam, seed);
  const id = 'h' + hashStr(fam + seed).toString(36);
  const costume = at(COSTUMES[fam], u[0] as number);
  let [main, sec, acc] = costume;
  const kit = fam === 'scifi' ? at(['astro', 'cyborg', 'android', 'pilot'], u[20] as number)
    : fam === 'fantasy' ? at(['knight', 'mage', 'archer', 'paladin'], u[20] as number)
      : fam === 'vilains' ? 'villain' : 'hero';

  // Fantasy : palette alignée sur le rôle (acier rouge/bleu pour les chevaliers, violet/vert pour les mages...).
  if (fam === 'fantasy') {
    const roles: Record<string, number[]> = { knight: [0, 1, 6], mage: [2, 3, 7], archer: [4, 5, 3], paladin: [6, 0, 1] };
    const idx = at(roles[kit] as number[], u[0] as number);
    [main, sec, acc] = COSTUMES.fantasy[idx] as readonly [string, string, string];
  }
  if (fam === 'scifi' && kit === 'astro') [main, sec, acc] = at(COSTUMES.scifi.slice(0, 4), u[0] as number);

  let skin = at(SKINS, u[1] as number);
  let android = false;
  let elf = false;
  if (kit === 'android') { skin = at(ANDROID_SKINS, u[1] as number); android = true; }
  else if (fam === 'scifi' && u[2] as number < 0.14) skin = at(ALIEN_SKINS, u[1] as number);
  else if (fam === 'fantasy' && u[2] as number < 0.12) skin = at(ALIEN_SKINS, u[1] as number);
  if (kit === 'archer') elf = (u[19] as number) < 0.55;
  else if (kit === 'mage') elf = (u[19] as number) < 0.3;
  else if (fam === 'fantasy') elf = (u[19] as number) < 0.15;

  const fancy = (u[4] as number) < (fam === 'heros' ? 0.2 : fam === 'scifi' ? 0.3 : 0.08);
  let hair = fancy ? at(FANCY_HAIRS, u[3] as number) : at(HAIRS, u[3] as number);

  const head = at(HEADS, u[6] as number);

  // ---- traits par famille
  let mask: MaskId = 'none';
  let headgear: HeadgearId = 'none';
  let hairStyle: HairId = at(ALL_HAIR, u[5] as number);
  let armor: ArmorId = at(ALL_ARMOR, u[9] as number);
  let cape: CapeId = 'none';
  let accessory: AccessoryId = 'none';
  let mouth: MouthId = at<MouthId>(['smile', 'smile', 'flat', 'grin', 'smirk'], u[13] as number);
  let beard: BeardId = 'none';
  let neon = (u[15] as number) < 0.25;
  let angry = false;
  const emblem = at(ALL_EMBLEM, u[11] as number);
  const acc1 = at<AccessoryId>(['none', 'none', 'headset', 'scar', 'glasses', 'shades', 'earring', 'none'], u[12] as number);

  if (fam === 'heros') {
    mask = at<MaskId>(['wolf', 'half', 'full', 'visor', 'none', 'none', 'wolf', 'half'], u[7] as number);
    headgear = mask === 'none' ? at<HeadgearId>(['none', 'none', 'none', 'crest', 'goggles', 'headband'], u[8] as number)
      : mask === 'full' || mask === 'visor' ? 'none' : at<HeadgearId>(['none', 'none', 'none', 'headband', 'crest'], u[8] as number);
    cape = at<CapeId>(['cape', 'cape', 'highcollar', 'scarf', 'fur', 'turtleneck', 'cloak', 'none', 'none'], u[10] as number);
    accessory = acc1;
    beard = (u[14] as number) < 0.1 ? 'goatee' : 'none';
  } else if (fam === 'vilains') {
    mask = at<MaskId>(['wolf', 'half', 'full', 'visor', 'none', 'none', 'half'], u[7] as number);
    headgear = at<HeadgearId>(['none', 'horns', 'hood', 'crown', 'hood', 'horns', 'none'], u[8] as number);
    if (headgear === 'crown' && mask === 'full') headgear = 'horns';
    hairStyle = at<HairId>(['spiky', 'long', 'mohawk', 'bald', 'sweep', 'quiff'], u[5] as number);
    cape = at<CapeId>(['cape', 'highcollar', 'cloak', 'highcollar', 'scarf', 'cloak', 'none'], u[10] as number);
    accessory = (u[12] as number) < 0.4 ? 'scar' : acc1;
    mouth = at<MouthId>(['smirk', 'grin', 'flat', 'smirk', 'open'], u[13] as number);
    beard = (u[14] as number) < 0.3 ? 'goatee' : 'none';
    angry = true;
    neon = (u[15] as number) < 0.5;
  } else if (fam === 'scifi') {
    if (kit === 'astro') {
      headgear = 'astro'; mask = 'none'; cape = 'none';
      hairStyle = at<HairId>(['crop', 'quiff', 'buzz', 'sweep', 'bun', 'ponytail', 'bald'], u[5] as number);
      armor = at<ArmorId>(['plain', 'harness', 'gorget'], u[9] as number);
      accessory = (u[12] as number) < 0.2 ? 'scar' : 'none';
      neon = false;
    } else if (kit === 'cyborg') {
      headgear = 'cyber'; mask = 'none';
      hairStyle = at<HairId>(['crop', 'mohawk', 'buzz', 'bald', 'spiky'], u[5] as number);
      armor = at<ArmorId>(['plate', 'harness', 'gorget', 'spikes'], u[9] as number);
      cape = at<CapeId>(['none', 'turtleneck', 'highcollar', 'none'], u[10] as number);
      accessory = (u[12] as number) < 0.3 ? 'headset' : 'none';
      angry = (u[16] as number) < 0.5;
      neon = true;
    } else if (kit === 'android') {
      headgear = 'antenna'; mask = 'none'; hairStyle = 'bald';
      armor = at<ArmorId>(['plain', 'gorget', 'plate'], u[9] as number);
      cape = at<CapeId>(['none', 'turtleneck', 'none'], u[10] as number);
      neon = true; accessory = 'none';
    } else {
      mask = at<MaskId>(['visor', 'none', 'half', 'none'], u[7] as number);
      headgear = mask === 'visor' ? 'none' : at<HeadgearId>(['crest', 'goggles', 'none', 'headband'], u[8] as number);
      hairStyle = at<HairId>(['crop', 'ponytail', 'buzz', 'sweep', 'quiff', 'mohawk'], u[5] as number);
      armor = at<ArmorId>(['harness', 'plain', 'plate', 'gorget'], u[9] as number);
      cape = at<CapeId>(['none', 'scarf', 'turtleneck', 'none'], u[10] as number);
      accessory = (u[12] as number) < 0.5 ? 'headset' : acc1;
    }
  } else if (kit === 'knight') {
    headgear = (u[8] as number) < 0.5 ? 'greathelm' : 'openhelm';
    armor = at<ArmorId>(['plate', 'pauldrons', 'spikes', 'scales', 'gorget'], u[9] as number);
    cape = at<CapeId>(['cloak', 'fur', 'none', 'cape'], u[10] as number);
    beard = headgear === 'openhelm' && (u[14] as number) < 0.4 ? 'goatee' : 'none';
    accessory = headgear === 'openhelm' && (u[12] as number) < 0.4 ? 'scar' : 'none';
    angry = (u[16] as number) < 0.3;
  } else if (kit === 'mage') {
    headgear = 'wizhat';
    hairStyle = at<HairId>(['long', 'ponytail', 'sweep', 'long'], u[5] as number);
    armor = at<ArmorId>(['plain', 'gorget', 'harness'], u[9] as number);
    cape = at<CapeId>(['cloak', 'highcollar', 'scarf', 'fur'], u[10] as number);
    if ((u[14] as number) < 0.6) { beard = 'full'; hair = at(['#f2f2f2', '#c9ced8', '#ecdba6'], u[3] as number); }
    mouth = 'smile';
    accessory = (u[12] as number) < 0.3 ? 'glasses' : 'none';
    if (u[15] as number < 0.35) neon = true;
  } else if (kit === 'archer') {
    headgear = 'archerhood';
    armor = at<ArmorId>(['harness', 'scales', 'plain'], u[9] as number);
    cape = at<CapeId>(['scarf', 'cloak', 'none', 'fur'], u[10] as number);
    mask = (u[7] as number) < 0.25 ? 'half' : 'none';
    accessory = (u[12] as number) < 0.3 ? 'earring' : (u[12] as number) > 0.85 ? 'scar' : 'none';
  } else {
    headgear = at<HeadgearId>(['openhelm', 'headband', 'crown', 'none'], u[8] as number);
    hairStyle = at<HairId>(['long', 'sweep', 'quiff', 'ponytail', 'crop'], u[5] as number);
    armor = at<ArmorId>(['pauldrons', 'plate', 'gorget', 'spikes'], u[9] as number);
    cape = at<CapeId>(['cape', 'cloak', 'fur', 'highcollar'], u[10] as number);
    beard = (u[14] as number) < 0.25 ? 'goatee' : 'none';
    accessory = (u[12] as number) < 0.2 ? 'scar' : 'none';
  }

  // Cohérence : pas de lunettes sous un masque, pas de coiffure sous un casque qui la cache.
  if (mask !== 'none' && (accessory === 'glasses' || accessory === 'shades')) accessory = 'none';
  if (headgear === 'astro' && hairStyle === 'afro') hairStyle = 'crop';
  if (headgear === 'wizhat' && (hairStyle === 'bun' || hairStyle === 'afro')) hairStyle = 'long';
  if (accessory === 'headset' && (headgear === 'crest' || headgear === 'openhelm')) accessory = 'none';
  if (accessory === 'glasses' && headgear === 'goggles') accessory = 'none';
  if (beard !== 'none' && (mask === 'half' || mask === 'visor' || mask === 'full')) beard = mask === 'full' ? 'none' : beard;
  if (kit === 'android') accessory = 'none';

  const palette = [main, sec, acc];
  const neonColor = fam === 'vilains' ? at(VILLAIN_NEONS, u[22] as number)
    : kit === 'cyborg' ? at(['#ff3b3b', '#33e1ff', '#ff4fd8'], u[22] as number)
      : at(NEONS, u[22] as number);
  void palette;
  const steel = mix(main, '#b8c2d2', 0.72);
  return {
    id, fam, kit,
    skin, skinD: darken(skin, 0.2), skinL: lighten(skin, 0.4),
    hair, hairD: darken(hair, 0.28), hairL: lighten(hair, 0.4),
    main, mainD: darken(main, 0.3), mainL: lighten(main, 0.35),
    sec, secD: darken(sec, 0.32), secL: lighten(sec, 0.35),
    maskC: [sec, main, acc].find((col) => colorDist(col, skin) > 90) ?? sec,
    acc, accD: darken(acc, 0.3),
    steel, steelD: darken(steel, 0.35), steelL: lighten(steel, 0.5),
    ink: INK,
    iris: at(IRISES, u[21] as number),
    neonColor,
    head, hairStyle, mask, headgear, armor, cape, emblem, accessory, mouth, beard,
    neon, angry,
    backing: (u[17] as number) < 0.5,
    fins: (u[18] as number) < 0.5,
    elf, android,
    covered: headgear === 'greathelm',
  };
}

// ---------------------------------------------------------------- fond

function backgroundSvg(c: Ctx, u: number[]): string {
  const base = [c.main, c.sec, c.acc].reduce((a, b) => (vividness(b) > vividness(a) ? b : a));
  const dark = '#0c0e15';
  const a = mix(base, dark, 0.4);
  const b = mix(base, dark, 0.86);
  const rays = (u[23] as number) < 0.45;
  const dots = (u[24] as number) < 0.6;
  let s = `<rect width="128" height="128" fill="url(#${c.id}b)"/>`;
  if (rays) {
    let d = '';
    const n = 12;
    for (let i = 0; i < n; i += 2) {
      const a1 = (i / n) * Math.PI * 2 + 0.2;
      const a2 = ((i + 1) / n) * Math.PI * 2 + 0.2;
      d += `M64 58L${Math.round(64 + Math.cos(a1) * 130)} ${Math.round(58 + Math.sin(a1) * 130)}L${Math.round(64 + Math.cos(a2) * 130)} ${Math.round(58 + Math.sin(a2) * 130)}Z`;
    }
    s += `<path d="${d}" fill="${lighten(base, 0.5)}" opacity=".09"/>`;
  } else {
    s += `<circle cx="64" cy="54" r="46" fill="none" stroke="${lighten(base, 0.5)}" stroke-width="1.4" opacity=".16"/><circle cx="64" cy="54" r="58" fill="none" stroke="${lighten(base, 0.5)}" stroke-width="1" opacity=".1"/>`;
  }
  if (dots) {
    const corner = (u[25] as number) < 0.5;
    s += `<rect width="128" height="128" fill="url(#${c.id}d)" mask="url(#${c.id}k${corner ? 'a' : 'b'})" opacity=".5"/>`;
  }
  s += `<circle cx="64" cy="52" r="40" fill="#ffffff" opacity=".06"/>`;
  void a; void b;
  return s;
}

function defsSvg(c: Ctx): string {
  const base = [c.main, c.sec, c.acc].reduce((a, b) => (vividness(b) > vividness(a) ? b : a));
  const dark = '#0c0e15';
  const dot = lighten(base, 0.45);
  return '<defs>' +
    `<radialGradient id="${c.id}b" cx="64" cy="54" r="92" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${mix(base, dark, 0.4)}"/><stop offset="1" stop-color="${mix(base, dark, 0.86)}"/></radialGradient>` +
    `<linearGradient id="${c.id}m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.steelL}"/><stop offset=".5" stop-color="${c.steel}"/><stop offset="1" stop-color="${c.steelD}"/></linearGradient>` +
    `<pattern id="${c.id}d" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><circle cx="3" cy="3" r="1.25" fill="${dot}"/></pattern>` +
    `<radialGradient id="${c.id}ga" cx="0" cy="0" r="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>` +
    `<radialGradient id="${c.id}gb" cx="128" cy="0" r="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>` +
    `<mask id="${c.id}ka"><rect width="128" height="128" fill="url(#${c.id}ga)"/></mask><mask id="${c.id}kb"><rect width="128" height="128" fill="url(#${c.id}gb)"/></mask>` +
    (c.armor === 'scales' ? `<pattern id="${c.id}s" width="12" height="8" patternUnits="userSpaceOnUse"><g fill="${c.sec}" stroke="${c.secD}" stroke-width=".7"><circle cx="0" cy="0" r="6.4"/><circle cx="12" cy="0" r="6.4"/><circle cx="6" cy="4" r="6.4" fill="${c.secL}"/></g></pattern>` : '') +
    `<clipPath id="${c.id}h"><path d="${HEAD_PATHS[c.head]}"/></clipPath>` +
    `<clipPath id="${c.id}t"><path d="${TORSO_PATH}"/></clipPath>` +
    '</defs>';
}

const HAIR_HIDING_FRONT: ReadonlySet<HeadgearId> = new Set<HeadgearId>(['crest', 'hood', 'archerhood', 'openhelm', 'wizhat', 'greathelm']);
const HAIR_HIDING_BACK: ReadonlySet<HeadgearId> = new Set<HeadgearId>(['hood', 'archerhood', 'greathelm']);

/** SVG complet (chaîne) d'un avatar de la famille donnée pour la graine donnée. */
export function renderHero(fam: HeroFamily, seed: string): string {
  const c = buildHero(fam, seed);
  const u = draws(fam, seed);
  const hairBack = c.mask !== 'full' && !HAIR_HIDING_BACK.has(c.headgear) && !c.android;
  const hairFront = c.mask !== 'full' && !HAIR_HIDING_FRONT.has(c.headgear) && !c.android && !c.covered;
  const neckColor = c.mask === 'full' ? c.sec : c.skin;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">` +
    defsSvg(c) + backgroundSvg(c, u) +
    capeBackSvg(c) + headgearBackSvg(c) +
    neckSvg(c, neckColor) + torsoSvg(c) + armorSvg(c) + capeFrontSvg(c) + emblemSvg(c) +
    (hairBack ? hairBackSvg(c) : '') +
    (c.covered || c.mask === 'full' ? '' : earsSvg(c)) +
    (c.covered ? '' : headSvg(c)) +
    noseMouthSvg(c) + beardSvg(c) + maskSvg(c) + eyesSvg(c) +
    (hairFront ? hairFrontSvg(c) : '') +
    accessorySvg(c) + headgearFrontSvg(c) +
    '</svg>';
}

/** URI data: du SVG, prête pour un `background-image`. */
export const heroDataUri = (fam: HeroFamily, seed: string): string =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderHero(fam, seed));
