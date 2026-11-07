import { describe, expect, it } from 'vitest';
import type { TvAlternative, TvCatalog, TvChannel } from '../src/lt/tv-catalog.js';
import { applyHealth, checkStream, type HealthMap } from '../src/lt/tv-health.js';

type Route = () => Response;

/** Réseau simulé : URL → réponse ; absent = 404. Les requêtes sont consignées (URL + en-tête Range). */
function fakeFetch(routes: Record<string, Route | 'throw'>, calls: { url: string; range?: string }[] = []): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, range: (init?.headers as Record<string, string> | undefined)?.range });
    const route = routes[url];
    if (route === 'throw') return Promise.reject(new Error('network'));
    return Promise.resolve(route === undefined ? new Response('absent', { status: 404 }) : route());
  }) as typeof fetch;
}

const hls = (body: string): Route => () => new Response(body, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nseg2.ts\n';
const segment: Route = () => new Response(new Uint8Array([0x47, 1, 2, 3]), { status: 206, headers: { 'content-type': 'video/mp2t' } });

describe('checkStream : manifeste puis segment', () => {
  it('manifeste média : lit le premier segment (URI relative résolue, Range borné)', async () => {
    const calls: { url: string; range?: string }[] = [];
    const net = { 'https://a.example/live/tf1.m3u8': hls(media), 'https://a.example/live/seg1.ts': segment };
    expect(await checkStream(fakeFetch(net, calls), 'https://a.example/live/tf1.m3u8')).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/live/tf1.m3u8', 'https://a.example/live/seg1.ts']);
    expect(calls[1]?.range).toBe('bytes=0-1023');
  });

  it('manifeste maître : suit la première variante puis son segment', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nhttps://cdn.example/v/low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhaut.m3u8\n';
    const net = { 'https://a.example/m.m3u8': hls(master), 'https://cdn.example/v/low.m3u8': hls(media), 'https://cdn.example/v/seg1.ts': segment };
    expect(await checkStream(fakeFetch(net), 'https://a.example/m.m3u8')).toBe('ok');
  });

  it('manifeste maître dont la variante est un maître : panne (profondeur bornée)', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';
    const net = { 'https://a.example/m.m3u8': hls(master), 'https://a.example/v.m3u8': hls(master) };
    expect(await checkStream(fakeFetch(net), 'https://a.example/m.m3u8')).toBe('down');
  });

  it('pannes franches : 404, 5xx, page HTML, manifeste sans segment, segment 404, segment vide, erreur réseau', async () => {
    const html: Route = () => new Response('<html>Bienvenue</html>', { headers: { 'content-type': 'text/html' } });
    const check = (net: Record<string, Route | 'throw'>): Promise<string> => checkStream(fakeFetch(net), 'https://a.example/x.m3u8');
    expect(await check({})).toBe('down');
    expect(await check({ 'https://a.example/x.m3u8': () => new Response('x', { status: 503 }) })).toBe('down');
    expect(await check({ 'https://a.example/x.m3u8': html })).toBe('down');
    expect(await check({ 'https://a.example/x.m3u8': hls('#EXTM3U\n#EXT-X-TARGETDURATION:6\n') })).toBe('down');
    expect(await check({ 'https://a.example/x.m3u8': hls(media) })).toBe('down'); // segment 404
    expect(await check({ 'https://a.example/x.m3u8': hls(media), 'https://a.example/seg1.ts': () => new Response(new Uint8Array()) })).toBe('down');
    expect(await check({ 'https://a.example/x.m3u8': hls(media), 'https://a.example/seg1.ts': html })).toBe('down');
    expect(await check({ 'https://a.example/x.m3u8': 'throw' })).toBe('down');
  });

  it('refus d’accès (géoblocage, jeton, limite) : sans verdict', async () => {
    for (const status of [401, 403, 429, 451]) {
      expect(await checkStream(fakeFetch({ 'https://a.example/x.m3u8': () => new Response('non', { status }) }), 'https://a.example/x.m3u8')).toBe('unknown');
    }
    const net = { 'https://a.example/x.m3u8': hls(media), 'https://a.example/seg1.ts': () => new Response('non', { status: 403 }) };
    expect(await checkStream(fakeFetch(net), 'https://a.example/x.m3u8')).toBe('unknown');
  });

  it('flux direct non HLS : ok s’il envoie des octets de média, panne si vide', async () => {
    const audio: Route = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    expect(await checkStream(fakeFetch({ 'https://radio.example/live': audio }), 'https://radio.example/live')).toBe('ok');
    expect(await checkStream(fakeFetch({ 'https://radio.example/live': () => new Response(new Uint8Array()) }), 'https://radio.example/live')).toBe('down');
  });

  it('segment servi sous un type MIME quelconque : jugé sur les octets ; page HTML/JSON : panne', async () => {
    const body = (type: string, bytes: Uint8Array | string): Route => () => new Response(bytes, { headers: { 'content-type': type } });
    const ts = new Uint8Array([0x47, 0x40, 0, 0x10]);
    const run = (seg: Route): Promise<string> =>
      checkStream(fakeFetch({ 'https://a.example/x.m3u8': hls(media), 'https://a.example/seg1.ts': seg }), 'https://a.example/x.m3u8');
    expect(await run(body('text/plain', ts))).toBe('ok');
    expect(await run(body('image/png', ts))).toBe('ok');
    expect(await run(body('video/mp2t', '<html>Indisponible dans votre pays</html>'))).toBe('down');
    expect(await run(body('application/json', '{"error":"geo"}'))).toBe('down');
  });

  it('hôtes AllDebrid : jamais appelés (manifeste, redirection ou segment)', async () => {
    const calls: { url: string }[] = [];
    expect(await checkStream(fakeFetch({}, calls), 'https://api.alldebrid.com/v4/link')).toBe('unknown');
    const net = { 'https://a.example/x.m3u8': hls('#EXTM3U\n#EXTINF:6,\nhttps://cdn.alldebrid.com/seg.ts\n') };
    expect(await checkStream(fakeFetch(net, calls), 'https://a.example/x.m3u8')).toBe('unknown');
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/x.m3u8']);
  });

  it('limite de sous-requêtes du Worker : sans verdict, pas une panne', async () => {
    const fetcher = (() => Promise.reject(new Error('Too many subrequests by single Worker invocation.'))) as typeof fetch;
    expect(await checkStream(fetcher, 'https://a.example/x.m3u8')).toBe('unknown');
  });

  it('URI de segment hors http(s) : panne', async () => {
    const net = { 'https://a.example/x.m3u8': hls('#EXTM3U\n#EXTINF:6,\nfile:///etc/passwd\n') };
    expect(await checkStream(fakeFetch(net), 'https://a.example/x.m3u8')).toBe('down');
  });
});

