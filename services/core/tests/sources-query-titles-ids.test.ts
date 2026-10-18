import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/sources/http.js';
import { getTitleVariants, nameMatchesTitles, nameTokens } from '../src/sources/query-titles.js';
import type { ContentRef } from '../src/types.js';

const TOKEN = 'tmdb-read-token-XYZ123';
const API = 'https://api.themoviedb.org/3';
const SERIES: ContentRef = { type: 'series', id: 'tt9000001', imdbId: 'tt9000001' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Faux fetch TMDB : une réponse par URL exacte ; toute URL non prévue répond 500. Aucun réseau. */
function tmdb(table: Record<string, () => Response>) {
  const mock = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const handler = table[String(input)];
    return handler ? handler() : new Response('unexpected', { status: 500 });
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

const severance = {
  [`${API}/find/tt9000001?external_source=imdb_id`]: () => json({ movie_results: [], tv_results: [{ id: 4242 }] }),
  [`${API}/tv/4242?language=en-US`]: () => json({ name: 'Severance', original_name: 'Severance', first_air_date: '2022-02-18' }),
  [`${API}/tv/4242?language=fr-FR`]: () => json({ name: 'Severance', original_name: 'Severance', first_air_date: '2022-02-18' }),
};

describe('getTitleVariants : identifiant TVDB des séries (TMDB external_ids)', () => {
  it('série : tvdbId renvoyé par external_ids (appel authentifié, sans jeton dans l’URL)', async () => {
    const { fetch, mock } = tmdb({
      ...severance,
      [`${API}/tv/4242/external_ids`]: () => json({ imdb_id: 'tt9000001', tvdb_id: 371028 }),
    });

    const variants = await getTitleVariants(SERIES, { tmdbToken: TOKEN, fetch, cache: new Map() });

    expect(variants).toEqual({ titles: ['Severance'], year: 2022, fr: 'Severance', en: 'Severance', tvdbId: 371028 });
    const urls = mock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`${API}/tv/4242/external_ids`);
    expect(urls.some((url) => url.includes(TOKEN))).toBe(false);
  });

  it('external_ids en échec : résultat complet sans tvdbId', async () => {
    const { fetch } = tmdb(severance);

    const variants = await getTitleVariants(SERIES, { tmdbToken: TOKEN, fetch, cache: new Map() });

    expect(variants).toEqual({ titles: ['Severance'], year: 2022, fr: 'Severance', en: 'Severance' });
    expect(variants.tvdbId).toBeUndefined();
  });
});

describe('nameMatchesTitles : le nom de la release contient le titre de la série', () => {
  it('jetons : sans accents, minuscules, apostrophes retirées, séparateurs ignorés', () => {
    expect(nameTokens("Frieren: Beyond Journey's End")).toEqual(['frieren', 'beyond', 'journeys', 'end']);
    expect(nameTokens('Dune : Deuxième Partie')).toEqual(['dune', 'deuxieme', 'partie']);
  });

  it('titre présent en séquence dans le nom : accepté, quel que soit le séparateur', () => {
    expect(nameMatchesTitles('Lupin.S03E01.VOSTFR.1080p', ['Lupin'])).toBe(true);
    expect(nameMatchesTitles('Breaking Bad S04 MULTI VFF', ['Breaking Bad'])).toBe(true);
    expect(nameMatchesTitles('Dune.Deuxieme.Partie.2024.FRENCH', ['Dune : Deuxième Partie'])).toBe(true);
    expect(nameMatchesTitles('Sousou.No.Frieren.S01E05.MULTi', ['Frieren'])).toBe(true);
  });

  it('pack d’une autre série (même saison) : rejeté ; un mot seul ne suffit pas', () => {
    expect(nameMatchesTitles('Simon.2016.S03.VFF.1080p.WEB', ['Lupin'])).toBe(false);
    expect(nameMatchesTitles('Molang.2015.S03.VFF.1080p', ['Lupin'])).toBe(false);
    expect(nameMatchesTitles('Breaking.Bad.S04', ['Bad Breaking'])).toBe(false);
  });

  it('sans titre exploitable (vide, ou seulement de la ponctuation/japonais) : vrai, rien à vérifier', () => {
    expect(nameMatchesTitles('Quelque.Chose.S01E01', [])).toBe(true);
    expect(nameMatchesTitles('Quelque.Chose.S01E01', ['葬送のフリーレン'])).toBe(true);
  });
});
