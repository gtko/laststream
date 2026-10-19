// Compatibilité des invités de la watch party : parseur des codecs, verdict et avertissement, choix d'une source compatible.
import { describe, expect, it } from 'vitest';
import {
  audioKnown, compatWarning, fileCodecsOf, guestStatuses, isCompatibleSource, isStreamable, parseSourceCodecs, pickCompatibleSource, verdictOf, type FileCodecs, type GuestStatus, type SourceLike,
} from '../src/party/compat';
import { capsMask } from '../src/relay/protocol';

const file = (video: FileCodecs['video'], audio: FileCodecs['audio']): FileCodecs => ({ video, audio });

describe('parseur des codecs d’une source', () => {
  const cases: Array<[string, FileCodecs]> = [
    ['Movie.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP', file('hevc', 'eac3')],
    ['Show S01E02 1080p x264 AAC', file('h264', 'aac')],
    ['Film 1080p BluRay x265 10bit DTS-HD MA 5.1', file('hevc', 'dts')],
    ['Film 720p HEVC AC3 5.1', file('hevc', 'ac3')],
    ['Film 1080p AV1 Opus', file('av1', 'opus')],
    ['Film 1080p VP9 FLAC', file('vp9', 'flac')],
    ['Film 1080p WEB-DL DD5.1 H264', file('h264', 'ac3')],
    ['Film 1080p E-AC-3 Atmos x264', file('h264', 'eac3')],
    ['Film 1080p Dolby Digital Plus x264', file('h264', 'eac3')],
    ['Film 1080p Dolby Digital x264', file('h264', 'ac3')],
    ['Film 1080p WEB DDP x264', file('h264', 'eac3')],
    ['Film DTS:X 2160p x265', file('hevc', 'dts')],
    ['Film 1080p x264', file('h264', null)],
    ['The Addams Family 1080p', file(null, null)],
    ['Titre sans codec', file(null, null)],
    ['Film.2160p.BluRay.REMUX.HEVC.TrueHD.Atmos.7.1', file('hevc', null)],
    ['Film 1080p x264 HEVC', file('h264', null)],
  ];
  it.each(cases)('« %s »', (text, expected) => {
    expect(parseSourceCodecs(text)).toEqual(expected);
  });

  it('lit les champs codec et son d’une source affichée', () => {
    expect(fileCodecsOf({ codec: 'x265', audio: 'DTS-HD MA 5.1' })).toEqual(file('hevc', 'dts'));
    expect(fileCodecsOf({ stream: { behaviorHints: { filename: 'Film.2020.1080p.AAC.x264.mkv' } } })).toEqual(file('h264', 'aac'));
    expect(fileCodecsOf(null)).toEqual(file(null, null));
  });
});

describe('verdict d’un invité', () => {
  it('ok si tout est décodable, « sans son » si l’audio manque, « illisible » si la vidéo manque', () => {
    expect(verdictOf(file('h264', 'aac'), ['h264', 'aac'])).toBe('ok');
    expect(verdictOf(file('h264', 'dts'), ['h264', 'aac'])).toBe('no-audio');
    expect(verdictOf(file('hevc', null), ['h264'])).toBe('unplayable');
  });

  it('la vidéo prime sur le son ; un codec inconnu ne compte pas', () => {
    expect(verdictOf(file('hevc', 'dts'), [])).toBe('unplayable');
    expect(verdictOf(file(null, null), [])).toBe('ok');
  });
});

describe('avertissement pour l’hôte', () => {
  const g = (id: string, caps: GuestStatus['caps']): GuestStatus => ({ id, caps });

  it('un invité sans son', () => {
    const guests = [g('a', ['h264', 'aac']), g('b', ['h264', 'dts'])];
    expect(compatWarning(file('h264', 'dts'), guests)).toBe('1 invité n’aura pas le son (DTS)');
  });

  it('un invité qui ne peut pas lire la vidéo', () => {
    expect(compatWarning(file('hevc', null), [g('a', ['h264'])])).toBe('1 invité ne peut pas lire cette vidéo (HEVC)');
  });

  it('au pluriel', () => {
    expect(compatWarning(file('hevc', null), [g('a', ['h264']), g('b', ['h264'])])).toBe('2 invités ne peuvent pas lire cette vidéo (HEVC)');
    expect(compatWarning(file('h264', 'dts'), [g('a', ['h264']), g('b', ['h264']), g('c', ['h264', 'dts'])])).toBe('2 invités n’auront pas le son (DTS)');
  });

  it('les deux cas à la fois, séparés par « · »', () => {
    const guests = [g('a', ['h264', 'dts']), g('b', ['hevc', 'aac'])];
    expect(compatWarning(file('hevc', 'dts'), guests)).toBe('1 invité ne peut pas lire cette vidéo (HEVC) · 1 invité n’aura pas le son (DTS)');
  });

  it('rien quand tout va, quand aucun invité n’a annoncé ses capacités, ou quand le fichier n’a pas de codec connu', () => {
    expect(compatWarning(file('h264', 'aac'), [g('a', ['h264', 'aac'])])).toBeNull();
    expect(compatWarning(file('hevc', 'dts'), [g('a', null)])).toBeNull();
    expect(compatWarning(file(null, null), [g('a', [])])).toBeNull();
    expect(compatWarning(file('hevc', 'dts'), [])).toBeNull();
  });
});

