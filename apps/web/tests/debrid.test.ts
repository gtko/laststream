import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAllDebrid } from '../src/sources/debrid/alldebrid';
import { createTorbox } from '../src/sources/debrid/torbox';
import { createRealDebrid } from '../src/sources/debrid/realdebrid';
import { pickFile } from '../src/sources/debrid/files';
import { createHttp, createRangeFetch, debridHostAllowed, parseDebridUrl, type HttpFn, type HttpRequest, type HttpResponse } from '../src/sources/debrid/http';
import { DebridError, type DebridProvider, type ProviderId } from '../src/sources/debrid/types';
import { DebridManager, MemoryStatusStore, type KeyValueStore } from '../src/sources/debridClient';
import { applyVerdicts, clientCopiesOf, isClientStream, playableStreams, toSourceViews } from '../src/sources/info';
import type { Stream } from '../src/data/stream';

/* Débrideurs sur l'appareil : tous les appels réseau sont simulés (aucune clé réelle, aucun appel à un vrai service). */

const H1 = 'a1'.repeat(20);
const H2 = 'b2'.repeat(20);
const H3 = 'c3'.repeat(20);
const KEY = 'SECRET-KEY-DO-NOT-LEAK';

const enc = new TextEncoder();
const res = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: body === undefined ? new Uint8Array(0) : enc.encode(typeof body === 'string' ? body : JSON.stringify(body)),
});

interface Call { url: URL; method: string; headers: Record<string, string>; body: string }
function recorder(handler: (c: Call) => HttpResponse | Promise<HttpResponse>): { http: HttpFn; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpFn = async (req: HttpRequest) => {
    const call = { url: new URL(req.url), method: req.method ?? 'GET', headers: req.headers ?? {}, body: req.body ?? '' };
    calls.push(call);
    return handler(call);
  };
  return { http, calls };
}
const noSleep = (): Promise<void> => Promise.resolve();

describe('choix du fichier', () => {
  const files = [
    { key: 'a', name: 'Show/Show.S01E01.mkv', size: 100 },
    { key: 'b', name: 'Show/Show.S01E02.mkv', size: 200 },
    { key: 'c', name: 'Show/readme.txt', size: 1 },
  ];
  it('prend l épisode demandé dans un pack, et échoue s il est absent', () => {
    expect(pickFile(files, { season: 1, episode: 2 }).key).toBe('b');
    expect(() => pickFile(files, { season: 1, episode: 9 })).toThrow(DebridError);
  });
  it('préfère le nom attendu, puis la taille', () => {
    expect(pickFile(files, { filename: 'show.s01e01.mkv' }).key).toBe('a');
    expect(pickFile(files, { size: 200 }).key).toBe('b');
  });
});

describe('domaines autorisés', () => {
  it('limite aux API et fichiers des débrideurs, en https', () => {
    expect(debridHostAllowed('api.alldebrid.com')).toBe(true);
    expect(debridHostAllowed('e1.debrid.it')).toBe(true);
    expect(debridHostAllowed('api.torbox.app')).toBe(true);
    expect(debridHostAllowed('x.download.real-debrid.com')).toBe(true);
    expect(debridHostAllowed('debrid.it')).toBe(false);
    expect(debridHostAllowed('evil.com')).toBe(false);
    expect(parseDebridUrl('http://api.alldebrid.com/v4/user')).toBeNull();
    expect(parseDebridUrl('https://api.alldebrid.com.evil.com/')).toBeNull();
  });
});

