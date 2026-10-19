import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addonUrl, isConfigured, ltUrl, reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { cachedRequest, clearCache, inFlightCount, limited, MAX_IN_FLIGHT, requestJson } from '../src/data/transport';
import { getRegion, setRegion } from '../src/data/prefs';
import { episodeStreamId, groupByQuality, pickAutoplay, planBandwidth, sortStreams, stremioId } from '../src/data/sources';
import { getLaststream } from '../src/data/stream';
import { canonSummary, normalizeCanon, pickAiredEpisode, tmdbShape } from '../src/data/series';
import { hasProviders, movieAvailability } from '../src/data/released';
import { episodeIndex, newEpisodeCount } from '../src/data/episodes';
import { groupByDate, mergeEpisodes, monthGrid, movieReleases } from '../src/data/calendar';
import { ADULT_ROWS, activeRows, Appearances, KID_ROWS, kidBase, makeCtx, passesQuality, pickSeed, PROBES, rowById } from '../src/data/rows';
import { compactItems, packRecs, todayLocal, unpackRecs } from '../src/data/recs';
import { pickTrailerKey, sortVideos } from '../src/data/trailers';
import { certLteFor, kidGenreOk, sectionAllowed } from '../src/data/kid';
import { LocalUserStore, LIBRARY_KEY } from '../src/data/userStore';
import { onAccent, readTheme, resolveTheme } from '../src/data/theme';

const stream = (resolution: string, score: number, extra: Record<string, unknown> = {}) => ({
  url: 'https://x/' + score,
  laststream: {
    resolution, height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score,
    estBitrateKbps: 4000, ...extra,
  },
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearCache();
});

describe('config lastAddon', () => {
  it('reprend la clé laststream.lastaddon de l’ancienne application', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'abc_DEF-1' }));
    reloadSettings();
    expect(isConfigured()).toBe(true);
    expect(ltUrl('tmdb/movie/550', { region: 'FR' })).toBe('http://localhost:7000/abc_DEF-1/lt/tmdb/movie/550?region=FR');
    expect(addonUrl('stream/movie/tt1.json')).toBe('http://localhost:7000/abc_DEF-1/stream/movie/tt1.json');
  });

  it('n’est pas configuré sans clé', () => {
    reloadSettings();
    expect(isConfigured()).toBe(false);
    expect(() => ltUrl('tv/channels')).toThrow();
  });
});

