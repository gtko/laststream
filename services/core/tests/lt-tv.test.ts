import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUrlSigner } from '../src/lt/signing.js';
import { fakeLookup, fullToken, json, mockUpstream, postJson, SECRET, startApp, text, tokenFor, type MockUpstream, type RunningApp } from './lt-harness.js';

const FREETV = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';
const API = 'https://iptv-org.github.io/api/';
const PLUTO = 'https://i.mjh.nz/PlutoTV/.channels.json';
const SAMSUNG = 'https://i.mjh.nz/SamsungTVPlus/.channels.json';
const EPG_TNT = 'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz';

const now = Math.floor(Date.now() / 1000);
/** Horodatage XMLTV (AAAAMMJJHHMMSS +0000) pour un instant Unix. */
const xmltv = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

/** Playlist Free-TV : TF1 (même identifiant EPG qu'iptv-org), chaînes géo-bloquées, adulte, chaîne sans iptv-org. */
const FREETV_BODY = [
  '#EXTM3U x-tvg-url="https://epg.example/x.xml.gz"',
  '#EXTINF:-1 tvg-id="TF1.fr" tvg-logo="https://logo.freetv.example/tf1.png" tvg-country="FR" group-title="France",TF1 Ⓢ',
  'https://stream.tf1.example/tf1.m3u8',
  '#EXTINF:-1 tvg-id="Adult.xx" tvg-country="XX" group-title="XXX",Adult Channel',
  'https://stream.adult.example/a.m3u8',
  '#EXTINF:-1 tvg-id="Sport.fr" tvg-country="FR" group-title="Sport",Sport Geo Ⓖ',
  'https://rebind.example.fr/sport.m3u8',
  '#EXTINF:-1 tvg-id="BFMTV.fr" tvg-country="FR" group-title="News",BFM TV',
  'https://bfm.example.fr/bfm.m3u8',
].join('\n');

const CHANNELS = [
  { id: 'TF1.fr', name: 'TF1', country: 'FR', categories: ['general'], is_nsfw: false, closed: null, alt_names: [] },
  { id: 'Adult.xx', name: 'Adult Channel', country: 'XX', categories: ['xxx'], is_nsfw: true, closed: null, alt_names: [] },
  { id: 'Closed.fr', name: 'Ancienne Chaîne', country: 'FR', categories: ['news'], is_nsfw: false, closed: '2020-01-01', alt_names: [] },
  { id: 'Euronews.fr', name: 'Euronews', country: 'FR', categories: ['news'], is_nsfw: false, closed: null, alt_names: ['Euro News'] },
  { id: 'Blocked.fr', name: 'Bloquée', country: 'FR', categories: ['entertainment'], is_nsfw: false, closed: null, alt_names: [] },
  { id: 'Kids.de', name: 'KiKA', country: 'DE', categories: ['kids'], is_nsfw: false, closed: null, alt_names: [] },
  { id: 'Multi.de', name: 'Multi', country: 'DE', categories: ['music'], is_nsfw: false, closed: null, alt_names: [] },
  { id: 'NoStream.fr', name: 'Sans flux', country: 'FR', categories: [], is_nsfw: false, closed: null, alt_names: [] },
];

const STREAMS = [
  { channel: 'TF1.fr', feed: 'SD', url: 'https://stream.iptv.example/tf1.m3u8', quality: '720p', labels: [] },
  { channel: 'Adult.xx', feed: 'SD', url: 'https://stream.adult.example/x.m3u8', quality: '720p', labels: [] },
  { channel: 'Closed.fr', feed: 'SD', url: 'https://closed.example/c.m3u8', quality: '720p', labels: [] },
  { channel: 'Euronews.fr', feed: 'SD', url: 'https://euro.example/sd.m3u8', quality: '720p', labels: [] },
  { channel: 'Blocked.fr', feed: 'SD', url: 'https://blocked.example/b.m3u8', quality: '720p', labels: [] },
  { channel: 'Kids.de', feed: 'SD', url: 'https://kika.example/k.m3u8', quality: '576p', labels: ['Not 24/7'] },
  { channel: 'Multi.de', feed: 'SD', url: 'https://multi.example/sd.m3u8', quality: '480p', labels: [] },
  { channel: 'Multi.de', feed: 'HD', url: 'https://multi.example/hd.m3u8', quality: '1080p', labels: [] },
  { channel: 'Inconnue.fr', feed: 'SD', url: 'https://ghost.example/g.m3u8', quality: '720p', labels: [] },
];

