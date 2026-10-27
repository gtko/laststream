// Migration : lecture des sources (Stremio compte et fichier, champ « watched », Nuvio, Simkl, Plex), sans réseau réel.
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { itemsOfLibraryItem, parseStremioExport, readStremioAccount, STREMIO_API, StremioError } from '../src/data/migration/stremio';
import { browserInflate, decodeWatched, sortVideos, type BitfieldVideo } from '../src/data/migration/watchedBitfield';
import { parseNuvioBackup } from '../src/data/migration/nuvio';
import { parseCsv, parseSimklExport } from '../src/data/migration/simkl';
import { PLEX_TV, plexClientId, readPlexHistory, refOfPlexMeta, type PlexServer } from '../src/data/migration/plex';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const libItem = (over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({
  _id: 'tt0133093', name: 'Matrix', type: 'movie', removed: false, temp: false, _ctime: '2024-01-02T00:00:00Z', _mtime: '2024-03-01T00:00:00Z',
  state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false, ...state },
  ...over,
});

describe('Stremio : titres de la bibliothèque', () => {
  it('un film jamais commencé va en bibliothèque et dans « À voir »', () => {
    const items = itemsOfLibraryItem(libItem());
    expect(items.map((i) => i.action + (i.list ? ':' + i.list : ''))).toEqual(['library', 'list:watchlist']);
    expect(items[0].ref).toEqual({ imdb: 'tt0133093' });
    expect(items[0].at).toBe(Date.parse('2024-01-02T00:00:00Z'));
  });

  it('un film retiré mais vu reste dans l’historique, sans bibliothèque', () => {
    const items = itemsOfLibraryItem(libItem({ removed: true }, { flaggedWatched: 1, lastWatched: '2024-02-01T00:00:00Z' }));
    expect(items.map((i) => i.action)).toEqual(['watched']);
    expect(items[0].at).toBe(Date.parse('2024-02-01T00:00:00Z'));
  });

  it('progression d’un épisode : secondes, saison et épisode tirés de video_id', () => {
    const items = itemsOfLibraryItem(libItem({ _id: 'tt0944947', type: 'series', name: 'GoT' }, { timeOffset: 754_000, duration: 3_300_000, video_id: 'tt0944947:2:5' }));
    const p = items.find((i) => i.action === 'progress');
    expect(p).toMatchObject({ type: 'tv', season: 2, episode: 5, positionSec: 754, durationSec: 3300 });
    expect(items.some((i) => i.list === 'watchlist')).toBe(false);
  });

  it('série vue : le champ « watched » est transmis tel quel au moteur', () => {
    const items = itemsOfLibraryItem(libItem({ _id: 'tt1', type: 'series' }, { watched: 'tt1:1:3:eJwDAAAAAAE=' }));
    expect(items.find((i) => i.action === 'watched')?.stremioWatched).toBe('tt1:1:3:eJwDAAAAAAE=');
  });

  it('chaînes TV et identifiants d’addon : ignorés avec une raison', () => {
    expect(itemsOfLibraryItem(libItem({ _id: 'ch1', type: 'tv' }))[0].skipReason).toMatch(/Chaîne TV/);
    expect(itemsOfLibraryItem(libItem({ _id: 'kitsu:42', type: 'series' }))[0].skipReason).toMatch(/kitsu/);
    expect(itemsOfLibraryItem(libItem({ _id: 'kitsu:42', type: 'series', removed: true }))).toEqual([]);
  });

  it('identifiant tmdb: reconnu', () => {
    expect(itemsOfLibraryItem(libItem({ _id: 'tmdb:603' }))[0].ref).toEqual({ tmdb: 603 });
  });
});

