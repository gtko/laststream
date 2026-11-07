// Message de capacités de décodage (invité -> hôte, trame 7) : encodage, décodage, masques et réception par le lien hôte.
import { describe, expect, it, vi } from 'vitest';
import { RangeServer } from './host';
import { memoryChannelPair } from './memory';
import { DECODE_CAPS, capsFromMask, capsMask, decodeFrame, encodeCaps } from './protocol';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const src = { size: async () => 1000, read: async (s: number, e: number) => new Uint8Array(e - s) };

describe('message de capacités : trame', () => {
  it('encode la trame 7 : type, identifiant 0, masque u32 big-endian', () => {
    const bytes = encodeCaps(0x01020304);
    expect(Array.from(bytes)).toEqual([7, 0, 0, 0, 0, 1, 2, 3, 4]);
  });

  it('décodage : même masque, et trame malformée rejetée', () => {
    expect(decodeFrame(encodeCaps(17))).toEqual({ t: 'caps', mask: 17 });
    expect(decodeFrame(new Uint8Array([7, 0, 0, 0, 1, 0, 0, 0, 0]))).toBeNull(); // identifiant non nul
    expect(decodeFrame(new Uint8Array([7, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // trop courte
  });

  it('refuse un masque hors bornes à l’encodage', () => {
    expect(() => encodeCaps(-1)).toThrow();
    expect(() => encodeCaps(2 ** 32)).toThrow();
    expect(() => encodeCaps(1.5)).toThrow();
  });
});

describe('message de capacités : noms et bits', () => {
  it('le premier bit est h264 et la liste reste dans l’ordre annoncé', () => {
    expect(DECODE_CAPS).toEqual(['h264', 'hevc', 'av1', 'vp9', 'aac', 'opus', 'ac3', 'eac3', 'dts', 'flac']);
    expect(capsMask(['h264'])).toBe(1);
    expect(capsMask(['flac'])).toBe(1 << 9);
  });

  it('masque et liste se correspondent, sans les noms ni les bits inconnus', () => {
    const mask = capsMask(['aac', 'h264', 'inconnu']);
    expect(mask).toBe((1 << 0) | (1 << 4));
    expect(capsFromMask(mask)).toEqual(['h264', 'aac']);
    expect(capsFromMask(0xffffffff)).toEqual([...DECODE_CAPS]);
    expect(capsFromMask(0)).toEqual([]);
  });
});

describe('message de capacités : réception par le lien hôte', () => {
  it('le lien hôte transmet le masque annoncé par l’invité', async () => {
    const [hostCh, guestCh] = memoryChannelPair(0);
    const onCaps = vi.fn();
    const server = new RangeServer(src, hostCh, { onCaps });
    guestCh.send(encodeCaps(capsMask(['h264', 'aac', 'eac3'])));
    await wait(10);
    expect(onCaps).toHaveBeenCalledTimes(1);
    expect(onCaps).toHaveBeenCalledWith(capsMask(['h264', 'aac', 'eac3']));
    server.close();
  });
});
