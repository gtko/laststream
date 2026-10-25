import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TvBlobStore } from '../src/lt/tv-build.js';
import { TV_KEYS } from '../src/lt/tv-build.js';
import { alertsOf, applyOutcomes, epgSourceId, isFullPassWindow, planResume, type SourceOutcome } from '../src/lt/tv-passes.js';
import { setWarningReporter } from '../src/observability/report.js';
import { readTvCron, runTvPass } from '../src/platform/workers/tv-store.js';

/** Reprise du cron TV (LAST-137) : planification pure, alerte, et passes successives sur un stockage et des sources simulés. */

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const EPG_FRANCE = 'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz';
const EPG_URLS = [EPG_FRANCE, 'https://iptv-epg.org/files/epg-fr.xml.gz', 'https://i.mjh.nz/PlutoTV/fr.xml.gz', 'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz'];
const TF1 = 'https://tf1.example/tf1.m3u8';
const M6 = 'https://m6.example/m6.m3u8';
const CATALOG_PREFIXES = ['https://iptv-org.github.io/', 'https://raw.githubusercontent.com/', 'https://i.mjh.nz/PlutoTV/.channels', 'https://i.mjh.nz/SamsungTVPlus/.channels'];

let clock = T0;
const now = (): number => clock;
const later = (minutes: number): void => {
  clock += minutes * 60_000;
};

/** Horodatage XMLTV (AAAAMMJJHHMMSS +0000). */
const stamp = (sec: number): string => new Date(sec * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

function epgGzip(): Uint8Array {
  const sec = T0 / 1000;
  return gzipSync(`<tv><programme start="${stamp(sec - 60)}" stop="${stamp(sec + 3600)}" channel="TF1.fr"><title>Journal</title></programme></tv>`);
}

interface World {
  fetch: typeof fetch;
  calls: string[];
  failing: Set<string>;
}

/** Sources simulées : catalogue, EPG et flux. `failing` : URL qui répondent 500. */
function world(options: { failing?: string[]; m6?: boolean } = {}): World {
  const failing = new Set(options.failing ?? []);
  const calls: string[] = [];
  const json = (body: unknown): Response => new Response(JSON.stringify(body));
  const channels = [{ id: 'TF1.fr', name: 'TF1', country: 'FR', categories: ['general'], is_nsfw: false, closed: null, alt_names: [] }];
  const streams = [{ channel: 'TF1.fr', feed: 'SD', url: TF1, quality: '720p', labels: [] }];
  if (options.m6 === true) {
    channels.push({ id: 'M6.fr', name: 'M6', country: 'FR', categories: ['general'], is_nsfw: false, closed: null, alt_names: [] });
    streams.push({ channel: 'M6.fr', feed: 'SD', url: M6, quality: '720p', labels: [] });
  }
  const stream = (): Response => new Response('segment', { headers: { 'access-control-allow-origin': '*' } });
  const routes: Record<string, () => Response> = {
    'https://iptv-org.github.io/api/channels.json': () => json(channels),
    'https://iptv-org.github.io/api/streams.json': () => json(streams),
    'https://iptv-org.github.io/api/feeds.json': () => json([]),
    'https://iptv-org.github.io/api/logos.json': () => json([]),
    'https://iptv-org.github.io/api/countries.json': () => json([{ code: 'FR', name: 'France', languages: ['fra'] }]),
    'https://iptv-org.github.io/api/languages.json': () => json([{ code: 'fra', name: 'French' }]),
    'https://iptv-org.github.io/api/blocklist.json': () => json([]),
    'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8': () => new Response('#EXTM3U\n'),
    'https://i.mjh.nz/PlutoTV/.channels.json': () => json({ regions: { fr: { channels: {} } } }),
    'https://i.mjh.nz/SamsungTVPlus/.channels.json': () => json({ regions: { fr: { channels: {} } } }),
    [TF1]: stream,
    [M6]: stream,
    ...Object.fromEntries(EPG_URLS.map((url) => [url, () => new Response(epgGzip())])),
  };
  const fake = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (failing.has(url)) return Promise.resolve(new Response('erreur', { status: 500 }));
    const route = routes[url];
    return Promise.resolve(route === undefined ? new Response('absent', { status: 404 }) : route());
  }) as typeof fetch;
  return { fetch: fake, calls, failing };
}

