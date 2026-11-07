import { describe, expect, it } from 'vitest';
import {
  AVATAR_PATTERN, HERO_FAMILIES, HERO_PATTERN, HERO_SEEDS, formatHero, isValidAvatar, parseAvatar, parseHero, tabTiles,
  type HeroFamily,
} from '../src/data/avatars';
import { buildHero, heroDataUri, renderHero } from '../src/data/heroes/render';
import { COSTUMES } from '../src/data/heroes/palettes';
import { avatarAttrs, avatarUri, cachedAvatarUri, resetAvatarCache } from '../src/ui/avatar-art.js';

const FAMILIES = HERO_FAMILIES.map((f) => f.id);

describe('générateur de héros : rendu', () => {
  it('déterministe : même famille et même graine, même SVG ; autre graine ou autre famille, autre SVG', () => {
    for (const fam of FAMILIES) {
      expect(renderHero(fam, 'Aegis')).toBe(renderHero(fam, 'Aegis'));
      expect(renderHero(fam, 'Aegis')).not.toBe(renderHero(fam, 'Blaze'));
    }
    expect(renderHero('heros', 'Nova')).not.toBe(renderHero('vilains', 'Nova'));
    expect(heroDataUri('scifi', 'Ion')).toBe(heroDataUri('scifi', 'Ion'));
  });

  it('SVG valide 128x128, sans ressource externe ni script, pour chaque famille et 150 graines', () => {
    const parser = new DOMParser();
    for (const fam of FAMILIES) {
      for (const seed of HERO_SEEDS.slice(0, 150)) {
        const svg = renderHero(fam, seed);
        const doc = parser.parseFromString(svg, 'image/svg+xml');
        expect(doc.getElementsByTagName('parsererror').length, fam + seed).toBe(0);
        const root = doc.documentElement;
        expect(root.nodeName).toBe('svg');
        expect(root.getAttribute('viewBox')).toBe('0 0 128 128');
        expect(svg).not.toMatch(/<script|<image|<foreignObject|(?:href|src)=/);
        expect(svg).not.toMatch(/NaN|undefined|Infinity/);
        // Identifiants uniques (plusieurs avatars peuvent cohabiter dans une même page) et toutes les références résolues.
        const ids = Array.from(svg.matchAll(/ id="([^"]+)"/g)).map((m) => m[1]);
        expect(new Set(ids).size).toBe(ids.length);
        for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids, ref[1]).toContain(ref[1]);
      }
    }
  });

  it('48 avatars par famille tous différents, et deux avatars d’une même page n’ont aucun identifiant en commun', () => {
    for (const fam of FAMILIES) {
      const svgs = HERO_SEEDS.slice(0, 48).map((s) => renderHero(fam, s));
      expect(new Set(svgs).size).toBe(48);
    }
    const ida = Array.from(renderHero('heros', 'Aegis').matchAll(/ id="([^"]+)"/g)).map((m) => m[1]);
    const idb = new Set(Array.from(renderHero('heros', 'Blaze').matchAll(/ id="([^"]+)"/g)).map((m) => m[1]));
    expect(ida.some((i) => idb.has(i))).toBe(false);
  });

  it('riche : coiffures, masques, casques, capes, emblèmes, accessoires et palettes variés', () => {
    const seen = { hair: new Set<string>(), mask: new Set<string>(), headgear: new Set<string>(), cape: new Set<string>(), emblem: new Set<string>(), accessory: new Set<string>(), armor: new Set<string>(), neon: new Set<boolean>(), skin: new Set<string>(), main: new Set<string>() };
    for (const fam of FAMILIES) {
      for (let i = 0; i < 300; i += 1) {
        const c = buildHero(fam, 'seed' + i);
        seen.hair.add(c.hairStyle); seen.mask.add(c.mask); seen.headgear.add(c.headgear); seen.cape.add(c.cape);
        seen.emblem.add(c.emblem); seen.accessory.add(c.accessory); seen.armor.add(c.armor); seen.neon.add(c.neon);
        seen.skin.add(c.skin); seen.main.add(c.main);
      }
    }
    expect(seen.hair.size).toBeGreaterThanOrEqual(8);
    expect([...seen.mask].sort()).toEqual(['full', 'half', 'none', 'visor', 'wolf']);
    expect(seen.headgear.size).toBeGreaterThanOrEqual(6);
    expect(seen.cape.size).toBeGreaterThanOrEqual(5);
    expect(seen.emblem.size).toBeGreaterThanOrEqual(10);
    expect(seen.armor.size).toBeGreaterThanOrEqual(6);
    expect(seen.accessory.size).toBeGreaterThanOrEqual(4);
    expect(seen.neon.size).toBe(2);
    expect(seen.skin.size).toBeGreaterThanOrEqual(10);
    const palettes = new Set(Object.values(COSTUMES).flat().map((p) => p.join()));
    expect(palettes.size).toBeGreaterThanOrEqual(12);
  });

  it('familles : les vilains ont l’air méchant, le sci-fi a des casques, la fantasy des heaumes et chapeaux', () => {
    const vil = Array.from({ length: 80 }, (_, i) => buildHero('vilains', 'v' + i));
    expect(vil.every((c) => c.angry)).toBe(true);
    expect(vil.some((c) => c.headgear === 'horns') && vil.some((c) => c.headgear === 'hood')).toBe(true);
    const sf = new Set(Array.from({ length: 120 }, (_, i) => buildHero('scifi', 's' + i).headgear));
    expect(sf.has('astro') && sf.has('cyber') && sf.has('antenna')).toBe(true);
    const fa = new Set(Array.from({ length: 120 }, (_, i) => buildHero('fantasy', 'f' + i).headgear));
    expect(fa.has('wizhat') && fa.has('greathelm') && fa.has('archerhood')).toBe(true);
  });
});

