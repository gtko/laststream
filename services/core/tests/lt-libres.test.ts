import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLibresIndex,
  createLibres,
  LIBRES_KEY,
  type LibreFilm,
  type LibresIndex,
  libreBounds,
  libreStreams,
  parseLibres,
  pickArchiveFile,
} from '../src/lt/libres.js';
import type { RowBlob, RowBlobStore } from '../src/lt/rows.js';
import { fakeLookup, type RunningApp, startApp, tokenFor } from './lt-harness.js';

/** Classiques libres (lt/libres.ts) : règle « libre partout », choix des fichiers, streams, index, routes. */

const NOW = Date.UTC(2026, 10, 27);

class MemoryRows implements RowBlobStore {
  readonly items = new Map<string, RowBlob>();
  get(key: string): Promise<RowBlob | undefined> {
    return Promise.resolve(this.items.get(key));
  }
  put(key: string, blob: RowBlob): Promise<void> {
    this.items.set(key, blob);
    return Promise.resolve();
  }
}

const lit = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

/** Ligne SPARQL : film, IMDb, date, liens, et au choix vidéo, Archive, TMDB, auteur et décès. */
function row(o: { film: string; imdb: string; date: string; links?: number; video?: string; ia?: string; tmdb?: number; author?: string; death?: string }) {
  return {
    film: uri(`http://www.wikidata.org/entity/${o.film}`),
    imdb: lit(o.imdb),
    date: lit(`${o.date}T00:00:00Z`),
    links: lit(String(o.links ?? 10)),
    ...(o.video === undefined ? {} : { video: uri(`http://commons.wikimedia.org/wiki/Special:FilePath/${o.video}`) }),
    ...(o.ia === undefined ? {} : { ia: lit(o.ia) }),
    ...(o.tmdb === undefined ? {} : { tmdb: lit(String(o.tmdb)) }),
    ...(o.author === undefined ? {} : { author: uri(`http://www.wikidata.org/entity/${o.author}`) }),
    ...(o.death === undefined ? {} : { death: lit(`${o.death}T00:00:00Z`) }),
  };
}

const sparql = (rows: unknown[]) => ({ results: { bindings: rows } });

/** Nosferatu (1922) : Murnau (†1931), Galeen (†1949), Erdmann (†1948), sur Commons et Archive. */
const NOSFERATU = [
  row({ film: 'Q151895', imdb: 'tt0013442', date: '1922-03-04', links: 60, video: 'Nosferatu%20(1922).webm', tmdb: 653, author: 'Q55405', death: '1931-03-11' }),
  row({ film: 'Q151895', imdb: 'tt0013442', date: '1922-03-04', links: 60, ia: 'nosferatu_1922', author: 'Q71512', death: '1949-06-30' }),
  row({ film: 'Q151895', imdb: 'tt0013442', date: '1922-03-04', links: 60, video: 'Nosferatu%20(1922).ogv', author: 'Q96021', death: '1948-08-21' }),
];

describe('règle « libre partout »', () => {
  it('bornes 2026 : publié en 1930 au plus tard, auteurs morts en 1955 au plus tard', () => {
    expect(libreBounds(NOW)).toEqual({ publishedUpTo: 1930, deathUpTo: 1955 });
  });

  it('garde un film libre aux USA et en Europe, avec WebM préféré, Archive et TMDB', () => {
    expect(parseLibres(sparql(NOSFERATU), NOW)).toEqual([
      {
        imdb: 'tt0013442',
        tmdb: 653,
        year: 1922,
        links: 60,
        commons: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nosferatu%20(1922).webm',
        archive: 'nosferatu_1922',
      },
    ]);
  });

  it('écarte un auteur mort il y a moins de 70 ans (Chaplin, †1977) même si le film est libre aux USA', () => {
    const film = [row({ film: 'Q1', imdb: 'tt0015864', date: '1925-06-26', video: 'Gold%20Rush.webm', author: 'Q882', death: '1977-12-25' })];
    expect(parseLibres(sparql(film), NOW)).toEqual([]);
  });

  it('écarte un film publié après 1930 (pas encore libre aux USA), quels que soient les auteurs', () => {
    const film = [row({ film: 'Q2', imdb: 'tt0021749', date: '1931-01-01', video: 'X.webm', author: 'Q3', death: '1940-01-01' })];
    expect(parseLibres(sparql(film), NOW)).toEqual([]);
  });

  it('écarte un film sans auteur connu, ou dont un auteur n’a pas de date de décès', () => {
    const noAuthor = [row({ film: 'Q4', imdb: 'tt0000004', date: '1910-01-01', video: 'A.webm' })];
    const unknownDeath = [
      row({ film: 'Q5', imdb: 'tt0000005', date: '1910-01-01', video: 'B.webm', author: 'Q6', death: '1920-01-01' }),
      row({ film: 'Q5', imdb: 'tt0000005', date: '1910-01-01', video: 'B.webm', author: 'Q7' }),
    ];
    expect(parseLibres(sparql(noAuthor), NOW)).toEqual([]);
    expect(parseLibres(sparql(unknownDeath), NOW)).toEqual([]);
  });

  it('retient la première date de publication, ignore les fichiers non vidéo et les IMDb invalides, trie par notoriété', () => {
    const rows = [
      row({ film: 'Q8', imdb: 'tt0000008', date: '1902-09-01', links: 5, video: 'Voyage.webm', author: 'Q9', death: '1938-01-21' }),
      row({ film: 'Q10', imdb: 'tt0000010', date: '1929-01-01', links: 40, video: 'Affiche.jpg', ia: 'film10', author: 'Q9', death: '1938-01-21' }),
      row({ film: 'Q10', imdb: 'tt0000010', date: '1950-01-01', links: 40, ia: 'film10', author: 'Q9', death: '1938-01-21' }),
      row({ film: 'Q11', imdb: 'nm0000011', date: '1910-01-01', video: 'C.webm', author: 'Q9', death: '1938-01-21' }),
    ];
    const films = parseLibres(sparql(rows), NOW);
    expect(films.map((f) => [f.imdb, f.year, f.commons !== undefined, f.archive])).toEqual([
      ['tt0000010', 1929, false, 'film10'],
      ['tt0000008', 1902, true, undefined],
    ]);
  });
});

