import { describe, expect, it } from 'vitest';
import { type FormatItem, type FormatOptions, formatStreams } from '../src/engine/format.js';
import { decodeCopiesToken } from '../src/play/token.js';
import type { ParsedRelease } from '../src/types.js';
import { cand, GB, MB, ranked } from './engine-fixtures.js';

/** Hash valide (40 hexadécimaux) : un jeton ne porte que des hashes bien formés. */
const HASH = 'ab'.repeat(20);
const OTHER = 'cd'.repeat(20);
const SECRET = 'format-test-secret';
const PREFIX = 'https://addon.example.com/TOKEN/play/c/';

const BASE: FormatOptions = {
  playBaseUrl: 'https://addon.example.com/',
  configToken: 'TOKEN',
  secret: SECRET,
  maxResults: 30,
  hasDebrid: true,
};

const format = (candidates: ReturnType<typeof cand>[], overrides: Partial<FormatOptions> = {}) =>
  formatStreams(
    candidates.map((c) => ranked(c, 42)),
    { ...BASE, ...overrides },
  );

/** Jeton de lecture d'une URL /play/c/ ; échoue si l'URL n'a pas cette forme. */
function tokenOf(url: string | undefined): string {
  if (url === undefined || !url.startsWith(PREFIX)) throw new Error(`URL de lecture inattendue : ${url}`);
  return decodeURIComponent(url.slice(PREFIX.length));
}

describe('formatStreams : formes d URL', () => {
  it('utilise l URL amont directe telle quelle', () => {
    const [stream] = format([cand({ raw: { sourceKind: 'upstream', url: 'https://up.example.com/v.mkv' } })]);
    expect(stream?.url).toBe('https://up.example.com/v.mkv');
    expect(stream?.infoHash).toBeUndefined();
    expect(stream?.fileIdx).toBeUndefined();
  });

  it('lit un hash par /play/c/ : le jeton est signé et décode la copie (slash final de playBaseUrl retiré)', () => {
    const [stream] = format([cand({ parsed: { infoHash: HASH } })]);
    expect(stream?.url?.startsWith(PREFIX)).toBe(true);
    expect(decodeCopiesToken(tokenOf(stream?.url), SECRET)).toEqual({ copies: [{ infoHash: HASH }] });
    expect(decodeCopiesToken(tokenOf(stream?.url), 'autre-secret')).toBeNull();
  });

  it('porte la saison et l épisode dans le jeton', () => {
    const [stream] = format([cand({ parsed: { infoHash: HASH } })], { season: 1, episode: 4 });
    expect(decodeCopiesToken(tokenOf(stream?.url), SECRET)).toMatchObject({ season: 1, episode: 4 });
  });

  it('porte le nom et la taille attendus seulement avec un index de fichier', () => {
    const withIdx = format(
      [cand({ parsed: { infoHash: HASH, fileIdx: 2 }, raw: { filename: 'Show.S01E02.mkv', sizeBytes: 1234 } })],
      { season: 1, episode: 2 },
    );
    expect(decodeCopiesToken(tokenOf(withIdx[0]?.url), SECRET)?.copies).toEqual([
      { infoHash: HASH, fileIdx: 2, filename: 'Show.S01E02.mkv', size: 1234 },
    ]);

    const withoutIdx = format([cand({ parsed: { infoHash: HASH }, raw: { filename: 'Show.S01E02.mkv', sizeBytes: 1234 } })]);
    expect(decodeCopiesToken(tokenOf(withoutIdx[0]?.url), SECRET)?.copies).toEqual([{ infoHash: HASH }]);
  });

  it('garde l ordre des copies reçues, sans doublon, et les copies au-delà de la limite de jeton', () => {
    const item: FormatItem = {
      ...ranked(cand({ parsed: { infoHash: OTHER } })),
      copies: [{ infoHash: HASH, cached: true }, { infoHash: OTHER }, { infoHash: HASH }],
    };
    const [stream] = formatStreams([item], { ...BASE });
    expect(decodeCopiesToken(tokenOf(stream?.url), SECRET)?.copies).toEqual([{ infoHash: HASH }, { infoHash: OTHER }]);
    expect(stream?.laststream).toMatchObject({ copies: 3 });
  });

  it('un lien d hébergeur débridé passe par /play/c/ (kind hoster) ; un lien direct ordinaire reste direct', () => {
    const hosterUrl = 'https://1fichier.example.com/?abc123';
    const hosted = { ...cand({ raw: { sourceKind: 'upstream', url: hosterUrl } }), hoster: '1fichier' };
    const [hoster] = formatStreams([ranked(hosted, 42)], { ...BASE });
    expect(hoster?.url?.startsWith(PREFIX)).toBe(true);
    expect(decodeCopiesToken(tokenOf(hoster?.url), SECRET)?.copies).toEqual([{ url: hosterUrl, kind: 'hoster' }]);
    expect(hoster?.description).toContain('Lien direct · 1fichier');

    const [direct] = format([cand({ raw: { sourceKind: 'upstream', url: 'https://cdn.example.com/v.mkv' } })]);
    expect(direct?.url).toBe('https://cdn.example.com/v.mkv');
  });

  it('passe en P2P (infoHash, fileIdx, sources, sans url) quand le débrideur est absent', () => {
    const [stream] = format(
      [cand({ parsed: { infoHash: HASH, fileIdx: 3 }, raw: { sources: ['tracker:udp://t.example.com:80'] } })],
      { hasDebrid: false },
    );
    expect(stream).toMatchObject({
      infoHash: HASH,
      fileIdx: 3,
      sources: ['tracker:udp://t.example.com:80'],
    });
    expect(stream?.url).toBeUndefined();
  });

  it('écarte un stream sans URL ni infoHash', () => {
    expect(format([cand({ raw: { title: 'vide' } })])).toEqual([]);
  });
});