const alt = (url: string, source = 'iptvorg'): TvAlternative => ({ url, source, quality: 'SD', reliability: 'high' });
const channel = (id: string, url: string, alternatives: TvAlternative[] = [], extra: Partial<TvChannel> = {}): TvChannel => ({
  id,
  name: id,
  logo: '',
  group: '',
  cat: 'Autre',
  source: 'iptvorg',
  fast: false,
  url,
  epgId: '',
  flaky: false,
  country: 'FR',
  countryName: 'France',
  languages: [],
  categories: [],
  quality: 'HD',
  reliability: 'high',
  alternatives,
  ...extra,
});
const catalogOf = (channels: TvChannel[]): TvCatalog => ({
  channels,
  search: channels.map((c) => c.name.toLowerCase()),
  counts: { freetv: 0, iptvorg: channels.length, pluto: 0, samsung: 0 },
  reliability: { high: channels.length, low: 0 },
  facets: { total: channels.length, countries: [], languages: [], categories: [], sources: [] },
  partial: false,
});

const GOOD = 'https://ok.example/a.m3u8';
const BAD = 'https://mort.example/b.m3u8';
const BACKUP = 'https://ok.example/c.m3u8';
const live = (...urls: string[]): Record<string, Route> =>
  Object.fromEntries(urls.flatMap((u) => [[u, hls(media)], [u.replace(/[^/]*$/, 'seg1.ts'), segment]]));