describe('Stremio : fichier d’export', () => {
  it('trouve bibliothèque, addons et titres aimés à n’importe quel niveau', () => {
    const b = parseStremioExport({
      result: [libItem(), libItem()], // doublon ignoré
      addons: { addons: [
        { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json', manifest: { name: 'Cinemeta' }, flags: { official: true } },
        { transportUrl: 'https://addon.example.test/cfg/manifest.json', manifest: { name: 'Mon addon' }, flags: {} },
      ] },
      likes: [{ id: 'tt0111161', type: 'movie', name: 'Les Évadés' }, 'tt0068646'],
    });
    expect(b.source).toBe('stremio-file');
    expect(b.items.filter((i) => i.action === 'library')).toHaveLength(1);
    expect(b.addons).toEqual([
      { manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json', name: 'Cinemeta', official: true },
      { manifestUrl: 'https://addon.example.test/cfg/manifest.json', name: 'Mon addon', official: false },
    ]);
    const fav = b.items.filter((i) => i.list === 'favorites');
    expect(fav.map((i) => i.ref.imdb)).toEqual(['tt0111161', 'tt0068646']);
    expect(fav[1].typeUnknown).toBe(true);
  });

  it('fichier sans rien de reconnu : une note l’explique', () => {
    expect(parseStremioExport({ foo: 1 }).notes[0]).toMatch(/Aucune bibliothèque/);
  });
});

describe('Stremio : compte lu depuis l’appareil', () => {
  it('lit la bibliothèque et les addons, n’appelle que des routes de lecture, puis ferme la session', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith('login')) return json({ result: { authKey: 'k1' } });
      if (url.endsWith('datastoreGet')) return json({ result: [libItem()] });
      if (url.endsWith('addonCollectionGet')) return json({ result: { addons: [{ transportUrl: 'https://a.test/manifest.json', manifest: { name: 'A' } }] } });
      return json({ result: { success: true } });
    });
    const steps: string[] = [];
    const b = await readStremioAccount('moi@exemple.ch', 'pw', { addons: true, fetchFn, onStep: (s) => steps.push(s) });
    await Promise.resolve();
    expect(calls.map((c) => c.url.slice(STREMIO_API.length))).toEqual(['login', 'datastoreGet', 'addonCollectionGet', 'logout']);
    expect(calls.every((c) => c.url.startsWith('https://api.strem.io/api/'))).toBe(true);
    expect(calls[1].body).toEqual({ authKey: 'k1', collection: 'libraryItem', ids: [], all: true });
    expect(steps).toEqual(['login', 'library', 'addons']);
    expect(b.source).toBe('stremio');
    expect(b.items.length).toBeGreaterThan(0);
    expect(b.addons).toHaveLength(1);
  });

  it('sans l’étape addons, la liste des addons n’est pas demandée', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.endsWith('login') ? json({ result: { authKey: 'k' } }) : json({ result: [] })));
    const b = await readStremioAccount('a@b.c', 'pw', { fetchFn });
    expect(fetchFn.mock.calls.map((c) => String(c[0]).split('/').pop())).not.toContain('addonCollectionGet');
    expect(b.addons).toEqual([]);
  });

  it('mot de passe refusé : erreur « credentials », lisible', async () => {
    const fetchFn = vi.fn(async () => json({ error: { code: 3, message: 'Wrong passphrase', wrongPass: true } }));
    const err = await readStremioAccount('a@b.c', 'x', { fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(StremioError);
    expect(err.kind).toBe('credentials');
  });

  it('réseau coupé : erreur « network »', async () => {
    const err = await readStremioAccount('a@b.c', 'x', { fetchFn: async () => { throw new TypeError('Failed to fetch'); } }).catch((e) => e);
    expect(err.kind).toBe('network');
  });
});

describe('Champ « watched » de Stremio', () => {
  const videos: BitfieldVideo[] = [
    { id: 'tt1:1:2', season: 1, episode: 2 }, { id: 'tt1:0:1', season: 0, episode: 1 }, { id: 'tt1:1:1', season: 1, episode: 1 },
    { id: 'tt1:2:1', season: 2, episode: 1 }, { id: 'tt1:1:3', season: 1, episode: 3 },
  ];
  const pack = (bits: number[]) => {
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
    return deflateSync(bytes).toString('base64');
  };

  it('trie comme Stremio : saison, épisode', () => {
    expect(sortVideos(videos).map((v) => v.id)).toEqual(['tt1:0:1', 'tt1:1:1', 'tt1:1:2', 'tt1:1:3', 'tt1:2:1']);
  });

  it('décode les épisodes vus (saison 0 exclue) avec la décompression du navigateur', async () => {
    const eps = await decodeWatched('tt1:1:2:3:' + pack([1, 1, 0, 1]), videos, browserInflate);
    expect(eps).toEqual([{ season: 1, episode: 1 }, { season: 1, episode: 3 }]);
  });

  it('recale les bits avec l’ancre quand des épisodes ont été ajoutés avant', async () => {
    // Écrit quand la liste n'avait pas la saison 0 : l'ancre tt1:1:2 était 2e (longueur 2).
    const eps = await decodeWatched('tt1:1:2:2:' + pack([1, 1]), videos, browserInflate);
    expect(eps).toEqual([{ season: 1, episode: 1 }, { season: 1, episode: 2 }]);
  });

  it('ancre inconnue ou champ illisible : rien', async () => {
    expect(await decodeWatched('tt9:1:1:1:' + pack([1]), videos, browserInflate)).toEqual([]);
    expect(await decodeWatched('n/a', videos, browserInflate)).toEqual([]);
  });
});

