import { describe, expect, it } from 'vitest';
import { createMemoryKvCache } from '../src/platform/memory-kv-cache.js';
import { IssuedUrls } from '../src/play/issued.js';
import { HostHealth } from '../src/play/hosts.js';
import { PackStore } from '../src/play/packs.js';
import { fetchTorrent, TorrentCache, type FetchedTorrent } from '../src/torrent/fetch-torrent.js';


/**
 * Caches persistants partagés entre instances (Workers : KV). Deux « instances » = deux objets distincts qui ne
 * partagent que le KvCache (ici en mémoire, même contrat que le KV).
 */

const HASH = 'a'.repeat(40);

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
