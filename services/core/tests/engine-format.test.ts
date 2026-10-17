import { describe, expect, it } from 'vitest';
import { type FormatOptions, formatStreams } from '../src/engine/format.js';
import type { ParsedRelease } from '../src/types.js';
import { cand, GB, MB, ranked } from './engine-fixtures.js';

const HASH = 'abc123';
const BASE: FormatOptions = {
  playBaseUrl: 'https://addon.example.com/',
  configToken: 'TOKEN',
  maxResults: 30,
  hasDebrid: true,
};

const format = (candidates: ReturnType<typeof cand>[], overrides: Partial<FormatOptions> = {}) =>
  formatStreams(
    candidates.map((c) => ranked(c, 42)),
    { ...BASE, ...overrides },
  );

describe('formatStreams : formes d URL', () => {
  it('utilise l URL amont directe telle quelle', () => {
    const [stream] = format([cand({ raw: { sourceKind: 'upstream', url: 'https://up.example.com/v.mkv' } })]);
    expect(stream?.url).toBe('https://up.example.com/v.mkv');
    expect(stream?.infoHash).toBeUndefined();
    expect(stream?.fileIdx).toBeUndefined();
  });

  it('produit une URL de lecture débridée sans fileIdx (slash final de playBaseUrl retiré)', () => {
    const [stream] = format([cand({ parsed: { infoHash: HASH } })]);
    expect(stream?.url).toBe(`https://addon.example.com/TOKEN/play/${HASH}`);
  });

  it('ajoute le fileIdx au chemin et les saisons/épisodes en query', () => {
    const [stream] = format([cand({ parsed: { infoHash: HASH, fileIdx: 2 } })], { season: 1, episode: 4 });
    expect(stream?.url).toBe(
      `https://addon.example.com/TOKEN/play/${HASH}/2?s=1&e=4&filename=Movie.2024.1080p.WEB-DL.DDP5.1.HEVC`,
    );
  });

  it('transmet le nom et la taille attendus avec un fileIdx (vérification de l index dans un pack)', () => {
    const [stream] = format(
      [cand({ parsed: { infoHash: HASH, fileIdx: 2 }, raw: { filename: 'Show.S01E02.mkv', sizeBytes: 1234 } })],
      { season: 1, episode: 2 },
    );
    expect(stream?.url).toBe(`https://addon.example.com/TOKEN/play/${HASH}/2?s=1&e=2&filename=Show.S01E02.mkv&size=1234`);
  });

  it('n ajoute ni nom ni taille à une URL sans fileIdx', () => {
    const [stream] = format(
      [cand({ parsed: { infoHash: HASH }, raw: { filename: 'Show.S01E02.mkv', sizeBytes: 1234 } })],
      { season: 1, episode: 2 },
    );
    expect(stream?.url).toBe(`https://addon.example.com/TOKEN/play/${HASH}?s=1&e=2`);
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
  it('nomme le stream avec la résolution, ? si inconnue', () => {
    const streams = format([
      cand({ parsed: { resolution: '1080p', infoHash: HASH } }),
      cand({ parsed: { resolution: 'unknown', infoHash: HASH } }),
      cand({ parsed: { resolution: 'SD', infoHash: HASH } }),
    ]);
    expect(streams.map((s) => s.name)).toEqual(['lastAddon\n1080p', 'lastAddon\n?', 'lastAddon\nSD']);
  });

  it('produit une description exacte en débrid, sans emoji', () => {
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
        raw: { sourceName: 'Indexeur' },
        cached: true,
      }),
    ]);
    expect(stream?.description).toBe(
      '1080p · WEB-DL · HEVC · HDR10\nVFF · 5.1 DDP\n4,2 Go · AllDebrid · Cache · Indexeur',
    );
    expect(stream?.description).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('produit une description P2P avec seeders, omet les champs inconnus', () => {
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
    expect(stream?.description).toBe('1080p\nMULTi\n850 Mo · P2P · 120 seeders · Indexeur');
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
