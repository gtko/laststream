// @vitest-environment node
// Gestionnaire des téléchargements (ODY-198) : magasin, index, serveur et résolveur sont simulés en mémoire ; le sleep est instantané.
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DownloadManager, type DownloadManagerOptions } from '../../src/downloads/manager';
import { MemoryDownloadIndex } from '../../src/downloads/index';
import {
  DownloadError,
  downloadId,
  type DownloadIndex,
  type DownloadItem,
  type DownloadSink,
  type DownloadSource,
  type DownloadStore,
  type HttpFn,
  type LinkResolver,
  type ResolvedFile,
} from '../../src/downloads/types';
import { DebridError } from '../../src/sources/debrid/types';

type Req = Parameters<HttpFn>[0];
type Res = Awaited<ReturnType<HttpFn>>;

const ETAG = '"v1"';
const CHUNK = 1000;
const SIZE = 5000;
const SOURCE: DownloadSource = { copies: [{ infoHash: 'a'.repeat(40) }] };
const REQ = { metaId: 'tt0001', title: 'Film' };

/** Attend que la condition soit vraie (les sessions tournent en microtâches ; le délai reste court). */
const until = (fn: () => void | Promise<void>) => vi.waitFor(fn, { timeout: 5000, interval: 5 });

const content = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251);

const headerOf = (req: Req, name: string): string | undefined =>
  Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