const FEEDS = [
  { channel: 'TF1.fr', id: 'SD', languages: ['fra'] },
  { channel: 'Euronews.fr', id: 'SD', languages: ['eng', 'fra'] },
  { channel: 'Kids.de', id: 'SD', languages: ['deu'] },
  { channel: 'Multi.de', id: 'SD', languages: ['deu'] },
  { channel: 'Multi.de', id: 'HD', languages: ['deu'] },
];

const EPG_XML = `<?xml version="1.0"?><tv>
  <programme start="${xmltv(now - 1800)}" stop="${xmltv(now + 1800)}" channel="TF1.fr">
    <title lang="fr">Journal &amp; météo</title><desc>Infos du soir</desc><category>News</category>
  </programme>
</tv>`;

/** Upstream simulé. `freetvStatus` permet de simuler une panne de la playlist Free-TV. */
function upstreamWith(freetvStatus = 200): MockUpstream {
  return mockUpstream({
    [FREETV]: () => (freetvStatus === 200 ? text(FREETV_BODY, 200, 'audio/x-mpegurl') : text('erreur', freetvStatus)),
    [`${API}channels.json`]: () => json(CHANNELS),
    [`${API}streams.json`]: () => json(STREAMS),
    [`${API}feeds.json`]: () => json(FEEDS),
    [`${API}logos.json`]: () => json([{ channel: 'TF1.fr', feed: null, in_use: true, url: 'https://logo.iptv.example/tf1.png' }]),
    [`${API}countries.json`]: () =>
      json([
        { name: 'France', code: 'FR', languages: ['fra'], flag: '🇫🇷' },
        { name: 'Germany', code: 'DE', languages: ['deu'], flag: '🇩🇪' },
      ]),
    [`${API}languages.json`]: () => json([{ code: 'fra', name: 'French' }, { code: 'deu', name: 'German' }, { code: 'eng', name: 'English' }]),
    [`${API}blocklist.json`]: () => json([{ channel: 'Blocked.fr', reason: 'dmca', ref: 'https://github.com/iptv-org/iptv/issues/1' }]),
    [PLUTO]: () =>
      json({
        regions: {
          fr: {
            channels: {
              abc: { name: 'Pluto Ciné', group: 'Movies', logo: '' },
              tf1: { name: 'TF1', group: 'General', logo: '' },
            },
          },
        },
      }),
    [SAMSUNG]: () => json({ regions: { fr: { channels: {} } } }),
    [EPG_TNT]: () => text(gzipSync(Buffer.from(EPG_XML)), 200, 'application/gzip'),
    'https://iptv-epg.org/files/epg-fr.xml.gz': () => text('erreur', 500),
    'https://i.mjh.nz/PlutoTV/fr.xml.gz': () => text('erreur', 500),
    'https://i.mjh.nz/SamsungTVPlus/fr.xml.gz': () => text('erreur', 500),
    'https://stream.tf1.example/tf1.m3u8': () =>
      text(
        ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000', 'variant/index.m3u8', '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/fr.m3u8"'].join('\n'),
        200,
        'application/vnd.apple.mpegurl',
      ),
    'https://stream.tf1.example/notplaylist.m3u8': () => text('pas une playlist'),
    'https://rebind.example.fr/sport.m3u8': () => text('#EXTM3U\n#EXTINF:10,\nseg.ts'),
    'https://lists.example.org/p.m3u': () =>
      text(
        [
          '#EXTM3U',
          '#EXTINF:-1 tvg-id="Canal1.fr" tvg-logo="https://l.example/x.png" group-title="Ma liste",Canal Un',
          'https://cdn.lists.example.org/c1.m3u8',
          '#EXTINF:-1 group-title="X",Local',
          'http://127.0.0.1/local.m3u8',
        ].join('\n'),
      ),
    'https://cdn.lists.example.org/c1.m3u8': () => text('#EXTM3U\n#EXTINF:10,\nseg.ts'),
    'http://iptv.example.org/player_api.php': (call) => {
      const action = call.url.searchParams.get('action');
      if (action === 'get_live_categories') return json([{ category_id: '1', category_name: 'Sport' }]);
      return json([
        { stream_id: 101, name: 'Eurosport', category_id: '1', stream_icon: '', epg_channel_id: 'eurosport.fr' },
        { stream_id: 102, name: 'Cinéma X', category_id: '9', stream_icon: '' },
      ]);
    },
    'http://refus.example.org/player_api.php': (call) =>
      call.url.searchParams.get('action') === 'get_live_categories' ? json([]) : json({ user_info: { auth: 0 } }),
  });
}

