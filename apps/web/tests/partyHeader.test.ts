// Codecs lus dans l'en-tête : mapping mediabunny, clé de cache sans URL, cache tolérant, choix d'une source avec sonde mockée.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseCompatibleSource, compatWarning, isCompatibleSource, type FileCodecs, type GuestStatus, type SourceLike,
} from '../src/party/compat';
import { audioCodecKey, codecCacheKey, fileCodecsFromMedia, getCodecs, putCodecs, videoCodecKey } from '../src/party/headerCodecs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mapping des codecs mediabunny', () => {
  it('vidéo : avc, hevc, av1, vp9 ; le reste est inconnu', () => {
    expect(videoCodecKey('avc')).toBe('h264');
    expect(videoCodecKey('hevc')).toBe('hevc');
    expect(videoCodecKey('av1')).toBe('av1');
    expect(videoCodecKey('vp9')).toBe('vp9');
    expect(videoCodecKey('vp8')).toBeNull();
    expect(videoCodecKey('h264')).toBeNull(); // nom mediabunny, pas notre clé
    expect(videoCodecKey(undefined)).toBeNull();
  });

  it('audio : aac, opus, flac, ac3, eac3, dts, truehd ; mp3 et vorbis sont inconnus', () => {
    for (const c of ['aac', 'opus', 'flac', 'ac3', 'eac3', 'dts', 'truehd'] as const) expect(audioCodecKey(c)).toBe(c);
    expect(audioCodecKey('mp3')).toBeNull();
    expect(audioCodecKey('vorbis')).toBeNull();
    expect(audioCodecKey('avc')).toBeNull(); // une clé vidéo n'est jamais une piste audio
    expect(audioCodecKey(null)).toBeNull();
  });

  it('un fichier : ses pistes vidéo et audio, ou null si la piste manque', () => {
    expect(fileCodecsFromMedia({ video: { codec: 'hevc' } as never, audio: { codec: 'truehd' } as never })).toEqual({ video: 'hevc', audio: 'truehd' });
    expect(fileCodecsFromMedia({ video: null, audio: { codec: 'eac3' } as never })).toEqual({ video: null, audio: 'eac3' });
  });
});

describe('clé de cache : identité du fichier, jamais l’URL', () => {
  it('avec un infoHash : la clé le reprend, avec le fichier, sans aucune URL', async () => {
    const key = await codecCacheKey({
      stream: { infoHash: 'ABCDEF', fileIdx: 2, url: 'https://secret.example/dl/file.mkv?token=sekret' },
      filename: 'Film.mkv',
    });
    expect(key).toBe('h:abcdef:2');
    expect(key).not.toMatch(/secret|token|https?:/);
  });

  it('sans infoHash : SHA-256 du nom et de la taille, sans URL, stable et distincte selon la taille', async () => {
    const view = { filename: 'Film.2024.mkv', sizeBytes: 1_500_000_000, stream: { url: 'https://secret.example/x?token=sekret' } };
    const a = await codecCacheKey(view);
    const b = await codecCacheKey({ ...view });
    const c = await codecCacheKey({ ...view, sizeBytes: 1_500_000_001 });
    expect(a).toMatch(/^n:[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(a).not.toMatch(/secret|token|https?:/);
  });

  it('sans nom de fichier ni infoHash : pas de clé (pas de cache)', async () => {
    expect(await codecCacheKey({ stream: { url: 'https://secret.example/x' } })).toBeNull();
    expect(await codecCacheKey(null)).toBeNull();
  });
});

describe('cache des codecs', () => {
  const codecs: FileCodecs = { video: 'hevc', audio: 'eac3' };

  it('range puis relit les codecs ; une valeur mal formée est ignorée', () => {
    putCodecs('h:cache-test-1:0', codecs);
    expect(getCodecs('h:cache-test-1:0')).toEqual(codecs);
    vi.stubGlobal('localStorage', { getItem: () => '{"video":"avc","audio":null}', setItem: () => undefined });
    expect(getCodecs('h:cache-test-garbage:0')).toBeNull(); // « avc » n'est pas une clé de capacité
  });

  it('un stockage indisponible (bloqué, plein, lève) ne fait jamais échouer', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    });
    expect(() => putCodecs('h:cache-test-2:0', codecs)).not.toThrow();
    expect(getCodecs('h:cache-test-2:0')).toEqual(codecs); // la mémoire de session suffit
    expect(getCodecs('h:cache-test-absent:0')).toBeNull();
  });
});