describe('AllDebrid (réponses simulées)', () => {
  function server(opts: { ready: Set<string>; existing?: number[]; suspended?: boolean }) {
    return recorder((c) => {
      if (opts.suspended) return res(200, { status: 'error', error: { code: 'AUTH_BLOCKED', message: 'blocked' } });
      const form = new URLSearchParams(c.body);
      switch (c.url.pathname) {
        case '/v4.1/magnet/status':
          if (form.has('id')) return res(200, { status: 'success', data: { magnets: { id: 7, statusCode: 4 } } });
          return res(200, { status: 'success', data: { magnets: (opts.existing ?? []).map((id) => ({ id })) } });
        case '/v4/magnet/upload': {
          const hashes = form.getAll('magnets[]');
          return res(200, { status: 'success', data: { magnets: hashes.map((hash, i) => ({ hash, ready: opts.ready.has(hash), id: 100 + i })) } });
        }
        case '/v4/magnet/delete': return res(200, { status: 'success', data: {} });
        case '/v4/magnet/files':
          return res(200, { status: 'success', data: { magnets: [{ id: 7, files: [{ n: 'Film.2024.mkv', s: 4_000, l: 'https://alldebrid.com/f/abc' }, { n: 'sample.txt', s: 1, l: 'x' }] }] } });
        case '/v4/link/unlock': return res(200, { status: 'success', data: { link: 'https://x1.debrid.it/dl/film.mkv', filename: 'Film.2024.mkv', filesize: 4_000 } });
        default: return res(404, { status: 'error', error: { code: 'NOT_FOUND' } });
      }
    });
  }

  it('contrôle le cache par lot, supprime seulement les magnets créés non prêts, clé uniquement dans Authorization', async () => {
    const s = server({ ready: new Set([H1]), existing: [101] });
    const ad = createAllDebrid({ apiKey: KEY, http: s.http, sleep: noSleep });
    const found = await ad.checkCache([H1, H2, H3]);
    expect(found.get(H1)).toBe(true);
    expect(found.get(H2)).toBe(false);
    // Ids renvoyés : H1=100, H2=101 (déjà au compte : jamais supprimé), H3=102 (créé par nous, non prêt : supprimé).
    const deleted = s.calls.filter((c) => c.url.pathname === '/v4/magnet/delete').map((c) => new URLSearchParams(c.body).get('id'));
    expect(deleted).toEqual(['102']);
    expect(s.calls.every((c) => c.headers.Authorization === `Bearer ${KEY}` && c.url.hostname === 'api.alldebrid.com')).toBe(true);
    expect(s.calls.some((c) => c.url.href.includes(KEY) || c.body.includes(KEY))).toBe(false);
    expect(s.calls.every((c) => c.url.searchParams.get('agent') === 'laststream')).toBe(true);
  });

  it('résout le lien du bon fichier (upload, statut, fichiers, unlock)', async () => {
    const s = server({ ready: new Set([H1]) });
    const link = await createAllDebrid({ apiKey: KEY, http: s.http, sleep: noSleep }).resolve(H1, { filename: 'Film.2024.mkv' });
    expect(link).toEqual({ url: 'https://x1.debrid.it/dl/film.mkv', filename: 'Film.2024.mkv', size: 4_000 });
    expect(new URLSearchParams(s.calls.find((c) => c.url.pathname === '/v4/link/unlock')?.body).get('link')).toBe('https://alldebrid.com/f/abc');
  });

  it('compte suspendu : erreur de compte avec état « suspended » et heure de fin', async () => {
    const now = Date.parse('2026-10-18T20:00:00Z');
    const ad = createAllDebrid({ apiKey: KEY, http: server({ ready: new Set(), suspended: true }).http, sleep: noSleep, now: () => now });
    const err = await ad.resolve(H1, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DebridError);
    expect((err as DebridError).kind).toBe('account');
    expect((err as DebridError).state).toBe('suspended');
    expect((err as DebridError).until).toBeGreaterThan(now);
    expect((await ad.status()).state).toBe('suspended');
  });
});

describe('TorBox (réponses simulées)', () => {
  function server(opts: { cached: string[]; denied?: boolean }) {
    return recorder((c) => {
      if (opts.denied) return res(403, { success: false, error: 'BAD_TOKEN', detail: 'bad' });
      switch (c.url.pathname) {
        case '/v1/api/torrents/checkcached':
          return res(200, { success: true, data: Object.fromEntries(opts.cached.map((h) => [h, { name: 'x', size: 1 }])) });
        case '/v1/api/torrents/createtorrent': return res(200, { success: true, data: { torrent_id: 55, hash: H1 } });
        case '/v1/api/torrents/mylist':
          return res(200, { success: true, data: { id: 55, download_finished: true, files: [{ id: 3, name: 'Pack/Show.S02E05.mkv', size: 9 }, { id: 4, name: 'Pack/Show.S02E06.mkv', size: 8 }] } });
        case '/v1/api/torrents/requestdl': return res(200, { success: true, data: `https://store-1.torbox.app/dl/${c.url.searchParams.get('file_id')}` });
        case '/v1/api/user/me': return res(200, { success: true, data: { plan: 1 } });
        default: return res(404, { success: false });
      }
    });
  }

  it('cache en lecture seule (checkcached), épisode d un pack, lien requestdl', async () => {
    const s = server({ cached: [H1] });
    const tb = createTorbox({ apiKey: KEY, http: s.http, sleep: noSleep });
    const found = await tb.checkCache([H1, H2]);
    expect([found.get(H1), found.get(H2)]).toEqual([true, false]);
    expect(s.calls.filter((c) => c.url.pathname.includes('createtorrent'))).toHaveLength(0);
    const link = await tb.resolve(H1, { season: 2, episode: 6 });
    expect(link.url).toBe('https://store-1.torbox.app/dl/4');
    expect(s.calls.every((c) => c.url.hostname === 'api.torbox.app')).toBe(true);
    expect((await tb.status()).state).toBe('ok');
  });

  it('jeton refusé : clé invalide', async () => {
    const tb = createTorbox({ apiKey: KEY, http: server({ cached: [], denied: true }).http, sleep: noSleep });
    expect((await tb.status()).state).toBe('invalid_key');
    await expect(tb.resolve(H1, {})).rejects.toMatchObject({ kind: 'account', state: 'invalid_key' });
  });
});

