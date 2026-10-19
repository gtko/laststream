import { describe, expect, it, vi } from 'vitest';
import type { CodecEnv } from './detect';
import { registerFallback, resolvePlayback, unsupportedMessage, type FallbackHandler } from './fallback';
import type { AudioTrackInfo, VideoTrackInfo } from './types';

const AVC: VideoTrackInfo = { codec: 'avc', codecString: 'avc1.64001f', width: 320, height: 240 };
const HEVC: VideoTrackInfo = { codec: 'hevc', codecString: 'hvc1.1.6.L93.B0', width: 1920, height: 1080 };
const AAC: AudioTrackInfo = { codec: 'aac', codecString: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 };

const hevcRefused: CodecEnv = {
  VideoDecoder: { isConfigSupported: async (cfg) => ({ supported: !cfg.codec.startsWith('hvc1') }) },
  AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
};
const allOk: CodecEnv = {
  VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
  AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
};

describe('resolvePlayback', () => {
  it('lit en natif quand WebCodecs suffit', async () => {
    expect(await resolvePlayback({ video: AVC, audio: AAC }, allOk)).toEqual({ kind: 'native' });
  });

  it('renvoie un résultat unsupported avec le message français, sans lever d’erreur', async () => {
    const plan = await resolvePlayback({ video: HEVC, audio: AAC }, hevcRefused);
    expect(plan).toEqual({
      kind: 'unsupported',
      message:
        "Format non pris en charge dans ce navigateur (codec H.265 (HEVC)). Le repli vlc.js n'est pas disponible dans cette version.",
    });
  });

  it('formule le message sans codec quand aucun codec n’est en cause', () => {
    expect(unsupportedMessage('')).toBe(
      "Format non pris en charge dans ce navigateur. Le repli vlc.js n'est pas disponible dans cette version.",
    );
  });
});

describe('registerFallback (point d’extension)', () => {
  it('utilise le repli qui renvoie un plan, avec le contexte du refus', async () => {
    const handler = vi.fn<FallbackHandler>(() => ({ kind: 'native' }));
    const unregister = registerFallback(handler);
    try {
      const plan = await resolvePlayback({ video: HEVC, audio: AAC }, hevcRefused);
      expect(plan).toEqual({ kind: 'native' });
      const ctx = handler.mock.calls[0][0];
      expect(ctx.tracks.video).toBe(HEVC);
      expect(ctx.support).toMatchObject({ ok: false, codec: 'H.265 (HEVC)' });
    } finally {
      unregister();
    }
  });

  it('passe au suivant si le repli renvoie null, et ne garde pas les repli retirés', async () => {
    const decline = registerFallback(() => null);
    const other = registerFallback(() => ({ kind: 'unsupported', message: 'autre moteur' }));
    expect(await resolvePlayback({ video: HEVC, audio: null }, hevcRefused)).toEqual({
      kind: 'unsupported',
      message: 'autre moteur',
    });
    other();
    decline();
    expect(await resolvePlayback({ video: HEVC, audio: null }, hevcRefused)).toMatchObject({
      kind: 'unsupported',
      message: expect.stringContaining('(codec H.265 (HEVC))'),
    });
  });
});
