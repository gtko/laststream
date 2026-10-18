import { describe, expect, it } from 'vitest';
import {
  audioLangOf, completeVideos, hasTrailerInLang, includeVideoLanguages, isTrailerCandidate, mergeVideos, pickTrailerKey,
  trailerFallbackTags, type TmdbVideo, videoTier,
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
