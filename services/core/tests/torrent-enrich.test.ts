import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { formatStreams } from '../src/engine/format.js';
import type { FetchFn } from '../src/sources/http.js';
import { ENRICH_CONCURRENCY, resolveInfoHashes } from '../src/torrent/enrich.js';
import { TorrentCache } from '../src/torrent/fetch-torrent.js';
import type { RawStream } from '../src/types.js';
import { cand, ranked } from './engine-fixtures.js';
import { monoTorrent, packTorrent } from './torrent-fixtures.js';

const SECRET = 'PK-ENRICH-SECRET-5150';
const KNOWN_HASH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const MAGNET = `magnet:?xt=urn:btih:${KNOWN_HASH}&tr=https%3A%2F%2Ft.example%2F${SECRET}`;
const MONO_HASH = '9657bd8853fb7dbe97ee66bd828aa7ec85f26231';

function torrentResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), { status: 200 });
}

/** Flux Prowlarr sans infoHash, avec un lien .torrent proxifié (passkey dans l'URL). */
function torrentStream(id: number, extra: Partial<RawStream> = {}): RawStream {
  return {
    sourceName: 'Alpha',
    sourceKind: 'torznab',
    title: `Film ${id}`,
    downloadUrl: `https://indexeur.example.com/${id}.torrent?apikey=${SECRET}`,
    guid: `guid-${id}`,
    ...extra,
  };
}

function hashedStream(id: number): RawStream {
  return { sourceName: 'Alpha', sourceKind: 'torznab', title: `Hashé ${id}`, infoHash: KNOWN_HASH.toLowerCase() };
}

/** Faux fetch : répond selon l'URL, sans réseau. Compte les appels. */
function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  const mock = vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url));
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

describe('resolveInfoHashes : sélection (topN)', () => {
  it('ne lit que les N premiers flux sans infoHash mais avec downloadUrl ; les autres sont les mêmes objets', async () => {
    const streams = [torrentStream(1), hashedStream(2), torrentStream(3), torrentStream(4)];
    const { fetch, mock } = fakeFetch(() => torrentResponse(monoTorrent()));

    const out = await resolveInfoHashes(streams, { fetch, topN: 2, cache: new TorrentCache() });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(out[0]?.infoHash).toBe(MONO_HASH);
    expect(out[1]).toBe(streams[1]);
    expect(out[2]?.infoHash).toBe(MONO_HASH);
    expect(out[3]).toBe(streams[3]);
  });

  it('topN = 0 (ou non fini) : aucune requête, flux inchangés', async () => {
    const streams = [torrentStream(1)];
    const { fetch, mock } = fakeFetch(() => torrentResponse(monoTorrent()));

    const zero = await resolveInfoHashes(streams, { fetch, topN: 0, cache: new TorrentCache() });
    const nan = await resolveInfoHashes(streams, { fetch, topN: Number.NaN, cache: new TorrentCache() });

    expect(mock).not.toHaveBeenCalled();
    expect(zero[0]).toBe(streams[0]);
    expect(nan[0]).toBe(streams[0]);
  });

  it('ne modifie jamais le tableau ni les objets d’entrée', async () => {
    const streams = [torrentStream(1)];
    const snapshot = JSON.stringify(streams);
    const { fetch } = fakeFetch(() => torrentResponse(monoTorrent()));

    const out = await resolveInfoHashes(streams, { fetch, topN: 1, cache: new TorrentCache() });

    expect(JSON.stringify(streams)).toBe(snapshot);
    expect(out).not.toBe(streams);
    expect(out[0]).not.toBe(streams[0]);
  });
});

describe('resolveInfoHashes : parallélisme borné', () => {
  it('budget dépassé : les lectures terminées sont gardées, la lecture lente est abandonnée sans bloquer', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/2.torrent')) return new Promise<Response>(() => undefined);
      return torrentResponse(monoTorrent());
    }) as unknown as FetchFn;
    const streams = [torrentStream(1), torrentStream(2)];

    const started = Date.now();
    const out = await resolveInfoHashes(streams, { fetch, topN: 2, cache: new TorrentCache(), budgetMs: 100 });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(out[0]?.infoHash).toBe(MONO_HASH);
    expect(out[1]?.infoHash).toBeUndefined();
    expect(out[1]?.downloadUrl).toBeDefined();
  });

  it(`au plus ${ENRICH_CONCURRENCY} lectures simultanées`, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return torrentResponse(monoTorrent());
    }) as unknown as FetchFn;
    const count = ENRICH_CONCURRENCY + 4;
    const streams = Array.from({ length: count }, (_, i) => torrentStream(i + 1));

    const out = await resolveInfoHashes(streams, { fetch, topN: count, cache: new TorrentCache() });

    expect(maxInFlight).toBe(ENRICH_CONCURRENCY);
    expect(out.every((stream) => stream.infoHash === MONO_HASH)).toBe(true);
  });
});

describe('resolveInfoHashes : échecs isolés', () => {
  it('un flux en erreur reste sans infoHash ; les autres sont enrichis', async () => {
    const streams = [torrentStream(1), torrentStream(2), torrentStream(3)];
    const { fetch } = fakeFetch((url) => (url.includes('/2.torrent') ? new Response('boom', { status: 500 }) : torrentResponse(monoTorrent())));

    const out = await resolveInfoHashes(streams, { fetch, topN: 3, cache: new TorrentCache() });

    expect(out[0]?.infoHash).toBe(MONO_HASH);
    expect(out[1]).toBe(streams[1]);
    expect(out[1]?.infoHash).toBeUndefined();
    expect(out[2]?.infoHash).toBe(MONO_HASH);
  });

  it('une exception inattendue (réseau) ne casse pas le lot', async () => {
    const streams = [torrentStream(1), torrentStream(2)];
    const { fetch } = fakeFetch((url) => {
      if (url.includes('/1.torrent')) throw new Error(`reset ${SECRET}`);
      return torrentResponse(monoTorrent());
    });

    const out = await resolveInfoHashes(streams, { fetch, topN: 2, cache: new TorrentCache() });

    expect(out[0]).toBe(streams[0]);
    expect(out[1]?.infoHash).toBe(MONO_HASH);
  });
});