describe('transport', () => {
  it('met en cache et partage les requêtes identiques en vol', async () => {
    const load = vi.fn(async () => 42);
    const [a, b] = await Promise.all([cachedRequest('k', load), cachedRequest('k', load)]);
    expect([a, b]).toEqual([42, 42]);
    await cachedRequest('k', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ne met pas les erreurs en cache', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(1);
    await expect(cachedRequest('e', load)).rejects.toThrow();
    expect(await cachedRequest('e', load)).toBe(1);
  });

  it('ne met jamais en cache les playlists HLS en direct', async () => {
    const load = vi.fn(async () => 'pl');
    const key = 'http://x/CFG/lt/tv/hls?u=a&s=b';
    await cachedRequest(key, load);
    await cachedRequest(key, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('réessaie après une réponse 429 en respectant Retry-After', async () => {
    const answers = [429, 429, 200];
    vi.stubGlobal('fetch', vi.fn(async () => {
      const code = answers.shift()!;
      return code === 200 ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    }));
    const t0 = Date.now();
    await expect(requestJson('http://x/y')).resolves.toEqual({ ok: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(answers).toHaveLength(0);
  });

  it('limite à 6 requêtes en vol', async () => {
    let peak = 0;
    const release: Array<() => void> = [];
    const jobs = Array.from({ length: 10 }, () =>
      limited(
        () =>
          new Promise<void>((resolve) => {
            peak = Math.max(peak, inFlightCount());
            release.push(resolve);
          }),
      ),
    );
    await Promise.resolve();
    expect(release.length).toBe(MAX_IN_FLIGHT);
    while (release.length) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(inFlightCount()).toBe(0);
  });
});

describe('délai des requêtes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejette une requête sans réponse à l’échéance et libère son créneau', async () => {
    // fetch qui ne répond jamais et ignore le signal : seul le délai peut la terminer.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await expect(requestJson('http://x/lent', { timeoutMs: 30 })).rejects.toMatchObject({ kind: 'network' });
    expect(inFlightCount()).toBe(0);
  });

  it('après six requêtes bloquées, une septième passe une fois leur délai écoulé', async () => {
    const fetchMock = vi.fn();
    for (let i = 0; i < MAX_IN_FLIGHT; i += 1) fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    fetchMock.mockImplementation(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const blocked = Array.from({ length: MAX_IN_FLIGHT }, () =>
      expect(requestJson('http://x/bloque', { timeoutMs: 30 })).rejects.toMatchObject({ kind: 'network' }),
    );
    await expect(requestJson('http://x/suivante')).resolves.toEqual({ ok: true });
    await Promise.all(blocked);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);
    expect(inFlightCount()).toBe(0);
  });
});

describe('profil enfant : certification et genres', () => {
  it('traduit l’âge en certification TMDB du pays', () => {
    expect(certLteFor('FR', 10)).toBe('10');
    expect(certLteFor('FR', 12)).toBe('12');
    expect(certLteFor('fr', 14)).toBe('16');
    expect(certLteFor('CA', 10)).toBe('PG');
    expect(certLteFor('XX', 10)).toBeNull();
  });
  it('exige un genre jeunesse', () => {
    expect(kidGenreOk([28, 16])).toBe(true);
    expect(kidGenreOk([28, 53])).toBe(false);
    expect(kidGenreOk([])).toBe(false);
    expect(kidGenreOk(undefined)).toBe(false);
  });
  it('limite la TV jeunesse aux sections cochées', () => {
    expect(sectionAllowed([], 'dessins')).toBe(true);
    expect(sectionAllowed([], 'tv')).toBe(false);
    expect(sectionAllowed(['tv', 'dessins'], 'tv')).toBe(true);
    expect(sectionAllowed(['dessins'], 'famille')).toBe(false);
  });
});

describe('bandes-annonces : langue préférée', () => {
  const fr = { lang: 'fr', tag: 'fr-FR', country: 'FR' };
  const v = (o: Record<string, unknown>) => ({ site: 'YouTube', key: String(o.key), type: 'Trailer', official: true, iso_639_1: 'fr', iso_3166_1: 'FR', published_at: '2024-01-01T00:00:00Z', size: 1080, ...o });
  it('suit l’ordre : même langue bande-annonce, teaser, autre, anglais, reste', () => {
    expect(pickTrailerKey([v({ key: 'en', iso_639_1: 'en' }), v({ key: 'frTeaser', type: 'Teaser' }), v({ key: 'frClip', type: 'Clip' })], fr)).toBe('frTeaser');
    expect(pickTrailerKey([v({ key: 'en', iso_639_1: 'en' }), v({ key: 'de', iso_639_1: 'de' })], fr)).toBe('en');
    expect(pickTrailerKey([v({ key: 'enT', iso_639_1: 'en', type: 'Teaser' }), v({ key: 'de', iso_639_1: 'de' })], fr)).toBe('enT');
    expect(pickTrailerKey([v({ key: 'de', iso_639_1: 'de' })], fr)).toBe('de');
    expect(pickTrailerKey([], fr)).toBe('');
  });
  it('départage : région, official, plus récent, 1080', () => {
    const ca = v({ key: 'ca', iso_3166_1: 'CA' });
    const frFr = v({ key: 'frFR' });
    expect(pickTrailerKey([ca, frFr], fr)).toBe('frFR');
    expect(pickTrailerKey([ca, frFr], { lang: 'fr', tag: 'fr-CA', country: 'CA' })).toBe('ca');
    expect(pickTrailerKey([v({ key: 'a', official: false }), v({ key: 'b' })], fr)).toBe('b');
    expect(pickTrailerKey([v({ key: 'old' }), v({ key: 'new', published_at: '2025-06-01T00:00:00Z' })], fr)).toBe('new');
    expect(pickTrailerKey([v({ key: 'sd', size: 720 }), v({ key: 'hd' })], fr)).toBe('hd');
  });
  it('classe la rangée Bonus par type puis par langue', () => {
    const list = [v({ key: 'a', iso_639_1: 'en', type: 'Teaser' }), v({ key: 'b', type: 'Teaser' }), v({ key: 'c', iso_639_1: 'en' })];
    expect(sortVideos(list, (x) => (x.type === 'Trailer' ? 0 : 1), fr).map((x) => x.key)).toEqual(['c', 'b', 'a']);
  });
});

describe('recommandations du jour', () => {
  it('découpe la liste en morceaux de moins de 4 Ko et la recompose', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ i, t: 'm' as const, n: 'Titre ' + i, p: '/p' + i + '.jpg', y: '2024', r: 'Parce que '.repeat(12) }));
    const packed = packRecs({ date: '2026-10-18', items });
    const chunks = Object.entries(packed).filter(([k, v]) => /^aiRecs\d+$/.test(k) && v);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(([, v]) => expect(JSON.stringify(v).length).toBeLessThan(4096));
    expect(unpackRecs(packed)).toEqual({ date: '2026-10-18', items });
    expect(unpackRecs({})).toBeNull();
  });
  it('compacte la réponse de l’IA sans doublon ni titre sans affiche', () => {
    const out = compactItems([
      { id: 1, media_type: 'movie', title: 'A', poster_path: '/a', reason_fr: 'r' },
      { id: 1, media_type: 'movie', title: 'A', poster_path: '/a' },
      { id: 2, media_type: 'tv', name: 'B', poster_path: null },
      { id: 1, media_type: 'tv', name: 'C', poster_path: '/c', first_air_date: '2020-02-02' },
    ]);
    expect(out.map((x) => x.n)).toEqual(['A', 'C']);
    expect(out[1].y).toBe('2020');
  });
  it('donne le jour local', () => {
    expect(todayLocal(new Date(2026, 9, 18, 23, 59))).toBe('2026-10-18');
  });
});