describe('statuts des invités', () => {
  it('ne prend que les invités, et leurs capacités par identifiant de pair', () => {
    const caps = new Map([['peer-1', capsMask(['h264', 'aac'])]]);
    const participants = [
      { username: 'hote' },
      { username: 'ami', guest: true, peerId: 'peer-1' },
      { username: 'invite', guest: true, peerId: 'peer-2' },
    ];
    expect(guestStatuses(participants, caps)).toEqual([
      { id: 'ami', caps: ['h264', 'aac'] },
      { id: 'invite', caps: null },
    ]);
  });
});

describe('choix d’une source compatible', () => {
  const all: GuestStatus[] = [{ id: 'a', caps: ['h264', 'aac', 'ac3'] }];
  const views: Array<SourceLike & { id: string }> = [
    { id: 'hevc-dts', index: 0, playable: true, codec: 'x265', audio: 'DTS' },
    { id: 'ok', index: 1, playable: true, filename: 'Film 1080p x264 AAC' },
    { id: 'client', index: 2, playable: true, client: true, filename: 'Film 1080p x264 AAC' },
    { id: 'torrent', index: 3, playable: true, filename: 'Film 1080p x264 AAC', stream: { infoHash: 'abc' } },
    { id: 'off', index: 4, playable: false, filename: 'Film 1080p x264 AAC' },
    { id: 'nocodec', index: 5, playable: true, filename: 'Film 1080p' },
  ];

  it('choisit la première source compatible avec tous les invités annoncés, sans torrent ni débridage local', () => {
    expect(pickCompatibleSource(views, all, 0)?.id).toBe('ok');
  });

  it('exclut la source en cours', () => {
    expect(pickCompatibleSource(views, all, 1)).toBeNull();
  });

  it('une source incompatible avec un invité n’est jamais proposée', () => {
    const guests: GuestStatus[] = [{ id: 'a', caps: ['h264', 'aac'] }, { id: 'b', caps: ['hevc'] }];
    expect(pickCompatibleSource([views[0], views[1]], guests, null)).toBeNull();
  });

  it('rien à proposer si aucun invité n’a annoncé ses capacités', () => {
    expect(pickCompatibleSource(views, [{ id: 'a', caps: null }], null)).toBeNull();
    expect(pickCompatibleSource(views, [], null)).toBeNull();
  });

  it('préfère une source dont la vidéo et le son sont connus, puis l’ordre de classement', () => {
    const ranked: Array<SourceLike & { id: string }> = [
      { id: 'video-seule', index: 10, playable: true, filename: 'Film 1080p x264' },
      { id: 'video-et-son', index: 11, playable: true, filename: 'Film 1080p x264 AAC' },
      { id: 'autre-video-et-son', index: 12, playable: true, filename: 'Film 720p x264 AAC' },
    ];
    expect(pickCompatibleSource(ranked, all, null)?.id).toBe('video-et-son');
    expect(pickCompatibleSource(ranked.slice(0, 1), all, null)?.id).toBe('video-seule');
  });
});

describe('garde des sources de repli et son non vérifié', () => {
  const guests: GuestStatus[] = [{ id: 'a', caps: ['h264', 'aac', 'dts'] }];

  it('un magnet n’est jamais une source compatible, même avec des codecs connus', () => {
    const magnet: SourceLike = { playable: true, filename: 'Film 1080p x264 AAC', stream: { url: 'magnet:?xt=urn:btih:abc' } };
    expect(isStreamable(magnet)).toBe(false);
    expect(isCompatibleSource(magnet, guests)).toBe(false);
  });

  it('une source sans aucun codec connu, ou incompatible avec un invité annoncé, n’est pas compatible', () => {
    expect(isCompatibleSource({ playable: true, filename: 'Film 1080p' }, guests)).toBe(false);
    expect(isCompatibleSource({ playable: true, filename: 'Film 1080p HEVC AAC' }, guests)).toBe(false);
    expect(isCompatibleSource({ playable: true, filename: 'Film 1080p x264 AAC' }, guests)).toBe(true);
  });

  it('un invité qui n’a pas encore annoncé ses capacités ne bloque pas le repli', () => {
    expect(isCompatibleSource({ playable: true, filename: 'Film 1080p HEVC' }, [{ id: 'b', caps: null }])).toBe(true);
  });

  it('son non vérifié : signalé, et à égalité de codecs connus, la source au son connu est préférée', () => {
    expect(audioKnown({ filename: 'Film 1080p x264' })).toBe(false);
    expect(audioKnown({ filename: 'Film 1080p DTS' })).toBe(true);
    const ranked: Array<SourceLike & { id: string }> = [
      { id: 'video-seule', index: 20, playable: true, filename: 'Film 1080p x264' },
      { id: 'son-seul', index: 21, playable: true, filename: 'Film 1080p DTS' },
    ];
    expect(pickCompatibleSource(ranked, guests, null)?.id).toBe('son-seul');
  });

  it('une source à codecs connus complets bat une source à son seul connu', () => {
    const ranked: Array<SourceLike & { id: string }> = [
      { id: 'son-seul', index: 30, playable: true, filename: 'Film DTS' },
      { id: 'complete', index: 31, playable: true, filename: 'Film x264 DTS' },
    ];
    expect(pickCompatibleSource(ranked, guests, null)?.id).toBe('complete');
  });
});
