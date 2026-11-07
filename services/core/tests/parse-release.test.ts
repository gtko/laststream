import { describe, expect, it } from 'vitest';
import { parseRawStream, parseRelease } from '../src/parse/index.js';
import type { RawStream } from '../src/types.js';

const GB = 1024 ** 3;
const HASH = 'AbCdEf0123456789AbCdEf0123456789AbCdEf01';
const HASH_LOWER = HASH.toLowerCase();

function stream(overrides: Partial<RawStream> = {}): RawStream {
  return { sourceName: 'Source', sourceKind: 'upstream', ...overrides };
}

describe('parseRelease : noms de release complets (FR et EN)', () => {
  it('FR : FRENCH WEB-DL 1080p DDP 5.1 H264', () => {
    const r = parseRelease('Le.Dernier.Duel.2021.FRENCH.1080p.WEB-DL.DDP5.1.H264-TEAM');
    expect(r).toMatchObject({
      resolution: '1080p',
      height: 1080,
      source: 'WEB-DL',
      codec: 'AVC',
      audio: ['DDP'],
      channels: '5.1',
      languages: ['fr'],
      frVariant: 'FRENCH',
      multi: false,
      subsFr: false,
      group: 'TEAM',
      title: 'Le.Dernier.Duel.2021.FRENCH.1080p.WEB-DL.DDP5.1.H264-TEAM',
    });
  });

  it('FR : MULTi VFF 2160p REMUX HEVC TrueHD Atmos 7.1', () => {
    const r = parseRelease('Mon.Film.2019.MULTi.VFF.2160p.UHD.BluRay.REMUX.HDR10.HEVC.TrueHD.7.1.Atmos-FW');
    expect(r).toMatchObject({
      resolution: '2160p',
      source: 'REMUX',
      codec: 'HEVC',
      hdr: ['HDR10'],
      languages: ['fr', 'multi', 'original'],
      frVariant: 'VFF',
      multi: true,
      channels: '7.1',
      group: 'FW',
    });
    expect(r.audio).toEqual(expect.arrayContaining(['TrueHD', 'Atmos']));
  });

  it('FR : VOSTFR 720p WEBRip, sous-titres FR seulement', () => {
    const r = parseRelease('Serie.S02E05.VOSTFR.720p.WEBRip.x264-NEO');
    expect(r).toMatchObject({
      resolution: '720p',
      source: 'WEBRip',
      codec: 'AVC',
      languages: ['original'],
      frVariant: 'VOSTFR',
      subsFr: true,
      multi: false,
      group: 'NEO',
    });
  });

  it('FR : VFQ 1080p BluRay x265 DTS-HD MA', () => {
    const r = parseRelease('Un.Autre.Film.2022.VFQ.1080p.BluRay.x265.DTS-HD.MA.5.1-ALPHA');
    expect(r).toMatchObject({
      resolution: '1080p',
      source: 'BluRay',
      codec: 'HEVC',
      languages: ['fr'],
      frVariant: 'VFQ',
      channels: '5.1',
      group: 'ALPHA',
    });
    expect(r.audio).toContain('DTS-HD MA');
  });

  it('EN : ENGLISH 2160p REMUX HDR10 HEVC TrueHD Atmos 7.1', () => {
    const r = parseRelease('Oppenheimer.2023.ENGLISH.2160p.UHD.BluRay.REMUX.HDR10.HEVC.TrueHD.7.1.Atmos-EDGE');
    expect(r).toMatchObject({
      resolution: '2160p',
      source: 'REMUX',
      codec: 'HEVC',
      hdr: ['HDR10'],
      languages: ['en'],
      multi: false,
      channels: '7.1',
      group: 'EDGE',
    });
    expect(r.frVariant).toBeUndefined();
  });

  it('EN : sans mention de langue, la piste est supposée VO (original)', () => {
    const r = parseRelease('Some.Movie.2020.2160p.WEB-DL.DDP5.1.HDR10.HEVC-GRP');
    expect(r).toMatchObject({
      resolution: '2160p',
      source: 'WEB-DL',
      codec: 'HEVC',
      languages: ['original'],
      group: 'GRP',
    });
    expect(r.frVariant).toBeUndefined();
  });

  it('EN : BluRay 1080p x264 et canaux 2.0', () => {
    const r = parseRelease('Another.Show.S01E01.1080p.BluRay.x264.AAC2.0-SHOW');
    expect(r).toMatchObject({
      resolution: '1080p',
      source: 'BluRay',
      codec: 'AVC',
      audio: ['AAC'],
      channels: '2.0',
      languages: ['original'],
    });
  });
});