describe('qualité des rangées et graines', () => {
  it('écarte actualités, talk-shows, téléréalité et titres trop peu votés', () => {
    expect(passesQuality({ type: 'tv', genreIds: [10763], votes: 5000 })).toBe(false); // Tagesschau
    expect(passesQuality({ type: 'tv', genreIds: [10767, 35], votes: 900 })).toBe(false); // talk-show
    expect(passesQuality({ type: 'tv', genreIds: [10764], votes: 900 })).toBe(false);
    expect(passesQuality({ type: 'tv', genreIds: [18], votes: 99 })).toBe(false);
    expect(passesQuality({ type: 'tv', genreIds: [18], votes: 100 })).toBe(true);
    expect(passesQuality({ type: 'movie', genreIds: [28], votes: 199 })).toBe(false);
    expect(passesQuality({ type: 'movie', genreIds: [28], votes: 200 })).toBe(true);
    expect(passesQuality({ type: 'movie', genreIds: [28] })).toBe(true); // nombre de votes inconnu
  });
  it('envoie la disponibilité du pays et l’exclusion des genres bruit dans les requêtes génériques', () => {
    const ctx = makeCtx('CH', null, new Date(2026, 9, 18));
    const series = rowById('series')!.fetch as { k: 'discover'; params: (c: typeof ctx) => Record<string, string> };
    expect(series.params(ctx)).toMatchObject({ watch_region: 'CH', with_watch_monetization_types: 'flatrate|free|ads|rent|buy', without_genres: '10763,10767,10764', 'vote_count.gte': '100' });
    const films = rowById('films')!.fetch as { k: 'discover'; params: (c: typeof ctx) => Record<string, string> };
    expect(films.params(ctx)).toMatchObject({ watch_region: 'CH', 'vote_count.gte': '200' });
  });
  it('une graine ne pilote qu’une rangée : on prend la suivante', () => {
    const used = new Set<string>(['tv:1']);
    expect(pickSeed([{ key: 'tv:1' }, { key: 'movie:2' }, { key: 'tv:3' }], used)).toEqual({ key: 'movie:2' });
    expect(pickSeed([{ key: 'tv:1' }], used)).toBeUndefined();
  });
});

