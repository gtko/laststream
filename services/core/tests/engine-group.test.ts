import { describe, expect, it } from 'vitest';
import { groupCopies } from '../src/engine/group.js';
import { cand, MB } from './engine-fixtures.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

describe('groupCopies', () => {
  it('renvoie un tableau vide pour une entrée vide', () => {
    expect(groupCopies([])).toEqual([]);
  });

  it('fusionne un même nom normalisé (extension, casse et ponctuation ignorées)', () => {
    const result = groupCopies([
      cand({ raw: { title: 'x', filename: 'Movie.2024.1080p.WEB-DL.mkv', sourceName: 'A' } }),
      cand({ raw: { title: 'movie 2024 1080p web dl', sourceName: 'B' } }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.copies.map((copy) => copy.sourceName)).toEqual(['A', 'B']);
  });

  it('fusionne par taille à ±0,5 % si même groupe et même résolution', () => {
    const result = groupCopies([
      cand({ parsed: { group: 'FRATRIX', sizeBytes: 4000 * MB }, raw: { title: 'Alpha 2024', sourceName: 'A' } }),
      cand({
        parsed: { group: 'fratrix', sizeBytes: Math.round(4000 * MB * 1.004) },
        raw: { title: 'Beta 2024', sourceName: 'B' },
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.copies).toHaveLength(2);
  });

  it('ne fusionne pas par taille si l écart dépasse 0,5 %', () => {
    const result = groupCopies([
      cand({ parsed: { group: 'FRATRIX', sizeBytes: 4000 * MB }, raw: { title: 'Alpha 2024' } }),
      cand({ parsed: { group: 'FRATRIX', sizeBytes: Math.round(4000 * MB * 1.01) }, raw: { title: 'Beta 2024' } }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('ne fusionne pas par taille si les groupes de release diffèrent ou sont absents', () => {
    const otherGroup = groupCopies([
      cand({ parsed: { group: 'FRATRIX', sizeBytes: 4000 * MB }, raw: { title: 'Alpha 2024' } }),
      cand({ parsed: { group: 'OTHER', sizeBytes: 4000 * MB }, raw: { title: 'Beta 2024' } }),
    ]);
    expect(otherGroup).toHaveLength(2);

    const noGroup = groupCopies([
      cand({ parsed: { sizeBytes: 4000 * MB }, raw: { title: 'Alpha 2024' } }),
      cand({ parsed: { sizeBytes: 4000 * MB }, raw: { title: 'Beta 2024' } }),
    ]);
    expect(noGroup).toHaveLength(2);
  });

  it('ne fusionne pas par taille si les résolutions diffèrent', () => {
    const result = groupCopies([
      cand({ parsed: { group: 'FRATRIX', resolution: '1080p', sizeBytes: 4000 * MB }, raw: { title: 'Alpha 2024' } }),
      cand({ parsed: { group: 'FRATRIX', resolution: '720p', sizeBytes: 4000 * MB }, raw: { title: 'Beta 2024' } }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('fusionne un même infoHash et garde les fichiers distincts (fileIdx différents)', () => {
    const result = groupCopies([
      cand({ parsed: { infoHash: HASH_A, fileIdx: 0 }, raw: { title: 'file0', sourceName: 'S0' } }),
      cand({ parsed: { infoHash: HASH_A, fileIdx: 1 }, raw: { title: 'file1', sourceName: 'S1' } }),
      cand({ parsed: { infoHash: HASH_A, fileIdx: 1 }, raw: { title: 'file1-dup', sourceName: 'S1bis' } }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.copies.map((copy) => copy.fileIdx)).toEqual([0]);
    expect(result[1]?.copies.map((copy) => copy.sourceName)).toEqual(['S1']);
  });

  it('choisit le représentant cached avant les seeders', () => {
    const result = groupCopies([
      cand({ parsed: { infoHash: HASH_A, seeders: 500 }, raw: { title: 'popular', sourceName: 'P' }, cached: false }),
      cand({ parsed: { infoHash: HASH_A, seeders: 1 }, raw: { title: 'cached', sourceName: 'C' }, cached: true }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.raw.sourceName).toBe('C');
  });

  it('choisit le représentant au plus de seeders, puis l URL directe', () => {
    const bySeeders = groupCopies([
      cand({ parsed: { seeders: 3 }, raw: { title: 'Movie 2024', sourceName: 'low' } }),
      cand({ parsed: { seeders: 40 }, raw: { title: 'movie 2024', sourceName: 'high' } }),
    ]);
    expect(bySeeders[0]?.raw.sourceName).toBe('high');

    const byDirect = groupCopies([
      cand({ raw: { title: 'Movie 2024', sourceName: 'torrent' } }),
      cand({ raw: { title: 'movie 2024', sourceName: 'direct', url: 'https://cdn.example/file.mkv' } }),
    ]);
    expect(byDirect[0]?.raw.sourceName).toBe('direct');
  });

  it('fusionne les métadonnées : langues, audio, hdr en union ; canaux le plus riche ; drapeaux en OR', () => {
    const result = groupCopies([
      cand({
        parsed: { languages: ['fr'], audio: ['DDP'], hdr: [], channels: '2.0', frVariant: 'VOSTFR', subsFr: false, multi: false, seeders: 50 },
        raw: { title: 'Movie 2024' },
      }),
      cand({
        parsed: { languages: ['en'], audio: ['AAC', 'DDP'], hdr: ['HDR10'], channels: '5.1', frVariant: 'VFQ', subsFr: true, multi: true },
        raw: { title: 'movie 2024' },
        cached: true,
      }),
    ]);
    const merged = result[0];
    expect(merged?.parsed.languages).toEqual(['fr', 'en']);
    expect(merged?.parsed.audio).toEqual(['DDP', 'AAC']);
    expect(merged?.parsed.hdr).toEqual(['HDR10']);
    expect(merged?.parsed.channels).toBe('5.1');
    expect(merged?.parsed.frVariant).toBe('VFQ');
    expect(merged?.parsed.subsFr).toBe(true);
    expect(merged?.parsed.multi).toBe(true);
    expect(merged?.cached).toBe(true);
  });

  it('garde une variante FR exacte plutôt que VFQ ou sous-titres seuls', () => {
    const result = groupCopies([
      cand({ parsed: { frVariant: 'VOSTFR' }, raw: { title: 'Movie 2024' } }),
      cand({ parsed: { frVariant: 'VFF' }, raw: { title: 'movie 2024' } }),
      cand({ parsed: { frVariant: 'VFQ' }, raw: { title: 'MOVIE 2024' } }),
    ]);
    expect(result[0]?.parsed.frVariant).toBe('VFF');
  });

  it('ordonne les copies : cachées d abord, puis seeders décroissants, puis directes', () => {
    const result = groupCopies([
      cand({ parsed: { seeders: 5 }, raw: { title: 'Movie 2024', sourceName: 'seed5' } }),
      cand({ parsed: { seeders: 1 }, raw: { title: 'movie 2024', sourceName: 'cachedOne' }, cached: true }),
      cand({ parsed: { seeders: 50 }, raw: { title: 'MOVIE 2024', sourceName: 'seed50' } }),
      cand({ raw: { title: 'Movie 2024', sourceName: 'direct', url: 'https://cdn.example/a.mkv' } }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.copies.map((copy) => copy.sourceName)).toEqual(['cachedOne', 'seed50', 'seed5', 'direct']);
  });

  it('dédoublonne les copies identiques (même hash+fichier, même URL)', () => {
    const result = groupCopies([
      cand({ parsed: { infoHash: HASH_A, fileIdx: 2 }, raw: { title: 'Movie 2024', sourceName: 'first' } }),
      cand({ parsed: { infoHash: HASH_A, fileIdx: 2 }, raw: { title: 'movie 2024', sourceName: 'second' } }),
      cand({ raw: { title: 'Movie 2024', sourceName: 'd1', url: 'https://cdn.example/a.mkv' } }),
      cand({ raw: { title: 'movie 2024', sourceName: 'd2', url: 'https://cdn.example/a.mkv' } }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.copies.map((copy) => copy.sourceName)).toEqual(['first', 'd1']);
  });

  it('renseigne chaque copie avec hash, fichier, URL, nom de fichier, taille, source et état cached', () => {
    const result = groupCopies([
      cand({
        parsed: { infoHash: HASH_B, fileIdx: 3, sizeBytes: 123 },
        raw: { title: 'Movie 2024', filename: 'Movie.2024.mkv', sourceName: 'Torznab' },
        cached: true,
      }),
    ]);
    expect(result[0]?.copies).toEqual([
      { infoHash: HASH_B, fileIdx: 3, filename: 'Movie.2024.mkv', size: 123, sourceName: 'Torznab', cached: true },
    ]);
  });

  it('conserve l ordre d arrivée des groupes et ne modifie pas les entrées', () => {
    const input = [
      cand({ parsed: { infoHash: HASH_A }, raw: { title: 'First', sourceName: 'x' } }),
      cand({ raw: { title: 'Second' } }),
      cand({ parsed: { infoHash: HASH_A }, raw: { title: 'First-bis', sourceName: 'y' } }),
    ];
    const snapshot = structuredClone(input);
    const result = groupCopies(input);
    expect(result.map((group) => group.raw.title)).toEqual(['First', 'Second']);
    expect(input).toEqual(snapshot);
  });

  it('propage languageFallback seulement si tous les membres sont en repli', () => {
    const fallbackOnly = groupCopies([
      cand({ raw: { title: 'Movie 2024' } }),
      cand({ raw: { title: 'movie 2024' } }),
    ].map((c) => ({ ...c, languageFallback: true })));
    expect(fallbackOnly[0]?.languageFallback).toBe(true);

    const mixed = groupCopies([
      { ...cand({ raw: { title: 'Movie 2024' } }), languageFallback: true },
      { ...cand({ raw: { title: 'movie 2024' } }), languageFallback: false },
    ]);
    expect(mixed[0]?.languageFallback).toBe(false);
  });
});