describe('Nuvio', () => {
  it('bibliothèque, listes, progression à la seconde, vus et addons', () => {
    const b = parseNuvioBackup({
      library: { items: [
        { id: 'tt0903747', type: 'series', name: 'Breaking Bad', savedAtEpochMs: 1_700_000_000_000, listKeys: ['watchlist'], tmdbId: 1396 },
        { id: 'tt0245429', type: 'movie', name: 'Chihiro', savedAtEpochMs: 1_700_000_000_000, mediaCategory: 'anime', listKeys: ['favorites'] },
      ] },
      watchProgress: { entries: [
        { parentMetaId: 'tt0903747', parentMetaType: 'series', videoId: 'tt0903747:3:7', title: 'Breaking Bad', seasonNumber: 3, episodeNumber: 7, lastPositionMs: 1_234_567, durationMs: 2_800_000, lastUpdatedEpochMs: 1_710_000_000_000 },
        { parentMetaId: 'tt0245429', parentMetaType: 'movie', videoId: 'tt0245429', title: 'Chihiro', lastPositionMs: 7_000_000, durationMs: 7_200_000, lastUpdatedEpochMs: 1_710_000_000_000 },
      ] },
      watched: [{ id: 'tt0903747', type: 'series', name: 'Breaking Bad', entries: [{ season: 1, episode: 1, markedAtEpochMs: 1 }, { season: 1, episode: 2, markedAtEpochMs: 2 }] }],
      addons: [{ transportUrl: 'https://a.test/manifest.json', name: 'A' }],
    });
    const progress = b.items.find((i) => i.action === 'progress');
    expect(progress).toMatchObject({ type: 'tv', season: 3, episode: 7, positionSec: 1234, durationSec: 2800, ref: { imdb: 'tt0903747' } });
    const movieWatched = b.items.find((i) => i.action === 'watched' && i.type === 'movie');
    expect(movieWatched?.ref.imdb).toBe('tt0245429'); // 97 % : vu
    expect(b.items.find((i) => i.action === 'watched' && i.episodes)?.episodes).toEqual([{ season: 1, episode: 1 }, { season: 1, episode: 2 }]);
    expect(b.items.find((i) => i.action === 'library' && i.ref.imdb === 'tt0245429')?.anime).toBe(true);
    expect(b.items.some((i) => i.list === 'watchlist')).toBe(true);
    expect(b.items.some((i) => i.list === 'favorites')).toBe(true);
    expect(b.addons.map((a) => a.name)).toEqual(['A']);
  });

  it('ancienne app : positions en secondes dans un objet watchProgress', () => {
    const b = parseNuvioBackup({ watchProgress: {
      '@watch_progress:movie:tt0133093': { currentTime: 600, duration: 8160, lastUpdated: 1_700_000_000_000 },
      'series:tt0944947:tt0944947:1:2': { currentTime: 100, duration: 3000, lastUpdated: 1_700_000_000_000 },
    } });
    expect(b.items.map((i) => [i.ref.imdb, i.positionSec, i.season ?? null])).toEqual([['tt0133093', 600, null], ['tt0944947', 100, 1]]);
  });

  it('une même progression en double : la plus récente l’emporte', () => {
    const e = (pos: number, at: number) => ({ parentMetaId: 'tt1', parentMetaType: 'movie', videoId: 'tt1', title: 'X', lastPositionMs: pos, durationMs: 100_000, lastUpdatedEpochMs: at });
    const b = parseNuvioBackup({ a: [e(10_000, 1_700_000_000_000)], b: [e(20_000, 1_700_000_100_000)] });
    expect(b.items).toHaveLength(1);
    expect(b.items[0].positionSec).toBe(20);
  });
});

