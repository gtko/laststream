import { describe, expect, it, vi } from 'vitest';
import type { ContentRef } from '../src/types.js';
import type { FetchFn } from '../src/sources/http.js';
import { searchTorznab, testTorznab, type TorznabSource } from '../src/sources/torznab.js';

const MOVIE: ContentRef = { type: 'movie', id: 'tt1234567', imdbId: 'tt1234567' };
const SERIES: ContentRef = { type: 'series', id: 'tt1234567:1:2', imdbId: 'tt1234567', season: 1, episode: 2 };
const KEY = 'TZ-SECRET-KEY-77';
const SOURCE: TorznabSource = { name: 'Indexeur', baseUrl: 'https://idx.example.com', apiKey: KEY };
const HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const HASH_LOWER = HASH.toLowerCase();
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Film`;
const MAGNET_XML = MAGNET.replaceAll('&', '&amp;'); // un flux XML échappe le &

/** Faux fetch : aucun appel réseau, la réponse est produite par le gestionnaire fourni. */
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(handler);
  return { fetch: mock as unknown as FetchFn, mock };
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

/** Enveloppe RSS minimale autour d'un ou plusieurs <item>. */
function rss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>${items}</channel>
</rss>`;
}

/** Renvoie l'erreur levée par la promesse ; échoue si elle se résout. */
async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('aucune erreur levée');
}

/** Fetch qui ne répond jamais et se rejette seulement lorsque le signal est annulé. */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