describe('Real-Debrid (réponses simulées)', () => {
  function server(opts: { downloaded: boolean }) {
    let selected = false;
    return recorder((c) => {
      const p = c.url.pathname;
      if (p === '/rest/1.0/torrents/addMagnet') return res(201, { id: 'RDID', uri: 'x' });
      if (p === '/rest/1.0/torrents/info/RDID') {
        const files = [{ id: 1, path: '/Film.2024.mkv', bytes: 5000, selected: 0 }, { id: 2, path: '/info.nfo', bytes: 10, selected: 0 }];
        if (!selected) return res(200, { status: 'waiting_files_selection', files });
        return res(200, opts.downloaded
          ? { status: 'downloaded', files: files.map((f) => ({ ...f, selected: f.id === 1 ? 1 : 0 })), links: ['https://real-debrid.com/d/XYZ'] }
          : { status: 'downloading', files, links: [] });
      }
      if (p === '/rest/1.0/torrents/selectFiles/RDID') { selected = true; return res(204, undefined); }
      if (p === '/rest/1.0/unrestrict/link') return res(200, { download: 'https://20-4.download.real-debrid.com/d/XYZ/Film.2024.mkv', filename: 'Film.2024.mkv', filesize: 5000 });
      if (p === '/rest/1.0/torrents/delete/RDID') return res(204, undefined);
      if (p === '/rest/1.0/user') return res(200, { type: 'premium' });
      return res(404, { error: 'unknown_resource' });
    });
  }

  it('statut de cache inconnu (aucun appel), résolution addMagnet → selectFiles → unrestrict, torrent nettoyé', async () => {
    const s = server({ downloaded: true });
    const rd = createRealDebrid({ apiKey: KEY, http: s.http, sleep: noSleep });
    expect((await rd.checkCache([H1])).size).toBe(0);
    expect(s.calls).toHaveLength(0);
    const link = await rd.resolve(H1, { filename: 'Film.2024.mkv' });
    expect(link.url).toContain('download.real-debrid.com');
    const select = s.calls.find((c) => c.url.pathname.includes('selectFiles'));
    expect(new URLSearchParams(select?.body).get('files')).toBe('1');
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect((await rd.status()).state).toBe('ok');
  });

  it('source non prête (pas en cache) : not_ready et torrent supprimé du compte', async () => {
    const s = server({ downloaded: false });
    const rd = createRealDebrid({ apiKey: KEY, http: s.http, sleep: noSleep });
    await expect(rd.resolve(H1, {})).rejects.toMatchObject({ code: 'not_ready', kind: 'content' });
    expect(s.calls.some((c) => c.method === 'DELETE' && c.url.pathname.endsWith('/RDID'))).toBe(true);
  });
});

