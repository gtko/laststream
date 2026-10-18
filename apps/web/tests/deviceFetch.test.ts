import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { parseDeviceTargets } from '../src/data/sources';
import { clearCache } from '../src/data/transport';
import { DebridError } from '../src/sources/debrid/types';
import type { HttpFn, HttpRequest } from '../src/sources/debrid/http';
import { deviceHttp, fetchDeviceStreams, mergeDeviceStreams, normalizeDeviceResponse, normalizeDeviceStream } from '../src/sources/deviceFetch';
import { clearSourceCache, loadSources, watchSources, type SourceRequest } from '../src/sources/load';
import { toSourceViews } from '../src/sources/info';

const URL_A = 'https://torrentio.example.test/sort=seeders/stream/movie/tt0000001.json';
const URL_B = 'https://lumio.example.test/realdebrid=SECRET-KEY-1234/stream/movie/tt0000001.json';
const HASH = 'a'.repeat(40);

const reply = (body: unknown, status = 200) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
const cdn = (n: number, extra: Record<string, unknown> = {}) => ({ name: 'Lumio\n1080p', title: `Film.2024.MULTi.1080p.WEB-DL.x264-GRP ${n}`, url: `https://cdn.example.test/${n}.mkv`, ...extra });

describe('normalisation des flux de l’appareil', () => {
  it('lit qualité, langue, taille et seeders du nom', () => {
    const s = normalizeDeviceStream({ name: 'Torrentio\n1080p', title: 'Film.2024.VOSTFR.1080p.BluRay.x265.HDR\n👤 42 💾 4.5 GB ⚙️ YTS', infoHash: HASH.toUpperCase(), fileIdx: 2 }, 'Torrentio');
    expect(s?.infoHash).toBe(HASH);
    expect(s?.fileIdx).toBe(2);
    expect(s?.viaDevice).toBe(true);
    expect(s?.behaviorHints?.lastDebrid).toBe('client');
    expect(s?.laststream).toMatchObject({ resolution: '1080p', source: 'BluRay', codec: 'HEVC', seeders: 42, sizeBytes: 4_500_000_000, frVariant: 'VOSTFR', origins: [{ kind: 'addon', name: 'Torrentio' }] });
  });

  it('un lien HTTP est lisible tel quel ; ni lien ni hash valide : ignoré', () => {
    const [view] = toSourceViews(normalizeDeviceResponse({ streams: [cdn(1), { name: 'x' }, { infoHash: 'zz' }, 'bad'] }, 'Lumio'));
    expect(view.viaDevice).toBe(true);
    expect(view.playable).toBe(true);
    expect(view.origins.map((o) => o.name)).toEqual(['Lumio']);
    expect(view.hasFrench).toBe(true);
  });
});

describe('fusion et dédoublonnage', () => {
  it('garde l’existant, retire les doublons d’infoHash et de lien', () => {
    const base = [{ infoHash: HASH, name: 'serveur' }, { url: 'https://cdn.example.test/1.mkv', name: 'serveur' }];
    const extra = normalizeDeviceResponse({ streams: [{ infoHash: HASH.toUpperCase() }, cdn(1), cdn(2)] }, 'Lumio');
    const merged = mergeDeviceStreams(base, extra);
    expect(merged).toHaveLength(3);
    expect(merged.slice(0, 2)).toEqual(base);
    expect(merged[2].url).toBe('https://cdn.example.test/2.mkv');
  });
});