function memory(): TvBlobStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => Promise.resolve(data.get(key)),
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

const pass = (blobs: TvBlobStore, w: World, extra: { resume?: boolean; maxProbes?: number } = {}) =>
  runTvPass(blobs, { countries: ['FR'], probe: true, fetch: w.fetch, now, ...extra });

describe('planification de la reprise (fonctions pures)', () => {
  const ok: SourceOutcome = { ok: true, durationMs: 5 };
  const ko: SourceOutcome = { ok: false, durationMs: 5, error: 'upstream_500' };
  const allOk = applyOutcomes(undefined, { iptv: ok, freetv: ok, pluto: ok, samsung: ok, ...Object.fromEntries(EPG_URLS.map((url) => [epgSourceId(url), ok])) }, 'A');

  it('sans état précédent : rien à reprendre', () => {
    expect(planResume(undefined, EPG_URLS, false)).toBeUndefined();
  });

  it('tout à jour et aucun sondage en attente : rien à reprendre', () => {
    expect(planResume(allOk, EPG_URLS, false)).toBeUndefined();
  });

  it('source EPG en échec : seule cette URL, sans catalogue, sondes ni contrôle de santé', () => {
    const states = applyOutcomes(allOk, { [epgSourceId(EPG_FRANCE)]: ko }, 'B');
    expect(planResume(states, EPG_URLS, false)).toEqual({ kind: 'resume', catalog: false, epg: [EPG_FRANCE], probes: false, health: false });
  });

  it('source du catalogue en échec : catalogue relancé, aucune EPG', () => {
    const states = applyOutcomes(allOk, { pluto: ko }, 'B');
    expect(planResume(states, EPG_URLS, false)).toEqual({ kind: 'resume', catalog: true, epg: [], probes: false, health: false });
  });

  it('sondages restants : repris, sans rien d\'autre', () => {
    expect(planResume(allOk, EPG_URLS, true)).toEqual({ kind: 'resume', catalog: false, epg: [], probes: true, health: false });
  });
});

describe('états et seuil d\'alerte (fonctions pures)', () => {
  const ok: SourceOutcome = { ok: true, durationMs: 5 };
  const ko: SourceOutcome = { ok: false, durationMs: 5, error: 'upstream_500' };

  it('alerte une seule fois, au deuxième échec d\'affilée ; un succès remet le compteur à zéro', () => {
    const fail = { x: ko };
    const s1 = applyOutcomes(undefined, fail, 'A');
    expect(alertsOf(s1, fail)).toEqual([]);
    const s2 = applyOutcomes(s1, fail, 'B');
    expect(s2.x).toEqual({ lastSuccessAt: null, consecutiveFailures: 2, durationMs: 5, error: 'upstream_500' });
    expect(alertsOf(s2, fail)).toEqual(['x']);
    const s3 = applyOutcomes(s2, fail, 'C');
    expect(alertsOf(s3, fail)).toEqual([]);
    const s4 = applyOutcomes(s3, { x: ok }, 'D');
    expect(s4.x).toEqual({ lastSuccessAt: 'D', consecutiveFailures: 0, durationMs: 5, error: null });
  });

  it('une source non exécutée à ce passage garde son état', () => {
    const s = applyOutcomes(undefined, { x: ko }, 'A');
    expect(applyOutcomes(s, {}, 'B')).toEqual(s);
  });

  it('fenêtre de la passe complète : 00:00, 06:00… (UTC) seulement', () => {
    expect(isFullPassWindow(Date.UTC(2026, 9, 25, 6, 0))).toBe(true);
    expect(isFullPassWindow(Date.UTC(2026, 9, 25, 6, 4))).toBe(true);
    expect(isFullPassWindow(Date.UTC(2026, 9, 25, 6, 30))).toBe(false);
    expect(isFullPassWindow(Date.UTC(2026, 9, 25, 12, 30))).toBe(false);
  });
});