describe('avertissement avec les codecs de l’en-tête', () => {
  it('TrueHD est une piste sans décodeur : le son manque pour tout invité', () => {
    const guests: GuestStatus[] = [{ id: 'a', caps: ['h264', 'aac', 'dts'] }];
    expect(compatWarning({ video: 'h264', audio: 'truehd' }, guests)).toBe('1 invité n’aura pas le son (TrueHD)');
  });

  it('les codecs de l’en-tête priment sur le nom de la source', () => {
    const view: SourceLike = { filename: 'Film 1080p x264 AAC' };
    expect(isCompatibleSource(view, [{ id: 'a', caps: ['h264'] }], { video: 'h264', audio: 'eac3' })).toBe(false);
    expect(isCompatibleSource({ filename: 'Film 1080p HEVC' }, [{ id: 'a', caps: ['h264', 'aac'] }], { video: 'h264', audio: 'aac' })).toBe(true);
  });
});

describe('choix d’une source avec sonde d’en-tête mockée', () => {
  const guests: GuestStatus[] = [{ id: 'a', caps: ['h264', 'aac'] }];
  const view = (index: number, filename: string, extra: Partial<SourceLike> = {}): SourceLike & { id: string } => ({
    id: 'v' + index, index, playable: true, filename, ...extra,
  }) as SourceLike & { id: string };

  it('la première source dont l’en-tête est compatible gagne ; la suivante n’est pas sondée', async () => {
    const views = [view(0, 'Film 1080p'), view(1, 'Film 1080p'), view(2, 'Film 1080p')];
    const probe = vi.fn(async (v: SourceLike & { id: string }): Promise<FileCodecs | null> => (v.index === 0 ? { video: 'hevc', audio: 'aac' } : { video: 'h264', audio: 'aac' }));
    const r = await chooseCompatibleSource(views, guests, null, probe);
    expect(r?.view.id).toBe('v1');
    expect(r?.source).toBe('header');
    expect(r?.codecs).toEqual({ video: 'h264', audio: 'aac' });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('au plus trois sources sondées, dans l’ordre de classement ; la quatrième jamais', async () => {
    const views = [view(0, 'a'), view(1, 'b'), view(2, 'c'), view(3, 'd')];
    const probe = vi.fn(async (_v: SourceLike): Promise<FileCodecs | null> => ({ video: 'hevc', audio: 'aac' }));
    const r = await chooseCompatibleSource(views, guests, null, probe);
    expect(probe.mock.calls.map(([v]) => v.index)).toEqual([0, 1, 2]);
    expect(r).toBeNull(); // aucune en-tête compatible, et aucun nom de source ne donne de codec
  });

  it('repli sur le nom quand la sonde échoue partout : la source au nom compatible est retenue', async () => {
    const views = [view(0, 'Film 1080p'), view(1, 'Film 1080p'), view(2, 'Film 1080p'), view(3, 'Film x264 AAC')];
    const probe = async (): Promise<FileCodecs | null> => null;
    const r = await chooseCompatibleSource(views, guests, null, probe);
    expect(r?.view.id).toBe('v3');
    expect(r?.source).toBe('name');
    expect(r?.codecs).toBeNull();
  });

  it('une source dont l’en-tête a été lu et refusé n’est pas reprise par le repli sur le nom', async () => {
    const views = [view(0, 'Film x264 AAC'), view(1, 'Film 1080p')];
    const probe = async (v: SourceLike): Promise<FileCodecs | null> => (v.index === 0 ? { video: 'hevc', audio: 'aac' } : null);
    const r = await chooseCompatibleSource(views, guests, null, probe);
    expect(r).toBeNull();
  });

  it('un délai dépassé annule la sonde de la source et passe à la suivante', async () => {
    const views = [view(0, 'a'), view(1, 'b')];
    let seen: AbortSignal | null = null;
    const probe = (v: SourceLike, signal: AbortSignal): Promise<FileCodecs | null> => {
      if (v.index === 0) {
        seen = signal;
        return new Promise(() => undefined); // ne répond jamais
      }
      return Promise.resolve({ video: 'h264', audio: 'aac' });
    };
    const r = await chooseCompatibleSource(views, guests, null, probe, { timeoutMs: 20 });
    expect(r?.view.index).toBe(1);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  it('un magnet ou un torrent n’est jamais sondé, et la source en cours est exclue', async () => {
    const views = [
      view(0, 'Film x264 AAC', { stream: { url: 'magnet:?xt=urn:btih:abc' } }),
      view(1, 'Film x264 AAC', { client: true }),
      view(2, 'Film x264 AAC', { stream: { infoHash: 'abc' } }),
      view(3, 'Film x264 AAC'),
    ];
    const probe = vi.fn(async (): Promise<FileCodecs | null> => ({ video: 'h264', audio: 'aac' }));
    const r = await chooseCompatibleSource(views, guests, 3, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });

  it('aucun invité annoncé : rien n’est sondé', async () => {
    const probe = vi.fn(async (): Promise<FileCodecs | null> => ({ video: 'h264', audio: 'aac' }));
    expect(await chooseCompatibleSource([view(0, 'a')], [{ id: 'a', caps: null }], null, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