/** Hébergeur simulé : sert un fichier en plages (206 + Content-Range). Un lien n'est valide que tant qu'il n'a pas été `expire()`. */
function fakeHost(size: number) {
  const file = content(size);
  const live = new Set<string>();
  const urls: string[] = [];
  const starts: number[] = [];
  let issued = 0;
  const host = {
    file,
    urls,
    starts,
    /** Incident injecté avant la réponse : une erreur la remplace, une réponse aussi ; undefined = service normal. */
    incident: undefined as ((req: Req) => Res | Error | undefined) | undefined,
    issue(): string {
      issued += 1;
      const url = `https://cdn.example.test/film.mkv?apikey=SECRET&n=${issued}`;
      live.add(url);
      return url;
    },
    expire(): void {
      live.clear();
    },
    http: async (req: Req): Promise<Res> => {
      urls.push(req.url);
      const range = /bytes=(\d+)-(\d+)/.exec(headerOf(req, 'range') ?? '');
      const start = range ? Number(range[1]) : 0;
      starts.push(start);
      const hit = host.incident?.(req);
      if (hit instanceof Error) throw hit;
      if (hit) return hit;
      if (!live.has(req.url)) return { status: 403, headers: {}, body: new Uint8Array() };
      if (start >= file.length) return { status: 416, headers: { 'content-range': `bytes */${file.length}` }, body: new Uint8Array() };
      const end = Math.min(range ? Number(range[2]) : file.length - 1, file.length - 1);
      return {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${file.length}`, etag: ETAG, 'content-type': 'video/x-matroska' },
        body: file.slice(start, end + 1),
      };
    },
  };
  return host;
}

type Host = ReturnType<typeof fakeHost>;

/** Résolveur simulé : chaque appel délivre un nouveau lien ; `failures` sont lancées dans l'ordre avant tout succès. */
function fakeResolver(host: Host, failures: Error[] = []) {
  let calls = 0;
  const resolver: LinkResolver & { readonly calls: number } = {
    get calls() {
      return calls;
    },
    async resolve(_src: DownloadSource, _signal: AbortSignal): Promise<ResolvedFile> {
      calls += 1;
      const err = failures.shift();
      if (err) throw err;
      return { url: host.issue(), size: host.file.length, filename: 'film.mkv' };
    },
  };
  return resolver;
}

/** Magasin en mémoire : un fichier par identifiant, capacité optionnelle. Compte les sinks ouverts et non fermés, et les relevés d'espace. */
function memoryStore(capacity?: number) {
  const files = new Map<string, number[]>();
  const finalized: string[] = [];
  const removed: string[] = [];
  const opened: string[] = [];
  let openSinks = 0;
  let usageCalls = 0;
  const used = (): number => [...files.values()].reduce((n, f) => n + f.length, 0);
  const store: DownloadStore = {
    async open(id: string): Promise<DownloadSink> {
      opened.push(id);
      openSinks += 1;
      let file = files.get(id);
      if (!file) {
        file = [];
        files.set(id, file);
      }
      const bytes = file;
      let closed = false;
      return {
        async size() {
          return bytes.length;
        },
        async write(offset, chunk) {
          if (offset > bytes.length) throw new Error('écriture au-delà de la fin');
          const grow = Math.max(0, offset + chunk.byteLength - bytes.length);
          if (capacity !== undefined && used() + grow > capacity) throw new DownloadError('store_full', false);
          for (let i = 0; i < chunk.byteLength; i += 1) bytes[offset + i] = chunk[i];
        },
        async truncate(len) {
          bytes.length = len;
        },
        async finalize() {
          finalized.push(id);
        },
        async close() {
          if (!closed) {
            closed = true;
            openSinks -= 1;
          }
        },
      };
    },
    async size(id: string) {
      return files.get(id)?.length ?? 0;
    },
    async remove(id: string) {
      files.delete(id);
      removed.push(id);
    },
    async usage() {
      usageCalls += 1;
      return { used: used() };
    },
  };
  return {
    store,
    files,
    finalized,
    removed,
    opened,
    bytes: (id: string): Uint8Array => Uint8Array.from(files.get(id) ?? []),
    /** Sinks ouverts et pas encore fermés. */
    openSinks: (): number => openSinks,
    /** Nombre de relevés d'espace (`usage()`). */
    usageCalls: (): number => usageCalls,
  };
}

interface SetupOpts {
  limitBytes?: number | null;
  capacity?: number;
  failures?: Error[];
  maxResolves?: number;
  maxNetworkRetries?: number;
  concurrency?: number;
  http?: HttpFn;
  index?: DownloadIndex;
}

function setup(host: Host, opts: SetupOpts = {}) {
  const st = memoryStore(opts.capacity);
  const index = opts.index ?? new MemoryDownloadIndex();
  const resolver = fakeResolver(host, opts.failures);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const managerOpts: DownloadManagerOptions = {
    resolver,
    http: opts.http ?? host.http,
    store: st.store,
    index,
    chunkSize: CHUNK,
    limitBytes: opts.limitBytes,
    maxResolves: opts.maxResolves,
    maxNetworkRetries: opts.maxNetworkRetries,
    concurrency: opts.concurrency,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onLog: (event) => {
      logs.push(event);
    },
  };
  const manager = new DownloadManager(managerOpts);
  return { manager, store: st, index, resolver, sleeps, logs };
}

const idOf = (metaId: string, season?: number, episode?: number) => downloadId(metaId, season, episode);

describe('DownloadManager : cycle nominal', () => {
  it('un téléchargement complet passe à done, est finalisé une fois, et l’index suit', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host);
    await t.manager.init();
    const item = await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(item.id)?.state).toBe('done'));

    expect(t.store.finalized).toEqual([item.id]);
    expect(t.store.bytes(item.id)).toEqual(host.file);
    expect(t.manager.get(item.id)).toMatchObject({ state: 'done', bytesDone: SIZE, bytesTotal: SIZE, etag: ETAG });
    expect(t.resolver.calls).toBe(1);
    await until(async () => expect((await t.index.all()).find((i) => i.id === item.id)?.state).toBe('done'));

    // Un terminé ne bouge plus.
    t.manager.pause(item.id);
    t.manager.resume(item.id);
    expect(t.manager.get(item.id)?.state).toBe('done');
  });

  it('enqueue est idempotent par identifiant (saison et épisode compris)', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host);
    await t.manager.init();
    const a = await t.manager.enqueue({ ...REQ, source: SOURCE, estimatedSize: 100 });
    const b = await t.manager.enqueue({ ...REQ, source: SOURCE, estimatedSize: 100 });
    expect(b.id).toBe(a.id);
    const ep = await t.manager.enqueue({ metaId: 'tt0002', season: 1, episode: 2, title: 'Série', source: SOURCE });
    expect(ep.id).toBe('tt0002:1:2');
    expect(t.manager.list().map((i) => i.id).sort()).toEqual([a.id, ep.id].sort());
  });

  it('une erreur d’index ne fait ni planter le gestionnaire ni bloquer le téléchargement', async () => {
    const failing: DownloadIndex = {
      all: () => Promise.reject(new Error('idb')),
      put: () => Promise.reject(new Error('idb')),
      delete: () => Promise.reject(new Error('idb')),
    };
    const host = fakeHost(SIZE);
    const t = setup(host, { index: failing });
    await t.manager.init();
    const item = await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(item.id)?.state).toBe('done'));
    await t.manager.remove(item.id);
    expect(t.logs).toContain('index_failed');
  });

  it('subscribe reçoit les changements, et plus rien après désabonnement', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host);
    await t.manager.init();
    const seen: number[] = [];
    const off = t.manager.subscribe((items) => {
      seen.push(items.length);
    });
    const item = await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)).toBe(1);
    await until(() => expect(t.manager.get(item.id)?.state).toBe('done'));
    off();
    const before = seen.length;
    await t.manager.enqueue({ metaId: 'tt0009', title: 'Autre', source: SOURCE });
    await until(() => expect(t.manager.list()).toHaveLength(2));
    expect(seen.length).toBe(before);
  });
});

describe('DownloadManager : pause, reprise et redémarrage', () => {
  it('pause en cours puis reprise : la reprise part de la taille du fichier, sans réécrire', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host);
    const id = idOf(REQ.metaId);
    // Taille du fichier au moment où chaque requête arrive : la plage demandée doit toujours la commencer.
    const sizeAtRequest: number[] = [];
    let paused = false;
    host.incident = () => {
      sizeAtRequest.push(t.store.files.get(id)?.length ?? 0);
      if (host.urls.length === 2 && !paused) {
        paused = true;
        t.manager.pause(id);
      }
      return undefined;
    };
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('paused'));

    t.manager.resume(id);
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));

    expect(host.starts.length).toBeGreaterThan(2);
    host.starts.forEach((start, i) => expect(start).toBe(sizeAtRequest[i]));
    expect(t.store.bytes(id)).toEqual(host.file);
    expect(t.store.finalized).toEqual([id]);
  });

  it('init : un téléchargement running repasse en attente, sa taille est relue du magasin, et il reprend là', async () => {
    const host = fakeHost(SIZE);
    const id = idOf(REQ.metaId);
    const index = new MemoryDownloadIndex();
    const st = memoryStore();
    // Session précédente interrompue : 2000 octets écrits, item encore « running » dans l'index.
    const partial = await st.store.open(id);
    await partial.write(0, host.file.slice(0, 2000));
    await partial.close();
    const stale: DownloadItem = {
      id,
      metaId: REQ.metaId,
      title: REQ.title,
      source: SOURCE,
      state: 'running',
      bytesDone: 0,
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await index.put(stale);

    const resolver = fakeResolver(host);
    const m = new DownloadManager({ resolver, http: host.http, store: st.store, index, chunkSize: CHUNK, sleep: async () => undefined });
    await m.init();
    expect(m.get(id)?.bytesDone).toBeGreaterThanOrEqual(2000);
    await until(() => expect(m.get(id)?.state).toBe('done'));

    expect(host.starts[0]).toBe(2000);
    expect(st.bytes(id)).toEqual(host.file);
    expect(st.finalized).toEqual([id]);
  });

  it('pauseAll puis resumeAll remettent tout en route', async () => {
    const host = fakeHost(SIZE);
    const hang: HttpFn = (req) =>
      new Promise<Res>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('annulé')));
      });
    const t = setup(host, { http: hang, concurrency: 2 });
    await t.manager.init();
    const a = await t.manager.enqueue({ metaId: 'tt0001', title: 'A', source: SOURCE });
    const b = await t.manager.enqueue({ metaId: 'tt0002', title: 'B', source: SOURCE });
    await until(() => expect(t.manager.get(a.id)?.state).toBe('running'));
    t.manager.pauseAll();
    await until(() => {
      expect(t.manager.get(a.id)?.state).toBe('paused');
      expect(t.manager.get(b.id)?.state).toBe('paused');
    });
    t.manager.resumeAll();
    expect(t.manager.list().every((i) => i.state === 'pending' || i.state === 'running')).toBe(true);
    await t.manager.remove(a.id);
    await t.manager.remove(b.id);
  });
});

describe('DownloadManager : lien périmé et erreurs de résolution', () => {
  it('lien périmé en cours : une re-résolution, puis reprise au même offset avec la nouvelle URL', async () => {
    const host = fakeHost(SIZE);
    host.incident = () => {
      // Le lien du deuxième morceau expire juste avant sa requête.
      if (host.urls.length === 2) host.expire();
      return undefined;
    };
    const t = setup(host);
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));

    expect(t.resolver.calls).toBe(2);
    // Requêtes : 0 (ok), 1000 (403), 1000 (nouvelle URL, ok), puis 2000, 3000, 4000.
    expect(host.starts).toEqual([0, CHUNK, CHUNK, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK]);
    expect(host.urls[2]).not.toBe(host.urls[0]);
    expect(t.store.bytes(id)).toEqual(host.file);
    expect(t.logs).toContain('link_expired');
  });

  it('re-résolutions épuisées : error link_expired après maxResolves', async () => {
    const host = fakeHost(SIZE);
    host.incident = () => {
      host.expire();
      return undefined;
    };
    const t = setup(host, { maxResolves: 2 });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('error'));

    expect(t.manager.get(id)?.error?.code).toBe('link_expired');
    // Résolution initiale plus deux re-résolutions.
    expect(t.resolver.calls).toBe(3);
  });

  it('DebridError de compte : error account, sans nouvel essai', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { failures: [new DebridError('invalid_key', 'account', { state: 'invalid_key' })] });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('error'));

    expect(t.manager.get(id)?.error?.code).toBe('account');
    expect(t.resolver.calls).toBe(1);
    expect(t.sleeps).toEqual([]);
    expect(host.urls).toEqual([]);
  });

  it('retry relance un téléchargement en erreur, qui se termine', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { failures: [new DebridError('invalid_key', 'account')] });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('error'));

    t.manager.retry(id);
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));
    expect(t.manager.get(id)?.error).toBeUndefined();
    expect(t.resolver.calls).toBe(2);
  });

  it('écriture refusée en cours de route (ODY-240) : la cause reste précise, Réessayer reprend à l’octet écrit', async () => {
    const host = fakeHost(SIZE);
    const logs: Array<[string, Record<string, string | number> | undefined]> = [];
    const t = setup(host);
    // Le journal complet (données comprises) est lu sur le gestionnaire réel.
    const manager = new DownloadManager({
      resolver: t.resolver,
      http: host.http,
      store: t.store.store,
      index: t.index,
      chunkSize: CHUNK,
      sleep: async () => undefined,
      onLog: (event, data) => {
        logs.push([event, data]);
      },
    });
    const open = t.store.store.open.bind(t.store.store);
    let refuse = true;
    t.store.store.open = async (fileId) => {
      const sink = await open(fileId);
      const write = sink.write.bind(sink);
      sink.write = async (offset, chunk) => {
        if (refuse && offset >= 2 * CHUNK) throw new DownloadError('store_denied', false, 'io');
        await write(offset, chunk);
      };
      return sink;
    };
    const id = idOf(REQ.metaId);
    await manager.init();
    await manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(manager.get(id)?.state).toBe('error'));

    expect(manager.get(id)?.error?.code).toBe('store_denied');
    expect(t.store.bytes(id).length).toBe(2 * CHUNK);
    const failed = logs.find(([event]) => event === 'failed');
    expect(failed?.[1]).toMatchObject({ code: 'store_denied', detail: 'io', bytes: 2 * CHUNK, total: SIZE });

    refuse = false;
    host.starts.length = 0;
    manager.retry(id);
    await until(() => expect(manager.get(id)?.state).toBe('done'));
    expect(manager.get(id)?.error).toBeUndefined();
    // Reprise au premier octet manquant, jamais depuis zéro.
    expect(host.starts[0]).toBe(2 * CHUNK);
    expect([...t.store.bytes(id)]).toEqual([...host.file]);
    expect(manager.get(id)?.attempts).toBe(0);
  });

  it('un magasin muet (store_timeout) puis rétabli : Réessayer aboutit', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host);
    const open = t.store.store.open.bind(t.store.store);
    let calls = 0;
    t.store.store.open = async (fileId) => {
      calls += 1;
      if (calls === 1) throw new DownloadError('store_timeout', false, 'timeout');
      return open(fileId);
    };
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('error'));
    expect(t.manager.get(id)?.error?.code).toBe('store_timeout');

    t.manager.retry(id);
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));
  });

  it('DebridError transitoire : attente de 2 s (sleep injecté), puis succès', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { failures: [new DebridError('rate_limited', 'transient')] });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));

    expect(t.sleeps).toEqual([2000]);
    expect(t.resolver.calls).toBe(2);
  });
});

describe('DownloadManager : réseau, quota, concurrence, suppression', () => {
  it('coupure réseau : attentes de 2 s puis 4 s, puis error network après maxNetworkRetries', async () => {
    const host = fakeHost(SIZE);
    host.incident = () => new Error('connexion coupée');
    const t = setup(host, { maxNetworkRetries: 2 });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('error'));

    expect(t.manager.get(id)?.error?.code).toBe('network');
    expect(t.sleeps).toEqual([2000, 4000]);
    expect(host.urls).toHaveLength(3);
  });

  it('concurrence : jamais plus de 2 téléchargements en vol avec 4 éléments', async () => {
    const host = fakeHost(CHUNK);
    let active = 0;
    let max = 0;
    const slow: HttpFn = async (req) => {
      active += 1;
      max = Math.max(max, active);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await host.http(req);
      } finally {
        active -= 1;
      }
    };
    const t = setup(host, { http: slow, concurrency: 2 });
    await t.manager.init();
    const items = await Promise.all(
      [1, 2, 3, 4].map((n) => t.manager.enqueue({ metaId: `tt000${n}`, title: `F${n}`, source: SOURCE })),
    );
    await until(() => items.forEach((i) => expect(t.manager.get(i.id)?.state).toBe('done')));
    expect(max).toBe(2);
  });

  it('remove pendant un téléchargement en cours : fichier et index effacés, item retiré', async () => {
    const host = fakeHost(SIZE);
    const hang: HttpFn = (req) =>
      new Promise<Res>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('annulé')));
      });
    const t = setup(host, { http: hang });
    await t.manager.init();
    const item = await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.store.opened).toContain(item.id));
    await until(() => expect(t.manager.get(item.id)?.state).toBe('running'));

    await t.manager.remove(item.id);
    expect(t.manager.get(item.id)).toBeUndefined();
    expect(t.store.removed).toEqual([item.id]);
    expect(await t.index.all()).toEqual([]);
  });

  it('quota à l’ajout : refus si l’espace utilisé plus l’estimation dépasse la limite (un élément, puis un lot)', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { limitBytes: 1000 });
    await t.manager.init();
    await expect(t.manager.enqueue({ ...REQ, source: SOURCE, estimatedSize: 2000 })).rejects.toBeInstanceOf(DownloadError);
    await expect(t.manager.enqueue({ ...REQ, source: SOURCE, estimatedSize: 2000 })).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(
      t.manager.enqueueMany([
        { metaId: 'tt0001', title: 'A', source: SOURCE, estimatedSize: 600 },
        { metaId: 'tt0002', title: 'B', source: SOURCE, estimatedSize: 600 },
      ]),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(t.manager.list()).toEqual([]);
  });

  it('quota en cours : mis en pause avec quota_exceeded, repris après relèvement de la limite', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { limitBytes: 2500 });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('paused'));

    expect(t.manager.get(id)?.error?.code).toBe('quota_exceeded');
    expect(t.store.bytes(id)).toHaveLength(2000);
    expect(await t.manager.space()).toMatchObject({ used: 2000, limit: 2500, warn: false, full: false });

    t.manager.setLimit(null);
    t.manager.resume(id);
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));
    expect(t.store.bytes(id)).toEqual(host.file);
  });

  it('space() : alerte à 90 % et plein à 100 %, sans limite pas de ratio', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { limitBytes: 1000 });
    await t.manager.init();
    t.store.files.set('autre', new Array<number>(900).fill(0));
    expect(await t.manager.space()).toMatchObject({ used: 900, limit: 1000, ratio: 0.9, warn: true, full: false });
    t.store.files.set('autre', new Array<number>(1000).fill(0));
    expect(await t.manager.space()).toMatchObject({ used: 1000, ratio: 1, warn: true, full: true });
    t.manager.setLimit(null);
    expect(await t.manager.space()).toMatchObject({ limit: null, ratio: null, warn: false, full: false });
  });

  it('erreur d’écriture du stockage (disque plein) : error store_full', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { capacity: 1500 });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('error'));
    expect(t.manager.get(id)?.error?.code).toBe('store_full');
  });
});

describe('DownloadManager : validateurs, suppression, cache d’espace et fermeture', () => {
  it('re-résolution : l’ETag de l’ancien lien ne sert pas, l’offset est conservé', async () => {
    const host = fakeHost(SIZE);
    // Le premier lien annonce "v1" ; le lien délivré après l'expiration annonce "v2".
    const http: HttpFn = async (req) => {
      const res = await host.http(req);
      if (res.status === 206 && !req.url.endsWith('n=1')) return { ...res, headers: { ...res.headers, etag: '"v2"' } };
      return res;
    };
    host.incident = () => {
      // Le lien du deuxième morceau expire juste avant sa requête.
      if (host.urls.length === 2) host.expire();
      return undefined;
    };
    const t = setup(host, { http });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));

    expect(t.resolver.calls).toBe(2);
    // Pas de retour à zéro : le morceau à 1000 est repris au même offset, avec le nouveau lien.
    expect(host.starts).toEqual([0, CHUNK, CHUNK, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK]);
    expect(t.store.bytes(id)).toEqual(host.file);
    expect(t.manager.get(id)).toMatchObject({ state: 'done', etag: '"v2"' });
  });

  it('remove pendant running puis enqueue immédiat du même id : le nouvel item survit au nettoyage de l’ancien', async () => {
    const host = fakeHost(SIZE);
    const st = memoryStore();
    const index = new MemoryDownloadIndex();
    let hang = true;
    const http: HttpFn = (req) => {
      if (!hang) return host.http(req);
      return new Promise<Res>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('annulé')));
      });
    };
    // Nettoyage lent de l'ancien item : le nouvel enqueue arrive pendant qu'il tourne.
    const slowStore: DownloadStore = {
      ...st.store,
      async remove(id: string) {
        await new Promise((r) => setTimeout(r, 20));
        await st.store.remove(id);
      },
    };
    const m = new DownloadManager({
      resolver: fakeResolver(host),
      http,
      store: slowStore,
      index,
      chunkSize: CHUNK,
      sleep: async () => undefined,
    });
    const id = idOf(REQ.metaId);
    await m.init();
    await m.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(m.get(id)?.state).toBe('running'));

    const removal = m.remove(id);
    hang = false;
    const fresh = await m.enqueue({ ...REQ, source: SOURCE });
    await removal;
    await until(() => expect(m.get(id)?.state).toBe('done'));

    expect(fresh.id).toBe(id);
    expect(st.removed).toEqual([id]);
    expect(st.finalized).toEqual([id]);
    expect(st.bytes(id)).toEqual(host.file);
    expect((await index.all()).map((i) => [i.id, i.state])).toEqual([[id, 'done']]);
  });

  it('deux remove puis enqueue pendant un nettoyage lent : aucun nettoyage n’efface le nouvel item', async () => {
    const host = fakeHost(SIZE);
    const st = memoryStore();
    const index = new MemoryDownloadIndex();
    let hang = true;
    const http: HttpFn = (req) => {
      if (!hang) return host.http(req);
      return new Promise<Res>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('annulé')));
      });
    };
    const slowStore: DownloadStore = {
      ...st.store,
      async remove(id: string) {
        await new Promise((r) => setTimeout(r, 20));
        await st.store.remove(id);
      },
    };
    const m = new DownloadManager({
      resolver: fakeResolver(host),
      http,
      store: slowStore,
      index,
      chunkSize: CHUNK,
      sleep: async () => undefined,
    });
    const id = idOf(REQ.metaId);
    await m.init();
    await m.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(m.get(id)?.state).toBe('running'));

    // Le second remove arrive après l'enqueue, mais avant la fin du premier nettoyage.
    const first = m.remove(id);
    const fresh = m.enqueue({ ...REQ, source: SOURCE });
    const second = m.remove(id);
    hang = false;
    await Promise.all([first, second]);
    const item = await fresh;
    await until(() => expect(m.get(id)?.state).toBe('done'));

    expect(item.id).toBe(id);
    expect(st.bytes(id)).toEqual(host.file);
    expect((await index.all()).map((i) => [i.id, i.state])).toEqual([[id, 'done']]);
  });

  it('redémarrage après changement de fichier : les validateurs de l’ancien contenu ne reviennent pas', async () => {
    const host = fakeHost(SIZE);
    let n = 0;
    const http: HttpFn = async (req) => {
      n += 1;
      const res = await host.http(req);
      // 2e requête : le fichier a changé sous le même lien. Après le redémarrage, le serveur n'envoie plus d'ETag.
      if (n === 2 && res.status === 206) return { ...res, headers: { ...res.headers, etag: '"v2"' } };
      if (n > 2 && res.status === 206) {
        const headers = { ...res.headers };
        delete headers.etag;
        return { ...res, headers };
      }
      return res;
    };
    const t = setup(host, { http });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));

    expect(host.starts).toEqual([0, CHUNK, 0, CHUNK, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK]);
    expect(t.manager.get(id)?.etag).toBeUndefined();
    expect(t.store.bytes(id)).toEqual(host.file);
  });

  it('tout sink ouvert est fermé : fin, erreur de stockage, pause et suppression', async () => {
    {
      const host = fakeHost(SIZE);
      const t = setup(host);
      const id = idOf(REQ.metaId);
      await t.manager.init();
      await t.manager.enqueue({ ...REQ, source: SOURCE });
      await until(() => expect(t.manager.get(id)?.state).toBe('done'));
      await until(() => expect(t.store.openSinks()).toBe(0));
    }
    {
      const host = fakeHost(SIZE);
      const t = setup(host, { capacity: 1500 });
      const id = idOf(REQ.metaId);
      await t.manager.init();
      await t.manager.enqueue({ ...REQ, source: SOURCE });
      await until(() => expect(t.manager.get(id)?.state).toBe('error'));
      await until(() => expect(t.store.openSinks()).toBe(0));
    }
    {
      const host = fakeHost(SIZE);
      const t = setup(host);
      const id = idOf(REQ.metaId);
      let paused = false;
      host.incident = () => {
        if (host.urls.length === 2 && !paused) {
          paused = true;
          t.manager.pause(id);
        }
        return undefined;
      };
      await t.manager.init();
      await t.manager.enqueue({ ...REQ, source: SOURCE });
      await until(() => expect(t.manager.get(id)?.state).toBe('paused'));
      await until(() => expect(t.store.openSinks()).toBe(0));
      t.manager.resume(id);
      await until(() => expect(t.manager.get(id)?.state).toBe('done'));
      await until(() => expect(t.store.openSinks()).toBe(0));
    }
    {
      const host = fakeHost(SIZE);
      const hang: HttpFn = (req) =>
        new Promise<Res>((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('annulé')));
        });
      const t = setup(host, { http: hang });
      const id = idOf(REQ.metaId);
      await t.manager.init();
      await t.manager.enqueue({ ...REQ, source: SOURCE });
      await until(() => expect(t.store.opened).toContain(id));
      await t.manager.remove(id);
      expect(t.store.openSinks()).toBe(0);
    }
  });

  it('re-résolutions espacées par des morceaux réussis : le compteur repart de zéro, pas de link_expired', async () => {
    const host = fakeHost(SIZE);
    // Le lien expire juste avant les 2e, 4e et 6e requêtes : une seule re-résolution autorisée à la fois.
    host.incident = () => {
      if ([2, 4, 6].includes(host.urls.length)) host.expire();
      return undefined;
    };
    const t = setup(host, { maxResolves: 1 });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE });
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));

    expect(t.resolver.calls).toBe(4);
    expect(t.store.bytes(id)).toEqual(host.file);
  });

  it('quota : le magasin n’est pas relu à chaque morceau écrit', async () => {
    const host = fakeHost(SIZE);
    const t = setup(host, { limitBytes: 1_000_000 });
    const id = idOf(REQ.metaId);
    await t.manager.init();
    await t.manager.enqueue({ ...REQ, source: SOURCE, estimatedSize: 100 });
    await until(() => expect(t.manager.get(id)?.state).toBe('done'));

    // Cinq morceaux : un relevé à l'ajout et un au démarrage de la session, pas un par morceau.
    expect(t.store.usageCalls()).toBeLessThan(SIZE / CHUNK);
    expect(t.store.bytes(id)).toEqual(host.file);
  });

  it('attente réseau sans sleep injecté : l’écouteur abort est retiré à l’échéance', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost(SIZE);
      const signals: AbortSignal[] = [];
      const resolver: LinkResolver = {
        async resolve(_src, signal) {
          signals.push(signal);
          if (signals.length === 1) throw new DebridError('rate_limited', 'transient');
          return { url: host.issue(), size: SIZE, filename: 'film.mkv' };
        },
      };
      const m = new DownloadManager({
        resolver,
        http: host.http,
        store: memoryStore().store,
        index: new MemoryDownloadIndex(),
        chunkSize: CHUNK,
      });
      const id = idOf(REQ.metaId);
      await m.init();
      await m.enqueue({ ...REQ, source: SOURCE });
      await vi.advanceTimersByTimeAsync(2000);
      await until(() => expect(m.get(id)?.state).toBe('done'));

      expect(signals).toHaveLength(2);
      expect(getEventListeners(signals[0], 'abort')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
