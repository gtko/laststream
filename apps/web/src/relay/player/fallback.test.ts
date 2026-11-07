import { describe, expect, it, vi } from 'vitest';
import type { CodecEnv } from './detect';
import { AUDIO_UNSUPPORTED_NOTE, registerFallback, resolvePlayback, unsupportedMessage, type FallbackHandler } from './fallback';
import type { AudioTrackInfo, VideoTrackInfo } from './types';

const AVC: VideoTrackInfo = { codec: 'avc', codecString: 'avc1.64001f', width: 320, height: 240 };
const HEVC: VideoTrackInfo = { codec: 'hevc', codecString: 'hvc1.1.6.L93.B0', width: 1920, height: 1080 };
const AAC: AudioTrackInfo = { codec: 'aac', codecString: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 };
const EAC3: AudioTrackInfo = { codec: 'eac3', codecString: 'ec-3', sampleRate: 48000, numberOfChannels: 6 };

const noAc3 = async (): Promise<void> => {
  throw new Error('chargement impossible');
};

const hevcRefused: CodecEnv = {
  VideoDecoder: { isConfigSupported: async (cfg) => ({ supported: !cfg.codec.startsWith('hvc1') }) },
  AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
};
const allOk: CodecEnv = {
  VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
  AudioDecoder: { isConfigSupported: async () => ({ supported: true }) },
};
/** Vidéo décodable, son refusé (E-AC-3 par exemple). */
const audioRefused: CodecEnv = {
  VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
  AudioDecoder: { isConfigSupported: async () => ({ supported: false }) },
};

describe('resolvePlayback', () => {
  it('lit en natif quand WebCodecs suffit', async () => {
    expect(await resolvePlayback({ video: AVC, audio: AAC }, allOk)).toEqual({ kind: 'native' });
  });

  it('renvoie un résultat unsupported avec le message français, sans lever d’erreur', async () => {
    const plan = await resolvePlayback({ video: HEVC, audio: AAC }, hevcRefused);
    expect(plan).toEqual({
      kind: 'unsupported',
      message: 'Format non pris en charge dans ce navigateur (codec H.265 (HEVC)).',
    });
  });

  it('formule le message sans codec quand aucun codec n’est en cause, sans renvoi à vlc.js', () => {
    expect(unsupportedMessage('')).toBe('Format non pris en charge dans ce navigateur.');
    expect(unsupportedMessage('E-AC-3')).not.toMatch(/vlc/i);
  });

  it('lit la vidéo sans son, avec une note, quand seul le son (E-AC-3) est refusé', async () => {
    const plan = await resolvePlayback({ video: AVC, audio: EAC3 }, audioRefused, noAc3);
    expect(plan).toEqual({ kind: 'native', withoutAudio: true, note: 'Son non pris en charge par ce navigateur' });
    expect(AUDIO_UNSUPPORTED_NOTE).toBe('Son non pris en charge par ce navigateur');
  });

  it('refuse un fichier dont la vidéo est refusée, même si le son passe', async () => {
    const plan = await resolvePlayback({ video: HEVC, audio: AAC }, hevcRefused);
    expect(plan.kind).toBe('unsupported');
  });

  it('refuse un fichier audio seul dont le son est refusé (rien à lire sans son)', async () => {
    const plan = await resolvePlayback({ video: null, audio: EAC3 }, audioRefused, noAc3);
    expect(plan).toEqual({ kind: 'unsupported', message: 'Format non pris en charge dans ce navigateur (codec E-AC-3).' });
  });
});

describe('resolvePlayback : AC-3 / E-AC-3 par mediabunny', () => {
  const AC3: AudioTrackInfo = { codec: 'ac3', codecString: 'ac-3', sampleRate: 48000, numberOfChannels: 2 };

  it('natif d’abord : aucun chargement quand AudioDecoder accepte', async () => {
    const load = vi.fn(async () => undefined);
    expect(await resolvePlayback({ video: AVC, audio: EAC3 }, allOk, load)).toEqual({ kind: 'native' });
    expect(load).not.toHaveBeenCalled();
  });

  it('charge le décodeur wasm quand AudioDecoder refuse ac-3 / ec-3', async () => {
    const load = vi.fn(async () => undefined);
    expect(await resolvePlayback({ video: AVC, audio: EAC3 }, audioRefused, load)).toEqual({ kind: 'native', audioDecoder: 'ac3' });
    expect(await resolvePlayback({ video: AVC, audio: AC3 }, audioRefused, load)).toEqual({ kind: 'native', audioDecoder: 'ac3' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('accepte aussi un fichier audio seul', async () => {
    expect(await resolvePlayback({ video: null, audio: EAC3 }, audioRefused, async () => undefined)).toEqual({
      kind: 'native',
      audioDecoder: 'ac3',
    });
  });

  it('chargement en échec : vidéo seule avec la note', async () => {
    expect(await resolvePlayback({ video: AVC, audio: EAC3 }, audioRefused, noAc3)).toEqual({
      kind: 'native',
      withoutAudio: true,
      note: AUDIO_UNSUPPORTED_NOTE,
    });
  });

  it('ne charge rien pour un autre codec refusé (DTS) ni si la vidéo est refusée', async () => {
    const load = vi.fn(async () => undefined);
    const DTS: AudioTrackInfo = { codec: 'dts', codecString: 'dtsc', sampleRate: 48000, numberOfChannels: 6 };
    expect(await resolvePlayback({ video: AVC, audio: DTS }, audioRefused, load)).toMatchObject({ withoutAudio: true });
    const both: CodecEnv = { VideoDecoder: { isConfigSupported: async () => ({ supported: false }) }, AudioDecoder: { isConfigSupported: async () => ({ supported: false }) } };
    expect((await resolvePlayback({ video: AVC, audio: EAC3 }, both, load)).kind).toBe('unsupported');
    expect(load).not.toHaveBeenCalled();
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

  it('un repli enregistré pour le son passe avant la lecture sans son', async () => {
    const unregister = registerFallback(() => ({ kind: 'native' }));
    try {
      expect(await resolvePlayback({ video: AVC, audio: EAC3 }, audioRefused, noAc3)).toEqual({ kind: 'native' });
    } finally {
      unregister();
    }
    expect(await resolvePlayback({ video: AVC, audio: EAC3 }, audioRefused, noAc3)).toEqual({
      kind: 'native',
      withoutAudio: true,
      note: 'Son non pris en charge par ce navigateur',
    });
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