describe('applyHealth : retrait après échecs consécutifs, retour automatique', () => {
  const T0 = 1_800_000_000_000;
  const HOUR = 3600_000;
  const options = (net: Record<string, Route | 'throw'>, at: number, calls: { url: string }[] = []) => ({
    fetch: fakeFetch(net, calls),
    now: () => T0 + at * HOUR,
    check: true,
  });

  it('retire la chaîne au troisième échec de suite seulement, et la rend dès que le flux répond', async () => {
    const net = live(GOOD);
    let health: HealthMap | undefined;
    const run = async (hour: number, routes = net) => {
      const catalog = catalogOf([channel('Bonne', GOOD), channel('Morte', BAD)]);
      const result = await applyHealth(catalog, health, options(routes, hour));
      health = result.health;
      return { names: catalog.channels.map((c) => c.id), result, catalog };
    };
    expect((await run(0)).names).toEqual(['Bonne', 'Morte']); // 1 échec
    expect((await run(6)).names).toEqual(['Bonne', 'Morte']); // 2 échecs
    const third = await run(12);
    expect(third.names).toEqual(['Bonne']); // 3 échecs : retirée
    expect(third.result).toMatchObject({ removed: 1, dead: 1 });
    expect(third.catalog.facets.total).toBe(1);
    expect(third.catalog.counts.iptvorg).toBe(1);
    expect(third.catalog.search).toEqual(['bonne']);
    expect(health?.[BAD]?.[0]).toBe(3);

    // La chaîne retirée reste sondée : son flux revient, elle revient.
    const back = await run(18, { ...net, ...live(BAD) });
    expect(back.names).toEqual(['Bonne', 'Morte']);
    expect(health?.[BAD]?.[0]).toBe(0);
  });

  it('un refus d’accès (géoblocage possible) ne compte pas comme échec', async () => {
    const net = { [BAD]: () => new Response('non', { status: 403 }) };
    let health: HealthMap | undefined;
    for (let hour = 0; hour <= 36; hour += 6) {
      const catalog = catalogOf([channel('Geo', BAD)]);
      const result = await applyHealth(catalog, health, options(net, hour));
      health = result.health;
      expect(catalog.channels).toHaveLength(1);
    }
    expect(health?.[BAD]?.[0]).toBe(0);
  });

  it('flux principal mort : le premier repli vivant le remplace, avec ses attributs', async () => {
    const backup = alt(BACKUP, 'pluto');
    const catalog = catalogOf([channel('TF1', BAD, [backup, alt('https://ok.example/d.m3u8')], { direct: true })]);
    const health: HealthMap = { [BAD]: [3, 1] };
    const result = await applyHealth(catalog, health, { now: () => T0 });
    expect(result.removed).toBe(0);
    const tf1 = catalog.channels[0];
    expect(tf1).toMatchObject({ url: BACKUP, source: 'pluto', fast: true });
    expect(tf1?.alternatives.map((a) => a.url)).toEqual(['https://ok.example/d.m3u8']);
    expect(tf1?.direct).toBeUndefined();
    expect(catalog.counts).toMatchObject({ pluto: 1, iptvorg: 0 });
  });

  it('repli mort retiré de la liste ; les replis ne sont contrôlés que si le principal échoue', async () => {
    const calls: { url: string }[] = [];
    const net = live(GOOD);
    const catalog = catalogOf([channel('Bonne', GOOD, [alt(BAD)]), channel('Cassée', BAD, [alt(BACKUP)])]);
    const result = await applyHealth(catalog, { [BAD]: [3, 1] }, options({ ...net, ...live(BACKUP) }, 0, calls));
    expect(calls.some((c) => c.url === BACKUP || c.url.endsWith('c.m3u8'))).toBe(true); // repli de la chaîne cassée
    expect(catalog.channels.map((c) => [c.id, c.url, c.alternatives.length])).toEqual([['Bonne', GOOD, 0], ['Cassée', BACKUP, 0]]);
    expect(result.health[BACKUP]?.[0]).toBe(0);
  });

  it('un contrôle récent n’est pas refait ; sans « check », seul l’état enregistré sert', async () => {
    const calls: { url: string }[] = [];
    const recent: HealthMap = { [GOOD]: [0, T0 / 1000 - 3600] };
    const catalog = catalogOf([channel('Bonne', GOOD)]);
    await applyHealth(catalog, recent, options(live(GOOD), 0, calls));
    expect(calls).toEqual([]);

    const dead = catalogOf([channel('Morte', BAD)]);
    const result = await applyHealth(dead, { [BAD]: [3, 1] }, { fetch: fakeFetch({}, calls), now: () => T0 });
    expect(dead.channels).toEqual([]);
    expect(result).toMatchObject({ removed: 1, checked: 0 });
    expect(calls).toEqual([]);
  });

  it('plafond de sous-requêtes : le reste attend le passage suivant, jamais retiré faute de contrôle', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://ok.example/${i}/live.m3u8`);
    const catalog = catalogOf(urls.map((u, i) => channel(`C${i}`, u)));
    const result = await applyHealth(catalog, undefined, { ...options(Object.assign({}, ...urls.map((u) => live(u))), 0), maxRequests: 4, concurrency: 1 });
    expect(result.checked).toBeLessThan(10);
    expect(result.checked).toBeGreaterThan(0);
    expect(catalog.channels).toHaveLength(10);
  });

  it('disjoncteur : si presque tout tombe d’un coup (réseau du Worker), les pannes du passage sont ignorées', async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://ok.example/${i}/live.m3u8`);
    const catalog = catalogOf(urls.map((u, i) => channel(`C${i}`, u)));
    const before: HealthMap = Object.fromEntries(urls.map((u) => [u, [0, 1] as [number, number]]));
    const result = await applyHealth(catalog, before, options(Object.fromEntries(urls.map((u) => [u, 'throw' as const])), 0));
    expect(result.tripped).toBe(true);
    expect(result.health[urls[0] as string]?.[0]).toBe(0); // l'échec de ce passage n'est pas compté
  });

  it('premier passage sans état et catalogue à 60 % mort : pas de disjoncteur, un échec compté par flux mort', async () => {
    const ok = Array.from({ length: 12 }, (_, i) => `https://ok.example/${i}/live.m3u8`);
    const dead = Array.from({ length: 18 }, (_, i) => `https://mort.example/${i}/live.m3u8`);
    const catalog = catalogOf([...ok, ...dead].map((u, i) => channel(`C${i}`, u)));
    const result = await applyHealth(catalog, undefined, options(Object.assign({}, ...ok.map((u) => live(u))), 0));
    expect(result.tripped).toBe(false);
    expect(result.health[dead[0] as string]?.[0]).toBe(1);
    expect(result.health[ok[0] as string]?.[0]).toBe(0);
  });

  it('pas de disjoncteur pour des flux déjà en échec ni pour des replis morts : le retrait suit son cours', async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://mort.example/${i}/live.m3u8`);
    const backups = urls.map((_, i) => `https://mort.example/${i}/repli.m3u8`);
    const catalog = catalogOf(urls.map((u, i) => channel(`C${i}`, u, [alt(backups[i] as string)])));
    const before: HealthMap = Object.fromEntries([...urls, ...backups].map((u) => [u, [2, 1] as [number, number]]));
    const result = await applyHealth(catalog, before, options({}, 0));
    expect(result.tripped).toBe(false);
    expect(result.removed).toBe(30); // principaux au 3e échec, replis morts : plus aucun flux
    expect(catalog.channels).toHaveLength(0);
  });

  it('les URL qui ne sont plus au catalogue sont oubliées', async () => {
    const catalog = catalogOf([channel('Bonne', GOOD)]);
    const result = await applyHealth(catalog, { [GOOD]: [0, 1], 'https://disparu.example/x.m3u8': [2, 1] }, { now: () => T0 });
    expect(Object.keys(result.health)).toEqual([GOOD]);
  });
});