describe('fichier Internet Archive', () => {
  it('prend le MP4 le plus lourd entre 5 Mo et 8 Go, hors bande-annonce et sous-dossier', () => {
    const files = [
      { name: 'film_512kb.mp4', size: '120000000' },
      { name: 'film.mp4', size: '900000000' },
      { name: 'film_trailer.mp4', size: '990000000' },
      { name: 'extra/film.mp4', size: '999000000' },
      { name: 'film.ogv', size: '950000000' },
      { name: 'tiny.mp4', size: '1000' },
    ];
    expect(pickArchiveFile({ files })).toEqual({ name: 'film.mp4', size: 900000000 });
  });

  it('élément retiré ou sans MP4 : rien', () => {
    expect(pickArchiveFile({ is_dark: true, files: [{ name: 'a.mp4', size: '9000000' }] })).toBeUndefined();
    expect(pickArchiveFile({ files: [{ name: 'a.avi', size: '9000000' }] })).toBeUndefined();
    expect(pickArchiveFile({})).toBeUndefined();
  });
});

describe('streams', () => {
  it('Archive puis Commons, liens directs, champs laststream lisibles par l’app', () => {
    const film: LibreFilm = {
      imdb: 'tt0013442',
      year: 1922,
      links: 60,
      commons: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nosferatu%20(1922).webm',
      archive: 'nosferatu_1922',
      archiveFile: 'Nosferatu 1922.mp4',
      archiveSize: 900000000,
    };
    const streams = libreStreams(film);
    expect(streams.map((s) => s.url)).toEqual([
      'https://archive.org/download/nosferatu_1922/Nosferatu%201922.mp4',
      'https://commons.wikimedia.org/wiki/Special:FilePath/Nosferatu%20(1922).webm',
    ]);
    expect(streams[1]?.behaviorHints?.filename).toBe('Nosferatu (1922).webm');
    for (const stream of streams) {
      expect(stream.laststream).toMatchObject({ resolution: 'unknown', height: 0, source: 'web', codec: '', hdr: [], languages: ['original'], cached: false, score: 0, estBitrateKbps: null });
      expect(stream.laststream?.origins).toEqual([{ kind: 'addon', name: 'Classiques libres' }]);
    }
  });
});

/** Wikidata et Archive simulés ; compte les appels à chacun. */
function upstream(rows: unknown[], archive: Record<string, unknown> = {}) {
  const calls = { sparql: 0, archive: [] as string[] };
  const fetchFn = (input: string): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname === 'query.wikidata.org') {
      calls.sparql += 1;
      return Promise.resolve(Response.json(sparql(rows)));
    }
    if (url.hostname === 'archive.org' && url.pathname.startsWith('/metadata/')) {
      const id = decodeURIComponent(url.pathname.slice('/metadata/'.length));
      calls.archive.push(id);
      return Promise.resolve(Response.json(archive[id] ?? {}));
    }
    return Promise.resolve(new Response('inconnu', { status: 404 }));
  };
  return { fetchFn, calls };
}

