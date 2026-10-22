import { beforeEach, describe, expect, it } from 'vitest';
import {
  audioLangOf, captionParams, completeVideos, hasTrailerInLang, includeVideoLanguages, isTrailerCandidate, isVoVideo, mergeVideos,
  pickTrailer, pickTrailerKey, pickTrailers, titleScore, trailerFallbackTags, trailerLang, type TmdbVideo, type TrailerLang, videoTier,
} from '../src/data/trailers';

const fr = { lang: 'fr', tag: 'fr-FR', country: 'FR' };
const v = (o: Record<string, unknown>): TmdbVideo => ({
  site: 'YouTube', key: String(o.key), type: 'Trailer', official: true, iso_639_1: 'en', iso_3166_1: 'US',
  published_at: '2024-01-01T00:00:00Z', size: 1080, ...o,
});

describe('détection par le titre', () => {
  it('une VF étiquetée en anglais est doublée en français', () => {
    expect(audioLangOf(v({ name: 'Bande-annonce VF', iso_639_1: 'en' }))).toBe('fr');
    expect(audioLangOf(v({ name: 'Official Trailer', iso_639_1: 'en' }))).toBe('en');
    expect(audioLangOf(v({ name: 'Official Trailer', iso_639_1: null }))).toBeNull();
  });
  it('VF mal étiquetée en « en » est choisie avant une bande-annonce anglaise', () => {
    const videos = [v({ key: 'en', name: 'Official Trailer' }), v({ key: 'vf', name: 'VF Bande-annonce officielle' })];
    expect(pickTrailerKey(videos, fr)).toBe('vf');
  });
  it('VOSTFR vient après la VF mais avant l’anglais pur', () => {
    const en = v({ key: 'en', name: 'Official Trailer' });
    const vostfr = v({ key: 'vostfr', name: 'Bande-annonce VOSTFR' });
    const vf = v({ key: 'vf', name: 'Bande-annonce VF', iso_639_1: 'fr' });
    expect(pickTrailerKey([en, vostfr, vf], fr)).toBe('vf');
    expect(pickTrailerKey([en, vostfr], fr)).toBe('vostfr');
    expect(pickTrailerKey([en, vostfr], fr)).not.toBe('en');
    expect(videoTier(vostfr, fr)).toBeGreaterThan(videoTier(vf, fr));
    expect(videoTier(vostfr, fr)).toBeLessThan(videoTier(en, fr));
  });
  it('« sous-titré » et « subtitled » comptent comme sous-titres', () => {
    const en = v({ key: 'en', name: 'Official Trailer' });
    expect(pickTrailerKey([en, v({ key: 'st', name: 'Trailer sous-titré' })], fr)).toBe('st');
    expect(pickTrailerKey([en, v({ key: 'sub', name: 'Trailer (subtitled)' })], fr)).toBe('sub');
  });
  it('Teaser reste derrière Trailer à langue égale', () => {
    const teaser = v({ key: 'teaser', type: 'Teaser', name: 'Bande-annonce VF', iso_639_1: 'fr' });
    const trailer = v({ key: 'trailer', name: 'Bande-annonce VF', iso_639_1: 'fr' });
    expect(pickTrailerKey([teaser, trailer], fr)).toBe('trailer');
    expect(pickTrailerKey([teaser], fr)).toBe('teaser');
  });
  it('généralise aux autres langues (es, de, it)', () => {
    const es = { lang: 'es', tag: 'es-ES', country: 'ES' };
    const de = { lang: 'de', tag: 'de-DE', country: 'DE' };
    const it = { lang: 'it', tag: 'it-IT', country: 'IT' };
    expect(pickTrailerKey([v({ key: 'en' }), v({ key: 'doblado', name: 'Tráiler doblado' })], es)).toBe('doblado');
    expect(pickTrailerKey([v({ key: 'en' }), v({ key: 'omu', name: 'Trailer OmU' })], de)).toBe('omu');
    expect(pickTrailerKey([v({ key: 'en' }), v({ key: 'ita', name: 'Trailer doppiato' })], it)).toBe('ita');
    expect(pickTrailerKey([v({ key: 'en' }), v({ key: 'deu', name: 'Trailer synchronisiert' })], de)).toBe('deu');
  });
});

