// @vitest-environment node
// Hors ligne (ODY-198) : aucune requête au serveur Laststream, aucune fuite de lien débridé, aucun import de src/data ni du débrideur.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadManager } from '../../src/downloads/manager';
import { MemoryDownloadIndex } from '../../src/downloads/index';
import type { DownloadSink, DownloadSource, DownloadStore, HttpFn } from '../../src/downloads/types';

type Req = Parameters<HttpFn>[0];
type Res = Awaited<ReturnType<HttpFn>>;

const SECRET_URL = 'https://cdn.example.test/film.mkv?apikey=SECRET';
const CHUNK = 1000;
const SIZE = 3000;
const SOURCE: DownloadSource = { copies: [{ infoHash: 'b'.repeat(40) }] };
const until = (fn: () => void | Promise<void>) => vi.waitFor(fn, { timeout: 5000, interval: 5 });

const content = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 17 + 3) % 251);

/** Magasin en mémoire, avec la liste des identifiants ouverts. */
function memoryStore(): DownloadStore & { files: Map<string, number[]> } {
  const files = new Map<string, number[]>();
  return {
    files,
    async open(id: string): Promise<DownloadSink> {
      let bytes = files.get(id);
      if (!bytes) {
        bytes = [];
        files.set(id, bytes);
      }
      const b = bytes;
      return {
        async size() {
          return b.length;
        },
        async write(offset, chunk) {
          for (let i = 0; i < chunk.byteLength; i += 1) b[offset + i] = chunk[i];
        },
        async truncate(len) {
          b.length = len;
        },
        async finalize() {
          /* rien à faire en mémoire */
        },
        async close() {
          /* rien à libérer en mémoire */
        },
      };
    },
    async size(id: string) {
      return files.get(id)?.length ?? 0;
    },
    async remove(id: string) {
      files.delete(id);
    },
    async usage() {
      return { used: [...files.values()].reduce((n, f) => n + f.length, 0) };
    },
  };
}

/** Hébergeur simulé : une seule URL valide (avec la clé), qui expire une fois pour forcer une re-résolution. */
function fakeHost() {
  const file = content(SIZE);
  const urls: string[] = [];
  let expireOnce = true;
  const resolve = vi.fn(async () => ({ url: SECRET_URL, size: SIZE, filename: 'film.mkv' }));
  const http = async (req: Req): Promise<Res> => {
    urls.push(req.url);
    if (expireOnce && urls.length === 2) {
      expireOnce = false;
      return { status: 403, headers: {}, body: new Uint8Array() };
    }
    if (req.url !== SECRET_URL) return { status: 403, headers: {}, body: new Uint8Array() };
    const m = /bytes=(\d+)-(\d+)/.exec(Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'range')?.[1] ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = Math.min(m ? Number(m[2]) : SIZE - 1, SIZE - 1);
    return {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${SIZE}`, etag: '"v1"', 'content-type': 'video/x-matroska' },
      body: file.slice(start, end + 1),
    };
  };
  return { http, urls, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hors ligne : pas de serveur Laststream', () => {
  it('un cycle complet (avec re-résolution) n’appelle jamais fetch : tout passe par le transport injecté', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch interdit pendant un téléchargement hors ligne');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const host = fakeHost();
    const m = new DownloadManager({
      resolver: { resolve: host.resolve },
      http: host.http,
      store: memoryStore(),
      index: new MemoryDownloadIndex(),
      chunkSize: CHUNK,
      sleep: async () => undefined,
    });
    await m.init();
    const item = await m.enqueue({ metaId: 'tt0001', title: 'Film', source: SOURCE });
    await until(() => expect(m.get(item.id)?.state).toBe('done'));

    expect(fetchSpy).not.toHaveBeenCalled();
    // Chaque requête a visé l'hôte du lien résolu, et seulement lui.
    expect(host.urls.length).toBeGreaterThan(0);
    for (const u of host.urls) expect(new URL(u).hostname).toBe('cdn.example.test');
  });
});

describe('hors ligne : sources', () => {
  it.each(['state', 'transfer', 'manager', 'index'])(
    'src/downloads/%s.ts n’importe ni src/data ni le débrideur',
    (name) => {
      const path = fileURLToPath(new URL(`../../src/downloads/${name}.ts`, import.meta.url));
      const source = readFileSync(path, 'utf8');
      const specifiers = [...source.matchAll(/(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1] ?? m[2] ?? m[3],
      );
      for (const spec of specifiers) {
        expect(spec, `${name}.ts importe ${spec}`).not.toMatch(/(^|\/)data(\/|$)|debridClient/);
      }
    },
  );
});

describe('hors ligne : aucune fuite du lien débridé', () => {
  it('le lien (avec sa clé) n’apparaît ni dans les journaux, ni dans l’index, ni dans les items, ni dans une erreur', async () => {
    const host = fakeHost();
    const logs: string[] = [];
    const index = new MemoryDownloadIndex();
    const m = new DownloadManager({
      resolver: { resolve: host.resolve },
      http: host.http,
      store: memoryStore(),
      index,
      chunkSize: CHUNK,
      sleep: async () => undefined,
      onLog: (event, data) => {
        logs.push(event, JSON.stringify(data ?? {}));
      },
    });
    await m.init();
    const ok = await m.enqueue({ metaId: 'tt0001', title: 'Film', source: SOURCE });
    await until(() => expect(m.get(ok.id)?.state).toBe('done'));

    // Second cas : le transport échoue en levant un message qui contient le lien ; l'échec doit rester sans lien.
    const leakyIndex = new MemoryDownloadIndex();
    const leaky = new DownloadManager({
      resolver: { resolve: host.resolve },
      http: async (req: Req) => {
        throw new Error(`échec de ${req.url}`);
      },
      store: memoryStore(),
      index: leakyIndex,
      chunkSize: CHUNK,
      maxNetworkRetries: 0,
      sleep: async () => undefined,
      onLog: (event, data) => {
        logs.push(event, JSON.stringify(data ?? {}));
      },
    });
    await leaky.init();
    const bad = await leaky.enqueue({ metaId: 'tt0002', title: 'Film 2', source: SOURCE });
    await until(() => expect(leaky.get(bad.id)?.state).toBe('error'));
    expect(leaky.get(bad.id)?.error?.code).toBe('network');

    const dumps = JSON.stringify([logs, await index.all(), m.list(), leaky.list(), await leakyIndex.all()]);
    expect(logs).toContain('failed');
    expect(dumps).not.toContain('SECRET');
    expect(dumps).not.toContain('apikey');
    expect(dumps).not.toContain('cdn.example.test');
  });
});
