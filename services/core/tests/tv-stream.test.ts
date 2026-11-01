import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { scanJson, scanJsonArray, scanLines } from '../src/lt/json-stream.js';
import {
  applyDirect,
  buildCatalogStreaming,
  buildEpgStreaming,
  epgIdsOf,
  healthLog,
  refreshTv,
  TV_KEYS,
  type TvBlobStore,
} from '../src/lt/tv-build.js';
import { M3uAccumulator, type Programme, XmltvIngest } from '../src/lt/tv-feed.js';

const encoder = new TextEncoder();

/** Flux d'octets à partir de morceaux de texte, un par lecture. */
function streamOf(chunks: Iterable<string | Uint8Array>): ReadableStream<Uint8Array> {
  const it = chunks[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = it.next();
      if (next.done) controller.close();
      else controller.enqueue(typeof next.value === 'string' ? encoder.encode(next.value) : next.value);
    },
  });
}

/** Découpe un texte en morceaux de `size` octets (coupures au milieu des chaînes, des clés, des nombres). */
function* slices(text: string, size: number): Generator<Uint8Array> {
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function collectItems(text: string, path: string[], size: number): Promise<string[]> {
  const out: string[] = [];
  await scanJson(streamOf(slices(text, size)), path, (item) => out.push(item));
  return out;
}

describe('scanJson : lecture en flux', () => {
  const doc = JSON.stringify({
    skip: [1, 2, { a: ']' }],
    regions: { us: { channels: { z: { n: 1 } } }, fr: { channels: { abc: { name: 'A, "B" ]}', logo: 'x' }, def: { name: 'é\\"' } } } },
    tail: [3],
  });

  it('extrait les éléments d’un tableau racine quelle que soit la coupure des morceaux', async () => {
    const array = JSON.stringify([{ id: 'a', n: 'x]' }, 3, 'texte, avec virgule', [1, [2]], { k: { l: [4] } }]);
    for (const size of [1, 2, 3, 7, 1000]) {
      const items = await collectItems(array, [], size);
      expect(items.map((i) => JSON.parse(i) as unknown)).toEqual(JSON.parse(array) as unknown[]);
    }
  });

  it('extrait un objet imbriqué par chemin et ignore le reste du document', async () => {
    for (const size of [1, 5, 64, 100000]) {
      const items = await collectItems(doc, ['regions', 'fr', 'channels'], size);
      expect(items).toHaveLength(2);
      const entries = items.map((i) => JSON.parse('{' + i + '}') as Record<string, { name: string }>);
      expect(entries[0]?.abc?.name).toBe('A, "B" ]}');
      expect(entries[1]?.def?.name).toBe('é\\"');
    }
  });

  it('chemin absent : aucun élément ; élément trop gros : ignoré', async () => {
    expect(await collectItems(doc, ['regions', 'de', 'channels'], 16)).toEqual([]);
    const out: string[] = [];
    await scanJson(streamOf([JSON.stringify([{ big: 'x'.repeat(500) }, { ok: 1 }])]), [], (item) => out.push(item), { maxItemChars: 100 });
    expect(out).toEqual(['{"ok":1}']);
  });

  it('scanLines : lignes complètes, CRLF et dernière ligne sans saut', async () => {
    const lines: string[] = [];
    await scanLines(streamOf(slices('a\r\nbb\nccc', 2)), (l) => lines.push(l));
    expect(lines).toEqual(['a', 'bb', 'ccc']);
  });
});

describe('mémoire bornée sur un très gros fichier simulé', () => {
  it('parcourt 120 Mo de JSON en ne gardant que les éléments retenus', async () => {
    const record = (i: number): string => JSON.stringify({ channel: 'c' + i, url: 'https://s.example/' + i + '.m3u8', labels: [], pad: 'p'.repeat(900) });
    const total = 120_000; // ~ 120 Mo
    let next = 0;
    let opened = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!opened) {
          opened = true;
          controller.enqueue(encoder.encode('['));
        }
        if (next >= total) {
          controller.enqueue(encoder.encode(']'));
          controller.close();
          return;
        }
        const batch: string[] = [];
        for (let k = 0; k < 64 && next < total; k++) batch.push(record(next++));
        controller.enqueue(encoder.encode((next > 64 ? ',' : '') + batch.join(',')));
      },
    });
    const baseline = process.memoryUsage().heapUsed;
    let peak = 0;
    let seen = 0;
    const kept: string[] = [];
    await scanJsonArray(source, (r) => {
      seen += 1;
      if (seen % 64 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - baseline);
      if (String(r.channel).endsWith('000')) kept.push(String(r.channel));
    });
    expect(seen).toBe(total);
    expect(kept).toHaveLength(total / 1000 - 1); // c1000 … c119000
    // Les 120 Mo ne sont jamais retenus : la pointe reste très loin de la taille du fichier (marge pour le ramasse-miettes).
    expect(peak).toBeLessThan(40 * 1024 * 1024);
  }, 120_000);
});

