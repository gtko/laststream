import { describe, expect, it, vi } from 'vitest';
import { isAc3Codec, sampleToAudioData } from './ac3';

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