describe('exclusions du choix principal', () => {
  it('ignore featurettes, making-of, clips et bêtisiers même typés Trailer', () => {
    const en = v({ key: 'en', name: 'Official Trailer' });
    const feat = v({ key: 'feat', name: 'Featurette VF', iso_639_1: 'fr' });
    const bts = v({ key: 'bts', name: 'Behind the Scenes VF', iso_639_1: 'fr' });
    const clip = v({ key: 'clip', name: 'Clip VF', iso_639_1: 'fr' });
    const bloopers = v({ key: 'bloop', name: 'Bloopers', iso_639_1: 'fr' });
    const recap = v({ key: 'recap', type: 'Teaser', name: 'Recap VF', iso_639_1: 'fr' });
    for (const x of [feat, bts, clip, bloopers, recap]) expect(isTrailerCandidate(x)).toBe(false);
    expect(pickTrailerKey([feat, bts, clip, bloopers, recap, en], fr)).toBe('en');
    expect(pickTrailerKey([feat, bts], fr)).toBe('');
  });
  it('ignore les types autres que bande-annonce et teaser', () => {
    expect(pickTrailerKey([v({ key: 'f', type: 'Featurette', iso_639_1: 'fr' })], fr)).toBe('');
  });
});

describe('départage stable', () => {
  it('garde région, official, plus récent, 1080', () => {
    const ca = v({ key: 'ca', iso_639_1: 'fr', iso_3166_1: 'CA' });
    const frFr = v({ key: 'frFR', iso_639_1: 'fr', iso_3166_1: 'FR' });
    expect(pickTrailerKey([ca, frFr], fr)).toBe('frFR');
    expect(pickTrailerKey([ca, frFr], { lang: 'fr', tag: 'fr-CA', country: 'CA' })).toBe('ca');
    expect(pickTrailerKey([v({ key: 'a', official: false, name: 'VF' }), v({ key: 'b', name: 'VF' })], fr)).toBe('b');
    expect(pickTrailerKey([v({ key: 'old', name: 'VF' }), v({ key: 'new', name: 'VF', published_at: '2025-06-01T00:00:00Z' })], fr)).toBe('new');
    expect(pickTrailerKey([v({ key: 'sd', name: 'VF', size: 720 }), v({ key: 'hd', name: 'VF' })], fr)).toBe('hd');
  });
  it('est déterministe quel que soit l’ordre d’entrée', () => {
    const list = [v({ key: 'a', name: 'VOSTFR' }), v({ key: 'b', name: 'Official Trailer' }), v({ key: 'c', name: 'VF' })];
    expect(pickTrailerKey(list, fr)).toBe('c');
    expect(pickTrailerKey([...list].reverse(), fr)).toBe('c');
  });
});

