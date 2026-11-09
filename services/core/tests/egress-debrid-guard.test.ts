import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNotDebrid,
  DebridEgressBlockedError,
  guardedFetch,
  isDebridHost,
  isDebridResolverUrl,
  resetDebridReportThrottle,
  runWithEgressContext,
  SERVER_SIDE_DISABLED,
  setDebridBlockReporter,
} from '../src/egress/debrid-guard.js';
import { enrichWithProbe } from '../src/engine/probe-step.js';
import type { MediaProbe } from '../src/media/probe.js';
import { ProbeCache } from '../src/media/probe-cache.js';
import { applyDirect } from '../src/lt/tv-build.js';
import type { TvCatalog } from '../src/lt/tv-catalog.js';
import { checkStream } from '../src/lt/tv-health.js';
import { beforeSendFilter } from '../src/observability/scrub.js';
import { fetchBytes } from '../src/sources/http.js';
import { cand, ranked as asRanked } from './engine-fixtures.js';

const BLOCKED = [
  'https://api.alldebrid.com/v4/link/unlock?apikey=SECRET',
  'https://foo.alldebrid.com/dl/x',
  'https://alldebrid.fr/',
  'https://ALLDEBRID.com./x',
  'https://x.debrid.it/y',
  'https://debrid.it/y',
  'https://alldebrid.co.uk/z',
  'https://API.AllDebrid.COM./z',
  'https://alldebrid.xn--p1ai/z',
];
const ALLOWED = ['https://example.com/a', 'https://cdn.example.org/b.mkv', 'https://notalldebrid.com/', 'https://debrid.item.example/', 'https://my-alldebrid.example.com/'];

/** Récepteur d'événements : une entrée par appel bloqué. */
function captureReports(): DebridEgressBlockedError[] {
  const reports: DebridEgressBlockedError[] = [];
  setDebridBlockReporter((error) => reports.push(error));
  return reports;
}

afterEach(() => {
  resetDebridReportThrottle();
  setDebridBlockReporter(undefined);
  vi.restoreAllMocks();
});

describe('isDebridHost', () => {
  it('reconnaît alldebrid.<tld>, debrid.it et leurs sous-domaines, à la casse et au point final près', () => {
    for (const url of BLOCKED) expect(isDebridHost(new URL(url).hostname)).toBe(true);
  });

  it('laisse passer les autres hôtes, dont les noms qui ne font que contenir « alldebrid »', () => {
    for (const url of ALLOWED) expect(isDebridHost(new URL(url).hostname)).toBe(false);
  });
});

describe('isDebridResolverUrl', () => {
  it('reconnaît les liens de résolution de débrideur (hôte ou chemin)', () => {
    for (const url of [
      'https://torrentio.strem.fun/resolve/alldebrid/KEY/hash/null/0/f.mkv',
      'https://stremthru.example.com/v0/store/x',
      'https://addon.elfhosted.com/abc/film.mkv',
      'https://streamfusion.example/playback/CONFIG/abc',
      'https://x.example/streaming_provider/abc',
      'https://real-debrid.example/f',
      // Lumio : lien débridé à l'ouverture (`/play/<jeton>`), sondé depuis le serveur il se bloquait sur l'appareil.
      'https://mylumio.tv/play/74VfC3vsyYDRAaJp7XnWxr3RPzAK2ydtahnzMAY95v5PMvcvnvcE8rqNuQUKnuZ7ejdlZ',
      'https://addon.example/abc/play/token',
    ]) expect(isDebridResolverUrl(url)).toBe(true);
  });

  it('laisse passer un lien direct ordinaire', () => {
    for (const url of ['https://cdn.example.com/media/film.mkv', 'https://example.org/a/b/c.mp4', 'https://cdn.example.com/player/film.mp4', 'pas une url']) expect(isDebridResolverUrl(url)).toBe(false);
  });
});