describe('formatStreams : name et description', () => {
  it('nomme le stream avec la résolution, ? si inconnue (P2P : pas de préfixe AD)', () => {
    const streams = format(
      [
        cand({ parsed: { resolution: '1080p', infoHash: HASH } }),
        cand({ parsed: { resolution: 'unknown', infoHash: HASH } }),
        cand({ parsed: { resolution: 'SD', infoHash: HASH } }),
      ],
      { hasDebrid: false },
    );
    expect(streams.map((s) => s.name)).toEqual(['lastAddon 1080p', 'lastAddon ?', 'lastAddon SD']);
  });

  it('préfixe [AD⚡] pour un débridé en cache, [AD⏳] sans cache', () => {
    const [cached, pending] = format([
      cand({ parsed: { infoHash: HASH }, cached: true }),
      cand({ parsed: { infoHash: OTHER } }),
    ]);
    expect(cached?.name).toBe('[AD⚡] lastAddon 1080p');
    expect(pending?.name).toBe('[AD⏳] lastAddon 1080p');
  });

  it('produit une description détaillée sans émoji hors gabarit, langues annoncées suffixées de ?', () => {
    const [stream] = format([
      cand({
        parsed: {
          infoHash: HASH,
          resolution: '1080p',
          source: 'WEB-DL',
          codec: 'HEVC',
          hdr: ['HDR10'],
          audio: ['DDP'],
          channels: '5.1',
          languages: ['fr'],
          frVariant: 'VFF',
          sizeBytes: Math.round(4.2 * GB),
        },
        raw: { sourceName: 'Indexeur', title: 'Movie.2024.1080p.WEB-DL.DDP5.1.HEVC' },
        cached: true,
      }),
    ]);
    expect(stream?.description).toBe(
      'WEB-DL • HDR10 • 🇫🇷? • 💾 4,2 Go\n🎧 HEVC • 5.1 DDP\n🗂️ Movie.2024.1080p.WEB-DL.DDP5.1.HEVC',
    );
  });

  it('langues vérifiées par sonde : drapeau suivi de ✓ ; annoncées restantes suffixées de ?', () => {
    const [stream] = format([
      cand({
        parsed: { infoHash: HASH, languages: ['fr', 'en'], frVariant: undefined },
        verifiedLanguages: ['en'],
      }),
    ]);
    expect(stream?.description?.split('\n')[0]).toContain('🇬🇧 ✓ 🇫🇷?');
  });

  it('segment 🔎 : indexeurs de toutes les copies et nombre de copies', () => {
    const item: FormatItem = {
      ...ranked(cand({ parsed: { infoHash: HASH } })),
      copies: [{ infoHash: HASH }, { infoHash: OTHER }, { infoHash: 'ef'.repeat(20) }],
      indexers: ['Tracker A', 'Tracker B'],
    };
    const [stream] = formatStreams([item], { ...BASE, hasDebrid: false });
    expect(stream?.description?.split('\n')[0]).toContain('🔎 Tracker A | Tracker B · 3 copies');
  });

  it('P2P : les seeders apparaissent dans la description', () => {
    const [stream] = format(
      [
        cand({
          parsed: {
            infoHash: HASH,
            resolution: '1080p',
            source: 'unknown',
            codec: 'unknown',
            hdr: [],
            audio: [],
            channels: undefined,
            languages: ['multi'],
            multi: true,
            frVariant: undefined,
            sizeBytes: 850 * MB,
            seeders: 120,
          },
          raw: { sourceName: 'Indexeur' },
        }),
      ],
      { hasDebrid: false },
    );
    expect(stream?.description?.split('\n')[0]).toBe('🌐? • 💾 850 Mo • 🌱 120 seeders');
  });
});