describe('repli : langue, saison 1, régions, anglais', () => {
  type Call = { path: string; params: Record<string, string> };
  const fakeFetch = (answers: Record<string, TmdbVideo[]>) => {
    const calls: Call[] = [];
    const fetcher = async (path: string, params: Record<string, string>) => {
      calls.push({ path, params });
      const key = `${path}|${params.language}`;
      if (!(key in answers)) throw new Error('404');
      return { results: answers[key] };
    };
    return { calls, fetcher };
  };

  it('ne fait aucune requête quand une VF est déjà là', async () => {
    const list = [v({ key: 'vf', name: 'VF' })];
    const { calls, fetcher } = fakeFetch({});
    expect(await completeVideos(list, 'movie', 7, fr, fetcher)).toEqual(list);
    expect(calls).toHaveLength(0);
  });

  it('série : repli sur la saison 1 quand le niveau série n’a que de l’anglais', async () => {
    const series = [v({ key: 'en', name: 'Official Trailer' })];
    const { calls, fetcher } = fakeFetch({ 'tv/5/season/1/videos|fr-FR': [v({ key: 's1vf', name: 'Bande-annonce VF' })] });
    const out = await completeVideos(series, 'tv', 5, fr, fetcher);
    expect(pickTrailerKey(out, fr)).toBe('s1vf');
    expect(calls.map((c) => c.path)).toEqual(['tv/5/season/1/videos']);
    expect(calls[0].params).toEqual({ language: 'fr-FR', include_video_language: 'fr,en,null' });
  });

  it('film : essaie fr-FR puis les variantes régionales, en s’arrêtant dès qu’une VF apparaît', async () => {
    const pref = { lang: 'fr', tag: 'fr-CA', country: 'CA' };
    const { calls, fetcher } = fakeFetch({ 'movie/9/videos|fr-BE': [v({ key: 'be', name: 'Bande-annonce VF' })] });
    const out = await completeVideos([], 'movie', 9, pref, fetcher);
    expect(pickTrailerKey(out, pref)).toBe('be');
    expect(calls.map((c) => c.params.language)).toEqual(['fr-FR', 'fr-CA', 'fr-BE']);
    expect(trailerFallbackTags(fr)).toEqual(['fr-FR', 'fr-CA', 'fr-BE', 'fr-CH']);
  });

  it('repli anglais quand rien en français', async () => {
    const { calls, fetcher } = fakeFetch({ 'movie/3/videos|en-US': [v({ key: 'en', name: 'Official Trailer' })] });
    const out = await completeVideos([], 'movie', 3, fr, fetcher);
    expect(pickTrailerKey(out, fr)).toBe('en');
    expect(calls.map((c) => c.params.language)).toEqual(['fr-FR', 'fr-CA', 'fr-BE', 'fr-CH', 'en-US']);
  });

  it('une erreur TMDB ne casse pas le résultat existant', async () => {
    const list = [v({ key: 'en', name: 'Official Trailer' })];
    const boom = async () => {
      throw new Error('réseau');
    };
    expect(pickTrailerKey(await completeVideos(list, 'tv', 1, fr, boom), fr)).toBe('en');
  });

  it('demande include_video_language=<langue>,en,null et fusionne sans doublon', () => {
    expect(includeVideoLanguages(fr)).toBe('fr,en,null');
    const a = [v({ key: 'x' })];
    expect(mergeVideos(a, [v({ key: 'x' }), v({ key: 'y' })]).map((x) => x.key)).toEqual(['x', 'y']);
    expect(hasTrailerInLang([v({ key: 'en' })], fr)).toBe(false);
    expect(hasTrailerInLang([v({ key: 'vf', name: 'VF' })], fr)).toBe(true);
  });
});

describe('scénario : liste TMDB simulée', () => {
  it('fr VOST, fr VF, en official, sans langue → la VF', () => {
    const list = [
      v({ key: 'vostfr', name: 'Bande-annonce VOSTFR', iso_639_1: 'fr' }),
      v({ key: 'vf', name: 'Bande-annonce VF', iso_639_1: 'fr' }),
      v({ key: 'en', name: 'Official Trailer', iso_639_1: 'en', official: true }),
      v({ key: 'nul', name: 'Trailer', iso_639_1: null, official: true }),
    ];
    expect(pickTrailer(list, fr)).toEqual({ key: 'vf', vo: false });
  });

  it('pas de fr → anglais officiel, VO signalée, sous-titres français seulement dans ce cas', () => {
    const pick = pickTrailer([v({ key: 'en', name: 'Official Trailer', iso_639_1: 'en', official: true })], fr);
    expect(pick).toEqual({ key: 'en', vo: true });
    expect(captionParams(pick.vo, fr)).toBe('hl=fr&cc_lang_pref=fr&cc_load_policy=1');
    expect(captionParams(false, fr)).toBe('');
  });

  it('une VF choisie n’est pas marquée VO, un VOSTFR l’est', () => {
    expect(isVoVideo(v({ name: 'Bande-annonce VF', iso_639_1: 'fr' }), fr)).toBe(false);
    expect(isVoVideo(v({ name: 'Bande-annonce VOSTFR', iso_639_1: 'fr' }), fr)).toBe(true);
    expect(pickTrailer([], fr)).toEqual({ key: '', vo: false });
  });

  it('sans langue passe avant l’anglais', () => {
    expect(pickTrailerKey([v({ key: 'en', name: 'Official Trailer', iso_639_1: 'en' }), v({ key: 'nul', name: 'Trailer', iso_639_1: null })], fr)).toBe('nul');
  });

  it('langue secondaire passe avant l’anglais et les vidéos sans langue', () => {
    const pref: TrailerLang = { ...fr, secondary: 'es' };
    const en = v({ key: 'en', name: 'Official Trailer', iso_639_1: 'en' });
    const nul = v({ key: 'nul', name: 'Trailer', iso_639_1: null });
    const es = v({ key: 'es', name: 'Tráiler oficial', iso_639_1: 'es' });
    expect(pickTrailerKey([en, nul, es], pref)).toBe('es');
    expect(pickTrailerKey([en, nul], pref)).toBe('nul');
  });

  it('teaser VF avant bande-annonce anglaise : la langue prime sur la nature', () => {
    expect(pickTrailerKey([v({ key: 'en', name: 'Official Trailer' }), v({ key: 'tvf', type: 'Teaser', name: 'Teaser VF', iso_639_1: 'fr' })], fr)).toBe('tvf');
  });

  it('clip après toutes les bandes-annonces et teasers, mais admis en dernier recours', () => {
    const clipVf = v({ key: 'clip', type: 'Clip', name: 'VF Clip', iso_639_1: 'fr' });
    const en = v({ key: 'en', name: 'Official Trailer', iso_639_1: 'en' });
    expect(pickTrailerKey([clipVf, en], fr)).toBe('en');
    expect(pickTrailerKey([clipVf], fr)).toBe('clip');
    expect(isTrailerCandidate(v({ key: 'c', type: 'Clip', name: 'Clip' }))).toBe(true);
    expect(isTrailerCandidate(v({ key: 'c', type: 'Trailer', name: 'Clip VF' }))).toBe(false);
  });
});

