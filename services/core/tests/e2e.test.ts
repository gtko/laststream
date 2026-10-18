import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { decodeConfig } from '../src/config/codec.js';
import type { AppDeps } from '../src/deps.js';
import { decodeCopiesToken } from '../src/play/token.js';

/*
 * Parcours complet : configuration (plain ou chiffrée), agrégation, filtre, dédoublonnage, tri,
 * cache debrid et formatage. Toutes les sources externes (upstream, Torznab, Cinemeta, AllDebrid)
 * passent par un fetch simulé injecté dans les dépendances : aucun appel réseau, aucune vraie clé.
 */

const GB = 1024 ** 3;
const SECRET = 'e2e-test-secret';
const AD_KEY = 'AD-E2E-KEY-9999-SECRET';
const TZ_KEY = 'TZ-E2E-KEY-4242-SECRET';
const BAD_KEY = 'TZ-BAD-KEY-0000-SECRET';
const CDN_URL = 'https://cdn.example.test/film-vostfr.mkv';
const UPSTREAM_URL = 'https://upstream.example.test';
const BROKEN_URL = 'https://broken.example.test';
const INDEXER_URL = 'https://indexer.example.test';
const BAD_INDEXER_URL = 'https://bad-indexer.example.test';

const H = {
  vff: 'a'.repeat(40),
  remux: 'b'.repeat(40),
  cam: 'd'.repeat(40),
  multiSmall: 'e'.repeat(40),
  multiBig: 'f'.repeat(40),
  series: '9'.repeat(40),
};
/** Hashes déjà en cache chez AllDebrid (ready). Les autres sont absents ou non prêts. */
const CACHED = new Set([H.vff, H.multiSmall]);

interface StreamOut {
  name?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  behaviorHints?: Record<string, unknown>;
  laststream?: {
    resolution: string;
    source: string;
    frVariant?: string;
    sizeBytes?: number;
    seeders?: number;
    cached: boolean;
    estBitrateKbps: number | null;
  };
}

interface StreamsBody {
  streams: StreamOut[];
}

interface Recorded {
  url: string;
  method: string;
  form: string;
}

const requests: Recorded[] = [];

/* ---------- Données simulées ---------- */

const UPSTREAM_MOVIE_STREAMS = [
  {
    name: 'Upstream\n1080p',
    title: 'Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP',
    description: 'Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP\n👤 120 💾 4.2 GB ⚙️ Upstream',
    infoHash: H.vff,
  },
  {
    name: 'Upstream\n2160p',
    title: 'Film.2024.MULTi.2160p.BluRay.REMUX.HEVC.TrueHD.Atmos-GRP',
    infoHash: H.remux,
    behaviorHints: { videoSize: 50 * GB },
  },
  { name: 'Upstream', title: 'Film.2024.1080p.BluRay.x264.VOSTFR-XYZ', url: CDN_URL },
  { name: 'Upstream', title: 'Film.2024.CAM.720p.x264-CAMRIP', infoHash: H.cam },
  {
    name: 'Upstream',
    title: 'Film.2024.MULTi.1080p.WEB-DL.x264-SMALL',
    description: 'Film\n👤 15 💾 2.5 GB',
    infoHash: H.multiSmall,
  },
];

const UPSTREAM_SERIES_STREAMS = [
  {
    name: 'Upstream\n1080p',
    title: 'Serie.S01E02.VFF.1080p.WEB-DL.H264-GRP',
    infoHash: H.series,
    behaviorHints: { videoSize: 1.5 * GB },
  },
];

function torznabItem(title: string, attrs: Record<string, string | number>, size?: number): string {
  const sizeTag = size === undefined ? '' : `<size>${size}</size>`;
  const attrTags = Object.entries(attrs)
    .map(([name, value]) => `<torznab:attr name="${name}" value="${value}"/>`)
    .join('');
  return `<item><title>${title}</title>${sizeTag}${attrTags}</item>`;
}

