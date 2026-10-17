import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUrlSigner } from '../src/lt/signing.js';
import { fakeLookup, fullToken, json, mockUpstream, postJson, SECRET, startApp, text, tokenFor, type MockUpstream, type RunningApp } from './lt-harness.js';

const M3U_FR = 'https://iptv-org.github.io/iptv/countries/fr.m3u';
const PLUTO = 'https://i.mjh.nz/PlutoTV/.channels.json';
const SAMSUNG = 'https://i.mjh.nz/SamsungTVPlus/.channels.json';
const EPG_TNT = 'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz';

const now = Math.floor(Date.now() / 1000);
/** Horodatage XMLTV (AAAAMMJJHHMMSS +0000) pour un instant Unix. */
const xmltv = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

const M3U_BODY = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="TF1.fr" tvg-logo="https://logo.example/tf1.png" group-title="Général",TF1 (1080p)',
  'https://stream.tf1.example/tf1.m3u8',
  '#EXTINF:-1 tvg-id="Adult.xx" group-title="XXX",Adult Channel',
  'https://stream.adult.example/a.m3u8',
  '#EXTINF:-1 group-title="Sport",Sport Geo [geo-blocked]',
  'https://rebind.example.fr/sport.m3u8',
  '#EXTINF:-1 group-title="News",BFM TV',
  'https://bfm.example.fr/bfm.m3u8',
].join('\n');

const EPG_XML = `<?xml version="1.0"?><tv>
  <programme start="${xmltv(now - 1800)}" stop="${xmltv(now + 1800)}" channel="TF1.fr">
    <title lang="fr">Journal &amp; météo</title><desc>Infos du soir</desc><category>News</category>
  </programme>
</tv>`;

let upstream: MockUpstream;
let app: RunningApp;
let token: string;

beforeAll(async () => {
  upstream = mockUpstream({
    [M3U_FR]: () => text(M3U_BODY, 200, 'audio/x-mpegurl'),
    [PLUTO]: () => json({ regions: { fr: { channels: { abc: { name: 'Pluto Ciné', group: 'Movies', logo: '' } } } } }),
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

describe('lt/tv/channels', () => {
  it('liste les chaînes gratuites FR et FAST, sans chaîne adulte ; catégories dérivées du groupe', async () => {
    const res = await get('tv/channels');
    expect(res.status).toBe(200);
    const channels = (await res.json()) as { id: string; name: string; cat: string; source: string; flaky: boolean; url: string }[];
    const names = channels.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['TF1', 'Sport Geo', 'BFM TV', 'Pluto Ciné']));
    expect(names).not.toContain('Adult Channel');
    const tf1 = channels.find((c) => c.name === 'TF1');
    expect(tf1).toMatchObject({ id: 'fr:TF1.fr', source: 'iptv-org', flaky: false, cat: 'Divertissement' });
    expect(channels.find((c) => c.name === 'Sport Geo')).toMatchObject({ cat: 'Sport', flaky: true });
    expect(channels.find((c) => c.name === 'Pluto Ciné')).toMatchObject({ source: 'pluto', fast: true });
  });

  it('charge les sources une seule fois (cache 6 h)', async () => {
    await get('tv/channels');
    await get('tv/channels');
    expect(upstream.callsTo(M3U_FR).length).toBe(1);
  });
});

describe('lt/tv/stats', () => {
  it('compte les chaînes par source et la couverture EPG', async () => {
    const res = await get('tv/stats');
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      counts: Record<string, number>;
      total: number;
      epgCoverage: number;
      epgStats: { url: string; programmes: number; ok: boolean }[];
    };
    expect(stats.counts).toEqual({ 'iptv-org': 2, 'iptv-org (peut ne pas fonctionner)': 1, pluto: 1, samsung: 0 });
    expect(stats.total).toBe(4);
    expect(stats.epgCoverage).toBe(25);
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
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
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
    const channels = (await (await get('tv/channels')).json()) as { url: string; sig: string | null }[];
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
