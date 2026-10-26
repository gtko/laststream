import { describe, expect, it, vi } from 'vitest';
import { isAc3Codec, loadAc3Decoder, sampleToAudioData } from './ac3';

// Compteur d'imports de @mediabunny/ac3 : la factory ne tourne qu'à la première importation du module.
const ac3 = vi.hoisted(() => ({ imports: 0, register: vi.fn() }));
vi.mock('@mediabunny/ac3', () => {
  ac3.imports += 1;
  return { registerAc3Decoder: ac3.register };
});

describe('sampleToAudioData', () => {
  it('convertit via toAudioData (secondes -> µs) et ferme l’échantillon', () => {
    // Un AudioSample mediabunny a un timestamp en secondes ; toAudioData() le sort en µs.
    const data = { timestamp: 1_500_000, numberOfFrames: 1536, sampleRate: 48000 } as unknown as AudioData;
    const sample = { toAudioData: vi.fn(() => data), close: vi.fn() };
    const out = sampleToAudioData(sample);
    expect(out).toBe(data);
    expect(out.timestamp / 1e6).toBe(1.5);
    expect(sample.close).toHaveBeenCalledTimes(1);
  });

  it('ferme l’échantillon même si la conversion échoue', () => {
    const sample = {
      toAudioData: vi.fn(() => {
        throw new Error('boum');
      }),
      close: vi.fn(),
    };
    expect(() => sampleToAudioData(sample)).toThrow('boum');
    expect(sample.close).toHaveBeenCalled();
  });
});

describe('isAc3Codec', () => {
  it('reconnaît ac3 et eac3 seulement', () => {
    expect(isAc3Codec('ac3')).toBe(true);
    expect(isAc3Codec('eac3')).toBe(true);
    expect(isAc3Codec('aac')).toBe(false);
    expect(isAc3Codec('')).toBe(false);
  });
});

describe('chargement du décodeur AC-3', () => {
  it('n’importe @mediabunny/ac3 qu’à la demande, pas à l’import du module', async () => {
    expect(ac3.imports).toBe(0);
    await loadAc3Decoder();
    expect(ac3.imports).toBe(1);
    expect(ac3.register).toHaveBeenCalledTimes(1);
  });
});
