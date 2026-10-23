import { describe, expect, it } from 'vitest';
import { rankCandidates, selectForCacheCheck } from '../src/engine/score.js';
import type { SourceKind } from '../src/types.js';
import { cand, cfg, GB, MB, ranked, titles } from './engine-fixtures.js';

const config = cfg({});

describe('rankCandidates : ordre lexicographique', () => {
  it('la langue prime sur la résolution', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { resolution: '2160p', languages: ['en'], subsFr: true, frVariant: 'VOSTFR' }, raw: { title: 'vostfr-4k' } }),
        cand({ parsed: { resolution: '720p', languages: ['fr'], frVariant: 'VFF' }, raw: { title: 'vff-720' } }),
      ],
      cfg({ languages: { preferred: ['fr'], acceptVostfr: true } }),
    );
    expect(titles(result)).toEqual(['vff-720', 'vostfr-4k']);
  });

  it('à rang de langue égal, une variante FR exacte passe devant un MULTi', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { languages: ['multi'], multi: true, frVariant: undefined }, raw: { title: 'multi' } }),
        cand({ parsed: { languages: ['fr'], frVariant: 'TRUEFRENCH' }, raw: { title: 'exact' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['exact', 'multi']);
  });

  it('la résolution prime sur la source', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { resolution: '720p', source: 'REMUX' }, raw: { title: '720-remux' } }),
        cand({ parsed: { resolution: '1080p', source: 'HDTV' }, raw: { title: '1080-hdtv' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['1080-hdtv', '720-remux']);
  });

  it('classe les sources REMUX > BluRay > WEB-DL > WEBRip > HDTV > DVDRip > unknown > SCR > TS > CAM', () => {
    const expected: SourceKind[] = ['REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVDRip', 'unknown', 'SCR', 'TS', 'CAM'];
    const shuffled = [...expected].reverse().map((source) => cand({ parsed: { source }, raw: { title: source } }));
    const result = rankCandidates(shuffled, config);
    expect(result.map((c) => c.parsed.source)).toEqual(expected);
  });

  it('le bonus HDR (DV, HDR10+, HDR10) départage à source égale', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { hdr: [] }, raw: { title: 'sdr' } }),
        cand({ parsed: { hdr: ['HLG'] }, raw: { title: 'hlg-only' } }),
        cand({ parsed: { hdr: ['DV'] }, raw: { title: 'dolby-vision' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['dolby-vision', 'sdr', 'hlg-only']);
  });

  it('le bonus cached passe devant une taille plus petite', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { sizeBytes: 1 * GB }, raw: { title: 'uncached-small' }, cached: false }),
        cand({ parsed: { sizeBytes: 4 * GB }, raw: { title: 'cached-big' }, cached: true }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['cached-big', 'uncached-small']);
  });

  it('à tier égal, la plus petite taille d abord, taille inconnue en dernier', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { sizeBytes: undefined }, raw: { title: 'unknown' } }),
        cand({ parsed: { sizeBytes: 8 * GB }, raw: { title: 'big' } }),
        cand({ parsed: { sizeBytes: 2 * GB }, raw: { title: 'small' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['small', 'big', 'unknown']);
  });

  it('à taille égale, les seeders décroissants départagent', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { sizeBytes: 2 * GB, seeders: 12 }, raw: { title: 'few' } }),
        cand({ parsed: { sizeBytes: 2 * GB, seeders: 300 }, raw: { title: 'many' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['many', 'few']);
  });

  it('les sous-titres FR passent après tous les matchs de langue, les autres en dernier', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { resolution: '2160p', languages: ['en'], subsFr: false, frVariant: undefined }, raw: { title: 'vo-plain' } }),
        cand({ parsed: { resolution: '2160p', languages: ['en'], subsFr: true, frVariant: 'VOSTFR' }, raw: { title: 'vostfr' } }),
        cand({ parsed: { resolution: '480p', languages: ['multi'], multi: true, frVariant: undefined }, raw: { title: 'multi-sd' } }),
      ],
      cfg({ languages: { preferred: ['fr'] } }),
    );
    expect(titles(result)).toEqual(['multi-sd', 'vostfr', 'vo-plain']);
  });

  it('renvoie tier = rang de résolution et un score numérique, sans modifier les entrées', () => {
    const input = [cand({ parsed: { resolution: '2160p' }, raw: { title: 'uhd' } }), cand({ parsed: { resolution: 'unknown' }, raw: { title: 'unk' } })];
    const result = rankCandidates(input, config);
    expect(result[0]?.tier).toBe(6);
    expect(result[1]?.tier).toBe(0);
    expect(typeof result[0]?.score).toBe('number');
    expect(input[0]).not.toHaveProperty('score');
  });

  it('classe le 1440p entre le 2160p et le 1080p, sans que la source ne déborde sur la résolution', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { resolution: '1080p', source: 'REMUX' }, raw: { title: 'fhd-remux' } }),
        cand({ parsed: { resolution: '1440p', source: 'WEBRip' }, raw: { title: 'qhd-webrip' } }),
        cand({ parsed: { resolution: '2160p', source: 'HDTV' }, raw: { title: 'uhd-hdtv' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['uhd-hdtv', 'qhd-webrip', 'fhd-remux']);
    expect(result.map((r) => r.tier)).toEqual([6, 5, 4]);
  });
});