describe('searchTorznab : construction de la requête', () => {
  it('movie : appelle /api?t=movie&imdbid=…&apikey=… sans le préfixe tt', async () => {
    const { fetch, mock } = mockFetch(async () => xmlResponse(rss('')));

    await searchTorznab(SOURCE, MOVIE, { fetch });

    expect(mock.mock.calls[0]?.[0]).toBe(`https://idx.example.com/api?t=movie&imdbid=1234567&apikey=${KEY}`);
  });

  it('series : t=tvsearch avec season, ep et cat (catégories séparées par des virgules)', async () => {
    const { fetch, mock } = mockFetch(async () => xmlResponse(rss('')));

    await searchTorznab({ ...SOURCE, categories: [2000, 5000] }, SERIES, { fetch });

    const url = new URL(String(mock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api');
    expect(url.searchParams.get('t')).toBe('tvsearch');
    expect(url.searchParams.get('imdbid')).toBe('1234567');
    expect(url.searchParams.get('season')).toBe('1');
    expect(url.searchParams.get('ep')).toBe('2');
    expect(url.searchParams.get('cat')).toBe('2000,5000');
    expect(url.searchParams.get('apikey')).toBe(KEY);
  });

  it('n’ajoute pas /api si la baseUrl le contient déjà', async () => {
    const { fetch, mock } = mockFetch(async () => xmlResponse(rss('')));

    await searchTorznab({ ...SOURCE, baseUrl: 'https://idx.example.com/api/' }, MOVIE, { fetch });

    expect(new URL(String(mock.mock.calls[0]?.[0])).pathname).toBe('/api');
  });

  it('accepte une baseUrl Jackett (…/torznab) et ajoute /api', async () => {
    const { fetch, mock } = mockFetch(async () => xmlResponse(rss('')));
    const jackett = { ...SOURCE, baseUrl: 'http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab' };

    await searchTorznab(jackett, MOVIE, { fetch });

    expect(new URL(String(mock.mock.calls[0]?.[0])).pathname).toBe('/api/v2.0/indexers/all/results/torznab/api');
  });
});

describe('searchTorznab : mapping des items', () => {
  it('attribut unique (objet XML) : seeders, taille depuis <size>, infoHash depuis le magnet du lien', async () => {
    const item = `<item>
        <title>Film.2024.1080p.BluRay.x264-GRP</title>
        <size>2147483648</size>
        <link>${MAGNET_XML}</link>
        <torznab:attr name="seeders" value="42" />
      </item>`;
    const { fetch } = mockFetch(async () => xmlResponse(rss(item)));

    const [stream] = await searchTorznab(SOURCE, MOVIE, { fetch });

    expect(stream).toEqual({
      sourceName: 'Indexeur',
      sourceKind: 'torznab',
      name: 'Indexeur',
      title: 'Film.2024.1080p.BluRay.x264-GRP',
      filename: 'Film.2024.1080p.BluRay.x264-GRP',
      sizeBytes: 2147483648,
      seeders: 42,
      infoHash: HASH_LOWER,
      magnet: MAGNET,
    });
  });

  it('plusieurs attributs (liste) : infohash et magneturl lus dans les attributs', async () => {
    const item = `<item>
        <title>Serie S01E02 720p</title>
        <link>https://idx.example.com/dl/2.torrent</link>
        <torznab:attr name="seeders" value="7" />
        <torznab:attr name="infohash" value="${HASH}" />
        <torznab:attr name="magneturl" value="${MAGNET_XML}" />
        <torznab:attr name="size" value="999" />
      </item>`;
    const { fetch } = mockFetch(async () => xmlResponse(rss(item)));

    const [stream] = await searchTorznab(SOURCE, SERIES, { fetch });

    expect(stream?.infoHash).toBe(HASH_LOWER);
    expect(stream?.magnet).toBe(MAGNET);
    expect(stream?.seeders).toBe(7);
    expect(stream?.sizeBytes).toBe(999);
  });

  it('magnet seul (sans attribut ni infohash) : infoHash extrait du btih', async () => {
    const item = `<item><title>Seul.Magnet</title><link>${MAGNET_XML}</link></item>`;
    const { fetch } = mockFetch(async () => xmlResponse(rss(item)));

    const streams = await searchTorznab(SOURCE, MOVIE, { fetch });

    expect(streams).toHaveLength(1);
    expect(streams[0]?.infoHash).toBe(HASH_LOWER);
    expect(streams[0]?.magnet).toBe(MAGNET);
    expect(streams[0]?.seeders).toBeUndefined();
    expect(streams[0]?.sizeBytes).toBeUndefined();
  });

  it('ignore les items sans infoHash ni magnet', async () => {
    const items = `
      <item><title>Sans rien</title><link>https://idx.example.com/dl/3.torrent</link></item>
      <item><title>Avec magnet</title><link>${MAGNET_XML}</link></item>`;
    const { fetch } = mockFetch(async () => xmlResponse(rss(items)));

    const streams = await searchTorznab(SOURCE, MOVIE, { fetch });

    expect(streams.map((s) => s.title)).toEqual(['Avec magnet']);
  });

  it('enclosure : taille depuis length et magnet depuis url quand <size> et le lien sont absents', async () => {
    const item = `<item>
        <title>Enclosure.Film</title>
        <enclosure url="${MAGNET_XML}" length="1234567" type="application/x-bittorrent" />
      </item>`;
    const { fetch } = mockFetch(async () => xmlResponse(rss(item)));

    const [stream] = await searchTorznab(SOURCE, MOVIE, { fetch });

    expect(stream?.sizeBytes).toBe(1234567);
    expect(stream?.magnet).toBe(MAGNET);
    expect(stream?.infoHash).toBe(HASH_LOWER);
  });

  it('garde l’ordre des items et ignore les champs non numériques', async () => {
    const items = `
      <item><title>Premier</title><size>abc</size><link>${MAGNET_XML}</link><torznab:attr name="seeders" value="x" /></item>
      <item><title>Second</title><link>${MAGNET_XML}</link></item>`;
    const { fetch } = mockFetch(async () => xmlResponse(rss(items)));

    const streams = await searchTorznab(SOURCE, MOVIE, { fetch });

    expect(streams.map((s) => s.title)).toEqual(['Premier', 'Second']);
    expect(streams[0]?.sizeBytes).toBeUndefined();
    expect(streams[0]?.seeders).toBeUndefined();
  });

  it('flux RSS sans <channel> : renvoie une liste vide', async () => {
    const { fetch } = mockFetch(async () => xmlResponse('<?xml version="1.0"?><rss version="2.0"></rss>'));

    await expect(searchTorznab(SOURCE, MOVIE, { fetch })).resolves.toEqual([]);
  });
});

describe('searchTorznab : erreurs', () => {
  it('réponse <error> : lève le message de l’indexeur avec le code', async () => {
    const { fetch } = mockFetch(async () =>
      xmlResponse('<?xml version="1.0"?><error code="100" description="Incorrect user credentials"/>'),
    );

    await expect(searchTorznab(SOURCE, MOVIE, { fetch })).rejects.toThrow(
      'Source "Indexeur" : erreur Torznab : Incorrect user credentials (code 100)',
    );
  });

  it('<error> qui renvoie la clé : la clé est masquée dans le message', async () => {
    const { fetch } = mockFetch(async () =>
      xmlResponse(`<?xml version="1.0"?><error code="100" description="Invalid apikey ${KEY}"/>`),
    );

    const error = await errorOf(searchTorznab(SOURCE, MOVIE, { fetch }));

    expect(error.message).toContain('Invalid apikey ***');
    expect(error.message).not.toContain(KEY);
  });

  it('HTTP 401 avec un <error> : le message de l’indexeur prime sur le code HTTP', async () => {
    const { fetch } = mockFetch(async () =>
      xmlResponse('<?xml version="1.0"?><error code="100" description="Bad key"/>', 401),
    );

    await expect(searchTorznab(SOURCE, MOVIE, { fetch })).rejects.toThrow(/Bad key/);
  });

  it('XML mal formé : lève une erreur de réponse XML invalide', async () => {
    const { fetch } = mockFetch(async () => xmlResponse('<rss><channel><item><title>coupé</channel>'));

    await expect(searchTorznab(SOURCE, MOVIE, { fetch })).rejects.toThrow(
      'Source "Indexeur" : réponse XML invalide',
    );
  });

  it('racine inattendue (HTML valide) : lève une erreur de réponse Torznab inattendue', async () => {
    const { fetch } = mockFetch(async () => xmlResponse('<html><body>Page d’accueil</body></html>'));

    await expect(searchTorznab(SOURCE, MOVIE, { fetch })).rejects.toThrow(/réponse Torznab inattendue/);
  });

  it('HTTP 500 sans corps XML : lève HTTP 500', async () => {
    const { fetch } = mockFetch(async () => new Response('', { status: 500 }));

    await expect(searchTorznab(SOURCE, MOVIE, { fetch })).rejects.toThrow('Source "Indexeur" : HTTP 500');
  });

  it('délai dépassé : la requête est annulée et l’erreur est explicite', async () => {
    const { fetch, mock } = mockFetch(hangingFetch);

    await expect(searchTorznab(SOURCE, MOVIE, { fetch, timeoutMs: 20 })).rejects.toThrow(
      'Source "Indexeur" : délai dépassé (20 ms)',
    );
    expect(mock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('erreur réseau dont le message contient l’URL avec la clé : aucune fuite', async () => {
    const { fetch } = mockFetch(async (url) => {
      throw new TypeError(`fetch failed ${url}`);
    });

    const error = await errorOf(searchTorznab(SOURCE, MOVIE, { fetch }));

    expect(error.message).toBe('Source "Indexeur" : erreur réseau');
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('idx.example.com');
  });
});

describe('testTorznab', () => {
  it('ok quand t=caps renvoie un document <caps>', async () => {
    const { fetch, mock } = mockFetch(async () =>
      xmlResponse('<?xml version="1.0"?><caps><server title="Indexeur"/></caps>'),
    );

    const result = await testTorznab(SOURCE, { fetch });

    expect(result).toEqual({ ok: true });
    expect(mock.mock.calls[0]?.[0]).toBe(`https://idx.example.com/api?t=caps&apikey=${KEY}`);
  });

  it('ok à false quand la réponse est un <error> (message sans clé)', async () => {
    const { fetch } = mockFetch(async () =>
      xmlResponse(`<?xml version="1.0"?><error code="100" description="Bad ${KEY}"/>`),
    );

    const result = await testTorznab(SOURCE, { fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Source "Indexeur" : erreur Torznab : Bad *** (code 100)');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('ok à false quand la réponse n’est pas un <caps>', async () => {
    const { fetch } = mockFetch(async () => xmlResponse(rss('')));

    const result = await testTorznab(SOURCE, { fetch });

    expect(result).toEqual({ ok: false, error: 'Source "Indexeur" : réponse inattendue (<caps> absent)' });
  });

  it('ok à false sur erreur réseau, sans clé ni URL dans le message', async () => {
    const { fetch } = mockFetch(async (url) => {
      throw new TypeError(`ECONNREFUSED ${url}`);
    });

    const result = await testTorznab(SOURCE, { fetch });

    expect(result).toEqual({ ok: false, error: 'Source "Indexeur" : erreur réseau' });
  });
});
