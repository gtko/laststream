// Sonde des capacités de décodage de l'invité : codes WebCodecs acceptés, repli AC-3 / E-AC-3, erreurs tolérées.
import { describe, expect, it, vi } from 'vitest';
import { DECODE_CAPS } from '../protocol';
import { ac3FallbackAvailable, detectDecodeCaps, type CodecEnv } from './detect';

type Verdict = boolean | 'throw';

/** Faux décodeurs : `video` et `audio` répondent à partir du codec demandé. */
function env(video: (codec: string) => Verdict, audio: (codec: string) => Verdict): CodecEnv {
  const answer = (v: Verdict): Promise<{ supported: boolean }> => {
    if (v === 'throw') return Promise.reject(new TypeError('config refusée'));
    return Promise.resolve({ supported: v });
  };
  return {
    VideoDecoder: { isConfigSupported: vi.fn((cfg: VideoDecoderConfig) => answer(video(cfg.codec))) },
    AudioDecoder: { isConfigSupported: vi.fn((cfg: AudioDecoderConfig) => answer(audio(cfg.codec))) },
  };
}

const no = (_codec?: string): Verdict => false;

describe('sonde des capacités de décodage', () => {
  it('ne retient que les codecs acceptés, dans l’ordre de DECODE_CAPS', async () => {
    const e = env((c) => c.startsWith('avc1'), (c) => c === 'mp4a.40.2' || c === 'opus');
    expect(await detectDecodeCaps(e, () => false)).toEqual(['h264', 'aac', 'opus']);
  });

  it('AC-3 et E-AC-3 : vrais si le navigateur les accepte, ou si le repli AC-3 est disponible', async () => {
    const e = env(no, no);
    expect(await detectDecodeCaps(e, () => true)).toEqual(['ac3', 'eac3']);
    expect(await detectDecodeCaps(e, () => false)).toEqual([]);
  });

  it('AC-3 accepté nativement sans repli : seule la capacité ac3 est vraie', async () => {
    const e = env(no, (c) => c === 'ac-3');
    expect(await detectDecodeCaps(e, () => false)).toEqual(['ac3']);
  });

  it('une configuration refusée par exception compte pour non décodable, sans interrompre la sonde', async () => {
    const e = env((c) => (c.startsWith('hvc1') ? 'throw' : c.startsWith('av01')), (c) => (c === 'flac' ? 'throw' : no(c)));
    expect(await detectDecodeCaps(e, () => false)).toEqual(['av1']);
  });

  it('sans WebCodecs : aucune capacité vidéo ni audio (repli AC-3 seul possible)', async () => {
    expect(await detectDecodeCaps({}, () => false)).toEqual([]);
    expect(await detectDecodeCaps({}, () => true)).toEqual(['ac3', 'eac3']);
  });

  it('sonde tous les codecs et seulement avec des configurations génériques (pas de fichier, pas d’URL)', async () => {
    const e = env(() => true, () => true);
    const all = await detectDecodeCaps(e, () => true);
    expect(all).toEqual([...DECODE_CAPS]);
    const calls = [...(e.VideoDecoder?.isConfigSupported as ReturnType<typeof vi.fn>).mock.calls, ...(e.AudioDecoder?.isConfigSupported as ReturnType<typeof vi.fn>).mock.calls];
    for (const [cfg] of calls) expect(Object.keys(cfg).every((k) => ['codec', 'sampleRate', 'numberOfChannels'].includes(k))).toBe(true);
  });

  it('le repli AC-3 disponible dépend de WebAssembly (booléen)', () => {
    expect(typeof ac3FallbackAvailable()).toBe('boolean');
  });
});
