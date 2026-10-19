import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryKvCache } from '../src/platform/memory-kv-cache.js';
import { IssuedUrls } from '../src/play/issued.js';
import { HostHealth } from '../src/play/hosts.js';
import { PackStore } from '../src/play/packs.js';
import { AllDebridClient } from '../src/sources/alldebrid.js';
import { fetchTorrent, TorrentCache, type FetchedTorrent } from '../src/torrent/fetch-torrent.js';

// Mode serveur AllDebrid explicitement activé (opt-in) : le client AllDebrid est appelé depuis le serveur.
beforeEach(() => vi.stubEnv('LASTADDON_DEBRID_SERVER_SIDE', '1'));
afterEach(() => vi.unstubAllEnvs());

/**
 * Caches persistants partagés entre instances (Workers : KV). Deux « instances » = deux objets distincts qui ne
 * partagent que le KvCache (ici en mémoire, même contrat que le KV).
 */

const HASH = 'a'.repeat(40);
const API_KEY = 'AD-TEST-KEY-NE-PAS-FUITER';

interface Call {
  path: string;
  form: URLSearchParams;
}

/** AllDebrid simulé : magnet prêt, un fichier, déblocage d'un lien. */
function fakeAllDebrid(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const reply = (data: unknown): Response =>
    new Response(JSON.stringify({ status: 'success', data }), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    calls.push({ path: url.pathname, form });
    switch (url.pathname) {
      case '/v4/magnet/upload':
        return reply({ magnets: [{ magnet: `magnet:?xt=urn:btih:${HASH}`, hash: HASH, name: 'x', size: 1, ready: true, id: 7 }] });
      case '/v4.1/magnet/status':
        return reply({ magnets: [] });
      case '/v4/magnet/files':
        return reply({ magnets: [{ id: 7, files: [{ n: 'movie.mkv', s: 5000, l: 'locked-1' }] }] });
      case '/v4/link/unlock':
        return reply({ link: 'https://dl.example.com/movie.mkv', filename: 'movie.mkv', filesize: 5000 });
      default:
        return reply({ message: 'ok' });
    }
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

describe('AllDebrid : statuts et liens partagés entre instances', () => {
  it('le statut « prêt » appris par une instance évite l\'envoi du magnet par une autre', async () => {
    const kv = createMemoryKvCache();
    const first = fakeAllDebrid();
    const second = fakeAllDebrid();
    const a = new AllDebridClient(API_KEY, { fetch: first.fetch, kv });
    const b = new AllDebridClient(API_KEY, { fetch: second.fetch, kv });
    expect((await a.checkCached([HASH])).get(HASH)).toBe(true);
    expect(first.calls.some((call) => call.path === '/v4/magnet/upload')).toBe(true);
    expect((await b.checkCached([HASH])).get(HASH)).toBe(true);
    expect(second.calls).toEqual([]);
  });

  it('le lien résolu par une instance est servi à une autre sans appel AllDebrid', async () => {
    const kv = createMemoryKvCache();
    const first = fakeAllDebrid();
    const second = fakeAllDebrid();
    const a = new AllDebridClient(API_KEY, { fetch: first.fetch, kv });
    const b = new AllDebridClient(API_KEY, { fetch: second.fetch, kv });
    const link = await a.resolve(HASH, undefined, { sleep: async () => {} });
    expect(link.url).toBe('https://dl.example.com/movie.mkv');
    expect(await b.resolve(HASH, undefined, { sleep: async () => {} })).toEqual(link);
    expect(second.calls).toEqual([]);
  });

  it('les entrées sont propres à la clé API : un autre compte ne lit pas le cache', async () => {
    const kv = createMemoryKvCache();
    const first = fakeAllDebrid();
    const other = fakeAllDebrid();
    await new AllDebridClient(API_KEY, { fetch: first.fetch, kv }).checkCached([HASH]);
    await new AllDebridClient('AUTRE-CLE-API', { fetch: other.fetch, kv }).checkCached([HASH]);
    expect(other.calls.some((call) => call.path === '/v4/magnet/upload')).toBe(true);
  });

  it('aucune clé API dans les clés ni les valeurs du cache partagé', async () => {
    const stored: string[] = [];
    const inner = createMemoryKvCache();
    const kv = {
      ...inner,
      set: (key: string, value: string, ttl?: number) => {
        stored.push(key, value);
        return inner.set(key, value, ttl);
      },
    };
    const fake = fakeAllDebrid();
    const client = new AllDebridClient(API_KEY, { fetch: fake.fetch, kv });
    await client.checkCached([HASH]);
    await client.resolve(HASH, undefined, { sleep: async () => {} });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.join('\n')).not.toContain(API_KEY);
  });

  it('un cache partagé illisible est ignoré', async () => {
    const broken = {
      get: () => Promise.reject(new Error('KV indisponible')),
      set: () => Promise.reject(new Error('KV indisponible')),
      delete: () => Promise.reject(new Error('KV indisponible')),
    };
    const fake = fakeAllDebrid();
    const client = new AllDebridClient(API_KEY, { fetch: fake.fetch, kv: broken });
    expect((await client.checkCached([HASH])).get(HASH)).toBe(true);
    expect((await client.resolve(HASH, undefined, { sleep: async () => {} })).filename).toBe('movie.mkv');
  });
});

describe('URL émises partagées entre instances', () => {
  it('une URL notée par une instance est connue d\'une autre, ainsi que le lien débridé d\'un /play', async () => {
    const kv = createMemoryKvCache();
    const a = new IssuedUrls(Date.now, undefined, kv);
    const b = new IssuedUrls(Date.now, undefined, kv);
    await a.noteStreams([{ url: 'https://cdn.example.com/a.mkv' }, { name: 'sans url' }]);
    await a.noteResolved('/CFG/play/c/TOK?x=1', 'https://dl.example.com/b.mkv');
    expect(await b.has('https://cdn.example.com/a.mkv')).toBe(true);
    expect(await b.has('https://cdn.example.com/inconnu.mkv')).toBe(false);
    expect(await b.has('https://dl.example.com/b.mkv')).toBe(true);
    expect(await b.resolvedFor('http://x.example/CFG/play/c/TOK?x=1')).toBe('https://dl.example.com/b.mkv');
  });
});

describe('packs et hébergeurs partagés entre instances', () => {
  const files = [
    { idx: 0, name: 'Serie.S01E01.mkv', size: 100 },
    { idx: 1, name: 'Serie.S01E02.mkv', size: 200 },
  ];

  it('les fichiers d\'un pack appris par une instance servent à une autre après warm()', async () => {
    const kv = createMemoryKvCache();
    const pending: Promise<unknown>[] = [];
    const a = new PackStore({ kv, background: (work) => void pending.push(work) });
    const b = new PackStore({ kv });
    expect(a.learn(HASH, files)).toBe(true);
    await Promise.all(pending);
    expect(b.findEpisode(HASH, 1, 2)).toBeUndefined();
    await b.warm([HASH, 'pas-un-hash']);
    expect(b.findEpisode(HASH, 1, 2)).toEqual({ idx: 1, name: 'Serie.S01E02.mkv', size: 200 });
  });

  it('un hébergeur en panne signalé par une instance est vu par une autre après warm()', async () => {
    const kv = createMemoryKvCache();
    const pending: Promise<unknown>[] = [];
    const a = new HostHealth({ kv, background: (work) => void pending.push(work) });
    const b = new HostHealth({ kv });
    a.markDown('Hoster.Example.com.');
    await Promise.all(pending);
    expect(b.isDown('hoster.example.com')).toBe(false);
    await b.warm(['hoster.example.com', 'autre.example.com']);
    expect(b.isDown('hoster.example.com')).toBe(true);
    expect(b.isDown('autre.example.com')).toBe(false);
  });
});

describe('.torrent partagés entre instances', () => {
  const privateTorrent: FetchedTorrent = {
    kind: 'torrent',
    infoHash: HASH,
    files: [{ idx: 0, path: 'film.mkv', size: 10 }] as never,
    private: true,
    bytes: Buffer.from([1, 2, 3, 255]),
  };

  it('les octets d\'un torrent privé lus par une instance sont relus par une autre ; ceux d\'un public ne sont pas gardés', async () => {
    const kv = createMemoryKvCache();
    const a = new TorrentCache({ kv });
    const b = new TorrentCache({ kv });
    await a.save('guid-prive', privateTorrent);
    await a.save('guid-public', { ...privateTorrent, private: false });
    const restored = await b.load('guid-prive');
    expect(restored).toMatchObject({ kind: 'torrent', infoHash: HASH, private: true });
    expect(restored?.kind === 'torrent' ? [...(restored.bytes ?? [])] : []).toEqual([1, 2, 3, 255]);
    const pub = await b.load('guid-public');
    expect(pub?.kind === 'torrent' ? pub.bytes : 'x').toBeUndefined();
    expect(await b.load('inconnu')).toBeUndefined();
  });

  it('fetchTorrent répond depuis le cache partagé sans télécharger', async () => {
    const kv = createMemoryKvCache();
    await new TorrentCache({ kv }).save('guid', { kind: 'magnet', infoHash: HASH, magnet: `magnet:?xt=urn:btih:${HASH}` });
    let downloads = 0;
    const fetchImpl = (() => {
      downloads += 1;
      return Promise.resolve(new Response('', { status: 500 }));
    }) as unknown as typeof fetch;
    const result = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch: fetchImpl, guid: 'guid', cache: new TorrentCache({ kv }) });
    expect(result.kind).toBe('magnet');
    expect(downloads).toBe(0);
  });
});
