import { describe, expect, it } from 'vitest';
import { ficheHash, parseFicheHash } from '../src/ui/ficheRoute.js';
import { soonItemHTML } from '../src/ui/soon.js';
import { addDays, todayStr } from '../src/ui/dates.js';

describe('adresse d’une fiche avec épisode visé', () => {
  it('lit la fiche seule, avec ou sans épisode', () => {
    expect(parseFicheHash('#/tv/123')).toEqual({ type: 'tv', id: '123' });
    expect(parseFicheHash('#/movie/9')).toEqual({ type: 'movie', id: '9' });
    expect(parseFicheHash('#/tv/123/s2e49')).toEqual({ type: 'tv', id: '123', season: 2, episode: 49 });
    expect(parseFicheHash('#/tv/123/s0e1')).toEqual({ type: 'tv', id: '123', season: 0, episode: 1 });
  });
  it('un film ignore l’épisode ; une adresse mal formée n’est pas une fiche', () => {
    expect(parseFicheHash('#/movie/9/s1e1')).toEqual({ type: 'movie', id: '9' });
    for (const h of ['#/tv/123/s2', '#/tv/123/s2e', '#/tv/123/e4', '#/tv/123/s2e49/x', '#/tv', '', '#/person/5']) expect(parseFicheHash(h)).toBeNull();
  });
  it('construit l’adresse, sans épisode pour un film ou une valeur invalide', () => {
    expect(ficheHash('tv', '123')).toBe('#/tv/123');
    expect(ficheHash('tv', '123', { season: 2, episode: '49' })).toBe('#/tv/123/s2e49');
    expect(ficheHash('movie', '9', { season: 1, episode: 1 })).toBe('#/movie/9');
    expect(ficheHash('tv', '123', { season: 'x', episode: 3 })).toBe('#/tv/123');
    expect(ficheHash('tv', '123', { season: 1, episode: 0 })).toBe('#/tv/123');
  });
  it('l’adresse construite se relit', () => {
    expect(parseFicheHash(ficheHash('tv', '77', { season: 3, episode: 12 }))).toEqual({ type: 'tv', id: '77', season: 3, episode: 12 });
  });
});

describe('carte des suivis : clic vers l’épisode', () => {
  const o = (airDate: string) => ({ airDate, season: 2, episode: 49, epTitle: 'X', name: 'BLEACH' });
  it('ce soir : ouvre la fiche avec saison et épisode', () => {
    const html = soonItemHTML(o(todayStr()), 'tv:30984');
    expect(html).toContain('data-open="tv:30984"');
    expect(html).toContain('data-open-season="2"');
    expect(html).toContain('data-open-episode="49"');
    expect(html).not.toContain('data-play');
  });
  it('au-delà de 14 jours : idem', () => {
    const html = soonItemHTML(o(addDays(todayStr(), 30)), 'tv:30984');
    expect(html).toContain('data-open-season="2"');
  });
  it('dans les 14 jours : lecture directe inchangée', () => {
    const html = soonItemHTML(o(addDays(todayStr(), 5)), 'tv:30984');
    expect(html).toContain('data-play');
    expect(html).not.toContain('data-open=');
  });
});
