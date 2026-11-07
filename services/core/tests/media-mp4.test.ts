import { describe, expect, it } from 'vitest';
import { findMoovOffset, isMp4Head, parseMoov, scanTopLevelBoxes } from '../src/media/mp4.js';
import { box, buildMp4, largeBox, moovOffsetOf, packLanguage } from './media-fixtures.js';

describe('scanTopLevelBoxes et findMoovOffset', () => {
  it('trouve le moov quand il est au début (moov-first)', () => {
    const file = buildMp4({ layout: 'moov-first', mdatBytes: 1000 });

    expect(findMoovOffset(file)).toBe(moovOffsetOf(file));
    expect(scanTopLevelBoxes(file).moov).toMatchObject({ offset: moovOffsetOf(file), complete: true });
  });

  it('ne trouve pas le moov dans un en-tête coupé avant le mdat et indique la boîte suivante', () => {
    const file = buildMp4({ layout: 'moov-last', mdatBytes: 5_000_000 });
    const head = file.subarray(0, 1000);

    expect(findMoovOffset(head)).toBeUndefined();
    expect(scanTopLevelBoxes(head).nextOffset).toBe(moovOffsetOf(file));
  });

  it('signale un moov commencé dans la zone lisible mais coupé', () => {
    const file = buildMp4({ layout: 'moov-first' });
    const offset = moovOffsetOf(file);
    const head = file.subarray(0, offset + 30);

    expect(scanTopLevelBoxes(head).moov).toEqual({ offset, size: expect.any(Number) as number, complete: false });
    expect(findMoovOffset(head)).toBe(offset);
  });

  it('gère une boîte à taille 64 bits (largesize) avant le moov', () => {
    const source = buildMp4({ layout: 'moov-first' });
    const ftyp = box('ftyp', Buffer.from('isom'));
    const big = largeBox('free', Buffer.alloc(40));
    const file = Buffer.concat([ftyp, big, source.subarray(moovOffsetOf(source))]);

    expect(findMoovOffset(file)).toBe(ftyp.length + big.length);
  });

  it('gère une boîte de taille 0 (jusqu à la fin) sans moov exploitable', () => {
    const toEof = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('mdat'), Buffer.alloc(100)]);
    expect(scanTopLevelBoxes(toEof)).toEqual({});
  });

  it('détecte la signature ftyp en position 4', () => {
    expect(isMp4Head(buildMp4({ layout: 'moov-first' }))).toBe(true);
    expect(isMp4Head(Buffer.from('1a45dfa300000000', 'hex'))).toBe(false);
  });
});

describe('parseMoov', () => {
  it('lit langue (3 lettres packées), codec fourcc, canaux et durée', () => {
    const file = buildMp4({ layout: 'moov-first', durationSec: 5400 });
    const moov = file.subarray(moovOffsetOf(file));

    const info = parseMoov(moov);

    expect(info.tracks).toEqual([
      { handler: 'soun', language: 'fre', codec: 'ec-3', channels: 6 },
      { handler: 'soun', language: 'eng', codec: 'mp4a', channels: 2 },
      { handler: 'subt', language: 'fre', codec: 'tx3g' },
    ]);
    expect(info.durationSec).toBeCloseTo(5400, 6);
  });

  it("renvoie 'und' pour une langue absente ou invalide", () => {
    const file = buildMp4({
      layout: 'moov-first',
      tracks: [{ handler: 'soun', language: 'und', codec: 'ac-3', channels: 6 }],
    });

    expect(parseMoov(file.subarray(moovOffsetOf(file))).tracks[0]?.language).toBe('und');
    expect(packLanguage('und')).toBe(0x55c4);
  });

  it('renvoie les pistes lues quand le moov est tronqué au milieu de la deuxième piste', () => {
    const file = buildMp4({ layout: 'moov-first' });
    const moov = file.subarray(moovOffsetOf(file));
    const cut = moov.indexOf('mp4a') + 4;

    const info = parseMoov(moov.subarray(0, cut));

    expect(info.tracks[0]).toEqual({ handler: 'soun', language: 'fre', codec: 'ec-3', channels: 6 });
    expect(info.tracks.length).toBeLessThanOrEqual(2);
  });

  it('renvoie un résultat vide si le buffer ne commence pas par un moov', () => {
    expect(parseMoov(Buffer.alloc(64))).toEqual({ tracks: [] });
  });
});
