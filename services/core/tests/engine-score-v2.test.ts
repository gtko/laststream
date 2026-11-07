import { describe, expect, it } from 'vitest';
import { filterCandidates } from '../src/engine/filter.js';
import { computeScore, rankCandidates } from '../src/engine/score.js';
import { RESOLUTION_RANK, SOURCE_RANK } from '../src/engine/types.js';
import type { Candidate } from '../src/engine/types.js';
import type { ParsedRelease, SourceKind } from '../src/types.js';
import { cand, cfg, GB, titles } from './engine-fixtures.js';

describe('rankCandidates : mots préférés', () => {
  it('fait remonter un flux portant un mot préféré, à résolution et source égales', () => {
    const config = cfg({ filters: { preferredWords: ['REPACK'] } });
    const result = rankCandidates(
      [
        cand({ raw: { title: 'Movie.2024.1080p.WEB-DL' } }),
        cand({ raw: { title: 'Movie.2024.REPACK.1080p.WEB-DL' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['Movie.2024.REPACK.1080p.WEB-DL', 'Movie.2024.1080p.WEB-DL']);
  });

  it('un mot préféré ne passe ni devant la source ni devant la résolution', () => {
    const config = cfg({ filters: { preferredWords: ['REPACK'] } });
    const bySource = rankCandidates(
      [
        cand({ parsed: { source: 'WEB-DL' }, raw: { title: 'web-repack' } }),
        cand({ parsed: { source: 'BluRay' }, raw: { title: 'bluray' } }),
      ],
      config,
    );
    expect(titles(bySource)).toEqual(['bluray', 'web-repack']);

    const byResolution = rankCandidates(
      [
        cand({ parsed: { resolution: '720p' }, raw: { title: 'hd-repack' } }),
        cand({ parsed: { resolution: '1080p' }, raw: { title: 'fhd' } }),
      ],
      config,
    );
    expect(titles(byResolution)).toEqual(['fhd', 'hd-repack']);
  });
});

describe('rankCandidates : préférences audio', () => {
  it('prefer7_1 passe le 7.1 devant le 5.1', () => {
    const config = cfg({ audio: { multichannel: 'prefer7_1' } });
    const result = rankCandidates(
      [cand({ parsed: { channels: '5.1' }, raw: { title: 'a51' } }), cand({ parsed: { channels: '7.1' }, raw: { title: 'a71' } })],
      config,
    );
    expect(titles(result)).toEqual(['a71', 'a51']);
  });

  it('prefer5_1 passe le 5.1 devant le 2.0', () => {
    const config = cfg({ audio: { multichannel: 'prefer5_1' } });
    const result = rankCandidates(
      [cand({ parsed: { channels: '2.0' }, raw: { title: 'a20' } }), cand({ parsed: { channels: '5.1' }, raw: { title: 'a51' } })],
      config,
    );
    expect(titles(result)).toEqual(['a51', 'a20']);
  });

  it('atmos prefer passe Atmos devant un flux sans Atmos', () => {
    const config = cfg({ audio: { atmos: 'prefer' } });
    const result = rankCandidates(
      [
        cand({ parsed: { audio: ['DDP'] }, raw: { title: 'plain' } }),
        cand({ parsed: { audio: ['TrueHD', 'Atmos'] }, raw: { title: 'atmos' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['atmos', 'plain']);
  });

  it('la préférence audio ne passe pas devant la source', () => {
    const config = cfg({ audio: { multichannel: 'prefer7_1' } });
    const result = rankCandidates(
      [
        cand({ parsed: { source: 'WEB-DL', channels: '7.1' }, raw: { title: 'web-71' } }),
        cand({ parsed: { source: 'BluRay', channels: '2.0' }, raw: { title: 'bluray-20' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['bluray-20', 'web-71']);
  });
});

describe('rankCandidates : formats non supportés en déclassement', () => {
  const trueHdRemux = cand({
    parsed: { resolution: '2160p', source: 'REMUX', audio: ['TrueHD'], sizeBytes: 40 * GB },
    raw: { title: 'uhd-truehd' },
  });
  const plainWeb = cand({
    parsed: { resolution: '720p', source: 'WEBRip', audio: ['AAC'], sizeBytes: 2 * GB },
    raw: { title: 'hd-aac' },
  });

  it('deprioritize relègue le flux en fin de liste, même devant un 2160p REMUX', () => {
    const config = cfg({ audio: { unsupportedFormats: ['TrueHD'], unsupportedMode: 'deprioritize' } });
    expect(titles(rankCandidates([trueHdRemux, plainWeb], config))).toEqual(['hd-aac', 'uhd-truehd']);
  });

  it('deprioritize reste en fin de liste avec le tri par taille', () => {
    const config = cfg({ sort: 'heaviest', audio: { unsupportedFormats: ['TrueHD'], unsupportedMode: 'deprioritize' } });
    expect(titles(rankCandidates([trueHdRemux, plainWeb], config))).toEqual(['hd-aac', 'uhd-truehd']);
  });

  it('computeScore place un flux déclassé sous un flux non déclassé', () => {
    const config = cfg({ audio: { unsupportedFormats: ['TrueHD'], unsupportedMode: 'deprioritize' } });
    expect(computeScore(trueHdRemux, config)).toBeLessThan(computeScore(plainWeb, config));
  });

  it('sans déclassement (mode exclude), le format n\'est pas relégué dans le classement', () => {
    const config = cfg({ audio: { unsupportedFormats: ['TrueHD'], unsupportedMode: 'exclude' } });
    expect(titles(rankCandidates([trueHdRemux, plainWeb], config))).toEqual(['uhd-truehd', 'hd-aac']);
  });
});

describe('rankCandidates : tri par taille', () => {
  const sized = () => [
    cand({ parsed: { sizeBytes: 1 * GB }, raw: { title: 'small' } }),
    cand({ parsed: { sizeBytes: undefined }, raw: { title: 'unknown' } }),
    cand({ parsed: { sizeBytes: 8 * GB }, raw: { title: 'big' } }),
    cand({ parsed: { sizeBytes: 4 * GB }, raw: { title: 'mid' } }),
  ];

  it('heaviest : taille décroissante, taille inconnue en dernier', () => {
    expect(titles(rankCandidates(sized(), cfg({ sort: 'heaviest' })))).toEqual(['big', 'mid', 'small', 'unknown']);
  });

  it('lightest : taille croissante, taille inconnue en dernier', () => {
    expect(titles(rankCandidates(sized(), cfg({ sort: 'lightest' })))).toEqual(['small', 'mid', 'big', 'unknown']);
  });

  it('default : garde l\'ordre score puis taille croissante', () => {
    expect(titles(rankCandidates(sized(), cfg({})))).toEqual(['small', 'mid', 'big', 'unknown']);
  });

  it('heaviest : la taille prime sur la résolution', () => {
    const input = [
      cand({ parsed: { resolution: '1080p', sizeBytes: 1 * GB }, raw: { title: 'fhd-small' } }),
      cand({ parsed: { resolution: '720p', sizeBytes: 8 * GB }, raw: { title: 'hd-big' } }),
    ];
    expect(titles(rankCandidates(input, cfg({ sort: 'heaviest' })))).toEqual(['hd-big', 'fhd-small']);
    expect(titles(rankCandidates(input, cfg({})))).toEqual(['fhd-small', 'hd-big']);
  });

  it('heaviest : le niveau de langue prime sur la taille', () => {
    const config = cfg({ sort: 'heaviest', languages: { preferred: ['fr'], acceptVostfr: true } });
    const result = rankCandidates(
      [
        cand({ parsed: { languages: ['en'], subsFr: true, frVariant: 'VOSTFR', sizeBytes: 20 * GB }, raw: { title: 'vostfr-big' } }),
        cand({ parsed: { languages: ['fr'], frVariant: 'VFF', sizeBytes: 1 * GB }, raw: { title: 'vff-small' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['vff-small', 'vostfr-big']);
  });

  it('à taille égale, le score puis les seeders départagent', () => {
    const config = cfg({ sort: 'heaviest' });
    const result = rankCandidates(
      [
        cand({ parsed: { sizeBytes: 2 * GB, resolution: '720p', seeders: 500 }, raw: { title: 'hd-many' } }),
        cand({ parsed: { sizeBytes: 2 * GB, resolution: '1080p', seeders: 1 }, raw: { title: 'fhd-few' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['fhd-few', 'hd-many']);
  });
});

describe('score : invariant de superposition des niveaux', () => {
  const SOURCES = Object.keys(SOURCE_RANK) as SourceKind[];
  const RESOLUTIONS = Object.keys(RESOLUTION_RANK) as ParsedRelease['resolution'][];

  /** Tuple de référence : (résolution, source, HDR, cached), comparé lexicographiquement. */
  function tupleOf(c: Candidate): number[] {
    const hdr = c.parsed.hdr.some((format) => format === 'DV') ? 1 : 0;
    return [RESOLUTION_RANK[c.parsed.resolution], SOURCE_RANK[c.parsed.source], hdr, c.cached === true ? 1 : 0];
  }

  function compareTuples(a: number[], b: number[]): number {
    for (let index = 0; index < a.length; index += 1) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  it('comparer deux scores revient à comparer le tuple (résolution, source, HDR, cached), toutes combinaisons', () => {
    const config = cfg({});
    const candidates: Candidate[] = [];
    for (const resolution of RESOLUTIONS) {
      for (const source of SOURCES) {
        for (const dv of [false, true]) {
          for (const cached of [false, true]) {
            candidates.push(
              cand({
                parsed: { resolution, source, hdr: dv ? ['DV'] : [] },
                raw: { title: `${resolution}-${source}-${dv}-${cached}` },
                cached,
              }),
            );
          }
        }
      }
    }
    const scores = candidates.map((c) => computeScore(c, config));
    const tuples = candidates.map(tupleOf);
    const mismatches: string[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = 0; j < candidates.length; j += 1) {
        const byTuple = Math.sign(compareTuples(tuples[i] ?? [], tuples[j] ?? []));
        const byScore = Math.sign((scores[i] ?? 0) - (scores[j] ?? 0));
        if (byScore !== byTuple) mismatches.push(`${i}/${j}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('une résolution supérieure gagne toujours, même face à la meilleure source d\'une résolution inférieure', () => {
    const config = cfg({});
    const lowerBest = cand({ parsed: { resolution: '720p', source: 'REMUX' }, raw: { title: 'hd-remux' } });
    const higherWorst = cand({ parsed: { resolution: '1080p', source: 'CAM' }, raw: { title: 'fhd-cam' } });
    expect(computeScore(higherWorst, config)).toBeGreaterThan(computeScore(lowerBest, config));
  });
});

describe('rankCandidates : meta', () => {
  it('accepte le contenu en troisième argument sans changer le classement', () => {
    const config = cfg({ sort: 'heaviest' });
    const input = [cand({ parsed: { sizeBytes: 1 * GB }, raw: { title: 'a' } }), cand({ parsed: { sizeBytes: 3 * GB }, raw: { title: 'b' } })];
    expect(titles(rankCandidates(input, config, { runtimeSeconds: 3600 }))).toEqual(titles(rankCandidates(input, config)));
  });
});

describe('filterCandidates puis rankCandidates : bout en bout', () => {
  it('filtre les 3D et classe le reste par préférence de mot', () => {
    const config = cfg({ filters: { preferredWords: ['REPACK'] } });
    const kept = filterCandidates(
      [
        cand({ raw: { title: 'Movie.2024.3D.REPACK.1080p.BluRay' } }),
        cand({ raw: { title: 'Movie.2024.1080p.WEB-DL' } }),
        cand({ raw: { title: 'Movie.2024.REPACK.1080p.WEB-DL' } }),
      ],
      config,
    );
    expect(titles(rankCandidates(kept, config))).toEqual(['Movie.2024.REPACK.1080p.WEB-DL', 'Movie.2024.1080p.WEB-DL']);
  });
});
