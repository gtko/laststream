import { describe, expect, it } from 'vitest';
import {
  baseKey,
  fichePrefix,
  freshness,
  l10nKey,
  legacyKey,
  type MetaLayer,
  ratingsKey,
  resolveLang,
  SCHEMA_VERSION,
  seasonKey,
  staleCapMs,
  SUPPORTED_LANGS,
  type Subject,
  ttlMs,
} from '../src/lt/meta-policy.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
/** Minuit UTC : les dates AAAA-MM-JJ tombent exactement sur des multiples de jours. */
const NOW = Date.parse('2026-10-24T00:00:00Z');
/** Date AAAA-MM-JJ décalée de `days` jours par rapport à NOW (négatif : dans le passé). */
const dayAt = (days: number): string => new Date(NOW + days * DAY).toISOString().slice(0, 10);

const movie = (releaseDate: string | null | undefined): Subject => ({ kind: 'movie', releaseDate });
const series = (extra: Partial<Subject> = {}): Subject => ({ kind: 'tv', ...extra });

describe('resolveLang', () => {
  it.each<[string | undefined, string]>([
    ['fr', 'fr-FR'],
    ['FR', 'fr-FR'],
    ['fr-fr', 'fr-FR'],
    ['FR-fr', 'fr-FR'],
    ['en', 'en-US'],
    ['EN', 'en-US'],
    ['en-us', 'en-US'],
    ['En-Us', 'en-US'],
    ['de', 'fr-FR'],
    ['en-GB', 'fr-FR'],
    ['', 'fr-FR'],
    ['constructor', 'fr-FR'],
    ['__proto__', 'fr-FR'],
    [undefined, 'fr-FR'],
  ])('resolveLang(%s) = %s', (input, expected) => {
    expect(resolveLang(input)).toBe(expected);
  });

  it('expose les langues servies et la version du schéma', () => {
    expect(SUPPORTED_LANGS).toEqual(['fr-FR', 'en-US']);
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe('clés R2', () => {
  it.each<[string, string, string]>([
    ['baseKey film', baseKey('movie', 603), 'meta/v2/movie/603/base.json'],
    ['baseKey série', baseKey('tv', 1399), 'meta/v2/tv/1399/base.json'],
    ['l10nKey', l10nKey('tv', 1399, 'en-US'), 'meta/v2/tv/1399/l10n/en-US.json'],
    ['ratingsKey', ratingsKey('movie', 603), 'meta/v2/movie/603/ratings.json'],
    ['seasonKey', seasonKey(1399, 2, 'fr-FR'), 'meta/v2/tv/1399/s2/fr-FR.json'],
    ['legacyKey film', legacyKey('movie', 603), 'meta/movie/603.json'],
    ['legacyKey série (clé « series » de meta.ts)', legacyKey('tv', 1399), 'meta/series/1399.json'],
    ['fichePrefix', fichePrefix('tv', 1399), 'meta/v2/tv/1399/'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('range les couches d une fiche sous son préfixe, et seulement là', () => {
    const prefix = fichePrefix('tv', 1399);
    for (const key of [baseKey('tv', 1399), l10nKey('tv', 1399, 'fr-FR'), ratingsKey('tv', 1399)]) {
      expect(key.startsWith(prefix)).toBe(true);
    }
    expect(baseKey('tv', 13990).startsWith(prefix)).toBe(false);
    expect(legacyKey('tv', 1399).startsWith(prefix)).toBe(false);
  });
});

describe('films sortis', () => {
  // [couche, jours depuis la sortie, durée attendue en jours]
  it.each<[MetaLayer, number, number]>([
    ['base', 0, 7],
    ['base', 89, 7],
    ['base', 90, 30],
    ['base', 365, 30],
    ['base', 366, 180],
    ['l10n', 0, 30],
    ['l10n', 89, 30],
    ['l10n', 90, 90],
    ['l10n', 365, 90],
    ['l10n', 366, 180],
    ['ratings', 0, 1],
    ['ratings', 89, 1],
    ['ratings', 90, 7],
    ['ratings', 365, 7],
    ['ratings', 366, 30],
  ])('couche %s, sorti il y a %i j : %i j', (layer, ago, days) => {
    expect(ttlMs(layer, movie(dayAt(-ago)), NOW)).toBe(days * DAY);
  });
});

describe('films non sortis', () => {
  // [couche, sortie dans n jours, durée attendue en jours]
  it.each<[MetaLayer, number, number]>([
    ['base', 1, 2],
    ['l10n', 1, 2],
    ['base', 5, 6],
    ['base', 6, 7],
    ['base', 29, 7],
    ['l10n', 29, 7],
    ['base', 30, 30],
    ['l10n', 30, 30],
    ['base', 90, 30],
  ])('couche %s, sortie dans %i j : %i j', (layer, ahead, days) => {
    expect(ttlMs(layer, movie(dayAt(ahead)), NOW)).toBe(days * DAY);
  });

  it.each<[string, string | null | undefined]>([
    ['sans date', undefined],
    ['date nulle', null],
    ['date mal formée', '24/11/2026'],
  ])('%s : base et traduction 7 j, notes à 0 (aucun appel MDBList)', (_label, releaseDate) => {
    expect(ttlMs('base', movie(releaseDate), NOW)).toBe(7 * DAY);
    expect(ttlMs('l10n', movie(releaseDate), NOW)).toBe(7 * DAY);
    expect(ttlMs('ratings', movie(releaseDate), NOW)).toBe(0);
  });

  it('une sortie aujourd hui est un film sorti (pas un film non sorti)', () => {
    expect(ttlMs('ratings', movie(dayAt(0)), NOW)).toBe(DAY);
  });

  it('fiche incomplète : base et traduction une heure, pas de notes', () => {
    const subject = { ...movie(dayAt(10)), partial: true };
    expect(ttlMs('base', subject, NOW)).toBe(HOUR);
    expect(ttlMs('l10n', subject, NOW)).toBe(HOUR);
    expect(ttlMs('ratings', subject, NOW)).toBe(0);
  });
});

describe('séries en cours', () => {
  // [prochain épisode, durée attendue de la base en ms]
  it.each<[string, number]>([
    [dayAt(0), 6 * HOUR],
    [dayAt(-3), 6 * HOUR],
    [dayAt(2), 2 * DAY + 6 * HOUR],
    [dayAt(29), 29 * DAY + 6 * HOUR],
    [dayAt(30), 30 * DAY],
    [dayAt(120), 30 * DAY],
  ])('prochain épisode le %s : base %i ms', (nextAirDate, expected) => {
    expect(ttlMs('base', series({ status: 'Returning Series', nextAirDate }), NOW)).toBe(expected);
  });

  it.each<[string, string | null | undefined]>([
    ['absente', undefined],
    ['nulle', null],
    ['mal formée', 'bientôt'],
  ])('prochain épisode %s : série en pause, base 14 j', (_label, nextAirDate) => {
    expect(ttlMs('base', series({ status: 'Returning Series', nextAirDate }), NOW)).toBe(14 * DAY);
  });

  it('traduction 30 j et notes 7 j, quelle que soit la prochaine date', () => {
    for (const nextAirDate of [dayAt(2), undefined]) {
      expect(ttlMs('l10n', series({ status: 'Returning Series', nextAirDate }), NOW)).toBe(30 * DAY);
      expect(ttlMs('ratings', series({ status: 'Returning Series', nextAirDate }), NOW)).toBe(7 * DAY);
    }
  });
});

describe('séries terminées', () => {
  it.each<[string, Partial<Subject>]>([
    ["statut « Ended »", { status: 'Ended' }],
    ["statut « Canceled »", { status: 'Canceled' }],
    ['drapeau ended (TVDB) malgré un statut « en cours »', { status: 'Returning Series', ended: true }],
  ])('%s : base 180 j, traduction 180 j, notes 30 j', (_label, extra) => {
    const subject = series({ ...extra, nextAirDate: dayAt(2) });
    expect(ttlMs('base', subject, NOW)).toBe(180 * DAY);
    expect(ttlMs('l10n', subject, NOW)).toBe(180 * DAY);
    expect(ttlMs('ratings', subject, NOW)).toBe(30 * DAY);
  });
});

describe('fiches incomplètes (partial)', () => {
  it('série en cours ou terminée : base et traduction une heure, notes un jour', () => {
    for (const extra of [{ status: 'Returning Series', nextAirDate: dayAt(2) }, { status: 'Ended' }]) {
      const subject = series({ ...extra, partial: true });
      expect(ttlMs('base', subject, NOW)).toBe(HOUR);
      expect(ttlMs('l10n', subject, NOW)).toBe(HOUR);
      expect(ttlMs('ratings', subject, NOW)).toBe(DAY);
    }
  });

  it('film sorti depuis plus d un an : base et traduction une heure, notes un jour', () => {
    const subject = { ...movie(dayAt(-400)), partial: true };
    expect(ttlMs('base', subject, NOW)).toBe(HOUR);
    expect(ttlMs('l10n', subject, NOW)).toBe(HOUR);
    expect(ttlMs('ratings', subject, NOW)).toBe(DAY);
  });
});

describe('saisons', () => {
  it('saison à venir ou en cours : base de la série', () => {
    const subject = series({ status: 'Returning Series', nextAirDate: dayAt(2) });
    expect(ttlMs('season', subject, NOW)).toBe(ttlMs('base', subject, NOW));
    expect(ttlMs('season', subject, NOW)).toBe(2 * DAY + 6 * HOUR);
  });

  it('dernier épisode diffusé il y a 10 j, série en pause : base (14 j)', () => {
    expect(ttlMs('season', series({ status: 'Returning Series', lastAirDate: dayAt(-10) }), NOW)).toBe(14 * DAY);
  });

  it.each<[number, number]>([
    [30, 14 * DAY],
    [31, 180 * DAY],
  ])('dernier épisode il y a %i j, série en pause : %i ms', (ago, expected) => {
    expect(ttlMs('season', series({ status: 'Returning Series', lastAirDate: dayAt(-ago) }), NOW)).toBe(expected);
  });

  it('saison terminée depuis plus de 30 j, mais série avec un prochain épisode : base de la série', () => {
    const subject = series({ status: 'Returning Series', lastAirDate: dayAt(-60), nextAirDate: dayAt(20) });
    expect(ttlMs('season', subject, NOW)).toBe(20 * DAY + 6 * HOUR);
  });

  it.each<[string, string | null | undefined]>([
    ['dernier épisode hier', dayAt(-1)],
    ['dernier épisode il y a 400 j', dayAt(-400)],
    ['date du dernier épisode absente', undefined],
  ])('série terminée, %s : 180 j', (_label, lastAirDate) => {
    expect(ttlMs('season', series({ status: 'Ended', lastAirDate }), NOW)).toBe(180 * DAY);
  });

  it('fiche incomplète : une heure', () => {
    expect(ttlMs('season', series({ status: 'Ended', partial: true }), NOW)).toBe(HOUR);
    expect(ttlMs('season', series({ status: 'Returning Series', lastAirDate: dayAt(-60), partial: true }), NOW)).toBe(HOUR);
  });

  it('film : la « saison » suit la base du film', () => {
    expect(ttlMs('season', movie(dayAt(-200)), NOW)).toBe(30 * DAY);
    expect(ttlMs('season', movie(dayAt(-400)), NOW)).toBe(180 * DAY);
  });
});

describe('staleCapMs', () => {
  it.each<[number, number]>([
    [0, 0],
    [HOUR, HOUR],
    [DAY, DAY],
    [30 * DAY, 30 * DAY],
    [31 * DAY, 30 * DAY],
    [180 * DAY, 30 * DAY],
  ])('durée de vie %i ms : périmé servi %i ms au plus', (ttl, cap) => {
    expect(staleCapMs(ttl)).toBe(cap);
  });
});

describe('freshness', () => {
  const EXPIRES = 1000 * DAY;
  it.each<[string, number, number, 'fresh' | 'stale' | 'dead']>([
    ['une ms avant l échéance (ttl 7 j)', 7 * DAY, -1, 'fresh'],
    ['à l échéance (ttl 7 j)', 7 * DAY, 0, 'stale'],
    ['dernière ms du périmé (ttl 7 j)', 7 * DAY, 7 * DAY - 1, 'stale'],
    ['fin du périmé (ttl 7 j)', 7 * DAY, 7 * DAY, 'dead'],
    ['périmé plafonné à 30 j (ttl 180 j)', 180 * DAY, 30 * DAY - 1, 'stale'],
    ['mort à 30 j (ttl 180 j)', 180 * DAY, 30 * DAY, 'dead'],
    ['mort à une heure (ttl 1 h)', HOUR, HOUR, 'dead'],
    ['ttl nul : frais une ms avant', 0, -1, 'fresh'],
    ['ttl nul : mort à l échéance', 0, 0, 'dead'],
  ])('%s', (_label, ttl, offset, expected) => {
    expect(freshness(EXPIRES, ttl, EXPIRES + offset)).toBe(expected);
  });
});