describe('Simkl', () => {
  it('JSON : statuts, épisodes vus et catégorie anime', () => {
    const b = parseSimklExport(JSON.stringify({
      movies: [{ status: 'completed', last_watched_at: '2023-05-01T20:00:00Z', movie: { title: 'Dune', year: 2021, ids: { tmdb: 438631, imdb: 'tt1160419' } } }],
      shows: [{ status: 'plantowatch', show: { title: 'Severance', year: 2022, ids: { tmdb: 95396 } } }],
      anime: [
        { status: 'watching', anime_type: 'tv', show: { title: 'Frieren', ids: { tmdb: 209867, mal: 52991 } }, seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }] },
        { status: 'completed', anime_type: 'movie', show: { title: 'Akira', ids: { imdb: 'tt0094625' } } },
        { status: 'dropped', show: { title: 'X', ids: { tmdb: 1 } } },
      ],
    }));
    const dune = b.items.filter((i) => i.ref.tmdb === 438631);
    expect(dune.map((i) => i.action)).toEqual(['library', 'watched']);
    expect(dune[1].at).toBe(Date.parse('2023-05-01T20:00:00Z'));
    expect(b.items.find((i) => i.ref.tmdb === 95396)).toMatchObject({ action: 'list', list: 'watchlist' });
    const frieren = b.items.filter((i) => i.ref.tmdb === 209867);
    expect(frieren.every((i) => i.anime)).toBe(true);
    expect(frieren.find((i) => i.action === 'watched')?.episodes).toEqual([{ season: 1, episode: 1 }, { season: 1, episode: 2 }]);
    expect(b.items.find((i) => i.ref.imdb === 'tt0094625')).toMatchObject({ type: 'movie', anime: true });
    expect(b.items.find((i) => i.title === 'X')?.skipReason).toMatch(/abandonné/);
  });

  it('CSV : guillemets, point-virgule, un épisode par ligne', () => {
    expect(parseCsv('a;"b;c";"d ""e"""\n1;2;3')).toEqual([['a', 'b;c', 'd "e"'], ['1', '2', '3']]);
    const b = parseSimklExport('Title,Type,Status,IMDB ID,TMDB,Season,Episode,Last Watched\n"Frieren",anime,watching,,209867,1,1,2024-01-01\n"Frieren",anime,watching,,209867,1,2,2024-01-08\nDune,movie,completed,tt1160419,,,,2023-05-01\n');
    const fr = b.items.find((i) => i.ref.tmdb === 209867 && i.action === 'watched');
    expect(fr?.episodes).toHaveLength(2);
    expect(fr?.anime).toBe(true);
    expect(fr?.at).toBe(Date.parse('2024-01-08'));
    expect(b.items.some((i) => i.ref.imdb === 'tt1160419' && i.action === 'watched')).toBe(true);
  });

  it('fichier vide : note', () => {
    expect(parseSimklExport('{}').notes).toHaveLength(1);
  });
});

describe('Plex', () => {
  it('identifiants d’une fiche (nouveaux et anciens agents)', () => {
    expect(refOfPlexMeta({ Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }, { id: 'tvdb://169' }] })).toEqual({ imdb: 'tt0133093', tmdb: 603, tvdb: 169 });
    expect(refOfPlexMeta({ guid: 'com.plexapp.agents.imdb://tt0111161?lang=fr' })).toEqual({ imdb: 'tt0111161' });
    expect(refOfPlexMeta({ guid: 'com.plexapp.agents.thetvdb://81189/1/1?lang=en' })).toEqual({ tvdb: 81189 });
  });

  it('identifiant d’appareil stable', () => {
    expect(plexClientId()).toBe(plexClientId());
    expect(PLEX_TV).toBe('https://plex.tv/api/v2/');
  });

  it('historique : films et épisodes regroupés par série, avec la date du dernier visionnage', async () => {
    const server: PlexServer = { name: 'Salon', token: 'srv', uris: ['https://bad.plex.direct:32400', 'https://ok.plex.direct:32400'], owned: true };
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      seen.push(url);
      if (url.startsWith('https://bad')) throw new TypeError('down');
      if (url.endsWith('/identity')) return json({ MediaContainer: {} });
      if (url.includes('/status/sessions/history/all')) {
        return json({ MediaContainer: { Metadata: [
          { type: 'movie', ratingKey: '10', title: 'Matrix', viewedAt: 1_700_000_000 },
          { type: 'episode', grandparentRatingKey: '20', grandparentTitle: 'GoT', parentIndex: 1, index: 2, viewedAt: 1_700_000_500 },
          { type: 'episode', grandparentRatingKey: '20', grandparentTitle: 'GoT', parentIndex: 1, index: 1, viewedAt: 1_699_000_000 },
          { type: 'movie', ratingKey: '30', title: 'Vidéo perso', viewedAt: 1_600_000_000 },
        ] } });
      }
      if (url.includes('/library/metadata/10')) return json({ MediaContainer: { Metadata: [{ Guid: [{ id: 'imdb://tt0133093' }] }] } });
      if (url.includes('/library/metadata/20')) return json({ MediaContainer: { Metadata: [{ Guid: [{ id: 'tvdb://121361' }] }] } });
      return json({ MediaContainer: { Metadata: [{ guid: 'local://30' }] } });
    });
    const progress: number[] = [];
    const b = await readPlexHistory(server, 'user', { fetchFn, onProgress: (d) => progress.push(d) });
    expect(seen.some((u) => u.includes('accountID=1'))).toBe(true);
    expect(b.items.find((i) => i.title === 'Matrix')).toMatchObject({ action: 'watched', type: 'movie', ref: { imdb: 'tt0133093' }, at: 1_700_000_000_000 });
    const got = b.items.find((i) => i.title === 'GoT');
    expect(got).toMatchObject({ type: 'tv', ref: { tvdb: 121361 }, at: 1_700_000_500_000 });
    expect(got?.episodes).toEqual([{ season: 1, episode: 2 }, { season: 1, episode: 1 }]);
    expect(b.items.find((i) => i.title === 'Vidéo perso')?.skipReason).toMatch(/sans identifiant/);
    expect(progress).toHaveLength(3);
  });
});