describe('resolveInfoHashes : champs renseignés', () => {
  it('torrent public : infoHash, privateTorrent false, packFiles = un fichier', async () => {
    const { fetch } = fakeFetch(() => torrentResponse(monoTorrent()));

    const [out] = await resolveInfoHashes([torrentStream(1)], { fetch, topN: 1, cache: new TorrentCache() });

    expect(out).toMatchObject({ infoHash: MONO_HASH, privateTorrent: false, packFiles: [{ idx: 0, name: 'abc', size: 3 }] });
  });

  it('pack privé : privateTorrent true et packFiles (idx, name, size) dans l’ordre du .torrent', async () => {
    const body = packTorrent(
      [
        { path: ['S01E01.mkv'], length: 10 },
        { path: ['S01E02.mkv'], length: 20 },
      ],
      { private: true },
    );
    const { fetch } = fakeFetch(() => torrentResponse(body));

    const [out] = await resolveInfoHashes([torrentStream(1)], { fetch, topN: 1, cache: new TorrentCache() });

    expect(out?.privateTorrent).toBe(true);
    expect(out?.packFiles).toEqual([
      { idx: 0, name: 'S01E01.mkv', size: 10 },
      { idx: 1, name: 'S01E02.mkv', size: 20 },
    ]);
  });

  it('redirection vers un magnet : infoHash seulement (pas de privateTorrent ni de packFiles)', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 302, headers: { location: MAGNET } }));

    const [out] = await resolveInfoHashes([torrentStream(1)], { fetch, topN: 1, cache: new TorrentCache() });

    expect(out?.infoHash).toBe(KNOWN_HASH.toLowerCase());
    expect(out?.privateTorrent).toBeUndefined();
    expect(out?.packFiles).toBeUndefined();
  });
});

describe('resolveInfoHashes : guid et cache', () => {
  it('le guid du flux sert de clé de cache : un second passage ne fait aucune requête', async () => {
    const cache = new TorrentCache();
    const { fetch, mock } = fakeFetch(() => torrentResponse(monoTorrent()));

    await resolveInfoHashes([torrentStream(1)], { fetch, topN: 1, cache });
    const again = await resolveInfoHashes([torrentStream(1)], { fetch, topN: 1, cache });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(again[0]?.infoHash).toBe(MONO_HASH);
  });

  it('guidOf remplace stream.guid comme clé de cache', async () => {
    const cache = new TorrentCache();
    const { fetch, mock } = fakeFetch(() => torrentResponse(monoTorrent()));

    await resolveInfoHashes([torrentStream(1)], { fetch, topN: 1, cache, guidOf: () => 'clef-commune' });
    await resolveInfoHashes([torrentStream(2)], { fetch, topN: 1, cache, guidOf: () => 'clef-commune' });

    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('garde-fou : downloadUrl ne sort jamais', () => {
  it('le commentaire de RawStream.downloadUrl dans src/types.ts interdit toute sortie', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/types.ts', import.meta.url)), 'utf8');
    const block = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*downloadUrl\?: string;/.exec(source);

    expect(block?.[1]).toMatch(/SECRET/);
    expect(block?.[1]).toMatch(/jamais/);
  });

  it('la sortie Stremio d’un flux enrichi ne contient ni l’URL, ni la passkey, ni le guid', async () => {
    const { fetch } = fakeFetch(() => torrentResponse(monoTorrent({ private: true })));
    const [enriched] = await resolveInfoHashes([torrentStream(1)], { fetch, topN: 1, cache: new TorrentCache() });
    expect(enriched?.downloadUrl).toContain(SECRET);
    expect(enriched?.infoHash).toMatch(/^[0-9a-f]{40}$/);

    const streams = formatStreams([ranked(cand({ raw: enriched }))], {
      playBaseUrl: 'https://addon.example.com',
      configToken: 'TOKEN-CONFIG',
      secret: 'torrent-enrich-test-secret',
      maxResults: 10,
      hasDebrid: true,
    });
    const json = JSON.stringify(streams);

    // L'infoHash ne sort plus en clair : il voyage dans le jeton signé de l'URL /play (pas de P2P).
    expect(streams).toHaveLength(1);
    expect(streams[0]?.infoHash).toBeUndefined();
    expect(streams[0]?.url).toContain('/TOKEN-CONFIG/play/c/');
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('apikey');
    expect(json).not.toContain('indexeur.example.com');
    expect(json).not.toContain('guid-1');
    expect(json).not.toContain('downloadUrl');
  });

  it('un flux non enrichi (sans infoHash) n’expose pas davantage son URL', () => {
    const streams = formatStreams([ranked(cand({ raw: torrentStream(9) }))], {
      playBaseUrl: 'https://addon.example.com',
      configToken: 'TOKEN-CONFIG',
      secret: 'torrent-enrich-test-secret',
      maxResults: 10,
      hasDebrid: false,
    });

    expect(JSON.stringify(streams)).not.toContain(SECRET);
  });
});