let upstream: MockUpstream;
let app: RunningApp;
let token: string;

beforeAll(async () => {
  upstream = upstreamWith();
  app = await startApp({
    fetch: upstream.fetch,
    lookupHost: fakeLookup({ 'rebind.example.fr': '10.0.0.5', 'evil.example.org': '127.0.0.1' }),
  });
  token = fullToken();
});

afterAll(async () => {
  await app.close();
});

const get = (path: string): Promise<Response> => fetch(`${app.baseUrl}/${token}/lt/${path}`);
const signer = createUrlSigner(SECRET);
/** Requête du proxy HLS signée pour la configuration de test. */
const hlsPath = (url: string, sig: string | null = signer.sign(token, url)): string =>
  `tv/hls?u=${encodeURIComponent(url)}${sig === null ? '' : `&s=${sig}`}`;

type Channel = {
  id: string;
  name: string;
  cat: string;
  source: string;
  flaky: boolean;
  url: string;
  epgId: string;
  country: string;
  countryName: string;
  languages: { code: string; name: string }[];
  categories: { id: string; label: string }[];
  quality: string;
  reliability: 'high' | 'low';
  alternatives: { url: string; source: string; quality: string; reliability: string; sig: string | null }[];
  sig: string | null;
};
const channelsOf = async (query = ''): Promise<Channel[]> => (await (await get(`tv/channels${query}`)).json()) as Channel[];