/** Résultats Torznab : le VFF duplique l'upstream, le CAM doit être exclu, le dernier n'a pas de hash. */
const TORZNAB_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${[
  torznabItem('Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP', { infohash: H.vff, seeders: 50 }, 4509715661),
  torznabItem('Film.2024.CAM.720p.x264-CAMRIP', { infohash: H.cam, seeders: 3 }, 1181116006),
  torznabItem('Film.2024.MULTi.1080p.WEB-DL.x264-BIG', { infohash: H.multiBig, seeders: 20 }, 3865470566),
  '<item><title>Film.2024.MULTi.1080p.HDTV</title></item>',
].join('')}</channel></rss>`;

/* ---------- Faux fetch ---------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

function upstreamRoute(pathname: string): Response {
  const path = decodeURIComponent(pathname);
  if (path === '/manifest.json') return jsonResponse({ id: 'upstream.test', resources: ['stream'] });
  if (path.startsWith('/stream/movie/')) return jsonResponse({ streams: UPSTREAM_MOVIE_STREAMS });
  if (path.startsWith('/stream/series/')) return jsonResponse({ streams: UPSTREAM_SERIES_STREAMS });
  return jsonResponse({}, 404);
}

function cinemetaRoute(pathname: string): Response {
  if (pathname === '/meta/movie/tt1234567.json') return jsonResponse({ meta: { runtime: '120 min' } });
  if (pathname === '/meta/series/tt7654321.json') {
    return jsonResponse({
      meta: {
        runtime: '45 min',
        videos: [
          { season: 1, episode: 1, runtime: '40 min' },
          { season: 1, episode: 2, runtime: '52 min' },
        ],
      },
    });
  }
  // tt7000001 : Cinemeta en erreur, la durée reste inconnue.
  return jsonResponse({}, 500);
}

function torznabRoute(url: URL): Response {
  if (url.searchParams.get('t') === 'caps') return xmlResponse('<?xml version="1.0"?><caps><server title="Fake"/></caps>');
  return xmlResponse(TORZNAB_RSS);
}

function alldebridRoute(pathname: string, form: URLSearchParams | undefined): Response {
  if (pathname === '/v4/user') return jsonResponse({ status: 'success', data: { user: { isPremium: true } } });
  if (pathname === '/v4/magnet/upload') {
    const magnets = (form?.getAll('magnets[]') ?? []).map((hash, index) => ({
      magnet: `magnet:?xt=urn:btih:${hash}`,
      hash,
      name: 'x',
      size: 1,
      ready: CACHED.has(hash),
      id: index + 1,
    }));
    return jsonResponse({ status: 'success', data: { magnets } });
  }
  if (pathname === '/v4/magnet/delete') return jsonResponse({ status: 'success', data: {} });
  // Compte vide : aucun magnet préexistant, donc les magnets non prêts du contrôle peuvent être supprimés.
  if (pathname === '/v4.1/magnet/status') return jsonResponse({ status: 'success', data: { magnets: [] } });
  return jsonResponse({ status: 'error', error: { code: 'NOT_FOUND', message: 'x' } }, 404);
}

function route(url: URL, form: URLSearchParams | undefined): Response {
  switch (url.hostname) {
    case 'upstream.example.test':
      return upstreamRoute(url.pathname);
    case 'broken.example.test':
      return jsonResponse({}, 500);
    case 'v3-cinemeta.strem.io':
      return cinemetaRoute(url.pathname);
    case 'indexer.example.test':
      return torznabRoute(url);
    case 'bad-indexer.example.test':
      return xmlResponse(`<error code="100" description="Incorrect user credentials for ${BAD_KEY}"/>`);
    case 'api.alldebrid.com':
      return alldebridRoute(url.pathname, form);
    default:
      return jsonResponse({}, 404);
  }
}

/** fetch simulé : journalise chaque appel sortant et répond selon l'hôte. */
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const form = init?.body instanceof URLSearchParams ? init.body : undefined;
  requests.push({ url: url.toString(), method: init?.method ?? 'GET', form: form?.toString() ?? '' });
  return route(url, form);
};

/* ---------- Démarrage et helpers ---------- */

interface Running {
  baseUrl: string;
  close: () => Promise<void>;
}

async function start(deps: AppDeps): Promise<Running> {
  const server: Server = createApp(deps).listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Configuration en JSON brut encodé en base64url (accepté seulement avec allowPlain). */
const plain = (config: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');

const TZ_SOURCE = { type: 'torznab', name: 'Indexeur', baseUrl: INDEXER_URL, apiKey: TZ_KEY };
const UPSTREAM_SOURCE = { type: 'upstream', name: 'Upstream', url: UPSTREAM_URL };
const PLAIN_CONFIG = { sources: [UPSTREAM_SOURCE, TZ_SOURCE] };
const DEBRID = { service: 'alldebrid', apiKey: AD_KEY };
const DEBRID_CONFIG = { sources: [UPSTREAM_SOURCE, TZ_SOURCE], debrid: DEBRID };
const DEBRID_ONLY_CACHED = { ...DEBRID_CONFIG, onlyCached: true };
const SERIES_DEBRID_CONFIG = { sources: [UPSTREAM_SOURCE], debrid: DEBRID };

/** Clé ou URL affichée pour identifier un stream dans les assertions d'ordre. */
const idOf = (stream: StreamOut): string => stream.url ?? stream.infoHash ?? '?';

const PLAY_PREFIX = '/play/c/';

/** Copies portées par le jeton d'une URL /play/c/ (décodé avec le secret du test). Undefined pour une autre URL. */
function copiesOf(stream: StreamOut): ReturnType<typeof decodeCopiesToken> {
  const at = stream.url?.indexOf(PLAY_PREFIX) ?? -1;
  if (at < 0 || stream.url === undefined) return null;
  return decodeCopiesToken(stream.url.slice(at + PLAY_PREFIX.length), SECRET);
}

/** Hash de la première copie d'un stream lu par /play/c/, sinon son URL : sert aux assertions d'ordre. */
const playedKey = (stream: StreamOut): string =>
  copiesOf(stream)?.copies[0]?.infoHash ?? idOf(stream);

let main: Running;

beforeAll(async () => {
  main = await start({ secret: SECRET, allowPlain: true, fetch: fakeFetch as unknown as typeof fetch });
});

afterAll(async () => {
  await main.close();
});

beforeEach(() => {
  requests.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function streamsFor(
  config: string,
  id: string,
  type = 'movie',
  headers: Record<string, string> = {},
): Promise<StreamsBody> {
  const res = await fetch(`${main.baseUrl}/${config}/stream/${type}/${id}.json`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as StreamsBody;
}

function uploadsSent(): string[] {
  return requests
    .filter((r) => r.url.includes('/v4/magnet/upload'))
    .flatMap((r) => new URLSearchParams(r.form).getAll('magnets[]'));
}

/* ---------- Tests ---------- */

describe('agrégation : filtre, dédoublonnage et tri', () => {
  it('exclut le CAM, fusionne le doublon Torznab et trie langue > résolution > source > taille', async () => {
    const { streams } = await streamsFor(plain(PLAIN_CONFIG), 'tt1234567');

    expect(streams.map(idOf)).toEqual([H.vff, H.remux, H.multiSmall, H.multiBig, CDN_URL]);
    expect(streams.filter((s) => s.infoHash === H.vff)).toHaveLength(1);
    expect(streams.some((s) => s.infoHash === H.cam)).toBe(false);
  });

  it('renvoie les streams des sources saines quand une source est en erreur', async () => {
    const broken = plain({
      sources: [{ type: 'upstream', name: 'Cassé', url: BROKEN_URL }, TZ_SOURCE],
    });
    const { streams } = await streamsFor(broken, 'tt1234567');

    expect(streams.map(idOf)).toEqual([H.vff, H.multiBig]);
  });
});

describe('forme des streams Stremio', () => {
  it('stream P2P : nom, description détaillée (débit réel, langue annoncée, seeders), bingeGroup et infoHash sans url', async () => {
    const { streams } = await streamsFor(plain(PLAIN_CONFIG), 'tt1234567');
    const vff = streams[0];

    expect(vff?.name).toBe('lastAddon 1080p');
    // Débit réel : 4,2 Go sur 120 min, soit environ 5 Mb/s ; la langue VFF est annoncée, pas vérifiée (« ? »).
    expect(vff?.description).toBe(
      'WEB-DL • 📶 5 Mb/s 🇫🇷? • 💾 4,2 Go • 🌱 120 seeders\n🎧 AVC • 5.1 DDP • GRP\n🗂️ Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP',
    );
    expect(vff?.laststream).toMatchObject({ bitrateMbps: 5, copies: 1, verifiedLanguages: [], indexers: [] });
    expect(vff?.behaviorHints?.bingeGroup).toBe('lastaddon|1080p|vff|WEB-DL');
    expect(vff?.infoHash).toBe(H.vff);
    expect(vff?.url).toBeUndefined();
    expect(vff?.fileIdx).toBeUndefined();
  });

  it('le champ laststream porte estBitrateKbps quand la durée Cinemeta est connue, null sinon', async () => {
    const { streams } = await streamsFor(plain(PLAIN_CONFIG), 'tt1234567');
    const vff = streams[0]?.laststream;
    // 4,2 Go sur 120 min : environ 5 Mb/s.
    expect(vff?.estBitrateKbps).toBeGreaterThan(4900);
    expect(vff?.estBitrateKbps).toBeLessThan(5100);
    expect(vff).toMatchObject({ resolution: '1080p', source: 'WEB-DL', frVariant: 'VFF', seeders: 120, cached: false });

    const unknown = await streamsFor(plain(PLAIN_CONFIG), 'tt7000001');
    expect(unknown.streams.every((s) => s.laststream?.estBitrateKbps === null)).toBe(true);
  });

  it('applique le cache de Cache-Control max-age=60 sur la réponse', async () => {
    const res = await fetch(`${main.baseUrl}/${plain(PLAIN_CONFIG)}/stream/movie/tt1234567.json`);
    expect(res.headers.get('cache-control')).toBe('max-age=60');
  });
});

describe('debrid AllDebrid (cache simulé)', () => {
  it('fait passer chaque stream hashé par /play, marque le cache et interroge un seul lot', async () => {
    const { streams } = await streamsFor(plain(DEBRID_CONFIG), 'tt1234567');
    const token = plain(DEBRID_CONFIG);

    const vff = streams.find((s) => s.laststream?.cached === true);
    expect(vff?.url?.startsWith(`${main.baseUrl}/${token}/play/c/`)).toBe(true);
    expect(copiesOf(vff ?? {})?.copies).toEqual([{ infoHash: H.vff }]);
    expect(vff?.name).toBe('[AD⚡] lastAddon 1080p');
    const remux = streams.find((s) => copiesOf(s)?.copies[0]?.infoHash === H.remux);
    expect(remux?.laststream?.cached).toBe(false);
    expect(remux?.name).toBe('[AD⏳] lastAddon 4K');
    expect(streams.find((s) => s.url === CDN_URL)).toBeDefined();

    // Le CAM est exclu avant l'interrogation : son hash n'est jamais envoyé au débrideur.
    const sent = new Set(uploadsSent());
    expect(sent).toEqual(new Set([H.vff, H.remux, H.multiSmall, H.multiBig]));
    expect(sent.has(H.cam)).toBe(false);

    // Second appel : le cache du client évite toute nouvelle interrogation.
    requests.length = 0;
    await streamsFor(plain(DEBRID_CONFIG), 'tt1234567');
    expect(uploadsSent()).toHaveLength(0);
  });

  it('onlyCached ne garde que les streams cachés et les URL directes', async () => {
    const { streams } = await streamsFor(plain(DEBRID_ONLY_CACHED), 'tt1234567');
    const token = plain(DEBRID_ONLY_CACHED);

    expect(streams.map(playedKey)).toEqual([H.vff, H.multiSmall, CDN_URL]);
    expect(streams.slice(0, 2).every((s) => s.url?.startsWith(`${main.baseUrl}/${token}/play/c/`))).toBe(true);
  });

  it('série : identifiant tt:S:E, jeton portant saison et épisode, durée de l’épisode', async () => {
    const token = plain(SERIES_DEBRID_CONFIG);
    const { streams } = await streamsFor(token, 'tt7654321%3A1%3A2', 'series');

    expect(streams).toHaveLength(1);
    expect(streams[0]?.url?.startsWith(`${main.baseUrl}/${token}/play/c/`)).toBe(true);
    expect(copiesOf(streams[0] ?? {})).toMatchObject({ copies: [{ infoHash: H.series }], season: 1, episode: 2 });
    expect(streams[0]?.laststream?.estBitrateKbps).toBe(Math.round((1.5 * GB * 8) / 3120 / 1000));
    expect(requests.some((r) => r.url.endsWith('/stream/series/tt7654321:1:2.json'))).toBe(true);
  });

  it('LASTADDON_PUBLIC_URL prime sur les en-têtes X-Forwarded-*', async () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', 'https://addon.example.test/');
    const token = plain(DEBRID_CONFIG);
    const { streams } = await streamsFor(token, 'tt1234567', 'movie', {
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'evil.example.test',
    });

    const url = streams.find((s) => s.laststream?.cached === true)?.url ?? '';
    expect(url.startsWith(`https://addon.example.test/${token}/play/c/`)).toBe(true);
    expect(copiesOf({ url })?.copies).toEqual([{ infoHash: H.vff }]);
  });

  it('avec LASTADDON_TRUST_PROXY=1, X-Forwarded-Proto et X-Forwarded-Host sont respectés', async () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    vi.stubEnv('LASTADDON_TRUST_PROXY', '1');
    const token = plain(DEBRID_CONFIG);
    const { streams } = await streamsFor(token, 'tt1234567', 'movie', {
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'public.example.test',
    });

    const url = streams.find((s) => s.laststream?.cached === true)?.url ?? '';
    expect(url.startsWith(`https://public.example.test/${token}/play/c/`)).toBe(true);
    expect(copiesOf({ url })?.copies).toEqual([{ infoHash: H.vff }]);
  });

  it('sans LASTADDON_TRUST_PROXY, X-Forwarded-* sont ignorés (hôte de la requête)', async () => {
    vi.stubEnv('LASTADDON_PUBLIC_URL', '');
    vi.stubEnv('LASTADDON_TRUST_PROXY', '');
    const token = plain(DEBRID_CONFIG);
    const { streams } = await streamsFor(token, 'tt1234567', 'movie', {
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'public.example.test',
    });

    const url = streams.find((s) => s.laststream?.cached === true)?.url ?? '';
    expect(url).not.toContain('public.example.test');
    expect(url.startsWith('http://')).toBe(true);
  });
});