describe('registre des rangées', () => {
  it('a des identifiants uniques et des sondes pour chaque paramètre à vérifier', () => {
    const ids = [...ADULT_ROWS, ...KID_ROWS].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    [...ADULT_ROWS, ...KID_ROWS].forEach((r) => (r.needs ?? []).forEach((p) => expect(PROBES[p]).toBeDefined()));
    expect(ADULT_ROWS.length).toBeGreaterThanOrEqual(45);
    expect(KID_ROWS.length).toBeGreaterThanOrEqual(20);
  });
  it('applique saisons et rubriques autorisées', () => {
    const oct = makeCtx('FR', null, new Date(2026, 9, 18));
    const dec = makeCtx('FR', null, new Date(2026, 11, 3));
    expect(activeRows(oct, false, () => true).some((r) => r.id === 'halloween')).toBe(true);
    expect(activeRows(dec, false, () => true).some((r) => r.id === 'halloween')).toBe(false);
    expect(activeRows(dec, false, () => true).some((r) => r.id === 'noel')).toBe(true);
    const kid = makeCtx('FR', 10, new Date(2026, 5, 3));
    expect(activeRows(kid, true, () => true).every((r) => r.kid)).toBe(true);
    expect(activeRows(kid, true, (s) => s !== 'disney').some((r) => r.id === 'pixar')).toBe(false);
  });
  it('construit la base enfant : certification du pays et genres jeunesse', () => {
    const p = kidBase(makeCtx('FR', 10), 'movie');
    expect(p).toMatchObject({ certification_country: 'FR', 'certification.lte': '10', with_genres: '16|10751' });
    expect(kidBase(makeCtx('FR', 10), 'tv', '10762', 0)['certification.lte']).toBe('U');
  });
  it('limite à deux apparitions par titre', () => {
    const a = new Appearances();
    a.commit('movie:1');
    expect(a.canShow('movie:1')).toBe(true);
    a.commit('movie:1');
    expect(a.canShow('movie:1')).toBe(false);
    expect(a.canShow('movie:2')).toBe(true);
  });
});

describe('nouveaux épisodes et calendrier', () => {
  const seasons = [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 10 }, { season_number: 2, episode_count: 8 }];
  it('compte les épisodes diffusés après le dernier vu', () => {
    expect(newEpisodeCount(seasons, { season_number: 2, episode_number: 5 }, [{ season: 1, episode: 10 }])).toBe(5);
    expect(newEpisodeCount(seasons, { season_number: 2, episode_number: 5 }, [{ season: 2, episode: 5 }])).toBe(0);
    expect(newEpisodeCount(seasons, { season_number: 2, episode_number: 5 }, [{ season: 1, episode: 3 }, { season: 2, episode: 1 }])).toBe(4);
    expect(newEpisodeCount(seasons, { season_number: 2, episode_number: 5 }, [])).toBe(0);
    expect(newEpisodeCount(seasons, { season_number: 2, episode_number: 5 }, [], true)).toBe(15);
    expect(newEpisodeCount(seasons, null, [{ season: 1, episode: 1 }])).toBe(0);
    expect(episodeIndex(seasons, 2, 1)).toBe(11);
  });
  it('construit la grille du mois (semaines du lundi)', () => {
    const weeks = monthGrid(2026, 10); // 1er octobre 2026 : jeudi
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]).toEqual({ date: '2026-09-28', inMonth: false });
    expect(weeks[0][3]).toEqual({ date: '2026-10-01', inMonth: true });
    expect(weeks[4][6].date).toBe('2026-11-01');
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });
  it('sépare cinéma et streaming, et regroupe les épisodes du jour', () => {
    const rel = movieReleases([{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: '2026-10-20T00:00:00.000Z' }, { type: 4, release_date: '2027-01-10T00:00:00.000Z' }, { type: 3, release_date: '2026-10-22T00:00:00.000Z' }] }], 'FR');
    expect(rel).toEqual([{ date: '2026-10-20', label: 'Au cinéma' }, { date: '2027-01-10', label: 'En streaming' }]);
    expect(movieReleases([], 'FR', '2026-12-25')).toEqual([{ date: '2026-12-25', label: 'Au cinéma' }]);
    const ev = (n: number) => ({ date: '2026-10-20', kind: 'episode' as const, key: 'tv:1', title: 'S', poster: '', label: 'S2 É' + n });
    const merged = mergeEpisodes([ev(5), ev(6), ev(7)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe('S2 É5–É7');
    expect(groupByDate(merged).get('2026-10-20')).toHaveLength(1);
  });
});