describe('passes du cron TV (stockage et sources simulés)', () => {
  beforeEach(() => {
    clock = T0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setWarningReporter(undefined);
  });

  it('échec partiel d\'une source EPG : la passe suivante ne relit que cette source, et le journal le dit', async () => {
    const blobs = memory();
    await pass(blobs, world({ failing: [EPG_FRANCE] }));
    const state = await readTvCron(blobs);
    expect(state?.sources?.[epgSourceId(EPG_FRANCE)]).toMatchObject({ consecutiveFailures: 1, error: 'upstream_500' });
    expect(state?.sources?.iptv).toMatchObject({ consecutiveFailures: 0 });
    const journal = vi.mocked(console.log).mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(journal.find((line) => line.event === 'tv_pass' && line.kind === 'full')).toMatchObject({ ok: true, failed: [epgSourceId(EPG_FRANCE)] });

    later(30);
    const next = world();
    const result = await pass(blobs, next, { resume: true });
    expect(result?.epgOk).toBe(true);
    expect(next.calls.filter((url) => EPG_URLS.includes(url))).toEqual([EPG_FRANCE]);
    expect(next.calls.some((url) => CATALOG_PREFIXES.some((prefix) => url.startsWith(prefix)))).toBe(false);
    expect(next.calls).not.toContain(TF1);
    expect((await readTvCron(blobs))?.sources?.[epgSourceId(EPG_FRANCE)]?.consecutiveFailures).toBe(0);
  });

  it('deux passes en échec d\'affilée : une alerte de niveau avertissement, une seule', async () => {
    const alerts: { message: string; context: Record<string, unknown> }[] = [];
    setWarningReporter((message, context) => {
      alerts.push({ message, context });
    });
    const blobs = memory();
    const broken = world({ failing: [EPG_FRANCE] });
    await pass(blobs, broken);
    expect(alerts).toEqual([]);

    later(30);
    await pass(blobs, broken, { resume: true });
    expect(alerts).toEqual([{ message: 'tv_source_consecutive_failures', context: { source: epgSourceId(EPG_FRANCE), consecutiveFailures: 2, kind: 'resume' } }]);

    later(30);
    await pass(blobs, broken, { resume: true });
    expect(alerts).toHaveLength(1);
  });

  it('reprise sans état précédent : rien à faire, aucune requête', async () => {
    const w = world();
    expect(await pass(memory(), w, { resume: true })).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  it('passe complète sans échec : la reprise suivante n\'a rien à faire', async () => {
    const blobs = memory();
    await pass(blobs, world());
    later(30);
    const w = world();
    expect(await pass(blobs, w, { resume: true })).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  it('budget de sondes atteint : la reprise ne sonde que l\'URL restante, sans contrôle de santé', async () => {
    const blobs = memory();
    await pass(blobs, world({ m6: true }), { maxProbes: 1 });
    expect(await readTvCron(blobs)).toMatchObject({ probes: 1, probesPending: true });
    const probed = JSON.parse(blobs.data.get(TV_KEYS.probe) ?? '{}') as { results: Record<string, unknown> };
    const missing = [TF1, M6].find((url) => probed.results[url] === undefined);

    later(30);
    const w = world({ m6: true });
    await pass(blobs, w, { resume: true });
    expect(w.calls.filter((url) => url === TF1 || url === M6)).toEqual([missing]);
    expect((await readTvCron(blobs))?.probesPending).toBe(false);
  });
});