describe('transport : navigateur puis pont natif', () => {
  const ok: HttpFn = () => Promise.resolve(res(200, {}));
  const netFail: HttpFn = () => Promise.reject(new DebridError('network', 'transient'));

  it('AllDebrid : navigateur d abord, pont natif si le navigateur échoue (réseau/CORS)', async () => {
    const nativeSpy = vi.fn(ok);
    const http = createHttp('fetch-first', { fetchHttp: netFail, nativeHttp: nativeSpy });
    expect((await http({ url: 'https://api.alldebrid.com/v4/user' })).status).toBe(200);
    expect(nativeSpy).toHaveBeenCalledOnce();
  });
  it('TorBox : pont natif d abord ; un statut HTTP ne déclenche pas de repli', async () => {
    const fetchSpy = vi.fn(ok);
    const http = createHttp('native-first', { fetchHttp: fetchSpy, nativeHttp: () => Promise.resolve(res(401, {})) });
    expect((await http({ url: 'https://api.torbox.app/v1/api/user/me' })).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('refuse tout domaine hors débrideurs, sans appel', async () => {
    const spy = vi.fn(ok);
    const http = createHttp('native-first', { fetchHttp: spy, nativeHttp: spy });
    await expect(http({ url: 'https://evil.example/steal' })).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('plages de miniatures : direct chez l hébergeur ; repli natif mémorisé par hôte, jamais de relais', async () => {
    const urls: string[] = [];
    const native: HttpFn = (r) => { urls.push('native ' + r.url); return Promise.resolve(res(206, 'abc', { 'content-range': 'bytes 0-2/10' })); };
    const range = createRangeFetch({ fetchHttp: netFail, nativeHttp: native });
    const r = await range('https://e1.debrid.it/dl/f.mkv', { headers: { Range: 'bytes=0-2' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 0-2/10');
    await range('https://e1.debrid.it/dl/f.mkv', { headers: { Range: 'bytes=3-5' } });
    expect(urls).toHaveLength(2);
    await expect(range('https://app.laststream.app/__laststream/range?u=x')).rejects.toMatchObject({ code: 'host_not_allowed' });
  });
  it('sans pont natif ni CORS : le fetch échoue proprement (pas de miniatures)', async () => {
    const range = createRangeFetch({ fetchHttp: netFail, nativeHttp: null });
    await expect(range('https://e1.debrid.it/dl/f.mkv')).rejects.toBeInstanceOf(DebridError);
  });
});

describe('gestionnaire multi-fournisseurs', () => {
  const memStore = (): KeyValueStore => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
  };
  interface Fake extends DebridProvider { resolveCalls: number }
  function fake(id: ProviderId, o: { cached?: string[]; unknown?: boolean; resolve?: () => Promise<{ url: string; filename: string; size: number }> }): Fake {
    const f: Fake = {
      id, label: id, resolveCalls: 0,
      checkCache: (hashes) => Promise.resolve(o.unknown ? new Map() : new Map(hashes.map((h) => [h, (o.cached ?? []).includes(h)]))),
      resolve: () => { f.resolveCalls += 1; return o.resolve ? o.resolve() : Promise.resolve({ url: `https://x.${id}.test/f.mkv`, filename: 'f.mkv', size: 1 }); },
      status: () => Promise.resolve({ state: 'ok' }),
    };
    return f;
  }
  let t = Date.parse('2026-10-18T20:00:00Z');
  const now = (): number => t;
  function manager(providers: Partial<Record<ProviderId, Fake>>, keys: ProviderId[], extra: { onSwitch?: (a: ProviderId, b: ProviderId) => void } = {}): DebridManager {
    const store = memStore();
    const m = new DebridManager({ store, statuses: new MemoryStatusStore(), now, native: () => 'shell', makeProvider: (id) => providers[id] as DebridProvider, ...extra });
    for (const id of keys) m.setKey(id, 'k-' + id);
    return m;
  }
  beforeEach(() => { t = Date.parse('2026-10-18T20:00:00Z'); });

  it('cache combiné : en cache si au moins un fournisseur l a, avec la liste des fournisseurs', async () => {
    const m = manager({ alldebrid: fake('alldebrid', { cached: [H1] }), torbox: fake('torbox', { cached: [H1, H2] }), realdebrid: fake('realdebrid', { unknown: true }) }, ['alldebrid', 'torbox', 'realdebrid']);
    const v = await m.checkCache([H1, H2, H3]);
    expect(v.get(H1)).toEqual({ cached: true, by: ['alldebrid', 'torbox'] });
    expect(v.get(H2)).toEqual({ cached: true, by: ['torbox'] });
    expect(v.get(H3)).toEqual({ cached: false, by: [] });
  });

  it('résout par le premier fournisseur qui l a en cache, sinon le premier disponible (priorité réordonnable)', async () => {
    const ad = fake('alldebrid', { cached: [] });
    const tb = fake('torbox', { cached: [H1] });
    const m = manager({ alldebrid: ad, torbox: tb }, ['alldebrid', 'torbox']);
    await m.checkCache([H1, H2]);
    expect((await m.resolve([{ infoHash: H1 }])).provider).toBe('torbox');
    expect((await m.resolve([{ infoHash: H2 }])).provider).toBe('alldebrid');
    m.setOrder(['torbox', 'alldebrid', 'realdebrid']);
    expect((await m.resolve([{ infoHash: H3 }])).provider).toBe('torbox');
  });

  it('compte suspendu : fournisseur indisponible jusqu à l heure indiquée, bascule automatique et notification', async () => {
    const until = t + 3 * 3600_000;
    const ad = fake('alldebrid', { resolve: () => Promise.reject(new DebridError('AUTH_BLOCKED', 'account', { state: 'suspended', until })) });
    const tb = fake('torbox', {});
    const onSwitch = vi.fn();
    const m = manager({ alldebrid: ad, torbox: tb }, ['alldebrid', 'torbox'], { onSwitch });
    const r = await m.resolve([{ infoHash: H1 }]);
    expect(r.provider).toBe('torbox');
    expect(r.switchedFrom).toBe('alldebrid');
    expect(onSwitch).toHaveBeenCalledWith('alldebrid', 'torbox');
    expect(m.healthOf('alldebrid')).toMatchObject({ state: 'suspended', until });
    expect(m.available()).toEqual(['torbox']);
    // Tant que l heure n est pas passée, AllDebrid n est plus appelé.
    await m.resolve([{ infoHash: H2 }]);
    expect(ad.resolveCalls).toBe(1);
    // Après l heure indiquée, il redevient disponible.
    t = until + 1;
    expect(m.available()).toEqual(['alldebrid', 'torbox']);
  });

  it('erreur de contenu : essaie la copie suivante puis le fournisseur suivant sans marquer le compte', async () => {
    const ad = fake('alldebrid', { resolve: () => Promise.reject(new DebridError('no_file', 'content')) });
    const tb = fake('torbox', {});
    const m = manager({ alldebrid: ad, torbox: tb }, ['alldebrid', 'torbox']);
    const r = await m.resolve([{ infoHash: H1 }, { infoHash: H2 }]);
    expect(r.provider).toBe('torbox');
    expect(ad.resolveCalls).toBe(2);
    expect(m.healthOf('alldebrid')).toBeUndefined();
  });

  it('tous indisponibles : erreur explicite ; sans pont natif (web), TorBox et Real-Debrid sont ignorés', async () => {
    const ad = fake('alldebrid', { resolve: () => Promise.reject(new DebridError('AUTH_BLOCKED', 'account', { state: 'suspended', until: t + 1000 })) });
    const m = manager({ alldebrid: ad }, ['alldebrid']);
    await expect(m.resolve([{ infoHash: H1 }])).rejects.toMatchObject({ kind: 'account' });
    await expect(m.resolve([{ infoHash: H1 }])).rejects.toMatchObject({ code: 'all_unavailable' });

    const web = new DebridManager({ store: memStore(), statuses: new MemoryStatusStore(), native: () => null, makeProvider: () => fake('torbox', {}) });
    web.setKey('torbox', 'k');
    expect(web.hasAny()).toBe(false);
    expect(web.blockedReason('torbox')).toBe('web_unsupported');
    web.setKey('alldebrid', 'k');
    expect(web.configured()).toEqual(['alldebrid']);
  });

  it('les clés restent dans le stockage local de l appareil (aucun appel réseau pour les enregistrer)', () => {
    const store = memStore();
    const m = new DebridManager({ store, statuses: new MemoryStatusStore() });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    m.setKey('torbox', ' abc ');
    expect(m.settings().keys.torbox).toBe('abc');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('sources « client » dans le sélecteur', () => {
  const info = { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: false, score: 50, estBitrateKbps: 5000 };
  const client: Stream = {
    infoHash: H1, fileIdx: 2, behaviorHints: { lastDebrid: 'client', filename: 'Show.S01E02.mkv', videoSize: 123 },
    laststream: { ...info, client: { copies: [{ infoHash: H1, fileIdx: 2, filename: 'Show.S01E02.mkv', size: 123 }], season: 1, episode: 2 } },
  };
  const direct: Stream = { url: 'https://cdn.test/a.mp4', laststream: info };

  it('masque les torrents sans débrideur configuré, les garde sinon', () => {
    expect(isClientStream(client)).toBe(true);
    expect(playableStreams([client, direct])).toEqual([direct]);
    expect(playableStreams([client, direct], true)).toHaveLength(2);
  });
  it('lit les copies et l épisode visé', () => {
    expect(clientCopiesOf(client)).toEqual({ copies: [{ infoHash: H1, fileIdx: 2, filename: 'Show.S01E02.mkv', size: 123 }], season: 1, episode: 2 });
  });
  it('libellés selon le statut obtenu sur l appareil : « En cache ⚡ » avec le service, ou « À la demande »', () => {
    const views = toSourceViews([client, direct]);
    expect(views[0].client).toBe(true);
    const out = applyVerdicts(views, new Map([[H1, { cached: true, by: ['torbox'] }]]));
    expect(out[0].statusLabel).toBe('Débridé · En cache ⚡ · TorBox');
    expect(out[0].status).toBe('cached');
    expect(out[1].statusLabel).toBe('Lien direct');
    const none = applyVerdicts(views, new Map([[H1, { cached: false, by: [] }]]));
    expect(none[0].statusLabel).toBe('Débridé · À la demande');
    expect(applyVerdicts(views, new Map())[0].status).toBe('uncached');
  });
});
