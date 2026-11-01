import { describe, expect, it } from 'vitest';
import { buildCatalog, type IptvOrgRaw, type M3uEntry } from '../src/lt/tv-catalog.js';
import { isOfficialStreamUrl } from '../src/lt/tv-licensing.js';

describe('isOfficialStreamUrl : flux officiels ou licenciés', () => {
  it.each([
    'https://ott.tv5monde.com/Content/HLS/Live/TV5MONDE/index.m3u8',
    'https://ncdn-live-bfm.pfd.sfr.net/bfmtv/index.m3u8',
    'https://lotus.stingray.com/live/channel/master.m3u8',
    'https://a.example.net:8443/live/tv/index.m3u8', // port non standard, mais pas la forme Xtream
    'https://a.example.net/abc123/def456/789', // forme « alnum/alnum/chiffres » sur le port standard : gardée
    'https://a.example.net/index.m3u8?page=2', // « p » et « u » seuls seraient refusés, « page » non
  ])('garde %s', (url) => {
    expect(isOfficialStreamUrl(url)).toBe(true);
  });

  it.each([
    'http://145.239.5.177/314/index.m3u8', // IPv4 brute
    'http://103.190.232.129/stream/tvb/style/master.m3u8?p=abc&u=Oleg', // IPv4 brute + identifiants
    'http://152.89.62.111:8080/nXyAiP3DNp/QgOuvocpGv/222841', // IPv4 brute
    'http://51.91.73.99:25461/sweden/PM66f7Y43H/25849', // IPv4 brute
    'https://[2001:db8::1]/live/x/master.m3u8', // IPv6 brute
    'https://iptv.example.net/live/user1/pass1/12345.ts', // Xtream /live/<x>/<y>/<id>
    'https://iptv.example.net/live/user1/pass1/12345', // Xtream sans extension
    'https://cdn.example.net:8000/abc123/def456/789', // « alnum/alnum/chiffres » sur un port non standard
    'https://user:secret@cdn.example.net/index.m3u8', // identifiants dans l'URL
    'https://cdn.example.net/index.m3u8?username=bob', // paramètre de compte
    'https://cdn.example.net/index.m3u8?Token=abc', // paramètre de compte, casse ignorée
    'https://cdn.example.net/index.m3u8?key=1', // paramètre de compte
    'pas une url',
  ])('refuse %s', (url) => {
    expect(isOfficialStreamUrl(url)).toBe(false);
  });
});

describe('buildCatalog : admission des flux iptv-org et Free-TV', () => {
  const legit = 'https://ott.tv5monde.com/Content/HLS/Live/TV5MONDE/index.m3u8';
  const ip = 'http://145.239.5.177/314/index.m3u8';

  it('iptv-org : un flux IP brute n’entre pas, même en repli d’une chaîne qui a un flux officiel', () => {
    const iptv: IptvOrgRaw = {
      channels: [
        { id: 'TF1.fr', name: 'TF1', country: 'FR', categories: ['general'], is_nsfw: false, closed: null, alt_names: [] },
        { id: 'BFM.fr', name: 'BFM TV', country: 'FR', categories: ['news'], is_nsfw: false, closed: null, alt_names: [] },
      ],
      streams: [
        { channel: 'TF1.fr', feed: 'SD', url: ip, quality: '720p', labels: [] },
        { channel: 'TF1.fr', feed: 'HD', url: legit, quality: '1080p', labels: [] },
        { channel: 'BFM.fr', feed: 'SD', url: ip, quality: '720p', labels: [] },
      ],
      feeds: [],
      logos: [],
      countries: [],
      languages: [],
      blocklist: [],
    };
    const catalog = buildCatalog({ freetv: null, iptv, fast: [], partial: false });
    const urls = catalog.channels.flatMap((c) => [c.url, ...c.alternatives.map((alt) => alt.url)]);
    expect(urls).not.toContain(ip);
    expect(catalog.channels.map((c) => c.id)).toEqual(['fr:TF1.fr']); // BFM TV n'a plus aucun flux
    expect(catalog.channels[0]?.url).toBe(legit);
    expect(catalog.channels[0]?.alternatives).toEqual([]);
  });

  it('Free-TV : un flux IP brute ou à identifiants n’entre pas ; un flux officiel reste', () => {
    const entry = (name: string, url: string): M3uEntry => ({ attrs: { 'tvg-country': 'FR', 'group-title': 'News' }, name, url });
    const freetv: M3uEntry[] = [
      entry('Relais brut', ip),
      entry('Relais xtream', 'https://iptv.example.net/live/user1/pass1/77.ts'),
      entry('Officielle', legit),
    ];
    const catalog = buildCatalog({ freetv, iptv: null, fast: [], partial: false });
    expect(catalog.channels.map((c) => c.name)).toEqual(['Officielle']);
    expect(catalog.channels[0]?.url).toBe(legit);
  });
});
