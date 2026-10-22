// Onglet « Récemment » d'un ami (ODY-220) : titre et affiche résolus par l'identifiant TMDB quand le serveur n'en donne pas.
import { describe, expect, it, vi } from 'vitest';
import { enrichHistory, fallbackTitle, usableHistory, type MetaFetcher } from '../src/data/friendHistoryView';
import type { HistoryItem } from '../src/data/socialV2Api';

const row = (over: Partial<HistoryItem>): HistoryItem => ({ type: 'series', tmdbId: 95396, pos: 60, watched: false, updatedAt: 1, ...over });

describe('historique d’un ami : titres et affiches manquants', () => {
  it('résout titre et affiche par TMDB, une seule requête par série', async () => {
    const fetchMeta = vi.fn<MetaFetcher>(async () => ({ name: 'Severance', poster_path: '/sev.jpg' }));
    const out = await enrichHistory([row({ season: 1, episode: 3 }), row({ season: 1, episode: 2 }), row({ season: 1, episode: 1 })], fetchMeta);
    expect(fetchMeta).toHaveBeenCalledTimes(1);
    expect(fetchMeta).toHaveBeenCalledWith('tv', 95396);
    expect(out.map((x) => x.title)).toEqual(['Severance', 'Severance', 'Severance']);
    expect(out.every((x) => x.poster === '/sev.jpg')).toBe(true);
    expect(out.map((x) => x.episode)).toEqual([3, 2, 1]);
  });

  it('garde titre et affiche du serveur sans appel TMDB', async () => {
    const fetchMeta = vi.fn<MetaFetcher>();
    const full = row({ type: 'movie', tmdbId: 603, title: 'Matrix', poster: 'https://image.tmdb.org/t/p/w342/m.jpg' });
    expect(await enrichHistory([full], fetchMeta)).toEqual([full]);
    expect(fetchMeta).not.toHaveBeenCalled();
  });

  it('complète seulement ce qui manque (titre serveur, affiche TMDB)', async () => {
    const fetchMeta: MetaFetcher = async () => ({ title: 'Autre', poster_path: '/p.jpg' });
    const [x] = await enrichHistory([row({ type: 'movie', tmdbId: 603, title: 'Matrix' })], fetchMeta);
    expect(x.title).toBe('Matrix');
    expect(x.poster).toBe('/p.jpg');
  });

  it('échec réseau : libellé de repli, entrée conservée, jamais « Sans titre »', async () => {
    const fetchMeta: MetaFetcher = async () => { throw new Error('offline'); };
    const out = await enrichHistory([row({ season: 1, episode: 1 }), row({ type: 'movie', tmdbId: 603 })], fetchMeta);
    expect(out.map((x) => x.title)).toEqual(['Série', 'Film']);
    expect(out.map((x) => fallbackTitle(x))).toEqual(['Série', 'Film']);
    expect(out.every((x) => !x.poster)).toBe(true);
  });

  it('titre inconnu de TMDB et sans titre serveur : entrée masquée', async () => {
    const fetchMeta: MetaFetcher = async () => ({});
    expect(await enrichHistory([row({})], fetchMeta)).toEqual([]);
  });

  it('masque les entrées sans identifiant TMDB valide', async () => {
    const fetchMeta = vi.fn<MetaFetcher>(async () => ({ name: 'X' }));
    const bad = [row({ tmdbId: 0 }), row({ tmdbId: Number.NaN })];
    expect(usableHistory(bad)).toEqual([]);
    expect(await enrichHistory(bad, fetchMeta)).toEqual([]);
    expect(fetchMeta).not.toHaveBeenCalled();
  });
});