describe('disponibilité d’un film', () => {
  const today = '2026-10-18';
  const fr = (...rs: Array<[number, string]>) => [{ iso_3166_1: 'FR', release_dates: rs.map(([type, release_date]) => ({ type, release_date })) }];
  it('disponible avec un fournisseur ou une sortie numérique / physique / télé passée', () => {
    expect(movieAvailability(fr([3, '2026-10-01']), 'FR', '2026-10-01', today, true).available).toBe(true);
    expect(movieAvailability(fr([3, '2026-08-01'], [4, '2026-10-10']), 'FR', '2026-08-01', today, false).available).toBe(true);
    expect(movieAvailability(fr([5, '2026-10-18']), 'FR', '2026-08-01', today, false).available).toBe(true);
    expect(movieAvailability(fr([6, '2026-10-17']), 'FR', '2026-08-01', today, false).available).toBe(true);
  });
  it('seulement en salle, même ancienne : au cinéma, pas jouable (plus de repli à 45 jours)', () => {
    const a = movieAvailability(fr([3, '2026-01-05']), 'FR', '2026-01-05', today, false);
    expect(a).toEqual({ available: false, cinemaSince: '2026-01-05' });
    expect(movieAvailability(fr([3, '2026-10-01'], [4, '2026-12-20']), 'FR', '2026-10-01', today, false)).toEqual({ available: false, cinemaSince: '2026-10-01' });
  });
  it('sans date dans la région : États-Unis, sinon n’importe quelle région, sinon la date principale', () => {
    const us = [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2026-09-01' }] }];
    expect(movieAvailability(us, 'FR', null, today, false).available).toBe(true);
    const other = [{ iso_3166_1: 'JP', release_dates: [{ type: 3, release_date: '2026-09-01' }] }];
    expect(movieAvailability(other, 'FR', '2026-09-01', today, false).available).toBe(false);
    expect(movieAvailability([], 'FR', '2026-09-01', today, false).available).toBe(true);
    expect(movieAvailability([], 'FR', '2027-01-01', today, false).available).toBe(false);
    expect(movieAvailability(fr([4, '2027-01-01']), 'FR', '2027-01-01', today, false)).toEqual({ available: false, cinemaSince: null });
  });
  it('lit les fournisseurs de la région', () => {
    expect(hasProviders({ results: { FR: { rent: [{}] } } }, 'FR')).toBe(true);
    expect(hasProviders({ results: { FR: { rent: [] } } }, 'FR')).toBe(false);
    expect(hasProviders({ results: { US: { flatrate: [{}] } } }, 'FR')).toBe(false);
    expect(hasProviders(undefined, 'FR')).toBe(false);
  });
});

describe('affiche typographique', () => {
  it('donne une palette stable, sombre et propre à chaque titre', async () => {
    const { palette, titleSize, hashTitle } = await import('../src/ui/typo.js');
    expect(palette('Sabaya')).toEqual(palette('Sabaya'));
    expect(hashTitle('Sabaya')).not.toBe(hashTitle('Positano'));
    const hues = new Set(['Sabaya', 'Positano', 'Riverrun', 'Memento', 'Gone Girl', 'Loki'].map((t) => palette(t).hue));
    expect(hues.size).toBeGreaterThanOrEqual(5);
    const light = (c: string) => Number(/ (\d+)%\)$/.exec(c)![1]);
    ['Sabaya', 'Riverrun', 'Memento'].forEach((t) => { expect(light(palette(t).c1)).toBeLessThanOrEqual(22); expect(light(palette(t).c2)).toBeLessThanOrEqual(12); });
    expect(titleSize('Loki')).toBeGreaterThan(titleSize('Don’t Forget Me Tomorrow Because'));
  });
  it('génère le titre, un monogramme, l’année et le genre', async () => {
    const { fallbackHTML } = await import('../src/ui/typo.js');
    const html = fallbackHTML({ name: 'Star Trek <Discovery>', year: '2017', genre: 'Science-fiction', type: 'tv' });
    expect(html).toContain('Star Trek &lt;Discovery&gt;');
    expect(html).toContain('>ST<');
    expect(html).toContain('2017 · Science-fiction');
    expect(html).toContain('--tp1:hsl(');
  });
});

