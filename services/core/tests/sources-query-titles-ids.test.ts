import { describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/sources/http.js';
import {
  getTitleVariants,
  nameMatchesTitles,
  nameTokens,
  releaseYear,
  releaseYearFits,
  yearMatches,
} from '../src/sources/query-titles.js';
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

  it('titre en tête de nom, suivi d’un marqueur : accepté, quel que soit le séparateur', () => {
    expect(nameMatchesTitles('Lupin.S03E01.VOSTFR.1080p', ['Lupin'])).toBe(true);
    expect(nameMatchesTitles('Breaking Bad S04 MULTI VFF', ['Breaking Bad'])).toBe(true);
    expect(nameMatchesTitles('Dune.Deuxieme.Partie.2024.FRENCH', ['Dune : Deuxième Partie'])).toBe(true);
    // Titre romaji : « Sousou no Frieren » est un titre connu ; « Frieren » seul ne commence pas le nom (voir le bloc strict).
    expect(nameMatchesTitles('Sousou.No.Frieren.S01E05.MULTi', ['Sousou no Frieren'])).toBe(true);
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

describe('nameMatchesTitles strict : titre exact en tête de nom, suivi d’un marqueur de fin', () => {
  it('Star Trek (1966) : rejette Strange New Worlds, Starfleet Academy, The Next Generation', () => {
    const titles = ['Star Trek'];
    expect(nameMatchesTitles('Star.Trek.Strange.New.Worlds.2022.S01E01.1080p.WEB', titles)).toBe(false);
    expect(nameMatchesTitles('Star Trek Strange New Worlds S01E01 MULTi', titles)).toBe(false);
    expect(nameMatchesTitles('Star.Trek.Starfleet.Academy.S01.1080p', titles)).toBe(false);
    expect(nameMatchesTitles('Star.Trek.The.Next.Generation.S01E01.VFF', titles)).toBe(false);
  });

  it('Star Trek (1966) : accepte le titre suivi d’une année, d’un SxxEyy ou d’une langue', () => {
    const titles = ['Star Trek'];
    expect(nameMatchesTitles('Star.Trek.1966.S01E01.1080p.WEB-DL', titles)).toBe(true);
    expect(nameMatchesTitles('Star Trek S01E01 MULTI', titles)).toBe(true);
    expect(nameMatchesTitles('Star.Trek.S01E01.VOSTFR.720p', titles)).toBe(true);
  });

  it('un mot ou un chiffre de suite (suite de film) ne ferme pas le titre', () => {
    expect(nameMatchesTitles('Star.Trek.II.The.Wrath.of.Khan.1982', ['Star Trek'])).toBe(false);
    expect(nameMatchesTitles('Star.Trek.2.Wrath.of.Khan.1080p', ['Star Trek'])).toBe(false);
  });

  it('titre qui ne commence pas le nom : rejeté (titre romaji ou mot en tête)', () => {
    expect(nameMatchesTitles('Sousou.No.Frieren.S01E05.MULTi', ['Frieren'])).toBe(false);
    expect(nameMatchesTitles('Dark.Star.Trek.S01E01', ['Star Trek'])).toBe(false);
  });

  it('groupe de tête entre crochets ignoré', () => {
    expect(nameMatchesTitles('[SubsPlease] Sousou no Frieren - 05 (1080p) [HEVC]', ['Sousou no Frieren'])).toBe(true);
    expect(nameMatchesTitles('[YTS.MX] Star Trek S01E01 MULTI', ['Star Trek'])).toBe(true);
  });

  it('ponctuation et apostrophes : Re:Zero, Les Carnets de l’apothicaire (forme collée ou séparée)', () => {
    expect(nameMatchesTitles('Re.Zero.S03E01.1080p', ['Re:Zero'])).toBe(true);
    expect(nameMatchesTitles('Les.Carnets.de.l.Apothicaire.S01E01.1080p', ["Les Carnets de l'apothicaire"])).toBe(true);
    expect(nameMatchesTitles('Les.Carnets.de.lApothicaire.S01E01.1080p', ["Les Carnets de l'apothicaire"])).toBe(true);
  });

  it('titre original ou alternatif (VO) : Jujutsu Kaisen matche même si le titre FR diffère', () => {
    expect(nameMatchesTitles('Jujutsu.Kaisen.S01E01.VOSTFR.1080p', ['Sorcery Fight', 'Jujutsu Kaisen'])).toBe(true);
    expect(nameMatchesTitles('Jujutsu.Kaisen.S01E01', ['Sorcery Fight'])).toBe(false);
  });

  it('année dans le titre (1923) et numéro absolu d’anime (One Piece 1071)', () => {
    expect(nameMatchesTitles('1923.S01E01.1080p.WEB', ['1923'])).toBe(true);
    expect(nameMatchesTitles('One.Piece.1071.VOSTFR.1080p', ['One Piece'])).toBe(true);
    expect(nameMatchesTitles('[SubsPlease] One Piece - 1071 (1080p) [HEVC]', ['One Piece'])).toBe(true);
    expect(nameMatchesTitles('One.Piece.Film.Red.2022.1080p', ['One Piece'])).toBe(false);
  });
});

describe('année de la release : films à ±1 an, séries pas antérieure à la première diffusion moins un an', () => {
  it('une année qui fait partie du titre n’est pas une année de sortie', () => {
    expect(releaseYear('Blade.Runner.2049.1080p', ['Blade Runner 2049'])).toBeUndefined();
    expect(yearMatches('Blade.Runner.2049.1080p', 2017, ['Blade Runner 2049'])).toBe(true);
    expect(yearMatches('Blade.Runner.2049.1080p', 2017, ['Blade Runner'])).toBe(false);
  });

  it('séries 1923 (première diffusion 2022) : titre seul accepté, saison récente acceptée, année trop ancienne rejetée', () => {
    const variants = { titles: ['1923'], year: 2022 };
    expect(releaseYearFits('1923.S01E01.1080p', variants, 'series')).toBe(true);
    expect(releaseYearFits('1923.2022.S01E01.1080p', variants, 'series')).toBe(true);
    expect(releaseYearFits('1923.2015.S01E01.1080p', variants, 'series')).toBe(false);
  });

  it('série Star Trek (1966) : 1966 et 1965 acceptés, 1950 rejeté', () => {
    const variants = { titles: ['Star Trek'], year: 1966 };
    expect(releaseYearFits('Star.Trek.1966.S01E01', variants, 'series')).toBe(true);
    expect(releaseYearFits('Star.Trek.1965.S01E01', variants, 'series')).toBe(true);
    expect(releaseYearFits('Star.Trek.1950.S01E01', variants, 'series')).toBe(false);
  });
});
