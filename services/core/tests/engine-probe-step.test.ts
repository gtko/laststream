import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichWithProbe, newResolverHostMemo } from '../src/engine/probe-step.js';
import type { Ranked } from '../src/engine/types.js';
import { resetDebridReportThrottle, setDebridBlockReporter } from '../src/egress/debrid-guard.js';
import type { FetchFn } from '../src/sources/http.js';
import type { MediaProbe, ProbeOptions } from '../src/media/probe.js';
import { ProbeCache } from '../src/media/probe-cache.js';
import { cand, ranked as asRanked } from './engine-fixtures.js';
import { buildMkv, rangeServer } from './media-fixtures.js';

const HASH_A = 'a'.repeat(40);
const DIRECT_URL = 'https://cdn.example.com/media/film.mkv';

const FR_EN: MediaProbe = {
  container: 'mkv',
  audio: [
    { lang: 'fr', codec: 'EAC3', channels: 6, atmos: false },
    { lang: 'en', codec: 'TrueHD', channels: 8, atmos: true },
  ],
  subtitles: [],
};

const VERIFIED_FR_EN = ['fr', 'en', 'multi'];

/** Candidat sans lien direct, avec un infoHash : jamais sondé (le serveur ne résout aucun lien débridé). */
function notDirect(hash: string): Ranked {
  return asRanked(cand({ cached: true, raw: { infoHash: hash, title: 'Film.2024.1080p.WEB-DL' } }));
}

/** Lien direct http(s). */
function direct(url: string): Ranked {
  return asRanked(cand({ raw: { url, title: 'Film.2024.1080p.WEB-DL' } }));
}

/** Lien direct distinct par indice (une sonde par lien). */
function directAt(index: number): Ranked {
  return direct(`https://cdn.example.com/media/${index}.mkv`);
}

