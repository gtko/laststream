import { describe, expect, it } from 'vitest';
import { dedupe } from '../src/engine/dedupe.js';
import { cand, MB, titles } from './engine-fixtures.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

describe('dedupe', () => {
  it('fusionne un même infoHash et garde le cached malgré moins de seeders', () => {
    const result = dedupe([
      cand({ parsed: { infoHash: HASH_A, seeders: 500 }, raw: { title: 'popular' }, cached: false }),
      cand({ parsed: { infoHash: HASH_A, seeders: 1 }, raw: { title: 'cached' }, cached: true }),
    ]);
    expect(titles(result)).toEqual(['cached']);
  });

  it('garde les fichiers distincts d un même infoHash (fileIdx différents)', () => {
    const result = dedupe([
      cand({ parsed: { infoHash: HASH_A, fileIdx: 0 }, raw: { title: 'file0' } }),
      cand({ parsed: { infoHash: HASH_A, fileIdx: 1 }, raw: { title: 'file1' } }),
      cand({ parsed: { infoHash: HASH_A, fileIdx: 1 }, raw: { title: 'file1-dup' } }),
    ]);
    expect(titles(result)).toEqual(['file0', 'file1']);
  });

  it('fusionne sur nom normalisé + taille arrondie au Mo, sans extension ni ponctuation', () => {
    const result = dedupe([
      cand({
        parsed: { sizeBytes: 4000 * MB, seeders: 3 },
        raw: { title: 'x', filename: 'Movie.2024.1080p.WEB-DL.mkv' },
      }),
      cand({
        parsed: { sizeBytes: 4000 * MB + 300 * 1024, seeders: 40 },
        raw: { title: 'movie 2024 1080p WEB DL' },
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.parsed.seeders).toBe(40);
  });

  it('ne fusionne pas sur le nom si les tailles diffèrent d au moins 1 Mo', () => {
    const result = dedupe([
      cand({ parsed: { sizeBytes: 4000 * MB }, raw: { title: 'Movie 2024' } }),
      cand({ parsed: { sizeBytes: 4002 * MB }, raw: { title: 'Movie 2024' } }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('ne fusionne pas sur le nom quand la taille est inconnue', () => {
    const result = dedupe([
      cand({ raw: { title: 'Movie 2024' } }),
      cand({ raw: { title: 'Movie 2024' } }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('conserve l ordre d arrivée des représentants retenus', () => {
    const result = dedupe([
      cand({ parsed: { infoHash: HASH_A, seeders: 1 }, raw: { title: 'X-weak' } }),
      cand({ parsed: { infoHash: HASH_B }, raw: { title: 'Y' } }),
      cand({ parsed: { infoHash: HASH_A, seeders: 9 }, raw: { title: 'X-strong' } }),
    ]);
    expect(titles(result)).toEqual(['Y', 'X-strong']);
  });
});