describe('formatStreams : behaviorHints et laststream', () => {
  it('construit le bingeGroup lastaddon|resolution|langue|source', () => {
    const [stream] = format([cand({ parsed: { infoHash: HASH } })]);
    expect(stream?.behaviorHints).toMatchObject({ bingeGroup: 'lastaddon|1080p|vff|WEB-DL' });
  });

  it('marque notWebReady pour HEVC/AV1, REMUX, audio DTS ou TrueHD, et non pour un AVC simple', () => {
    const readiness = (parsed: Partial<ParsedRelease>): unknown => {
      const [stream] = format([cand({ parsed: { infoHash: HASH, ...parsed } })]);
      return stream?.behaviorHints?.notWebReady;
    };
    expect(readiness({ codec: 'HEVC', source: 'WEB-DL', audio: ['DDP'] })).toBe(true);
    expect(readiness({ codec: 'AV1', source: 'WEBRip', audio: ['AAC'] })).toBe(true);
    expect(readiness({ codec: 'AVC', source: 'REMUX', audio: ['AC3'] })).toBe(true);
    expect(readiness({ codec: 'AVC', source: 'WEB-DL', audio: ['TrueHD'] })).toBe(true);
    expect(readiness({ codec: 'AVC', source: 'WEB-DL', audio: ['DTS-HD MA'] })).toBe(true);
    expect(readiness({ codec: 'AVC', source: 'WEB-DL', audio: ['DDP'] })).toBe(false);
  });

  it('estime le débit en kb/s, ou null sans durée', () => {
    const [withRuntime] = format([cand({ parsed: { infoHash: HASH, sizeBytes: GB } })], { runtimeSeconds: 4000 });
    expect(withRuntime?.laststream).toMatchObject({ estBitrateKbps: 2147, sizeBytes: GB, cached: false, score: 42 });
    const [withoutRuntime] = format([cand({ parsed: { infoHash: HASH, sizeBytes: GB } })]);
    expect(withoutRuntime?.laststream?.estBitrateKbps).toBeNull();
  });

  it('laststream porte le débit réel, les copies, les langues vérifiées, la certification et les indexeurs', () => {
    const item: FormatItem = {
      ...ranked(cand({ parsed: { infoHash: HASH, sizeBytes: GB }, verifiedLanguages: ['fr', 'multi'] })),
      copies: [{ infoHash: HASH }, { infoHash: OTHER }],
      indexers: ['Tracker A'],
    };
    const [stream] = formatStreams([item], { ...BASE, runtimeSeconds: 4000, certificationFr: 16 });
    expect(stream?.laststream).toMatchObject({
      bitrateMbps: 2.1,
      copies: 2,
      verifiedLanguages: ['fr', 'multi'],
      certification: 16,
      indexers: ['Tracker A'],
    });
    expect(JSON.stringify(stream)).not.toContain('downloadUrl');
  });

  it('fusionne les en-têtes amont utiles pour une URL directe seulement', () => {
    const headers = { request: { 'User-Agent': 'agent' } };
    const [direct] = format([
      cand({ raw: { sourceKind: 'upstream', url: 'https://up.example.com/v.mkv', behaviorHints: { proxyHeaders: headers, other: 1 } } }),
    ]);
    expect(direct?.behaviorHints?.proxyHeaders).toEqual(headers);
    expect(direct?.behaviorHints).not.toHaveProperty('other');
  });

  it('remplit videoSize et filename à partir du candidat', () => {
    const [stream] = format([cand({ parsed: { infoHash: HASH, sizeBytes: 2 * GB }, raw: { filename: 'Movie.mkv' } })]);
    expect(stream?.behaviorHints).toMatchObject({ videoSize: 2 * GB, filename: 'Movie.mkv' });
  });

  it('ne sort jamais de downloadUrl ni de guid de torrent public', () => {
    const [stream] = format([
      cand({ parsed: { infoHash: HASH }, raw: { downloadUrl: 'https://tracker.example/dl?passkey=PK-SECRET-123', guid: 'guid-1' } }),
    ]);
    expect(JSON.stringify(stream)).not.toContain('PK-SECRET-123');
    expect(JSON.stringify(stream)).not.toContain('guid-1');
  });
});

describe('formatStreams : troncature', () => {
  it('tronque à maxResults', () => {
    const streams = format(
      [1, 2, 3, 4, 5].map((i) => cand({ parsed: { infoHash: `${i}`.repeat(40) } })),
      { maxResults: 2 },
    );
    expect(streams).toHaveLength(2);
  });
});
