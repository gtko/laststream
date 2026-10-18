import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addonUrl, isConfigured, ltUrl, reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { cachedRequest, clearCache, inFlightCount, limited, MAX_IN_FLIGHT } from '../src/data/transport';
import { getRegion, setRegion } from '../src/data/prefs';
import { groupByQuality, pickAutoplay, planBandwidth, sortStreams, stremioId } from '../src/data/sources';
import { getLaststream } from '../src/data/stream';
import { ADULT_ROWS, activeRows, Appearances, KID_ROWS, kidBase, makeCtx, PROBES } from '../src/data/rows';
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

describe('région', () => {
  it('vaut France par défaut', () => {
    expect(getRegion().code).toBe('FR');
    setRegion('CH');
    expect(getRegion().code).toBe('CH');
    setRegion('XX');
    expect(getRegion().code).toBe('CH');
  });
});

describe('sources', () => {
  it('construit les identifiants Stremio', () => {
    expect(stremioId('tt1')).toBe('tt1');
    expect(stremioId('tt1', 2, 5)).toBe('tt1:2:5');
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