/** Sonde factice qui renvoie toujours `result`. */
function probeMock(result: MediaProbe | null = FR_EN) {
  return vi.fn(async (_url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => result);
}

describe('enrichWithProbe : liens directs', () => {
  it('lien direct sondé : directVerified à vrai, langues vérifiées', async () => {
    const probe = probeMock();

    const [out] = await enrichWithProbe([direct(DIRECT_URL)], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(probe.mock.calls[0]?.[0]).toBe(DIRECT_URL);
    expect(out.directVerified).toBe(true);
    expect(out.verifiedLanguages).toEqual(VERIFIED_FR_EN);
  });

  it('lien direct en échec : directVerified absent, candidat inchangé', async () => {
    const input = [direct(DIRECT_URL)];

    const out = await enrichWithProbe(input, {
      probe: probeMock(null),
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(out[0]).toBe(input[0]);
    expect(out[0].directVerified).toBeUndefined();
  });

  it('lien direct non http(s) : ignoré', async () => {
    const probe = probeMock();

    await enrichWithProbe([direct('ftp://cdn.example.com/film.mkv')], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 1,
    });

    expect(probe).not.toHaveBeenCalled();
  });

  it('dedup : deux liens directs identiques donnent une seule sonde', async () => {
    const probe = probeMock();

    const out = await enrichWithProbe([direct(DIRECT_URL), direct(DIRECT_URL)], {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 2,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(out.every((c) => c.directVerified === true)).toBe(true);
  });

  it('budget dépassé : les sondes terminées sont gardées, les autres restent inchangées, sans attendre', async () => {
    const probe = vi.fn((url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => {
      if (url.endsWith('/1.mkv')) return new Promise<null>(() => undefined);
      return Promise.resolve(FR_EN);
    });
    const input = [directAt(0), directAt(1)];
    const started = Date.now();

    const out = await enrichWithProbe(input, {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 2,
      budgetMs: 50,
    });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(out[0].verifiedLanguages).toEqual(VERIFIED_FR_EN);
    expect(out[1]).toBe(input[1]);
  });

  it('concurrence : au plus 3 sondes simultanées', async () => {
    let inFlight = 0;
    let peak = 0;
    const probe = vi.fn(async (_url: string, _options?: ProbeOptions): Promise<MediaProbe | null> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return FR_EN;
    });
    const input = [0, 1, 2, 3, 4].map(directAt);

    const out = await enrichWithProbe(input, {
      probe,
      cache: new ProbeCache<MediaProbe>(),
      topN: 5,
      budgetMs: 2000,
    });

    expect(peak).toBe(3);
    expect(out.every((c) => c.verifiedLanguages !== undefined)).toBe(true);
  });
});

describe('enrichWithProbe : cas limites', () => {
  it('topN à 0 : aucune action, même tableau renvoyé', async () => {
    const probe = probeMock();
    const input = [notDirect(HASH_A), direct(DIRECT_URL)];

    const out = await enrichWithProbe(input, { probe, cache: new ProbeCache<MediaProbe>(), topN: 0 });

    expect(out).toBe(input);
    expect(probe).not.toHaveBeenCalled();
  });

  it('aucun candidat éligible (sans lien direct) : même tableau renvoyé, aucune sonde', async () => {
    const probe = probeMock();
    const input = [notDirect(HASH_A)];

    const out = await enrichWithProbe(input, { probe, cache: new ProbeCache<MediaProbe>(), topN: 3 });

    expect(out).toBe(input);
    expect(probe).not.toHaveBeenCalled();
  });
});

const HOUR_MS = 60 * 60 * 1000;
const OTHER_HOST_URL = 'https://autre.example.org/media/film.mkv';

/** Fetch de sonde : chaque requête reçoit une redirection 302 vers `location`. */
function redirectTo(location: string) {
  return vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
}

describe('enrichWithProbe : redirection vers un autre hôte', () => {
  afterEach(() => {
    setDebridBlockReporter(undefined);
    resetDebridReportThrottle();
  });

  it('une redirection vers un autre hôte arrête la sonde après un seul appel, sans changer le candidat', async () => {
    const memo = newResolverHostMemo();
    const fetch = redirectTo(OTHER_HOST_URL);
    const input = [direct(DIRECT_URL)];

    const out = await enrichWithProbe(input, {
      cache: new ProbeCache<MediaProbe>(),
      fetch: fetch as unknown as FetchFn,
      resolverHosts: memo,
      topN: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out[0]).toBe(input[0]);
    expect(out[0].directVerified).toBeUndefined();
    expect(memo.get('cdn.example.com')).toBe(true);
  });

  it('redirection vers un hôte de débridage : un seul appel, aucun événement Sentry', async () => {
    const reporter = vi.fn();
    setDebridBlockReporter(reporter);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = redirectTo('https://x.debrid.it/dl/abc');
    const input = [direct(DIRECT_URL)];

    const out = await enrichWithProbe(input, {
      cache: new ProbeCache<MediaProbe>(),
      fetch: fetch as unknown as FetchFn,
      resolverHosts: newResolverHostMemo(),
      topN: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out[0]).toBe(input[0]);
    expect(reporter).not.toHaveBeenCalled();
  });

  it('hôte mémorisé : un nouveau candidat de cet hôte n est plus sondé, sans appel réseau', async () => {
    const memo = newResolverHostMemo();
    const fetch = redirectTo(OTHER_HOST_URL);
    await enrichWithProbe([direct(DIRECT_URL)], {
      cache: new ProbeCache<MediaProbe>(),
      fetch: fetch as unknown as FetchFn,
      resolverHosts: memo,
      topN: 1,
    });
    fetch.mockClear();
    const input = [directAt(7)];

    const out = await enrichWithProbe(input, {
      cache: new ProbeCache<MediaProbe>(),
      fetch: fetch as unknown as FetchFn,
      resolverHosts: memo,
      topN: 1,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(out[0]).toBe(input[0]);
  });

  it('un hôte mémorisé ne compte pas dans topN : le candidat d un autre hôte est sondé', async () => {
    const memo = newResolverHostMemo();
    memo.set('cdn.example.com', true);
    const server = rangeServer(buildMkv());
    const input = [directAt(0), direct(OTHER_HOST_URL)];

    const out = await enrichWithProbe(input, {
      cache: new ProbeCache<MediaProbe>(),
      fetch: server.fetch,
      resolverHosts: memo,
      topN: 1,
    });

    expect(server.calls.map((call) => call.url)).toEqual([OTHER_HOST_URL]);
    expect(out[0]).toBe(input[0]);
    expect(out[1].directVerified).toBe(true);
  });

  it('mémoire expirée après 24 h : l hôte est de nouveau sondé', async () => {
    let now = 0;
    const memo = newResolverHostMemo(() => now);
    memo.set('cdn.example.com', true);
    const server = rangeServer(buildMkv());

    now = 23 * HOUR_MS;
    await enrichWithProbe([directAt(0)], {
      cache: new ProbeCache<MediaProbe>(),
      fetch: server.fetch,
      resolverHosts: memo,
      topN: 1,
    });
    expect(server.calls).toHaveLength(0);

    now = 25 * HOUR_MS;
    const out = await enrichWithProbe([directAt(0)], {
      cache: new ProbeCache<MediaProbe>(),
      fetch: server.fetch,
      resolverHosts: memo,
      topN: 1,
    });
    expect(server.calls).toHaveLength(1);
    expect(out[0].directVerified).toBe(true);
  });

  it('lien direct 206 sur un hôte non mémorisé : sondé comme avant', async () => {
    const server = rangeServer(buildMkv());
    const input = [direct(OTHER_HOST_URL)];

    const out = await enrichWithProbe(input, {
      cache: new ProbeCache<MediaProbe>(),
      fetch: server.fetch,
      resolverHosts: newResolverHostMemo(),
      topN: 1,
    });

    expect(out[0].directVerified).toBe(true);
    expect(out[0].verifiedLanguages).toEqual(['fr', 'en', 'multi']);
  });

  it('mémoire bornée à 500 hôtes : le plus ancien est évincé', () => {
    const memo = newResolverHostMemo();
    for (let index = 0; index < 501; index += 1) memo.set(`h${index}.example.com`, true);

    expect(memo.size()).toBe(500);
    expect(memo.get('h0.example.com')).toBeUndefined();
    expect(memo.get('h500.example.com')).toBe(true);
  });
});