describe('format stocké hero:<famille>:<graine>', () => {
  it('motif et analyse', () => {
    expect(HERO_PATTERN.test('hero:heros:Aegis')).toBe(true);
    expect(HERO_PATTERN.test('hero:vilains:Ab_c-1')).toBe(true);
    for (const bad of ['hero:inconnue:abc', 'hero:heros:', 'hero:heros:a b', 'hero:Heros:abc', 'hero:heros:' + 'a'.repeat(41), 'heros:heros:abc', 'hero:scifi:<svg>']) {
      expect(HERO_PATTERN.test(bad), bad).toBe(false);
    }
    expect(parseHero(formatHero('fantasy', 'Rune'))).toEqual({ family: 'fantasy', seed: 'Rune' });
    expect(parseHero('dicebear:lorelei:abc')).toBeNull();
    expect(parseHero(null)).toBeNull();
    // Les deux formats sont distincts : un Héros n'est pas un style DiceBear.
    expect(AVATAR_PATTERN.test('hero:heros:Aegis')).toBe(false);
    expect(parseAvatar('hero:heros:Aegis')).toBeNull();
    expect(isValidAvatar('hero:heros:Aegis')).toBe(true);
    expect(isValidAvatar('dicebear:thumbs:Mimi')).toBe(true);
    expect(isValidAvatar('hero:x:y')).toBe(false);
  });

  it('onglet Héros : 48 propositions par famille, « Plus » en donne davantage, la graine saisie passe en premier', () => {
    for (const fam of FAMILIES) {
      const tiles = tabTiles('heroes', '', fam as HeroFamily);
      expect(tiles.length).toBeGreaterThan(96);
      expect(tiles.slice(0, 48).every((t) => t.value.startsWith('hero:' + fam + ':'))).toBe(true);
      expect(new Set(tiles.map((t) => t.value)).size).toBe(tiles.length);
    }
    expect(tabTiles('heroes', 'Zélie', 'vilains')[0].value).toBe('hero:vilains:Zelie');
    expect(tabTiles('heroes').map((t) => t.value)).toEqual(tabTiles('heroes').map((t) => t.value));
  });
});

describe('rendu partout (même fonction que DiceBear)', () => {
  it('avatarAttrs pose l’illustration tout de suite, sans chargement ni réseau', async () => {
    resetAvatarCache();
    const attrs = avatarAttrs('hero:heros:Aegis', '#ff5a36');
    expect(attrs).toContain('data-avatar="hero:heros:Aegis"');
    expect(attrs).toContain('data-art="1"');
    expect(attrs).toContain('data:image/svg+xml');
    expect(cachedAvatarUri('hero:heros:Aegis')).toMatch(/^data:image\/svg\+xml/);
    expect(await avatarUri('hero:vilains:Blaze')).toBe(heroDataUri('vilains', 'Blaze'));
    expect(await avatarUri('hero:inconnue:x')).toBe('');
    expect(avatarAttrs('hero:inconnue:x', '#ff5a36')).not.toContain('data-avatar');
  });
});