describe('assertNotDebrid', () => {
  it('lève server_side_disabled, signale l\'hôte seul (jamais l\'URL ni la clé) et journalise', () => {
    const reports = captureReports();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => assertNotDebrid('https://api.alldebrid.com/v4/link/unlock?apikey=SECRET', 'test')).toThrow(DebridEgressBlockedError);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.code).toBe(SERVER_SIDE_DISABLED);
    expect(reports[0]?.host).toBe('api.alldebrid.com');
    const written = JSON.stringify([reports[0]?.message, reports[0]?.host, reports[0]?.trigger, log.mock.calls]);
    expect(written).not.toContain('SECRET');
    expect(written).not.toContain('/v4/link');
  });

  it('rattache le déclencheur et l\'identifiant de requête du contexte', () => {
    const reports = captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runWithEgressContext({ trigger: 'cron', requestId: 'cron-1' }, () => {
      expect(() => assertNotDebrid('https://x.debrid.it/a', 'tv-health')).toThrow(DebridEgressBlockedError);
    });
    expect(reports[0]?.trigger).toBe('cron/tv-health');
    expect(reports[0]?.requestId).toBe('cron-1');
  });

  it('ne fait rien pour un hôte légitime ou une valeur non analysable', () => {
    const reports = captureReports();
    for (const url of [...ALLOWED, 'pas une url']) expect(() => assertNotDebrid(url, 'test')).not.toThrow();
    expect(reports).toEqual([]);
  });

  it('étouffe la remontée Sentry (un événement par hôte et déclencheur) mais refuse et journalise à chaque fois', () => {
    const reports = captureReports();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < 5; i += 1) expect(() => assertNotDebrid('https://spam-throttle.debrid.it/a', 'throttle')).toThrow(DebridEgressBlockedError);
    expect(reports).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(5);
  });

  it('une remontée qui échoue ne change pas le refus', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setDebridBlockReporter(() => {
      throw new Error('sentry indisponible');
    });
    expect(() => assertNotDebrid('https://api.alldebrid.com/', 'test')).toThrow(DebridEgressBlockedError);
  });
});

describe('guardedFetch', () => {
  it('refuse api.alldebrid.com et les sous-domaines sans rien envoyer', async () => {
    const reports = captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const inner = vi.fn(async () => new Response('ok'));
    const guarded = guardedFetch(inner as unknown as typeof fetch, 'test');

    for (const url of BLOCKED) await expect(guarded(url)).rejects.toBeInstanceOf(DebridEgressBlockedError);
    await expect(guarded(new Request('https://api.alldebrid.com/x'))).rejects.toBeInstanceOf(DebridEgressBlockedError);
    await expect(guarded(new URL('https://api.alldebrid.com/x'), { redirect: 'manual' })).rejects.toBeInstanceOf(DebridEgressBlockedError);

    expect(inner).not.toHaveBeenCalled();
    // Remontée étouffée : un événement par hôte (et déclencheur), même si chaque appel est refusé.
    const hosts = new Set([...BLOCKED, 'https://api.alldebrid.com/x'].map((url) => new URL(url).hostname.toLowerCase().replace(/\.$/, '')));
    expect(reports).toHaveLength(hosts.size);
  });

  it('refuse une redirection vers un hôte de débridage AVANT de l\'envoyer', async () => {
    const reports = captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url === 'https://example.com/start') return new Response(null, { status: 302, headers: { location: 'https://api.alldebrid.com/v4/link?apikey=SECRET' } });
      return new Response('atteint', { status: 200 });
    });
    const guarded = guardedFetch(inner as unknown as typeof fetch, 'test');

    await expect(guarded('https://example.com/start')).rejects.toBeInstanceOf(DebridEgressBlockedError);

    expect(seen).toEqual(['https://example.com/start']);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.host).toBe('api.alldebrid.com');
  });

  it('refuse aussi une redirection relative en chaîne qui finit sur un hôte de débridage', async () => {
    captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url === 'https://a.example/1') return new Response(null, { status: 301, headers: { location: '/2' } });
      if (url === 'https://a.example/2') return new Response(null, { status: 307, headers: { location: '//dl.alldebrid.com/f' } });
      return new Response('x');
    });
    await expect(guardedFetch(inner as unknown as typeof fetch, 'test')('https://a.example/1')).rejects.toBeInstanceOf(DebridEgressBlockedError);
    expect(seen).toEqual(['https://a.example/1', 'https://a.example/2']);
  });

  it('laisse passer les hôtes légitimes, suit leurs redirections et expose l\'URL finale', async () => {
    const reports = captureReports();
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(init?.redirect).toBe('manual');
      if (url === 'https://example.com/start') return new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/final' } });
      return new Response('contenu', { status: 200 });
    });
    const res = await guardedFetch(inner as unknown as typeof fetch, 'test')('https://example.com/start');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('contenu');
    expect(res.url).toBe('https://cdn.example.org/final');
    expect(res.redirected).toBe(true);
    expect(reports).toEqual([]);
  });

  it('retire les identifiants au passage d\'une origine à l\'autre', async () => {
    const received: Headers[] = [];
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      received.push(new Headers(init?.headers));
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://a.example/x') return new Response(null, { status: 302, headers: { location: 'https://b.example/y' } });
      return new Response('ok');
    });
    await guardedFetch(inner as unknown as typeof fetch, 'test')('https://a.example/x', { headers: { authorization: 'Bearer t', accept: '*/*' } });
    expect(received[0]?.get('authorization')).toBe('Bearer t');
    expect(received[1]?.get('authorization')).toBeNull();
    expect(received[1]?.get('accept')).toBe('*/*');
  });

  it('en mode manual, ne suit rien mais refuse l\'hôte demandé', async () => {
    const inner = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://api.alldebrid.com/' } }));
    const res = await guardedFetch(inner as unknown as typeof fetch, 'test')('https://example.com/a', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('une requête passée en objet garde méthode et signal sur tous les sauts', async () => {
    const controller = new AbortController();
    const calls: { url: string; method: string; signal: boolean }[] = [];
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), signal: init?.signal instanceof AbortSignal && !init.signal.aborted });
      if (url === 'https://a.example/1') return new Response(null, { status: 301, headers: { location: 'https://a.example/2' } });
      return new Response('ok');
    });
    await guardedFetch(inner as unknown as typeof fetch, 'test')(new Request('https://a.example/1', { method: 'HEAD', signal: controller.signal }));
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'HEAD']);
    expect(calls.every((c) => c.signal)).toBe(true);
    controller.abort();
  });

  it('un DELETE suivi d\'un 307 reste un DELETE', async () => {
    const methods: string[] = [];
    const inner = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      methods.push((init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase());
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/1') ? new Response(null, { status: 307, headers: { location: '/2' } }) : new Response('ok');
    });
    await guardedFetch(inner as unknown as typeof fetch, 'test')(new Request('https://a.example/1', { method: 'DELETE' }));
    expect(methods).toEqual(['DELETE', 'DELETE']);
  });

  it('n\'enrobe pas deux fois le même fetch', () => {
    const once = guardedFetch(vi.fn() as unknown as typeof fetch, 'a');
    expect(guardedFetch(once, 'b')).toBe(once);
  });
});