describe('XMLTV et M3U incrémentaux', () => {
  const now = 1_800_000_000;
  const stamp = (s: number): string => new Date(s * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const prog = (channel: string, start: number, stop: number, title: string): string =>
    `<programme start="${stamp(start)}" stop="${stamp(stop)}" channel="${channel}"><title lang="fr">${title}</title><desc>d &amp; e</desc></programme>`;
  const xml = `<?xml version="1.0"?><tv><channel id="TF1.fr"/>${prog('TF1.fr', now - 600, now + 600, 'Journal')}${prog('Autre.fr', now, now + 60, 'Ignoré')}${prog('TF1.fr', now + 10 * 86400, now + 10 * 86400 + 60, 'Trop loin')}${prog('TF1.fr', now + 600, now + 1200, 'Suite')}</tv>`;

  it('filtre chaîne et fenêtre, quelle que soit la coupure des morceaux', () => {
    for (const size of [1, 7, 50, 100000]) {
      const store = new Map<string, Programme[]>();
      const ingest = new XmltvIngest(store, now - 1800, now + 86400, new Set(['TF1.fr']));
      for (let i = 0; i < xml.length; i += size) ingest.push(xml.slice(i, i + size));
      expect([...store.keys()]).toEqual(['TF1.fr']);
      expect(store.get('TF1.fr')?.map((p) => p.title)).toEqual(['Journal', 'Suite']);
      expect(store.get('TF1.fr')?.[0]?.desc).toBe('d & e');
      expect(ingest.count).toBe(2);
    }
  });

  it('M3U : l’acceptation écarte les entrées avant de les garder', () => {
    const acc = new M3uAccumulator((e) => e.attrs['tvg-country'] === 'FR');
    ['#EXTM3U', '#EXTINF:-1 tvg-country="FR",A', 'https://a.example/a.m3u8', '#EXTINF:-1 tvg-country="DE",B', 'https://b.example/b.m3u8'].forEach((l) => acc.push(l));
    expect(acc.entries.map((e) => e.name)).toEqual(['A']);
  });
});

/** Réseau simulé : URL → corps (texte ou octets), rendu en flux. */
function fakeFetch(routes: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    return Promise.resolve(route === undefined ? new Response('absent', { status: 404 }) : route());
  }) as typeof fetch;
}

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('construction du catalogue et de l’EPG en flux', () => {
  const now = 1_800_000_000_000;
  const sec = now / 1000;
  const stamp = (s: number): string => new Date(s * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const epgXml = `<tv>${[
    ['TF1.fr', sec - 600, sec + 600, 'Journal'],
    ['TF1.fr', sec + 3 * 86400, sec + 3 * 86400 + 60, 'Hors fenêtre'],
    ['Autre.us', sec, sec + 60, 'Hors pays'],
  ]
    .map(([c, a, b, t]) => `<programme start="${stamp(a as number)}" stop="${stamp(b as number)}" channel="${c as string}"><title>${t as string}</title></programme>`)
    .join('')}</tv>`;

  const channels = [
    { id: 'TF1.fr', name: 'TF1', country: 'FR', categories: ['general'], is_nsfw: false, closed: null, alt_names: [], extra: 'x'.repeat(50) },
    { id: 'Autre.us', name: 'Autre', country: 'US', categories: ['news'], is_nsfw: false, closed: null, alt_names: [] },
    { id: 'RTBF.be', name: 'RTBF', country: 'BE', categories: ['news'], is_nsfw: false, closed: null, alt_names: [] },
  ];
  const streams = [
    { channel: 'TF1.fr', feed: 'SD', url: 'https://tf1.example/tf1.m3u8', quality: '720p', labels: [] },
    { channel: 'TF1.fr', feed: 'SD', url: 'http://tf1.example/clair.m3u8', quality: '480p', labels: [] },
    { channel: 'Autre.us', feed: 'SD', url: 'https://us.example/a.m3u8', quality: '720p', labels: [] },
    { channel: 'RTBF.be', feed: 'SD', url: 'https://rtbf.example/r.m3u8', quality: '720p', labels: [] },
  ];
  const routes = (): Record<string, () => Response> => ({
    'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8': () =>
      new Response('#EXTM3U\n#EXTINF:-1 tvg-id="M6.fr" tvg-country="FR" group-title="France",M6\nhttps://m6.example/m6.m3u8\n#EXTINF:-1 tvg-id="CNN.us" tvg-country="US",CNN\nhttps://cnn.example/c.m3u8\n'),
    'https://i.mjh.nz/PlutoTV/.channels.json': () =>
      jsonResponse({ regions: { us: { channels: { u1: { name: 'US only' } } }, fr: { channels: { p1: { name: 'Pluto Ciné', group: 'Movies' } } } } }),
    'https://i.mjh.nz/SamsungTVPlus/.channels.json': () => jsonResponse({ regions: { fr: { channels: {} } } }),
    'https://iptv-org.github.io/api/channels.json': () => jsonResponse(channels),
    'https://iptv-org.github.io/api/streams.json': () => jsonResponse(streams),
    'https://iptv-org.github.io/api/feeds.json': () => jsonResponse([{ channel: 'TF1.fr', id: 'SD', languages: ['fra'] }, { channel: 'Autre.us', id: 'SD', languages: ['eng'] }]),
    'https://iptv-org.github.io/api/logos.json': () => jsonResponse([{ channel: 'TF1.fr', feed: null, in_use: true, url: 'https://logo.example/tf1.png' }]),
    'https://iptv-org.github.io/api/countries.json': () => jsonResponse([{ name: 'France', code: 'FR', languages: ['fra'] }]),
    'https://iptv-org.github.io/api/languages.json': () => jsonResponse([{ code: 'fra', name: 'French' }]),
    'https://iptv-org.github.io/api/blocklist.json': () => jsonResponse([]),
    'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz': () => new Response(gzipSync(Buffer.from(epgXml))),
    'https://iptv-epg.org/files/epg-fr.xml.gz': () => new Response('erreur', { status: 500 }),
    'https://i.mjh.nz/PlutoTV/fr.xml.gz': () => new Response('erreur', { status: 500 }),
    'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz': () => new Response('erreur', { status: 500 }),
  });

  it('garde les chaînes des pays retenus, avec leurs flux, et rien des autres', async () => {
    const catalog = await buildCatalogStreaming({ fetch: fakeFetch(routes()), countries: ['FR', 'BE'] });
    const names = catalog.channels.map((c) => c.name).sort();
    expect(names).toEqual(['M6', 'Pluto Ciné', 'RTBF', 'TF1']);
    const tf1 = catalog.channels.find((c) => c.name === 'TF1');
    expect(tf1?.url).toBe('https://tf1.example/tf1.m3u8');
    expect(tf1?.alternatives.map((a) => a.url)).toContain('http://tf1.example/clair.m3u8');
    expect(catalog.partial).toBe(false);
  });

  it('une source en échec donne un catalogue partiel ; toutes en échec : erreur', async () => {
    const down = routes();
    down['https://i.mjh.nz/PlutoTV/.channels.json'] = () => new Response('x', { status: 503 });
    const partial = await buildCatalogStreaming({ fetch: fakeFetch(down), countries: ['FR'] });
    expect(partial.partial).toBe(true);
    await expect(buildCatalogStreaming({ fetch: fakeFetch({}), countries: ['FR'] })).rejects.toThrow('tv_unavailable');
  });

  it('EPG : décompression en flux, chaînes retenues et fenêtre maintenant → +24 h seulement', async () => {
    const catalog = await buildCatalogStreaming({ fetch: fakeFetch(routes()), countries: ['FR'] });
    const wanted = epgIdsOf(catalog);
    expect(wanted.has('TF1.fr')).toBe(true);
    const epg = await buildEpgStreaming(wanted, { fetch: fakeFetch(routes()), now: () => now });
    expect(Object.keys(epg.programmes)).toEqual(['TF1.fr']);
    expect(epg.programmes['TF1.fr']?.map((p) => p.title)).toEqual(['Journal']);
    expect(epg.epgStats.filter((s) => s.ok)).toHaveLength(1);
  });

  it('refreshTv écrit catalogue, sondages et EPG ; sondage CORS : https/CORS lisible, http bloqué, inconnu laissé vide', async () => {
    const written = new Map<string, string>();
    const store: TvBlobStore = { get: (k) => Promise.resolve(written.get(k)), put: (k, v) => Promise.resolve(void written.set(k, v)) };
    const calls: string[] = [];
    const net = routes();
    net['https://tf1.example/tf1.m3u8'] = () => new Response('#EXTM3U', { headers: { 'access-control-allow-origin': '*' } });
    net['https://m6.example/m6.m3u8'] = () => new Response('#EXTM3U');
    net['https://rtbf.example/r.m3u8'] = () => new Response('x', { status: 403 });
    const result = await refreshTv(store, { fetch: fakeFetch(net, calls), countries: ['FR', 'BE'], probe: true, now: () => now });
    expect(result.channels).toBe(4);
    expect(result.epgOk).toBe(true);
    const snapshot = JSON.parse(written.get(TV_KEYS.catalog) ?? '{}') as { catalog: { channels: { name: string; direct?: boolean; alternatives: { url: string; direct?: boolean }[] }[] } };
    const by = (name: string) => snapshot.catalog.channels.find((c) => c.name === name);
    expect(by('TF1')?.direct).toBe(true);
    expect(by('TF1')?.alternatives.find((a) => a.url.startsWith('http:'))?.direct).toBe(false);
    expect(by('M6')?.direct).toBe(false); // https sans CORS
    expect(by('RTBF')?.direct).toBeUndefined(); // 403 : inconnu
    expect(written.has(TV_KEYS.epg)).toBe(true);
    expect(written.has(TV_KEYS.probe)).toBe(true);
    const probe = JSON.parse(written.get(TV_KEYS.probe) ?? '{}') as { health?: Record<string, [number, number]> };
    expect(probe.health?.['https://m6.example/m6.m3u8']).toEqual([1, now / 1000]); // manifeste sans segment : un échec, pas encore retirée
    expect(result.removed).toBe(0);

    // Deuxième passage : les sondages récents sont réutilisés (aucune nouvelle requête vers les flux).
    calls.length = 0;
    await refreshTv(store, { fetch: fakeFetch(net, calls), countries: ['FR', 'BE'], probe: true, now: () => now + 3600_000 });
    expect(calls.filter((u) => u.includes('tf1.example') || u.includes('m6.example'))).toEqual([]);
  });

  it('refreshTv : bilan de santé gardé dans probe.json, conservé par un passage sans contrôle ; journal borné à 40 noms', async () => {
    const written = new Map<string, string>();
    const store: TvBlobStore = { get: (k) => Promise.resolve(written.get(k)), put: (k, v) => Promise.resolve(void written.set(k, v)) };
    const net = routes();
    net['https://tf1.example/tf1.m3u8'] = () => new Response('#EXTM3U', { headers: { 'access-control-allow-origin': '*' } });
    await refreshTv(store, { fetch: fakeFetch(net), countries: ['FR', 'BE'], probe: true, now: () => now });
    const first = JSON.parse(written.get(TV_KEYS.probe) ?? '{}') as { report?: { at: number; checked: number; removed: unknown[]; restored: unknown[] } };
    expect(first.report).toMatchObject({ at: now, removed: [], restored: [] });
    expect(first.report?.checked).toBeGreaterThan(0);

    await refreshTv(store, { fetch: fakeFetch(net), countries: ['FR', 'BE'], probe: false, now: () => now + 3600_000 });
    const second = JSON.parse(written.get(TV_KEYS.probe) ?? '{}') as { report?: { at: number } };
    expect(second.report?.at).toBe(now);

    const many = Array.from({ length: 42 }, (_, i) => ({ id: `c${i}`, name: `N${i}` }));
    const line = healthLog({ at: now, checked: 7, tripped: true, removed: many, restored: [{ id: 'r', name: 'Remise' }] }, 42);
    expect(line).toContain('7 contrôlés, 42 flux écartés, 42 chaînes retirées, 1 remises (disjoncteur');
    expect(line).toContain('retirées : N0, N1, ');
    expect(line).toContain('N39, … (+2)');
    expect(line).not.toContain('N40');
    expect(line).toContain('remises : Remise');
  });

  it('sans sondage, seul http est marqué non lisible', async () => {
    const catalog = await buildCatalogStreaming({ fetch: fakeFetch(routes()), countries: ['FR'] });
    await applyDirect(catalog, undefined, { fetch: fakeFetch({}), probe: false });
    const tf1 = catalog.channels.find((c) => c.name === 'TF1');
    expect(tf1?.direct).toBeUndefined();
    expect(tf1?.alternatives.find((a) => a.url.startsWith('http:'))?.direct).toBe(false);
  });
});