const NOSFERATU_ARCHIVE = { nosferatu_1922: { files: [{ name: 'Nosferatu.mp4', size: '700000000' }] } };

describe('index', () => {
  it('construit l’index et reprend les fichiers Archive déjà connus sans relire leur fiche', async () => {
    const first = upstream(NOSFERATU, NOSFERATU_ARCHIVE);
    const index = await buildLibresIndex(first.fetchFn, NOW);
    expect(index.films[0]).toMatchObject({ archive: 'nosferatu_1922', archiveFile: 'Nosferatu.mp4', archiveSize: 700000000 });
    expect(first.calls.archive).toEqual(['nosferatu_1922']);

    const second = upstream(NOSFERATU, {});
    const again = await buildLibresIndex(second.fetchFn, NOW + 1, index);
    expect(again.films[0]?.archiveFile).toBe('Nosferatu.mp4');
    expect(second.calls.archive).toEqual([]);
  });

  it('élément Archive sans MP4 : retiré, le film reste par Commons ; sans aucune vidéo : film retiré', async () => {
    const rows = [
      ...NOSFERATU,
      row({ film: 'Q20', imdb: 'tt0000020', date: '1915-01-01', ia: 'sans_mp4', author: 'Q9', death: '1938-01-21' }),
    ];
    const { fetchFn } = upstream(rows, {});
    const index = await buildLibresIndex(fetchFn, NOW);
    expect(index.films.map((f) => f.imdb)).toEqual(['tt0013442']);
    expect(index.films[0]?.archive).toBeUndefined();
    expect(index.films[0]?.commons).toBeDefined();
  });

  it('service : écrit dans le stockage, ne reconstruit pas avant une semaine, garde l’index si Wikidata répond vide', async () => {
    const store = new MemoryRows();
    let now = NOW;
    const good = upstream(NOSFERATU, NOSFERATU_ARCHIVE);
    const service = createLibres({ store, fetch: good.fetchFn, now: () => now, background: () => undefined });
    expect(await service.refresh()).toBe('written');
    expect(store.items.get(LIBRES_KEY)?.generatedAt).toBe(NOW);
    expect(await service.refresh()).toBe('fresh');
    expect(good.calls.sparql).toBe(1);

    now = NOW + 8 * 24 * 3600e3;
    const empty = upstream([]);
    const later = createLibres({ store, fetch: empty.fetchFn, now: () => now, background: () => undefined });
    expect(await later.refresh()).toBe('failed');
    expect((await later.film('tt0013442'))?.archiveFile).toBe('Nosferatu.mp4');
  });
});

function storedIndex(films: LibreFilm[]): MemoryRows {
  const store = new MemoryRows();
  const index: LibresIndex = { version: 1, generatedAt: NOW, publishedUpTo: 1930, deathUpTo: 1955, films };
  store.items.set(LIBRES_KEY, { body: JSON.stringify(index), etag: '"x"', generatedAt: NOW });
  return store;
}

let running: RunningApp | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('routes', () => {
  const films: LibreFilm[] = [
    { imdb: 'tt0013442', tmdb: 653, year: 1922, links: 60, commons: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nosferatu.webm' },
    { imdb: 'tt0000417', year: 1902, links: 50, commons: 'https://commons.wikimedia.org/wiki/Special:FilePath/Voyage.webm' },
  ];

  it('GET /lt/libres : films ayant une fiche TMDB, sans appel réseau', async () => {
    const calls: string[] = [];
    const fetchFn = (input: string | URL | Request): Promise<Response> => {
      calls.push(String(input));
      return Promise.resolve(new Response('non', { status: 500 }));
    };
    running = await startApp({ fetch: fetchFn as typeof fetch, lookupHost: fakeLookup(), extra: { rowBlobs: storedIndex(films) } });
    const res = await fetch(`${running.baseUrl}/${tokenFor()}/lt/libres?page=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ tmdb: 653, imdb: 'tt0013442', year: 1922 }], total: 1 });
    expect(calls).toEqual([]);
  });

  it('flux d’un film libre : lien direct en tête, même sans aucune source configurée ; autre film : rien ajouté', async () => {
    running = await startApp({ lookupHost: fakeLookup(), extra: { rowBlobs: storedIndex(films) } });
    const libre = (await (await fetch(`${running.baseUrl}/${tokenFor()}/stream/movie/tt0013442.json`)).json()) as { streams: { url?: string; name?: string }[] };
    expect(libre.streams[0]).toMatchObject({ name: 'Classique libre', url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nosferatu.webm' });
    const other = (await (await fetch(`${running.baseUrl}/${tokenFor()}/stream/movie/tt0133093.json`)).json()) as { streams: unknown[] };
    expect(other.streams).toEqual([]);
  });
});