describe('fetchBytes (client HTTP commun des sources et de la sonde)', () => {
  it('refuse un hôte de débridage et une redirection vers un tel hôte, sans envoi', async () => {
    const reports = captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: 'https://dl.alldebrid.com/f' } });
    }) as typeof fetch;

    await expect(fetchBytes(fake, 'https://api.alldebrid.com/v4/user')).rejects.toBeInstanceOf(DebridEgressBlockedError);
    expect(seen).toEqual([]);

    await expect(fetchBytes(fake, 'https://example.com/redirige')).rejects.toBeInstanceOf(DebridEgressBlockedError);
    expect(seen).toEqual(['https://example.com/redirige']);
    expect(reports.map((r) => r.host)).toEqual(['api.alldebrid.com', 'dl.alldebrid.com']);
    expect(reports.every((r) => r.trigger === 'fetch-bytes')).toBe(true);
  });
});

describe('sonde de sources (probe-step)', () => {
  it('n\'envoie aucune sonde vers un lien direct *.alldebrid.com, sonde les liens légitimes', async () => {
    const reports = captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const probe = vi.fn(async (): Promise<MediaProbe | null> => ({ container: 'mkv', audio: [], subtitles: [] }));
    const direct = (url: string) => asRanked(cand({ raw: { url, title: 'Film.2024.1080p.WEB-DL' } }));

    await enrichWithProbe([direct('https://dl.alldebrid.com/dl/abc/film.mkv'), direct('https://cdn.example.com/film.mkv')], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      probeHosts: new Set(['cdn.example.com', 'dl.alldebrid.com']),
      topN: 5,
    });

    expect(probe.mock.calls.map((call) => (call as unknown as string[])[0])).toEqual(['https://cdn.example.com/film.mkv']);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.trigger).toBe('probe');
  });
});