describe('entrées invalides', () => {
  it('configuration invalide : 400 sans écho du contenu', async () => {
    const garbage = await fetch(`${main.baseUrl}/AAAA/stream/movie/tt1234567.json`);
    expect(garbage.status).toBe(400);
    expect(await garbage.text()).toBe('{"error":"invalid_config"}');

    const invalid = await fetch(`${main.baseUrl}/${plain({ maxResults: 0 })}/stream/movie/tt1234567.json`);
    expect(invalid.status).toBe(400);
    const body = await invalid.text();
    expect(body).toBe('{"error":"invalid_config"}');
    expect(body).not.toContain('maxResults');
  });

  it('type ou identifiant hors format : liste vide, sans appel aux sources', async () => {
    const token = plain(PLAIN_CONFIG);
    for (const [type, id] of [
      ['series', 'tt1234567'],
      ['tv', 'tt1234567'],
      ['movie', '12345'],
    ] as const) {
      const { streams } = await streamsFor(token, id, type);
      expect(streams).toEqual([]);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('POST /config/test et chiffrement', () => {
  it('renvoie un statut par source, sans jamais renvoyer une clé API', async () => {
    const body = {
      sources: [
        UPSTREAM_SOURCE,
        TZ_SOURCE,
        { type: 'torznab', name: 'Indexeur KO', baseUrl: BAD_INDEXER_URL, apiKey: BAD_KEY },
        { type: 'upstream', name: 'Cassé', url: BROKEN_URL },
      ],
      debrid: DEBRID,
    };
    const res = await fetch(`${main.baseUrl}/config/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(AD_KEY);
    expect(text).not.toContain(TZ_KEY);
    expect(text).not.toContain(BAD_KEY);

    const { sources } = JSON.parse(text) as {
      sources: Array<{ name: string; type: string; ok: boolean; error?: string }>;
    };
    const byName = (name: string) => sources.find((s) => s.name === name);
    expect(byName('Upstream')).toEqual({ name: 'Upstream', type: 'upstream', ok: true, manifest: { types: [], hasStream: true } });
    expect(byName('Indexeur')).toEqual({ name: 'Indexeur', type: 'torznab', ok: true });
    expect(byName('Indexeur KO')?.ok).toBe(false);
    expect(byName('Indexeur KO')?.error).toContain('***');
    expect(byName('Cassé')).toEqual({ name: 'Cassé', type: 'upstream', ok: false, error: 'Source "Cassé" : HTTP 500' });
    expect(byName('AllDebrid')).toEqual({ name: 'AllDebrid', type: 'alldebrid', ok: true });
  });

  it('POST /config/encode puis stream : la configuration chiffrée fait un aller-retour', async () => {
    const res = await fetch(`${main.baseUrl}/config/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(DEBRID_CONFIG),
    });
    expect(res.status).toBe(200);
    const { config: token } = (await res.json()) as { config: string };

    expect(token).not.toContain(AD_KEY);
    expect(decodeConfig(token, SECRET, { allowPlain: false }).debrid?.apiKey).toBe(AD_KEY);

    const { streams } = await streamsFor(token, 'tt1234567');
    expect(streams.map(playedKey)).toContain(H.vff);
    expect(streams.map(idOf)).toContain(CDN_URL);
  });
});

describe('journalisation', () => {
  it('aucune sortie console ne contient de clé API ni de configuration', async () => {
    const logged: unknown[][] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args)),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void logged.push(args)),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args)),
      vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => void logged.push(args)),
    ];
    try {
      await streamsFor(plain(DEBRID_CONFIG), 'tt1234567');
      await streamsFor(plain({ sources: [{ type: 'upstream', name: 'Cassé', url: BROKEN_URL }, TZ_SOURCE] }), 'tt1234567');
      await fetch(`${main.baseUrl}/AAAA/stream/movie/tt1234567.json`);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    const output = JSON.stringify(logged);
    expect(output).not.toContain(AD_KEY);
    expect(output).not.toContain(TZ_KEY);
    expect(output).not.toContain(plain(DEBRID_CONFIG));
  });
});
