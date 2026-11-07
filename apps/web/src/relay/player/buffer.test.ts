import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_DECODED_AHEAD_SEC,
  GUEST_BUFFER_MAX_BYTES,
  GUEST_BUFFER_TARGET_SEC,
  placeSegment,
  ReadAheadReader,
} from './buffer';
import type { RangeReader } from './types';

const MIB = 1024 * 1024;

describe('constantes du tampon', () => {
  it("l'audio décodé d'avance tient un blocage du fil principal d'environ 1 s (au moins 3 s)", () => {
    expect(AUDIO_DECODED_AHEAD_SEC).toBeGreaterThanOrEqual(3);
    expect(AUDIO_DECODED_AHEAD_SEC).toBe(3.5);
  });

  it('le tampon compressé vise au moins 30 s devant la position', () => {
    expect(GUEST_BUFFER_TARGET_SEC).toBeGreaterThanOrEqual(30);
  });

  it('la borne mémoire du tampon compressé vaut au moins 256 Mio', () => {
    expect(GUEST_BUFFER_MAX_BYTES).toBeGreaterThanOrEqual(256 * MIB);
  });
});

describe('placeSegment (ordonnancement sans trou)', () => {
  const RATE = 48000;
  const FRAMES = 1536; // une trame AC-3 : 32 ms à 48 kHz

  it('place un segment futur à sa place sur le calage média ↔ horloge', () => {
    // Ancre : média 10 s == horloge 50 s. Segment à 10,5 s -> 50,5 s.
    const p = placeSegment({ media: 10, clock: 50 }, RATE, Math.round(10.5 * RATE), FRAMES, 50.2);
    expect(p.skipped).toBe(false);
    expect(p.offset).toBe(0);
    expect(p.when).toBeCloseTo(50.5, 9);
  });

  it('chaîne 10 000 segments contigus sans trou ni chevauchement, même avec des horodatages en µs arrondis', () => {
    const anchor = { media: 2, clock: 7 };
    let previousEnd: number | null = null;
    let maxGap = 0;
    for (let n = 0; n < 10_000; n++) {
      // Horodatage tel que le fournit AudioData : entier en µs, arrondi.
      const startFrame = n * FRAMES;
      const tsUs = Math.round((startFrame / RATE) * 1e6);
      const startFromTs = Math.round((tsUs / 1e6) * RATE);
      const p = placeSegment(anchor, RATE, startFromTs, FRAMES, 0);
      if (previousEnd !== null) maxGap = Math.max(maxGap, Math.abs(p.when - previousEnd));
      previousEnd = p.when + FRAMES / RATE;
    }
    // Aucune dérive accumulée : l'écart reste au niveau de l'arithmétique flottante (sous la microseconde).
    expect(maxGap).toBeLessThan(1e-9);
  });

  it('démarre un segment en retard maintenant, décalé dans le segment', () => {
    // Segment à 9,99 s (ancre 10 s == horloge 50 s) : il devait commencer à 49,99 s ; on est à 50,005 s.
    // Il reste 1 536 − 720 images à jouer : il démarre à 50,005 s, avec un décalage de 720 images (0,015 s).
    const p = placeSegment({ media: 10, clock: 50 }, RATE, Math.round(9.99 * RATE), FRAMES, 50.005);
    expect(p.skipped).toBe(false);
    expect(p.when).toBe(50.005);
    expect(p.offset).toBeCloseTo(720 / RATE, 9);
  });

  it('écarte un segment entièrement passé', () => {
    const p = placeSegment({ media: 10, clock: 50 }, RATE, Math.round(9.0 * RATE), FRAMES, 60);
    expect(p.skipped).toBe(true);
  });
});

/** Source en mémoire : chaque lecture renvoie `end - start` octets, et on compte les appels. */
function fakeSource(size: number): RangeReader & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    size: async () => size,
    read: async (start, end) => {
      calls.push([start, end]);
      const out = new Uint8Array(end - start);
      for (let i = 0; i < out.length; i++) out[i] = (start + i) % 251;
      return out;
    },
  };
}

