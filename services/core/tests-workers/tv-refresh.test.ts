import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { scanJsonArray } from '../src/lt/json-stream.js';
import { refreshTv, TV_KEYS } from '../src/lt/tv-build.js';
import { createR2TvBlobs } from '../src/platform/workers/tv-store.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';

/** Construction du catalogue TV dans le runtime Workers (workerd, 128 Mo) : flux, gzip natif, écriture et lecture R2. */

const encoder = new TextEncoder();

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('Workers : lecture en flux et R2', () => {
  it('parcourt ~150 Mo de JSON simulé sans dépasser la mémoire de l’isolat', async () => {
    const total = 150_000;
    let next = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next === 0) controller.enqueue(encoder.encode('['));
        if (next >= total) {
          controller.enqueue(encoder.encode(']'));
          controller.close();
          return;
        }
        const batch: string[] = [];
        for (let k = 0; k < 64 && next < total; k++, next++) batch.push(JSON.stringify({ channel: 'c' + next, url: 'https://s.example/' + next, pad: 'p'.repeat(950) }));
        controller.enqueue(encoder.encode((next > 64 ? ',' : '') + batch.join(',')));
      },
    });
    let seen = 0;
    let kept = 0;
    await scanJsonArray(source, (record) => {
      seen += 1;
      if (String(record.channel).endsWith('0000')) kept += 1;
    });
    expect(seen).toBe(total);
    expect(kept).toBe(14); // c10000 … c140000
  }, 120_000);

  it('refreshTv : catalogue FR et EPG réduit (gzip en flux) écrits dans R2, relus à l’identique', async () => {
    const now = Date.UTC(2027, 0, 1, 12, 0, 0);
    const sec = now / 1000;
    const stamp = (s: number): string => new Date(s * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    const programme = (channel: string, start: number, stop: number, title: string): string =>
      `<programme start="${stamp(start)}" stop="${stamp(stop)}" channel="${channel}"><title>${title}</title></programme>`;
    const xml = `<tv>${programme('TF1.fr', sec - 60, sec + 3600, 'Journal')}${programme('TF1.fr', sec + 5 * 86400, sec + 5 * 86400 + 60, 'Loin')}${programme('X.us', sec, sec + 60, 'Autre')}</tv>`;
    const epg = await gzip(xml);
    const json = (body: unknown): Response => new Response(JSON.stringify(body));
    const routes: Record<string, () => Response> = {
      'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8': () => new Response('#EXTM3U\n'),
      'https://i.mjh.nz/PlutoTV/.channels.json': () => json({ regions: { fr: { channels: {} } } }),
      'https://i.mjh.nz/SamsungTVPlus/.channels.json': () => json({ regions: { fr: { channels: {} } } }),
      'https://iptv-org.github.io/api/channels.json': () =>
        json([
          { id: 'TF1.fr', name: 'TF1', country: 'FR', categories: ['general'], is_nsfw: false, closed: null, alt_names: [] },
          { id: 'X.us', name: 'X', country: 'US', categories: [], is_nsfw: false, closed: null, alt_names: [] },
        ]),
      'https://iptv-org.github.io/api/streams.json': () =>
        json([
          { channel: 'TF1.fr', feed: 'SD', url: 'https://tf1.example/tf1.m3u8', quality: '720p', labels: [] },
          { channel: 'X.us', feed: 'SD', url: 'https://x.example/x.m3u8', quality: '720p', labels: [] },
        ]),
      'https://iptv-org.github.io/api/feeds.json': () => json([]),
      'https://iptv-org.github.io/api/logos.json': () => json([]),
      'https://iptv-org.github.io/api/countries.json': () => json([{ name: 'France', code: 'FR', languages: ['fra'] }]),
      'https://iptv-org.github.io/api/languages.json': () => json([{ code: 'fra', name: 'French' }]),
      'https://iptv-org.github.io/api/blocklist.json': () => json([]),
      'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz': () => new Response(epg),
      'https://iptv-epg.org/files/epg-fr.xml.gz': () => new Response('erreur', { status: 500 }),
      'https://i.mjh.nz/PlutoTV/fr.xml.gz': () => new Response('erreur', { status: 500 }),
      'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz': () => new Response('erreur', { status: 500 }),
      'https://tf1.example/tf1.m3u8': () => new Response('#EXTM3U', { headers: { 'access-control-allow-origin': '*' } }),
    };
    const fake = ((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const route = routes[url];
      return Promise.resolve(route === undefined ? new Response('absent', { status: 404 }) : route());
    }) as typeof fetch;

    const bucket = (env as unknown as WorkerEnv).TV;
    if (bucket === undefined) throw new Error('binding TV absent');
    const blobs = createR2TvBlobs(bucket);
    const result = await refreshTv(blobs, { fetch: fake, countries: ['FR'], probe: true, now: () => now });
    // `removed` fait partie du contrat (RefreshResult, src/lt/tv-build.ts) : 0 au premier passage, sans historique de santé
    // le retrait exige HEALTH_THRESHOLD (3) échecs consécutifs.
    expect(result).toEqual({ channels: 1, programmes: 1, epgOk: true, removed: 0 });

    const catalog = JSON.parse((await blobs.get(TV_KEYS.catalog)) ?? '{}') as { catalog: { channels: { name: string; direct?: boolean }[] } };
    expect(catalog.catalog.channels.map((c) => [c.name, c.direct])).toEqual([['TF1', true]]);
    const stored = JSON.parse((await blobs.get(TV_KEYS.epg)) ?? '{}') as { programmes: Record<string, { title: string }[]> };
    expect(Object.keys(stored.programmes)).toEqual(['TF1.fr']);
    expect(stored.programmes['TF1.fr']?.map((p) => p.title)).toEqual(['Journal']);
  });
});
