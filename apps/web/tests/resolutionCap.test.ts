import { afterEach, describe, expect, it } from 'vitest';
import { getQualityGroupKey, is1440Text } from '../src/data/sources';
import { getResolutionCap, setResolutionCap } from '../src/data/prefs';
import type { Stream } from '../src/data/stream';
import { launchUsable } from '../src/player/launchCache';
import { toSourceViews } from '../src/sources/info';
import { isGoodMatch, recommend } from '../src/sources/rank';
import { capHeightOf, capLabel, capViews, currentCapHeight } from '../src/sources/resolutionCap';

const mk = (resolution: string, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Stream => ({
  url: 'https://x/play/' + resolution + Math.random().toString(36).slice(2),
  laststream: {
    resolution, height: parseInt(resolution, 10) || 0, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50,
    estBitrateKbps: 8000, sizeBytes: 5e9, ...over,
  },
  ...top,
});

afterEach(() => { localStorage.clear(); });

describe('1440p (2K)', () => {
  it('reconnu dans le nom de la release quand lastAddon répond « unknown »', () => {
    expect(getQualityGroupKey(mk('unknown', {}, { title: 'Film.2024.1440p.WEB-DL' }))).toBe('1440p');
    expect(getQualityGroupKey(mk('unknown', {}, { behaviorHints: { filename: 'Film 2560x1440 x265.mkv' } }))).toBe('1440p');
    expect(getQualityGroupKey(mk('unknown', {}, { name: 'Film QHD' }))).toBe('1440p');
    expect(getQualityGroupKey(mk('unknown', {}, { name: 'Film 2K' }))).toBe('1440p');
    expect(getQualityGroupKey(mk('unknown', {}, { name: 'Film 12K 14400' }))).toBe('other');
    expect(getQualityGroupKey(mk('unknown', {}, { name: 'Film 2K Remaster 1080p' }))).toBe('other');
    expect(is1440Text('Film.2K.WEB')).toBe(true);
    expect(is1440Text('Film.2K.Remaster.1080p')).toBe(false);
  });

  it('reconnu quand lastAddon annonce 1440p, et n’est plus regroupé avec le 4K ni le 1080p', () => {
    expect(getQualityGroupKey(mk('1440p'))).toBe('1440p');
    expect(getQualityGroupKey(mk('2160p'))).toBe('2160p');
    expect(getQualityGroupKey(mk('1080p'))).toBe('1080p');
    const [v] = toSourceViews([mk('unknown', {}, { title: 'Film 1440p' })]);
    expect(v.group).toBe('1440p');
    expect(v.resolution).toBe('1440p');
    expect(v.quality).toBe('2K');
    expect(v.sizeLabel).toBe('5.0 Go'.replace('.', ','));
  });
});

describe('plafond de résolution : hauteur', () => {
  it('réglage fixe', () => {
    expect(capHeightOf('1080p', null)).toBe(1080);
    expect(capHeightOf('1440p', 2160)).toBe(1440);
    expect(capHeightOf('720p', 2160)).toBe(720);
    expect(capHeightOf('2160p', 1080)).toBe(2160);
  });

  it('automatique : déduit de l’écran, aucun plafond si l’écran est inconnu', () => {
    expect(capHeightOf('auto', 768)).toBe(1080);
    expect(capHeightOf('auto', 1080)).toBe(1080);
    expect(capHeightOf('auto', 1200)).toBe(1080);
    expect(capHeightOf('auto', 1440)).toBe(1440);
    expect(capHeightOf('auto', 2160)).toBe(2160);
    expect(capHeightOf('auto', null)).toBeNull();
    expect(capHeightOf('auto', 0)).toBeNull();
  });

  it('réglage conservé entre les sessions, automatique par défaut', () => {
    expect(getResolutionCap()).toBe('auto');
    setResolutionCap('1440p');
    expect(getResolutionCap()).toBe('1440p');
    expect(currentCapHeight()).toBe(1440);
    localStorage.setItem('laststream.maxResolution', 'n’importe quoi');
    expect(getResolutionCap()).toBe('auto');
  });

  it('libellés', () => {
    expect([2160, 1440, 1080, 720].map(capLabel)).toEqual(['4K', '2K', '1080p', '720p']);
  });
});

describe('plafond de résolution : tri des sources', () => {
  const g = (group: 'other' | '2160p' | '1440p' | '1080p' | '720p' | 'SD') => ({ group });

  it('garde les sources sous le plafond, écarte les autres', () => {
    const r = capViews([g('2160p'), g('1440p'), g('1080p'), g('720p')], 1080);
    expect(r.pool.map((v) => v.group)).toEqual(['1080p', '720p']);
    expect(r.hidden).toBe(2);
    expect(r.above).toBeNull();
  });

  it('aucune source sous le plafond : la plus proche au-dessus', () => {
    const r = capViews([g('2160p'), g('1440p'), g('1440p')], 1080);
    expect(r.pool.map((v) => v.group)).toEqual(['1440p', '1440p']);
    expect(r.above).toBe('1440p');
  });

  it('résolution inconnue : jamais écartée, mais une source connue sous le plafond la précède', () => {
    expect(capViews([g('2160p'), g('other')], 1080).above).toBe('2160p');
    expect(capViews([g('other'), g('1080p')], 1080).pool).toHaveLength(2);
    expect(capViews([g('other')], 1080).pool).toHaveLength(1);
    expect(capViews([g('2160p')], null).pool).toHaveLength(1);
    expect(capViews([], 1080).pool).toHaveLength(0);
  });
});

describe('plafond de résolution : recommandation', () => {
  const list = () => toSourceViews([
    mk('2160p', { score: 95, estBitrateKbps: 40000 }),
    mk('1440p', { score: 90, estBitrateKbps: 20000 }),
    mk('1080p', { score: 80, estBitrateKbps: 8000 }),
    mk('720p', { score: 60, estBitrateKbps: 4000 }),
  ]);
  const pick = (maxHeight: number | null, opts = {}) => recommend(list(), null, 'fr', { maxHeight, ...opts })!;

  it('sans plafond : le meilleur, comme avant', () => {
    expect(pick(null).view.group).toBe('2160p');
    expect(pick(null).atCap).toBeUndefined();
  });

  it('plafond 1080p ou 1440p : jamais de 4K tant qu’une source plus légère existe', () => {
    const r1080 = pick(1080);
    expect(r1080.view.group).toBe('1080p');
    expect(r1080.reason).toContain('plafond 1080p');
    expect(r1080.atCap).toBe(true);
    expect(pick(1440).view.group).toBe('1440p');
    expect(pick(1440, { preferDirect: true }).view.group).toBe('1440p');
    expect(pick(720).view.group).toBe('720p');
  });

  it('plafond 4K : tout est permis', () => {
    expect(pick(2160).view.group).toBe('2160p');
    expect(pick(2160).reason).not.toContain('plafond');
  });

  it('aucune source sous le plafond : la plus proche au-dessus, et le dit', () => {
    const only4k = toSourceViews([mk('2160p'), mk('1440p', { score: 10 })]);
    const r = recommend(only4k, null, 'fr', { maxHeight: 1080 })!;
    expect(r.view.group).toBe('1440p');
    expect(r.reason).toContain('aucune source en 1080p ou moins');
    expect(r.atCap).toBeUndefined();
  });

  it('la langue préférée prime : une VF seulement en 4K l’emporte sur une VO sous le plafond', () => {
    const views = toSourceViews([
      mk('2160p', { languages: ['fr'], frVariant: 'VFF' }),
      mk('1080p', { languages: ['en'], score: 99 }),
    ]);
    const r = recommend(views, null, 'fr', { maxHeight: 1080 })!;
    expect(r.view.group).toBe('2160p');
    expect(r.languageFallback).toBe(false);
  });

  it('le débit reste respecté sous le plafond', () => {
    const r = recommend(list(), 6000, 'fr', { maxHeight: 1080 })!;
    expect(r.view.group).toBe('720p');
  });

  it('la source au plafond en cache suffit pour lancer sans attendre', () => {
    const cached = (r: NonNullable<ReturnType<typeof recommend>>) => ({ ...r, view: { ...r.view, status: 'cached' as const } });
    const r720 = recommend(toSourceViews([mk('720p'), mk('2160p')]), null, 'fr', { maxHeight: 720 })!;
    expect(isGoodMatch(cached(r720))).toBe(true);
    // Un 720p ne suffit pas sous un plafond de 1080p : un 1080p peut encore arriver.
    const wait = recommend(toSourceViews([mk('720p'), mk('2160p')]), null, 'fr', { maxHeight: 1080 })!;
    expect(wait.view.group).toBe('720p');
    expect(wait.atCap).toBeUndefined();
    expect(isGoodMatch(cached(wait))).toBe(false);
    expect(isGoodMatch(cached(recommend(toSourceViews([mk('1080p'), mk('2160p')]), null, 'fr', { maxHeight: 1080 })!))).toBe(true);
    expect(isGoodMatch(cached(recommend(toSourceViews([mk('720p')]), null, 'fr', { maxHeight: null })!))).toBe(false);
    expect(isGoodMatch(cached(recommend(toSourceViews([mk('1440p')]), null, 'fr', { maxHeight: null })!))).toBe(true);
  });
});

describe('plafond de résolution : relance d’une source mémorisée (ODY-206)', () => {
  const check = (maxHeight: number | null) => ({
    compat: { web: false, serverUp: true, rangeDenied: () => false },
    hasDebrid: true,
    bad: new Set<string>(),
    keyOf: () => 'k',
    maxHeight,
  });

  it('une source au-dessus du plafond n’est plus relancée telle quelle', () => {
    const [v4k] = toSourceViews([mk('2160p')]);
    const [v1080] = toSourceViews([mk('1080p')]);
    expect(launchUsable(v4k, check(1080))).toBe(false);
    expect(launchUsable(v4k, check(null))).toBe(true);
    expect(launchUsable(v1080, check(1080))).toBe(true);
  });
});