describe('transport de l’appareil', () => {
  const req = (url: string): HttpRequest => ({ url });

  it('refuse toute URL que le serveur n’a pas renvoyée, sans toucher fetch ni pont natif', async () => {
    const fetchHttp = vi.fn<HttpFn>(async () => reply({}));
    const nativeHttp = vi.fn<HttpFn>(async () => reply({}));
    const http = deviceHttp(new Set([URL_A]), { fetchHttp, nativeHttp });
    await expect(http(req('https://evil.example.test/steal'))).rejects.toThrow('url_not_allowed');
    await expect(http(req(URL_A + '?x=1'))).rejects.toThrow();
    expect(fetchHttp).not.toHaveBeenCalled();
    expect(nativeHttp).not.toHaveBeenCalled();
    await http(req(URL_A));
    expect(fetchHttp).toHaveBeenCalledTimes(1);
    expect(nativeHttp).not.toHaveBeenCalled();
  });

  it('bascule sur le pont natif quand le fetch échoue (CORS simulé)', async () => {
    const fetchHttp = vi.fn<HttpFn>(async () => { throw new DebridError('network', 'transient'); });
    const nativeHttp = vi.fn<HttpFn>(async () => reply({ streams: [cdn(7)] }));
    const out: string[] = [];
    await fetchDeviceStreams([{ addonId: 'Lumio', url: URL_B }], {
      http: deviceHttp(new Set([URL_B]), { fetchHttp, nativeHttp }),
      onAddon: (t, streams) => out.push(t.addonId + ':' + streams.length),
    });
    expect(fetchHttp).toHaveBeenCalledTimes(1);
    expect(nativeHttp).toHaveBeenCalledTimes(1);
    expect(nativeHttp.mock.calls[0][0].url).toBe(URL_B);
    expect(out).toEqual(['Lumio:1']);
  });

  it('sans pont natif (web), l’échec du fetch donne zéro flux sans lever', async () => {
    const fetchHttp = vi.fn<HttpFn>(async () => { throw new DebridError('network', 'transient'); });
    const out: number[] = [];
    await fetchDeviceStreams([{ addonId: 'A', url: URL_A }], { http: deviceHttp(new Set([URL_A]), { fetchHttp, nativeHttp: null }), onAddon: (_t, s) => out.push(s.length) });
    expect(out).toEqual([0]);
  });
});

describe('délai de 8 s par addon, en parallèle', () => {
  afterEach(() => vi.useRealTimers());

  it('un addon muet est abandonné à 8 s sans retarder les autres', async () => {
    vi.useFakeTimers();
    const http: HttpFn = (r) => (r.url === URL_A ? new Promise(() => undefined) : Promise.resolve(reply({ streams: [cdn(3)] })));
    const done: Array<[string, number]> = [];
    const all = fetchDeviceStreams([{ addonId: 'A', url: URL_A }, { addonId: 'B', url: URL_B }], { http, onAddon: (t, s) => done.push([t.addonId, s.length]) });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toEqual([['B', 1]]);
    await vi.advanceTimersByTimeAsync(8_000);
    await all;
    expect(done).toEqual([['B', 1], ['A', 0]]);
  });
});

describe('deviceFetch de lastAddon', () => {
  it('garde les entrées valides, sans doublon', () => {
    expect(parseDeviceTargets([{ addonId: 'A', url: URL_A }, { addonId: 'A', url: URL_A }, { addonId: '', url: URL_B }, { addonId: 'C', url: 'ftp://x' }, null, { addonId: 'D' }])).toEqual([{ addonId: 'A', url: URL_A }]);
    expect(parseDeviceTargets(undefined)).toEqual([]);
  });
});

describe('chargement des sources avec repli appareil', () => {
  const REQ: SourceRequest = { type: 'movie', id: '1', name: 'Film', key: 'movie:1', imdb: 'tt0000001' };
  const serverStream = { url: 'https://srv.example.test/1.mkv', name: 'Serveur', laststream: { resolution: '720p', height: 720, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 10, estBitrateKbps: null } };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
    reloadSettings();
    clearCache();
    clearSourceCache();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('ajoute en direct les flux des addons joints par l’appareil, sans doublon, marqués « via ton appareil »', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('http://localhost:7000')) {
        if (url.includes('/lt/streams/status/')) return new Response(JSON.stringify({ pending: [], count: 1 }));
        return new Response(JSON.stringify({ streams: [serverStream], deviceFetch: [{ addonId: 'Lumio', url: URL_B }] }));
      }
      if (url === URL_B) return new Response(JSON.stringify({ streams: [cdn(1), cdn(2), { ...serverStream }] }), { headers: { 'content-type': 'application/json' } });
      throw new Error('appel inattendu ' + url);
    }));

    const first = await loadSources(REQ);
    expect(first.pending).toEqual(['Lumio']);
    const updates: number[] = [];
    await new Promise<void>((resolve) => {
      const stop = watchSources(REQ, first, (next, added) => { updates.push(added); if (!next.pending.length) { stop(); resolve(); } }, { every: 10, maxMs: 2_000 });
    });
    const final = await loadSources(REQ);
    expect(final.views.map((v) => v.stream.url).sort()).toEqual(['https://cdn.example.test/1.mkv', 'https://cdn.example.test/2.mkv', 'https://srv.example.test/1.mkv']);
    expect(final.views.filter((v) => v.viaDevice)).toHaveLength(2);
    expect(updates.reduce((a, b) => a + b, 0)).toBe(2);
  });
});