describe('include_video_language', () => {
  it('langue, secondaire (anglais à défaut), sans langue, anglais, sans doublon', () => {
    expect(includeVideoLanguages(fr)).toBe('fr,en,null');
    expect(includeVideoLanguages({ ...fr, secondary: 'es' })).toBe('fr,es,null,en');
    expect(includeVideoLanguages({ ...fr, secondary: 'en' })).toBe('fr,en,null');
    expect(includeVideoLanguages({ lang: 'en', tag: 'en-US', country: 'US' })).toBe('en,null');
  });
});

describe('langue des bandes-annonces lue dans les réglages', () => {
  beforeEach(() => localStorage.clear());

  it('audio principal et secondaire des réglages', () => {
    localStorage.setItem('laststream.langprefs', JSON.stringify({ audio: 'fr', audio2: 'es' }));
    expect(trailerLang()).toMatchObject({ lang: 'fr', tag: 'fr-FR', secondary: 'es' });
  });

  it('version originale en secondaire : pas de secondaire', () => {
    localStorage.setItem('laststream.langprefs', JSON.stringify({ audio: 'fr', audio2: 'vo' }));
    expect(trailerLang().secondary).toBeUndefined();
  });

  it('version originale en principal : repli sur l’ancien réglage de langue', () => {
    localStorage.setItem('laststream.langprefs', JSON.stringify({ audio: 'vo', audio2: 'none' }));
    expect(trailerLang().lang).toBe('fr');
  });
});