describe('structure canonique des séries', () => {
  const raw = { source: 'tvdb', seasons: [
    { season_number: 2, episodes: [{ episode_number: 1, aired: '2022-03-01', title: 'B' }] },
    { seasonNumber: 1, name: 'S1', episodes: [{ number: 2, name: 'Deux', airDate: '2021-01-08', absoluteNumber: 2, still_path: '/x.jpg' }, { number: 1, name: 'Un', air_date: '2021-01-01', image: 'https://i/x.png' }] },
    { number: 'x', episodes: [] },
  ] };
  it('accepte les variantes de noms de champs et trie saisons et épisodes', () => {
    const c = normalizeCanon(raw)!;
    expect(c.seasons.map((s) => s.number)).toEqual([1, 2]);
    expect(c.seasons[0].episodes.map((e) => e.episode)).toEqual([1, 2]);
    expect(c.seasons[0].episodes[0]).toMatchObject({ name: 'Un', airDate: '2021-01-01', still: 'https://i/x.png' });
    expect(c.seasons[0].episodes[1]).toMatchObject({ absolute: 2, still: '/x.jpg' });
    expect(c.seasons[1].airDate).toBe('2022-03-01');
    expect(normalizeCanon(null)).toBeNull();
    expect(normalizeCanon({ seasons: [] })).toBeNull();
  });
  it('résume : saisons au format TMDB, dernier épisode diffusé, prochain, compteurs', () => {
    const c = normalizeCanon(raw)!;
    const s = canonSummary(c, '2022-01-01');
    expect(s.seasons).toEqual([
      { season_number: 1, episode_count: 2, air_date: '2021-01-01', name: 'S1' },
      { season_number: 2, episode_count: 1, air_date: '2022-03-01', name: '' },
    ]);
    expect(s.lastAired).toEqual({ season_number: 1, episode_number: 2 });
    expect(s.next).toMatchObject({ season: 2, episode: 1, airDate: '2022-03-01' });
    expect(s.nSeasons).toBe(2);
    expect(s.nEpisodes).toBe(3);
    expect(canonSummary(c, '2030-01-01').next).toBeNull();
    expect(tmdbShape(c.seasons[0].episodes[1])).toMatchObject({ episode_number: 2, season_number: 1, still_path: '/x.jpg', air_date: '2021-01-08' });
  });
});

describe('région', () => {
  it('vaut France par défaut', () => {
    expect(getRegion().code).toBe('FR');
    setRegion('CH');
    expect(getRegion().code).toBe('CH');
    setRegion('XX');
    expect(getRegion().code).toBe('CH');
  });
});

describe('structure canonique : streamId et épisode diffusé un jour donné', () => {
  const canon = normalizeCanon({
    source: 'tvdb',
    seasons: [
      { number: 0, name: 'Spéciaux', episodes: [{ number: 1, airDate: '2026-10-19', streamId: 'tt29694831:0:1' }] },
      {
        number: 2,
        name: 'Saison 2',
        episodes: [
          { number: 205, airDate: '2026-10-18', streamId: 'tt29694831:2:205' },
          { number: 206, airDate: '2026-10-19', streamId: 'tt29694831:2:206' },
          { number: 207, airDate: '2026-10-20', streamId: '' },
        ],
      },
      { number: 3, name: 'Saison 3', episodes: [{ number: 1, airDate: '2026-11-02' }, { number: 2, airDate: '2026-11-02' }] },
    ],
  });

  it('normalizeCanon garde le streamId du serveur, absent ou vide sinon', () => {
    const s2 = canon!.seasons.find((s) => s.number === 2)!;
    expect(s2.episodes.map((e) => e.streamId)).toEqual(['tt29694831:2:205', 'tt29694831:2:206', undefined]);
    expect('streamId' in s2.episodes[2]!).toBe(false);
  });

  it('pickAiredEpisode : S2E206 pour le 2026-10-19 (spéciaux exclus), null si aucun ou ambigu', () => {
    expect(pickAiredEpisode(canon!, '2026-10-19')).toMatchObject({ season: 2, episode: 206, streamId: 'tt29694831:2:206' });
    expect(pickAiredEpisode(canon!, '2026-10-30')).toBeNull();
    expect(pickAiredEpisode(canon!, '2026-11-02')).toBeNull();
    expect(pickAiredEpisode(canon!, '')).toBeNull();
  });
});