describe('lt/tv/channels', () => {
  it('fusionne Free-TV et iptv-org : Free-TV en tête, iptv-org et FAST en solutions de repli', async () => {
    const tf1 = (await channelsOf()).find((c) => c.id === 'fr:TF1.fr');
    expect(tf1).toMatchObject({
      name: 'TF1',
      source: 'freetv',
      url: 'https://stream.tf1.example/tf1.m3u8',
      quality: 'SD',
      reliability: 'high',
      flaky: false,
      country: 'FR',
      countryName: 'France',
      cat: 'Généraliste',
      epgId: 'TF1.fr',
      logo: 'https://logo.iptv.example/tf1.png',
      languages: [{ code: 'fra', name: 'français' }],
      categories: [{ id: 'generaliste', label: 'Généraliste' }],
    });
    expect(tf1?.alternatives.map((a) => [a.source, a.url])).toEqual([
      ['iptvorg', 'https://stream.iptv.example/tf1.m3u8'],
      ['pluto', 'https://jmp2.uk/plu-tf1.m3u8'],
    ]);
    expect(tf1?.alternatives.every((a) => typeof a.sig === 'string' && a.sig !== '')).toBe(true);
    expect(tf1?.sig).toBe(signer.sign(token, 'https://stream.tf1.example/tf1.m3u8'));
  });

  it('exclut chaînes adultes, fermées, sur liste de blocage, sans flux ; chaînes Free-TV adultes exclues', async () => {
    const names = (await channelsOf()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['TF1', 'Sport Geo', 'BFM TV', 'Euronews', 'KiKA', 'Multi', 'Pluto Ciné']));
    for (const excluded of ['Adult Channel', 'Ancienne Chaîne', 'Bloquée', 'Sans flux', 'Inconnue']) expect(names).not.toContain(excluded);
  });

  it('géo-bloqué (Ⓖ) et « Not 24/7 » : fiabilité basse, rangées après les flux fiables', async () => {
    const list = await channelsOf();
    expect(list.find((c) => c.name === 'Sport Geo')).toMatchObject({ cat: 'Sport', flaky: true, reliability: 'low', country: 'FR' });
    expect(list.find((c) => c.name === 'KiKA')).toMatchObject({
      flaky: true,
      reliability: 'low',
      cat: 'Jeunesse',
      countryName: 'Allemagne',
      languages: [{ code: 'deu', name: 'allemand' }],
    });
  });

  it('plusieurs flux iptv-org : meilleure qualité en tête, autres en solution de repli', async () => {
    const multi = (await channelsOf()).find((c) => c.name === 'Multi');
    expect(multi?.url).toBe('https://multi.example/hd.m3u8');
    expect(multi?.alternatives.map((a) => a.url)).toEqual(['https://multi.example/sd.m3u8']);
  });

  it('langues : jointure streams → feeds ; noms français ; chaîne sans feed : langue du pays', async () => {
    const list = await channelsOf();
    expect(list.find((c) => c.name === 'Euronews')?.languages).toEqual([
      { code: 'eng', name: 'anglais' },
      { code: 'fra', name: 'français' },
    ]);
    expect(list.find((c) => c.name === 'BFM TV')?.languages).toEqual([{ code: 'fra', name: 'français' }]);
  });

  it('catégories libellées en français ; chaîne Free-TV sans catégorie iptv-org classée par mots-clés', async () => {
    const list = await channelsOf();
    expect(list.find((c) => c.name === 'BFM TV')).toMatchObject({ cat: 'Actualités', source: 'freetv' });
    expect(list.find((c) => c.name === 'Pluto Ciné')).toMatchObject({ source: 'pluto', fast: true, cat: 'Cinéma' });
  });

  it('dédoublonnage FAST par nom normalisé : TF1 Pluto n est pas une chaîne distincte', async () => {
    const tf1s = (await channelsOf()).filter((c) => c.name === 'TF1');
    expect(tf1s).toHaveLength(1);
  });

  it('charge chaque source une seule fois (cache 12 h)', async () => {
    await get('tv/channels');
    await get('tv/channels');
    expect(upstream.callsTo(FREETV).length).toBe(1);
    expect(upstream.callsTo(`${API}channels.json`).length).toBe(1);
  });

  it('filtre par pays, langue, catégorie, source et recherche', async () => {
    expect((await channelsOf('?country=de')).map((c) => c.name).sort()).toEqual(['KiKA', 'Multi']);
    expect((await channelsOf('?language=deu')).map((c) => c.name).sort()).toEqual(['KiKA', 'Multi']);
    expect((await channelsOf('?category=sport')).map((c) => c.name)).toEqual(['Sport Geo']);
    expect((await channelsOf('?source=pluto')).map((c) => c.name)).toEqual(['Pluto Ciné']);
    expect((await channelsOf('?q=euro%20news')).map((c) => c.name)).toEqual(['Euronews']);
    expect((await channelsOf('?q=ctl')).map((c) => c.name)).toEqual([]);
  });

  it('paramètres invalides : 400 bad_request', async () => {
    for (const query of ['?country=FRA', '?language=fr', '?category=inconnue', '?source=ftp', '?page=0', '?limit=501', '?limit=abc']) {
      const res = await get(`tv/channels${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('pagination : sans paramètre, tableau complet ; avec limit ou page, enveloppe avec le total', async () => {
    const all = await channelsOf();
    const paged = (await (await get('tv/channels?limit=2&page=2')).json()) as { total: number; page: number; limit: number; channels: Channel[] };
    expect(paged.total).toBe(all.length);
    expect(paged).toMatchObject({ page: 2, limit: 2 });
    expect(paged.channels.map((c) => c.id)).toEqual(all.slice(2, 4).map((c) => c.id));
    const first = (await (await get('tv/channels?page=1')).json()) as { limit: number; channels: unknown[] };
    expect(first.limit).toBe(100);
    expect(Array.isArray(first.channels)).toBe(true);
  });
});

describe('lt/tv/facets', () => {
  it('compte les chaînes par pays, langue, catégorie et source', async () => {
    const res = await get('tv/facets');
    expect(res.status).toBe(200);
    const facets = (await res.json()) as {
      total: number;
      countries: { code: string; name: string; count: number }[];
      languages: { code: string; count: number }[];
      categories: { code: string; count: number }[];
      sources: { code: string; count: number }[];
    };
    expect(facets.total).toBe(7);
    expect(facets.countries.find((c) => c.code === 'FR')).toMatchObject({ name: 'France', count: 5 });
    expect(facets.countries.find((c) => c.code === 'DE')).toMatchObject({ count: 2 });
    expect(facets.languages.find((l) => l.code === 'fra')?.count).toBe(5);
    expect(facets.sources.map((s) => [s.code, s.count])).toEqual(
      expect.arrayContaining([
        ['freetv', 3],
        ['iptvorg', 3],
        ['pluto', 1],
      ]),
    );
  });
});

describe('lt/tv/stats', () => {
  it('compte les chaînes par source, la fiabilité et la couverture EPG', async () => {
    const res = await get('tv/stats');
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      counts: Record<string, number>;
      reliability: Record<string, number>;
      total: number;
      epgCoverage: number;
      epgStats: { url: string; programmes: number; ok: boolean }[];
    };
    expect(stats.counts).toEqual({ freetv: 3, iptvorg: 3, pluto: 1, samsung: 0 });
    expect(stats.reliability).toEqual({ high: 5, low: 2 });
    expect(stats.total).toBe(7);
    expect(stats.epgCoverage).toBe(14);
    expect(stats.epgStats.map((s) => [s.url, s.ok, s.programmes])).toEqual([
      ['xmltvfr.fr/xmltv/xmltv_tnt.xml.gz', true, 1],
      ['iptv-epg.org/files/epg-fr.xml.gz', false, 0],
      ['i.mjh.nz/PlutoTV/fr.xml.gz', false, 0],
      ['i.mjh.nz/SamsungTVPlus/fr.xml.gz', false, 0],
    ]);
  });
});

describe('lt/tv/epg', () => {
  it('renvoie les programmes décodés (entités XML) pour un id de chaîne ou un id EPG', async () => {
    const from = now - 3600;
    const to = now + 3600;
    const res = await get(`tv/epg?ids=fr:TF1.fr,TF1.fr,inconnue&from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { channelId: string; title: string; desc: string; category: string }[];
    expect(list.map((p) => p.channelId)).toEqual(['fr:TF1.fr', 'TF1.fr']);
    expect(list[0]).toMatchObject({ title: 'Journal & météo', desc: 'Infos du soir', category: 'News' });
  });

  it('exclut les programmes hors fenêtre', async () => {
    const res = await get(`tv/epg?ids=fr:TF1.fr&from=${now + 7200}&to=${now + 9000}`);
    expect(await res.json()).toEqual([]);
  });
});

describe('lt/tv/hls', () => {
  it('sans signature : 403 invalid_signature, sans appel amont', async () => {
    const before = upstream.calls.length;
    const res = await get(hlsPath('https://stream.tf1.example/tf1.m3u8', null));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_signature' });
    expect(upstream.calls.length).toBe(before);
  });

  it('signature d une autre URL ou d une autre configuration : 403 invalid_signature', async () => {
    const other = signer.sign(token, 'https://stream.tf1.example/notplaylist.m3u8');
    expect((await get(hlsPath('https://stream.tf1.example/tf1.m3u8', other))).status).toBe(403);
    const foreign = signer.sign(tokenFor({}), 'https://stream.tf1.example/tf1.m3u8');
    expect((await get(hlsPath('https://stream.tf1.example/tf1.m3u8', foreign))).status).toBe(403);
  });

  it('refuse une adresse privée littérale : 400 bad_url, sans appel amont, même avec une signature', async () => {
    const before = upstream.calls.length;
    const res = await get(hlsPath('http://192.168.1.10/x.m3u8'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_url' });
    expect(upstream.calls.length).toBe(before);
  });

  it('réécrit les variantes et médias via le proxy signé, garde les segments en URL directes', async () => {
    const res = await get(hlsPath('https://stream.tf1.example/tf1.m3u8'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    const variant = 'https://stream.tf1.example/variant/index.m3u8';
    const audio = 'https://stream.tf1.example/audio/fr.m3u8';
    expect(body).toContain(`/${token}/lt/tv/hls?u=${encodeURIComponent(variant)}&s=${signer.sign(token, variant)}`);
    expect(body).toContain(`URI="/${token}/lt/tv/hls?u=${encodeURIComponent(audio)}&s=${signer.sign(token, audio)}"`);
  });

  it('réponse qui n est pas une playlist : 415 not_a_playlist', async () => {
    const res = await get(hlsPath('https://stream.tf1.example/notplaylist.m3u8'));
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'not_a_playlist' });
  });

  it('les chaînes portent la signature à présenter au proxy', async () => {
    const channels = await channelsOf();
    const tf1 = channels.find((c) => c.url === 'https://stream.tf1.example/tf1.m3u8');
    expect(tf1?.sig).toBe(signer.sign(token, 'https://stream.tf1.example/tf1.m3u8'));
    const res = await get(hlsPath(tf1?.url ?? '', tf1?.sig ?? null));
    expect(res.status).toBe(200);
  });
});

describe('lt/tv/import', () => {
  const post = (body: unknown): Promise<Response> => fetch(`${app.baseUrl}/${token}/lt/tv/import`, postJson(body));

  it('importe une playlist M3U : adresses privées écartées, entrées normalisées', async () => {
    const res = await post({ type: 'm3u', url: 'https://lists.example.org/p.m3u' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; channels: Record<string, unknown>[] };
    expect(body.count).toBe(1);
    expect(body.channels[0]).toMatchObject({
      id: 'usr:0:canalun',
      name: 'Canal Un',
      group: 'Ma liste',
      cat: 'Ma playlist',
      source: 'user',
      url: 'https://cdn.lists.example.org/c1.m3u8',
      epgId: 'Canal1.fr',
      alternatives: [],
      sig: signer.sign(token, 'https://cdn.lists.example.org/c1.m3u8'),
    });
  });

  it('une entrée importée est lisible par le proxy avec sa signature, pas sans', async () => {
    const imported = (await (await post({ type: 'm3u', url: 'https://lists.example.org/p.m3u' })).json()) as {
      channels: { url: string; sig: string }[];
    };
    const entry = imported.channels[0];
    const res = await get(hlsPath(entry?.url ?? '', entry?.sig ?? null));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('https://cdn.lists.example.org/seg.ts');
    expect((await get(hlsPath(entry?.url ?? '', null))).status).toBe(403);
  });

  it('URL M3U privée ou invalide : 400 bad_url', async () => {
    expect((await post({ type: 'm3u', url: 'http://10.0.0.1/p.m3u' })).status).toBe(400);
    const res = await post({ type: 'm3u', url: 'pas une url' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_url' });
  });

  it('importe un compte Xtream (flux live, groupes, identifiants dans l URL du flux)', async () => {
    const res = await post({ type: 'xtream', server: 'iptv.example.org', username: 'alice', password: 's3cret' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; channels: Record<string, unknown>[] };
    expect(body.count).toBe(2);
    expect(body.channels[0]).toMatchObject({
      id: 'usr:101',
      name: 'Eurosport',
      group: 'Sport',
      epgId: 'eurosport.fr',
      url: 'http://iptv.example.org/live/alice/s3cret/101.m3u8',
    });
    expect(body.channels[1]).toMatchObject({ id: 'usr:102', group: 'Ma playlist' });
  });

  it('Xtream qui refuse les identifiants : 401 xtream_refused', async () => {
    const res = await post({ type: 'xtream', server: 'refus.example.org', username: 'bob', password: 'mauvais' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'xtream_refused' });
  });

  it('identifiants Xtream manquants ou type inconnu : 400 bad_request', async () => {
    expect(await (await post({ type: 'xtream', server: 'iptv.example.org', username: 'x' })).json()).toEqual({ error: 'bad_request' });
    expect(await (await post({ type: 'ftp' })).json()).toEqual({ error: 'bad_request' });
  });
});

describe('lt/tv : source en échec', () => {
  it('playlist Free-TV indisponible : catalogue partiel servi (iptv-org seul), gardé 15 min', async () => {
    const partialUpstream = upstreamWith(503);
    const partialApp = await startApp({ fetch: partialUpstream.fetch, lookupHost: fakeLookup() });
    try {
      const path = `${partialApp.baseUrl}/${fullToken()}/lt/tv/channels`;
      const list = (await (await fetch(path)).json()) as { name: string; source: string }[];
      expect(list.some((c) => c.source === 'freetv')).toBe(false);
      expect(list.find((c) => c.name === 'TF1')).toMatchObject({ source: 'iptvorg' });
      await fetch(path);
      expect(partialUpstream.callsTo(`${API}channels.json`).length).toBe(1);
      expect(partialUpstream.callsTo(FREETV).length).toBe(1);
    } finally {
      await partialApp.close();
    }
  });
});