describe('ReadAheadReader (tampon compressé)', () => {
  it('précharge au-delà de la position jusqu’à la cible au débit moyen', async () => {
    // 100 s pour 100 Mio : 1 Mio/s. Cible 30 s.
    const source = fakeSource(100 * MIB);
    const reader = new ReadAheadReader(source, { targetSec: 30, maxBytes: 256 * MIB });
    reader.setTimeline(100, 100 * MIB);
    await vi.waitFor(() => expect(reader.aheadSec(0)).toBeGreaterThanOrEqual(30));
    expect(reader.aheadSec(0)).toBeLessThan(33);
    expect(reader.aheadSec(10)).toBeCloseTo(reader.aheadSec(0) - 10, 6);
  });

  it('borne la mémoire : pas plus de maxBytes conservés', async () => {
    const source = fakeSource(100 * MIB);
    const reader = new ReadAheadReader(source, { targetSec: 30, maxBytes: 6 * MIB });
    reader.setTimeline(100, 100 * MIB);
    await vi.waitFor(() => expect(reader.bufferedBytes).toBeGreaterThan(2 * MIB));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.bufferedBytes).toBeLessThanOrEqual(6 * MIB);
  });

  it('sert une lecture couverte par le tampon sans solliciter la source, et passe les autres à la source', async () => {
    const source = fakeSource(100 * MIB);
    const reader = new ReadAheadReader(source, { targetSec: 4, maxBytes: 256 * MIB });
    reader.setTimeline(100, 100 * MIB);
    await vi.waitFor(() => expect(reader.aheadSec(0)).toBeGreaterThanOrEqual(4));
    const callsBefore = source.calls.length;
    const hit = await reader.read(10, 20);
    expect(source.calls.length).toBe(callsBefore);
    expect(Array.from(hit)).toEqual(Array.from({ length: 10 }, (_, i) => (10 + i) % 251));
    // Plage hors du tampon (au-delà du préchargement) : passe à la source.
    await reader.read(90 * MIB, 90 * MIB + 16);
    expect(source.calls.length).toBe(callsBefore + 1);
  });

  it('évince derrière la position et repart de la position après un saut', async () => {
    const source = fakeSource(100 * MIB);
    const reader = new ReadAheadReader(source, { targetSec: 5, maxBytes: 256 * MIB });
    reader.setTimeline(100, 100 * MIB);
    await vi.waitFor(() => expect(reader.aheadSec(0)).toBeGreaterThanOrEqual(5));
    const before = reader.bufferedBytes;
    reader.setPosition(4);
    expect(reader.bufferedBytes).toBeLessThan(before);
    // Saut à 60 s : le tampon repart de là et précharge autour.
    reader.setPosition(60);
    await vi.waitFor(() => expect(reader.aheadSec(60)).toBeGreaterThanOrEqual(5));
    expect(reader.aheadSec(60)).toBeLessThan(10);
  });

  it('ne fait aucune lecture anticipée tant que la durée est inconnue au-delà de l’en-tête', async () => {
    const source = fakeSource(100 * MIB);
    const reader = new ReadAheadReader(source, { targetSec: 30, maxBytes: 256 * MIB });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.calls.length).toBe(0);
    expect(reader.aheadSec(0)).toBe(0);
  });

  it('arrête le préchargement à la fermeture', async () => {
    const source = fakeSource(100 * MIB);
    const reader = new ReadAheadReader(source, { targetSec: 30, maxBytes: 256 * MIB });
    reader.setTimeline(100, 100 * MIB);
    reader.close();
    const calls = source.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.calls.length).toBeLessThanOrEqual(calls + 1);
    expect(reader.bufferedBytes).toBe(0);
  });
});