describe('sources', () => {
  it('construit les identifiants Stremio', () => {
    expect(stremioId('tt1')).toBe('tt1');
    expect(stremioId('tt1', 2, 5)).toBe('tt1:2:5');
  });

  it('identifiant d’épisode : streamId de la structure canonique en priorité, sinon saison et épisode demandés', () => {
    expect(episodeStreamId('tt29694831', 2, 206, 'tt29694831:2:206')).toBe('tt29694831:2:206');
    expect(episodeStreamId('tt1', 2, 5, 'tt1:3:9')).toBe('tt1:3:9');
    expect(episodeStreamId('tt29694831', 2, 206, null)).toBe('tt29694831:2:206');
    expect(episodeStreamId('tt29694831', 2, 206)).toBe('tt29694831:2:206');
  });

  it('trie par score et groupe par qualité', () => {
    const list = [stream('720p', 10), stream('1080p', 50), { url: 'u' }, stream('1080p', 80), stream('2160p', 5)];
    const sorted = sortStreams(list);
    expect(sorted.map((s) => (s as { url: string }).url.slice(-2))).toEqual(['80', '50', '10', '/5', 'u'.slice(-2)].map((x) => x));
    const groups = groupByQuality(sorted);
    expect(groups.map((g) => g.key)).toEqual(['2160p', '1080p', '720p', 'other']);
    expect(groups[1].streams).toHaveLength(2);
  });

  it('refuse un objet laststream mal formé', () => {
    expect(getLaststream({ laststream: { resolution: '1080p' } })).toBeNull();
    expect(getLaststream(stream('1080p', 1))?.score).toBe(1);
  });

  it('choisit la VF qui tient le débit, sinon le repli', () => {
    const vo = stream('2160p', 100, { languages: ['en'], estBitrateKbps: 2000 });
    const vf = stream('720p', 10, { languages: ['fr'], estBitrateKbps: 2000 });
    expect(pickAutoplay([vo, vf], 10000)?.stream).toBe(vf);
    expect(pickAutoplay([vo], 10000)?.fallbackReason).toBe('no-vf');
    expect(pickAutoplay([vo, vf], 1000)).toBeNull();
  });

  it('planifie la mesure de débit', () => {
    expect(planBandwidth(10, null, 0)).toEqual({ kind: 'manual', kbps: 10000 });
    expect(planBandwidth('auto', { kbps: 5000, expiresAt: 10 }, 5)).toEqual({ kind: 'stored', kbps: 5000 });
    expect(planBandwidth('auto', { kbps: 5000, expiresAt: 1 }, 5)).toEqual({ kind: 'measure' });
  });
});

describe('userStore local', () => {
  it('migre la bibliothèque du prototype et gère ajout / retrait', () => {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify([{ id: 550, type: 'movie', title: 'Fight Club', poster: '/p.jpg', addedAt: 5 }, { bad: true }]));
    const s = new LocalUserStore();
    expect(s.getLibrary()).toHaveLength(1);
    expect(s.inLibrary('movie:550')).toBe(true);
    expect(s.toggleLibrary({ id: 1399, type: 'tv', title: 'GoT', poster: '' })).toBe(true);
    s.removeFromLibrary('movie:550');
    expect(s.getLibrary().map((e) => e.id)).toEqual([1399]);
  });

  it('suit la progression et alimente « Reprendre la lecture »', () => {
    const s = new LocalUserStore();
    const base = { type: 'tv' as const, id: 1, title: 'S', poster: '', key: 'tv:1' };
    s.setProgress({ ...base, season: 1, episode: 1, position: 600, duration: 1200 });
    s.setProgress({ ...base, key: 'movie:2', type: 'movie', id: 2, position: 1190, duration: 1200 });
    expect(s.getProgress('tv:1', 1, 1)?.position).toBe(600);
    expect(s.continueWatching().map((p) => p.key)).toEqual(['tv:1']);
  });

  it('marque les épisodes vus', () => {
    const s = new LocalUserStore();
    expect(s.toggleSeen('tv:1:1:1')).toBe(true);
    expect(s.isSeen('tv:1:1:1')).toBe(true);
    expect(s.toggleSeen('tv:1:1:1')).toBe(false);
  });
});

describe('thème', () => {
  it('relit le format {id, accent} de l’ancienne application', () => {
    localStorage.setItem('laststream.theme', JSON.stringify({ id: 'custom', accent: '#112233' }));
    expect(readTheme()).toEqual({ id: 'custom', accent: '#112233' });
    expect(resolveTheme('inconnu', null).id).toBe('laststream');
  });

  it('choisit un texte lisible sur l’accent', () => {
    expect(onAccent('#ff5a36')).toBe('#0c0b11');
    expect(onAccent('#101010')).toBe('#ffffff');
  });
});