describe('selectForCacheCheck', () => {
  const HASH_A = 'ABCDEF'.padEnd(40, '0');
  const HASH_B = '1'.repeat(40);

  it('renvoie les infoHash distincts, en minuscules, des candidats sans URL directe', () => {
    const items = [
      ranked(cand({ parsed: { infoHash: HASH_A } })),
      ranked(cand({ parsed: { infoHash: HASH_A, fileIdx: 1 } })),
      ranked(cand({ raw: { title: 'direct', url: 'https://up.example.com/v.mkv' }, parsed: { infoHash: HASH_B } })),
      ranked(cand({ parsed: { infoHash: undefined } })),
      ranked(cand({ parsed: { infoHash: HASH_B } })),
    ];
    expect(selectForCacheCheck(items, 10)).toEqual([HASH_A.toLowerCase(), HASH_B]);
  });

  it('respecte la limite n sur les candidats éligibles', () => {
    const items = [
      ranked(cand({ parsed: { infoHash: '1'.repeat(40) } })),
      ranked(cand({ parsed: { infoHash: '2'.repeat(40) } })),
      ranked(cand({ parsed: { infoHash: '3'.repeat(40) } })),
    ];
    expect(selectForCacheCheck(items, 2)).toEqual(['1'.repeat(40), '2'.repeat(40)]);
    expect(selectForCacheCheck(items, 0)).toEqual([]);
  });

  it('ne lève pas sur une liste vide et ne dépend pas de la taille', () => {
    expect(selectForCacheCheck([], 5)).toEqual([]);
    const sized = ranked(cand({ parsed: { infoHash: HASH_B, sizeBytes: 5 * MB } }));
    expect(selectForCacheCheck([sized], 5)).toEqual([HASH_B]);
  });
});

describe('rankCandidates : priorité de source (départage des scores égaux)', () => {
  const same = { resolution: '1080p' as const, languages: ['fr' as const], frVariant: 'VFF' as const, source: 'WEB-DL' as const };

  it('à score égal, la source prioritaire passe devant, même plus lourde (tri par défaut)', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { ...same, sizeBytes: 2 * GB }, raw: { title: 'leger-prio-1', sourcePriority: 1 } }),
        cand({ parsed: { ...same, sizeBytes: 4 * GB }, raw: { title: 'lourd-prio-0', sourcePriority: 0 } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['lourd-prio-0', 'leger-prio-1']);
  });

  it('la priorité ne passe jamais devant un meilleur score (résolution)', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { ...same, resolution: '720p' }, raw: { title: '720-prio-0', sourcePriority: 0 } }),
        cand({ parsed: { ...same }, raw: { title: '1080-prio-3', sourcePriority: 3 } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['1080-prio-3', '720-prio-0']);
  });

  it('tri par taille : à score et taille égaux, la priorité départage avant les seeders', () => {
    const result = rankCandidates(
      [
        cand({ parsed: { ...same, sizeBytes: 4 * GB, seeders: 900 }, raw: { title: 'seeds-prio-2', sourcePriority: 2 } }),
        cand({ parsed: { ...same, sizeBytes: 4 * GB, seeders: 5 }, raw: { title: 'peu-prio-1', sourcePriority: 1 } }),
      ],
      cfg({ sort: 'heaviest' }),
    );
    expect(titles(result)).toEqual(['peu-prio-1', 'seeds-prio-2']);
  });
});