describe('sonde de sources : liens de résolution', () => {
  it('ne sonde pas un lien de résolution de débrideur (pas de débridage chez le tiers avec l\'IP du serveur)', async () => {
    const probe = vi.fn(async (): Promise<MediaProbe | null> => ({ container: 'mkv', audio: [], subtitles: [] }));
    const direct = (url: string) => asRanked(cand({ raw: { url, title: 'Film.2024.1080p.WEB-DL' } }));
    await enrichWithProbe([direct('https://torrentio.strem.fun/resolve/alldebrid/KEY/h/null/0/f.mkv'), direct('https://cdn.example.com/f.mkv')], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      probeHosts: new Set(['torrentio.strem.fun', 'cdn.example.com']),
      topN: 5,
    });
    expect(probe.mock.calls.map((call) => (call as unknown as string[])[0])).toEqual(['https://cdn.example.com/f.mkv']);
  });
});

describe('cron des chaînes TV', () => {
  const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n';

  it('tv-health : ni le flux, ni un saut de redirection, ni un segment ne vont vers un hôte de débridage', async () => {
    const reports = captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      seen.push(url);
      if (url === 'https://tv.example/redirige.m3u8') return new Response(null, { status: 302, headers: { location: 'https://x.debrid.it/live.m3u8' } });
      if (url === 'https://tv.example/manifeste.m3u8') return new Response(hls.replace('seg1.ts', 'https://dl.alldebrid.com/seg1.ts'), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      return new Response('absent', { status: 404 });
    }) as typeof fetch;

    expect(await checkStream(fake, 'https://api.alldebrid.com/live.m3u8')).toBe('unknown');
    expect(await checkStream(fake, 'https://tv.example/redirige.m3u8')).toBe('unknown');
    expect(await checkStream(fake, 'https://tv.example/manifeste.m3u8')).toBe('unknown');

    expect(seen.filter((url) => /debrid/i.test(url))).toEqual([]);
    expect(reports.length).toBeGreaterThanOrEqual(3);
    expect(reports.every((r) => r.trigger.startsWith('tv-health'))).toBe(true);
  });

  it('tv-build : le sondage des flux n\'atteint jamais un hôte de débridage', async () => {
    const reports = captureReports();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      seen.push(url);
      if (url === 'https://tv.example/redirige.m3u8') return new Response(null, { status: 302, headers: { location: 'https://api.alldebrid.com/live' } });
      return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
    }) as typeof fetch;
    const channel = (id: string, url: string) => ({ id, name: id, url, country: 'FR', alternatives: [] });
    const catalog = {
      v: 1,
      channels: [channel('a', 'https://api.alldebrid.com/live.m3u8'), channel('b', 'https://tv.example/redirige.m3u8'), channel('c', 'https://tv.example/ok.m3u8')],
    } as unknown as TvCatalog;

    await applyDirect(catalog, undefined, { fetch: fake, probe: true, probeBudgetMs: 5000 });

    expect(seen.filter((url) => /debrid/i.test(url))).toEqual([]);
    expect(seen).toContain('https://tv.example/ok.m3u8');
    // Deux tentatives (flux direct et redirection), un seul événement par hôte et déclencheur.
    expect(reports.map((r) => r.host)).toEqual(['api.alldebrid.com']);
  });
});

describe('remontée Sentry', () => {
  it('l\'événement n\'est pas écarté comme « attendu » et garde hôte, déclencheur et identifiant', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let blocked: DebridEgressBlockedError | undefined;
    runWithEgressContext({ trigger: 'request', requestId: 'ray-123' }, () => {
      try {
        assertNotDebrid('https://api.alldebrid.com/v4/user?apikey=SECRET', 'fetch-bytes');
      } catch (error) {
        blocked = error as DebridEgressBlockedError;
      }
    });
    expect(blocked).toBeInstanceOf(DebridEgressBlockedError);

    const event = {
      type: undefined,
      level: 'error' as const,
      message: 'appel bloqué vers https://api.alldebrid.com/v4/user?apikey=SECRET',
      tags: { blocked_host: blocked?.host ?? '', egress_trigger: blocked?.trigger ?? '', request_id: blocked?.requestId ?? '' },
      fingerprint: ['server_side_debrid_call'],
    };
    const sent = beforeSendFilter(event, { originalException: blocked });

    expect(sent).not.toBeNull();
    expect(sent?.level).toBe('error');
    expect(sent?.tags).toEqual({ blocked_host: 'api.alldebrid.com', egress_trigger: 'request/fetch-bytes', request_id: 'ray-123' });
    expect(JSON.stringify(sent)).not.toContain('SECRET');
  });
});
