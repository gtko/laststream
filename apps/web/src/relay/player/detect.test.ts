import { describe, expect, it, vi } from 'vitest';
import { checkSupport, codecLabel, type CodecEnv } from './detect';
import type { AudioTrackInfo, VideoTrackInfo } from './types';

const AVC: VideoTrackInfo = {
  codec: 'avc',
  codecString: 'avc1.64001f',
  width: 320,
  height: 240,
  description: new Uint8Array([1, 2, 3]),
};
const HEVC: VideoTrackInfo = { codec: 'hevc', codecString: 'hvc1.1.6.L93.B0', width: 1920, height: 1080 };
const AAC: AudioTrackInfo = { codec: 'aac', codecString: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 };
const OPUS: AudioTrackInfo = { codec: 'opus', codecString: 'opus', sampleRate: 48000, numberOfChannels: 2 };

type Verdict = boolean | 'throw';

/** Faux décodeurs : `video` et `audio` décident de la réponse à partir de la configuration demandée. */
function mockEnv(video: (cfg: VideoDecoderConfig) => Verdict, audio: (cfg: AudioDecoderConfig) => Verdict): CodecEnv {
  return {
    VideoDecoder: {
      isConfigSupported: vi.fn(async (cfg: VideoDecoderConfig) => {
        const v = video(cfg);
        if (v === 'throw') throw new TypeError('invalid config');
        return { supported: v };
      }),
    },
    AudioDecoder: {
      isConfigSupported: vi.fn(async (cfg: AudioDecoderConfig) => {
        const v = audio(cfg);
        if (v === 'throw') throw new TypeError('invalid config');
        return { supported: v };
      }),
    },
  };
}

const allSupported = mockEnv(
  () => true,
  () => true,
);

describe('checkSupport', () => {
  it('accepte un fichier dont toutes les pistes sont décodables', async () => {
    const result = await checkSupport({ video: AVC, audio: AAC }, allSupported);
    expect(result).toEqual({ ok: true, reason: null, codec: null });
  });

  it('transmet la chaîne de codec, les dimensions et le descriptif au décodeur', async () => {
    const env = mockEnv(
      () => true,
      () => true,
    );
    await checkSupport({ video: AVC, audio: AAC }, env);
    expect(env.VideoDecoder!.isConfigSupported).toHaveBeenCalledWith({
      codec: 'avc1.64001f',
      codedWidth: 320,
      codedHeight: 240,
      description: new Uint8Array([1, 2, 3]),
    });
    expect(env.AudioDecoder!.isConfigSupported).toHaveBeenCalledWith({
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
    });
  });

  it('refuse le HEVC avec un message en français qui nomme le codec', async () => {
    const env = mockEnv(
      (cfg) => !cfg.codec.startsWith('hvc1'),
      () => true,
    );
    const result = await checkSupport({ video: HEVC, audio: AAC }, env);
    expect(result).toEqual({
      ok: false,
      codec: 'H.265 (HEVC)',
      reason: 'Codec vidéo H.265 (HEVC) non décodable dans ce navigateur.',
    });
  });

  it("signale un codec audio refusé", async () => {
    const env = mockEnv(
      () => true,
      () => false,
    );
    const result = await checkSupport({ video: AVC, audio: OPUS }, env);
    expect(result).toMatchObject({ ok: false, codec: 'Opus' });
    expect(result.ok === false && result.reason).toBe('Codec audio Opus non décodable dans ce navigateur.');
  });

  it('traite une configuration rejetée (exception) comme non décodable', async () => {
    const env = mockEnv(
      () => 'throw',
      () => true,
    );
    const result = await checkSupport({ video: AVC, audio: null }, env);
    expect(result).toMatchObject({ ok: false, codec: 'H.264 (AVC)' });
  });

  it("signale l'absence de WebCodecs sans lever d'erreur", async () => {
    const result = await checkSupport({ video: AVC, audio: null }, {});
    expect(result).toEqual({
      ok: false,
      codec: 'H.264 (AVC)',
      reason: 'WebCodecs (VideoDecoder) indisponible dans ce navigateur.',
    });
  });

  it('accepte un fichier audio seul et refuse un fichier vide', async () => {
    expect(await checkSupport({ video: null, audio: AAC }, allSupported)).toMatchObject({ ok: true });
    expect(await checkSupport({ video: null, audio: null }, allSupported)).toMatchObject({ ok: false });
  });

  it('omet les dimensions inconnues (0) de la configuration', async () => {
    const env = mockEnv(
      () => true,
      () => true,
    );
    await checkSupport({ video: { ...AVC, width: 0, height: 0, description: undefined }, audio: null }, env);
    const sent = vi.mocked(env.VideoDecoder!.isConfigSupported).mock.calls[0][0];
    expect(sent).toEqual({ codec: 'avc1.64001f' });
  });
});

describe('codecLabel', () => {
  it('donne des libellés lisibles', () => {
    expect(codecLabel('avc')).toBe('H.264 (AVC)');
    expect(codecLabel('av1')).toBe('AV1');
    expect(codecLabel('xyz')).toBe('XYZ');
    expect(codecLabel('')).toBe('inconnu');
  });
});