describe('parseRelease : champs complémentaires', () => {
  it('extrait la taille, les seeders et l’infoHash du texte', () => {
    const r = parseRelease(`Film 1080p\n👤 42 💾 1.5 GB ${HASH}`);
    expect(r.sizeBytes).toBe(Math.round(1.5 * GB));
    expect(r.seeders).toBe(42);
    expect(r.infoHash).toBe(HASH_LOWER);
  });

  it('title vaut le texte fourni', () => {
    expect(parseRelease('Film.2024.1080p').title).toBe('Film.2024.1080p');
  });
});

describe('parseRawStream : texte Torrentio et champs structurés', () => {
  it('description Torrentio : seeders 123 et taille 4,2 Go', () => {
    const r = parseRawStream(
      stream({
        name: 'Torrentio\n1080p',
        title: 'Film.2024.VFF.1080p.WEB-DL.DDP5.1.H264-GRP\n👤 123 💾 4.2 GB ⚙️ YggTorrent',
      }),
    );
    expect(r.seeders).toBe(123);
    expect(r.sizeBytes).toBe(Math.round(4.2 * GB));
    expect(r.resolution).toBe('1080p');
    expect(r.frVariant).toBe('VFF');
    // Le codec et le groupe du titre restent reconnus malgré la description accolée.
    expect(r.codec).toBe('AVC');
    expect(r.group).toBe('GRP');
  });

  it('fusionne filename, title, name et description sans doublon de texte', () => {
    const r = parseRawStream(
      stream({
        filename: 'Film.2024.MULTi.1080p.WEB-DL.H264-XYZ.mkv',
        title: 'Film.2024.MULTi.1080p.WEB-DL.H264-XYZ.mkv',
        description: 'Qualité\n💾 3 GB 👤 9',
      }),
    );
    expect(r.languages).toEqual(['fr', 'multi', 'original']);
    expect(r.resolution).toBe('1080p');
    expect(r.sizeBytes).toBe(3 * GB);
    expect(r.seeders).toBe(9);
    expect(r.title).toBe('Film.2024.MULTi.1080p.WEB-DL.H264-XYZ.mkv');
  });

  it('les champs structurés de la source l’emportent sur le texte', () => {
    const r = parseRawStream(
      stream({
        title: 'Film.2024.1080p.WEB-DL\n👤 5 💾 9 GB',
        sizeBytes: 2 * GB,
        seeders: 77,
        fileIdx: 3,
      }),
    );
    expect(r.sizeBytes).toBe(2 * GB);
    expect(r.seeders).toBe(77);
    expect(r.fileIdx).toBe(3);
  });

  it('l’infoHash structuré passe en minuscules et prime sur celui du texte et du magnet', () => {
    const magnet = `magnet:?xt=urn:btih:${'c'.repeat(40)}&dn=Film`;
    const r = parseRawStream(stream({ title: `Film 1080p ${HASH}`, infoHash: HASH, magnet }));
    expect(r.infoHash).toBe(HASH_LOWER);
  });

  it('sans infoHash structuré, lit celui du magnet', () => {
    const magnet = `magnet:?xt=urn:btih:${HASH_LOWER}&dn=Film`;
    const r = parseRawStream(stream({ title: 'Film.2024.1080p.WEB-DL', magnet }));
    expect(r.infoHash).toBe(HASH_LOWER);
  });

  it('ignore le nom de la source configurée : il ne doit pas créer une fausse langue FR', () => {
    const r = parseRawStream(
      stream({
        sourceName: 'FR Indexeur',
        sourceKind: 'torznab',
        name: 'FR Indexeur',
        title: 'Film.2024.1080p.WEB-DL.H264-GRP',
      }),
    );
    expect(r.languages).toEqual(['original']);
    expect(r.frVariant).toBeUndefined();
  });
});