describe('applyHealth : dernier succès et rapport de passage', () => {
  const T0 = 1_800_000_000_000;
  const HOUR = 3_600_000;
  const at = (hour: number): number => T0 + hour * HOUR;
  const sec = (hour: number): number => Math.floor(at(hour) / 1000);
  type Net = Record<string, Route | 'throw'>;

  const PAIR: [string, string][] = [
    ['Bonne', GOOD],
    ['Morte', BAD],
  ];
  /** Un passage sur un catalogue (par défaut Bonne et Morte), avec l'état du passage précédent. */
  function runner(net: () => Net) {
    let health: HealthMap | undefined;
    return async (hour: number, spec: [string, string][] = PAIR) => {
      const catalog = catalogOf(spec.map(([name, url]) => channel(name, url)));
      const result = await applyHealth(catalog, health, { fetch: fakeFetch(net()), now: () => at(hour), check: true });
      health = result.health;
      return { result, ids: catalog.channels.map((c) => c.id), health: result.health };
    };
  }

  it('(a) chaîne gardée aux 1er et 2e échecs, retirée au 3e et listée dans report.removed', async () => {
    const run = runner(() => live(GOOD));
    const first = await run(0);
    expect(first.ids).toEqual(['Bonne', 'Morte']);
    expect(first.result.report.removed).toEqual([]);
    const second = await run(6);
    expect(second.ids).toEqual(['Bonne', 'Morte']);
    const third = await run(12);
    expect(third.ids).toEqual(['Bonne']);
    expect(third.result.report).toEqual({
      at: at(12),
      checked: 2,
      tripped: false,
      removed: [{ id: 'Morte', name: 'Morte' }],
      restored: [],
    });
  });

  it('(b) un succès remet l’échec à 0 : la chaîne revient, figure dans restored, dernier succès à jour', async () => {
    let up: Net = live(GOOD);
    const run = runner(() => up);
    await run(0);
    await run(6);
    expect((await run(12)).result.report.removed).toEqual([{ id: 'Morte', name: 'Morte' }]);
    up = { ...live(GOOD), ...live(BAD) };
    const back = await run(18);
    expect(back.ids).toEqual(['Bonne', 'Morte']);
    expect(back.result.report).toMatchObject({ removed: [], restored: [{ id: 'Morte', name: 'Morte' }] });
    expect(back.health[BAD]).toEqual([0, sec(18), sec(18)]);
    expect(back.health[GOOD]).toEqual([0, sec(18), sec(18)]);
  });

  it('(b bis) un échec garde le dernier succès d’avant ; sans succès, pas de troisième valeur', async () => {
    let up: Net = live(GOOD);
    const run = runner(() => up);
    const first = await run(0);
    expect(first.health[GOOD]).toEqual([0, sec(0), sec(0)]);
    expect(first.health[BAD]).toEqual([1, sec(0)]); // jamais réussi : pas de troisième valeur
    up = { [GOOD]: () => new Response('panne', { status: 500 }) };
    const down = await run(6);
    expect(down.health[GOOD]).toEqual([1, sec(6), sec(0)]);
    expect(down.health[BAD]).toEqual([2, sec(6)]);
  });

  it('(c) refus 403 et 451 (géoblocage) : ni échec ni succès, le dernier succès ne bouge pas', async () => {
    let status = 200;
    const run = runner(() => (status === 200 ? live(GOOD) : { [GOOD]: () => new Response('non', { status }) }));
    expect((await run(0, [['Bonne', GOOD]])).health[GOOD]).toEqual([0, sec(0), sec(0)]);
    status = 403;
    expect((await run(6, [['Bonne', GOOD]])).health[GOOD]).toEqual([0, sec(6), sec(0)]);
    status = 451;
    const geo = await run(12, [['Bonne', GOOD]]);
    expect(geo.health[GOOD]).toEqual([0, sec(12), sec(0)]);
    expect(geo.result.report.removed).toEqual([]);
  });

  it('(c bis) un refus d’accès ne remet pas non plus un échec à zéro', async () => {
    let current: Net = {};
    const run = runner(() => current);
    const morte: [string, string][] = [['Morte', BAD]];
    await run(0, morte); // 404 : échec
    await run(6, morte); // 404 : échec
    current = { [BAD]: () => new Response('non', { status: 403 }) };
    const after = await run(12, morte);
    expect(after.health[BAD]).toEqual([2, sec(12)]);
    expect(after.ids).toEqual(['Morte']);
  });

  it('(d) entrées anciennes à 2 éléments acceptées : un succès ajoute le dernier succès, un échec reste à 2 éléments', async () => {
    const legacy: HealthMap = { [GOOD]: [0, sec(-6)], [BAD]: [2, sec(-6)] };
    const catalog = catalogOf([channel('Bonne', GOOD), channel('Morte', BAD)]);
    const result = await applyHealth(catalog, legacy, { fetch: fakeFetch(live(GOOD)), now: () => at(0), check: true });
    expect(result.health[GOOD]).toEqual([0, sec(0), sec(0)]);
    expect(result.health[BAD]).toEqual([3, sec(0)]);
    expect(result.report.removed).toEqual([{ id: 'Morte', name: 'Morte' }]);
    expect(catalog.channels.map((c) => c.id)).toEqual(['Bonne']);
  });

  it('rapport : tripped reflète le disjoncteur', async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://ok.example/${i}/live.m3u8`);
    const catalog = catalogOf(urls.map((u, i) => channel(`C${i}`, u)));
    const before: HealthMap = Object.fromEntries(urls.map((u) => [u, [0, 1] as [number, number]]));
    const net: Net = Object.fromEntries(urls.map((u) => [u, 'throw' as const]));
    const result = await applyHealth(catalog, before, { fetch: fakeFetch(net), now: () => at(0), check: true });
    expect(result.tripped).toBe(true);
    expect(result.report.tripped).toBe(true);
    expect(result.report.removed).toEqual([]);
  });
});
