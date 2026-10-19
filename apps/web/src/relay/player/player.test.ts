import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodecEnv } from './detect';
import { openMedia, type OpenedMedia } from './demux';
import { GuestPlayer } from './player';
import type { AudioTrackInfo, RangeReader, VideoTrackInfo } from './types';

// Le lecteur est testé sans WebCodecs réel : le démuxage est remplacé, les décodeurs et WebAudio sont factices.
vi.mock('./demux', () => ({ openMedia: vi.fn() }));

const AVC: VideoTrackInfo = { codec: 'avc', codecString: 'avc1.64001f', width: 320, height: 240 };
const AAC: AudioTrackInfo = { codec: 'aac', codecString: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 };
const EAC3: AudioTrackInfo = { codec: 'eac3', codecString: 'ec-3', sampleRate: 48000, numberOfChannels: 6 };

const NOTE = 'Son non pris en charge par ce navigateur';
const reader: RangeReader = { size: async () => 0, read: async () => new Uint8Array() };
const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;

/** Décodeurs WebCodecs : vidéo et audio acceptent toute configuration, la décision est dans `env`. */
const env = (audioSupported: boolean): CodecEnv => ({
  VideoDecoder: { isConfigSupported: async () => ({ supported: true }) },
  AudioDecoder: { isConfigSupported: async () => ({ supported: audioSupported }) },
});

function fakeDecoder() {
  return { decodeQueueSize: 0, configure: vi.fn(), reset: vi.fn(), close: vi.fn(), decode: vi.fn(), flush: vi.fn(async () => undefined) };
}

function opened(audio: AudioTrackInfo | null): OpenedMedia {
  return {
    info: { container: 'MP4', duration: 10, video: AVC, audio },
    videoSink: null,
    audioSink: null,
    videoConfig: { codec: AVC.codecString, codedWidth: 320, codedHeight: 240 },
    audioConfig: audio ? { codec: audio.codecString, sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels } : null,
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'VideoDecoder',
    vi.fn(function () {
      return fakeDecoder();
    }),
  );
  vi.stubGlobal(
    'AudioDecoder',
    vi.fn(function () {
      return fakeDecoder();
    }),
  );
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return {
        currentTime: 0,
        destination: {},
        resume: vi.fn(async () => undefined),
        suspend: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
    }),
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn(() => undefined),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GuestPlayer.load : son non décodable', () => {
  it('lit la vidéo sans créer de décodeur ni de contexte audio, et renvoie la note', async () => {
    vi.mocked(openMedia).mockResolvedValue(opened(EAC3));
    const player = new GuestPlayer({ env: env(false) });

    const plan = await player.load(reader, canvas);

    expect(plan).toEqual({ kind: 'native', withoutAudio: true, note: NOTE });
    expect(VideoDecoder).toHaveBeenCalledTimes(1);
    expect(AudioDecoder).not.toHaveBeenCalled();
    expect(AudioContext).not.toHaveBeenCalled();
    expect(player.getStats()).toMatchObject({ videoCodec: 'avc', audioCodec: 'eac3', audioChunks: 0 });
    player.destroy();
  });

  it('avec un son décodable, configure le décodeur audio et ne renvoie aucune note', async () => {
    vi.mocked(openMedia).mockResolvedValue(opened(AAC));
    const player = new GuestPlayer({ env: env(true) });

    const plan = await player.load(reader, canvas);

    expect(plan).toEqual({ kind: 'native' });
    expect(AudioDecoder).toHaveBeenCalledTimes(1);
    expect(AudioContext).toHaveBeenCalledTimes(1);
    player.destroy();
  });
});