describe('listes TMDB réelles (fr) : promo, VOST, plateforme', () => {
  const souvenirs = [
    v({ key: 'promo', name: 'L\'île des Souvenirs - Beach Art à Deauville [Au cinéma le 21 octobre]', iso_639_1: 'fr', iso_3166_1: 'FR', official: true, published_at: '2026-10-15T10:00:00Z' }),
    v({ key: 'vf', name: 'Nouvelle bande-annonce officielle VF', iso_639_1: 'fr', iso_3166_1: 'FR', official: true, published_at: '2026-09-01T10:00:00Z' }),
    v({ key: 'vost', name: 'Nouvelle bande-annonce officielle VOST', iso_639_1: 'fr', iso_3166_1: 'FR', official: true, published_at: '2026-09-02T10:00:00Z' }),
  ];
  it('L\'île des Souvenirs : la VF officielle, jamais la promo de Deauville', () => {
    expect(pickTrailer(souvenirs, fr)).toEqual({ key: 'vf', vo: false });
    expect(pickTrailer([...souvenirs].reverse(), fr)).toEqual({ key: 'vf', vo: false });
  });

  const avatar = [
    v({ key: 'disney', name: 'Avatar : De Feu et de Cendres - Bande-annonce officielle | Disney+', iso_639_1: 'fr', iso_3166_1: 'FR', official: true, published_at: '2025-11-05T10:00:00Z' }),
    v({ key: '20th', name: 'Avatar : De Feu et de Cendres - Bande-annonce officielle (VF) | 20th Century Studios', iso_639_1: 'fr', iso_3166_1: 'FR', official: true, published_at: '2025-10-01T10:00:00Z' }),
    v({ key: 'premiere-vf', name: 'Première bande-annonce (VF)', iso_639_1: 'fr', iso_3166_1: 'FR', official: true, published_at: '2025-06-01T10:00:00Z' }),
    v({ key: 'premiere-vost', name: 'Première bande-annonce (VOST)', iso_639_1: 'en', iso_3166_1: 'US', official: true, published_at: '2025-06-02T10:00:00Z' }),
  ];
  it('Avatar : la VF officielle du studio, pas la version Disney+', () => {
    expect(pickTrailerKey(avatar, fr)).toBe('20th');
    expect(pickTrailerKey([...avatar].reverse(), fr)).toBe('20th');
    expect(pickTrailerKey(avatar.filter((x) => x.key !== '20th'), fr)).toBe('premiere-vf');
  });

  it('VOST jamais choisie quand une VF existe, même plus ancienne et sans « officielle »', () => {
    const vost = v({ key: 'vost', name: 'Nouvelle bande-annonce officielle VOST', iso_639_1: 'fr', published_at: '2026-09-02T10:00:00Z' });
    const vf = v({ key: 'vf', name: 'Bande-annonce VF', iso_639_1: 'fr', published_at: '2020-01-01T10:00:00Z', official: false });
    expect(pickTrailerKey([vost, vf], fr)).toBe('vf');
  });

  it('promo jamais choisie quand une bande-annonce officielle existe, quelle que soit sa langue', () => {
    const promo = souvenirs[0];
    const enOfficial = v({ key: 'en', name: 'Official Trailer', iso_639_1: 'en', official: true });
    expect(pickTrailerKey([promo, enOfficial], fr)).toBe('en');
    expect(pickTrailerKey([promo, souvenirs[1]], fr)).toBe('vf');
    expect(pickTrailerKey([promo], fr)).toBe('promo');
  });

  it('mention explicite de la VF avant une vidéo fr sans mention de langue', () => {
    const sansMention = v({ key: 'nue', name: 'Official Trailer', iso_639_1: 'fr', official: false });
    const explicite = v({ key: 'vf', name: 'Bande-annonce VF', iso_639_1: 'en', official: false });
    expect(pickTrailerKey([sansMention, explicite], fr)).toBe('vf');
  });

  it('titleScore : VF explicite, officielle, nouveauté, plateforme', () => {
    expect(titleScore(v({ name: 'Bande-annonce officielle (VF)' }), fr)).toBe(7);
    expect(titleScore(v({ name: 'Nouvelle bande-annonce officielle VF' }), fr)).toBe(9);
    expect(titleScore(v({ name: 'Bande-annonce officielle | Disney+' }), fr)).toBe(2);
    expect(titleScore(v({ name: 'Official Trailer' }), fr)).toBe(0 + 3);
    expect(titleScore(v({ name: 'Trailer' }), fr)).toBe(0);
  });
});

describe('pickTrailers', () => {
  const list = [v({ key: 'a', name: 'Official Trailer' }), v({ key: 'b', name: 'Trailer 2' }), v({ key: 'c', name: 'Final Trailer' })];
  it('premier élément identique à pickTrailer', () => {
    expect(pickTrailers(list, fr)[0]).toEqual(pickTrailer(list, fr));
  });
  it('ne répète pas une même clé', () => {
    const dup = [...list, v({ key: 'a', name: 'Official Trailer (copie)' })];
    const keys = pickTrailers(dup, fr).map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(3);
  });
  it('ignore les clés vides', () => {
    expect(pickTrailers([v({ key: '' }), ...list], fr).every((t) => t.key !== '')).toBe(true);
  });
  it('tronque à limit', () => {
    expect(pickTrailers(list, fr, 2)).toHaveLength(2);
    expect(pickTrailers(list, fr, 1)).toHaveLength(1);
  });
  it('liste vide ou absente : rien', () => {
    expect(pickTrailers([], fr)).toEqual([]);
    expect(pickTrailers(null, fr)).toEqual([]);
  });
});
