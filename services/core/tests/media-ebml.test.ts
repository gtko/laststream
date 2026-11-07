import { describe, expect, it } from 'vitest';
import { isEbml, parseMkv } from '../src/media/ebml.js';
import { buildMkv, buildMp4, defaultMkvTracks } from './media-fixtures.js';

describe('parseMkv', () => {
  it('lit les pistes du jeu par défaut : vidéo, deux audio fre/eng, un sous-titre', () => {
    const { tracks, durationSec } = parseMkv(buildMkv({ durationSec: 5400 }));

    expect(tracks.map((t) => t.type)).toEqual(['video', 'audio', 'audio', 'subtitle']);
    const [, fre, eng, sub] = tracks;
    expect(fre).toMatchObject({ number: 2, codecId: 'A_EAC3', language: 'fre', name: 'Français Atmos', channels: 6 });
    expect(eng).toMatchObject({ number: 3, codecId: 'A_AAC', language: 'eng', channels: 2 });
    expect(sub).toMatchObject({ number: 4, codecId: 'S_TEXT/UTF8', language: 'fre', name: 'Français' });
    expect(durationSec).toBeCloseTo(5400, 6);
  });

  it('expose LanguageBCP47 à côté de Language et garde Language brut', () => {
    const { tracks } = parseMkv(
      buildMkv({
        tracks: [{ number: 1, type: 'audio', codecId: 'A_AC3', language: 'fre', languageIetf: 'fr-CA', channels: 6 }],
      }),
    );

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ language: 'fre', languageIetf: 'fr-CA' });
  });

  it("utilise 'eng' comme langue quand Language est absent (défaut Matroska)", () => {
    const { tracks } = parseMkv(buildMkv({ tracks: [{ number: 1, type: 'audio', codecId: 'A_AAC' }] }));

    expect(tracks[0]?.language).toBe('eng');
    expect(tracks[0]?.languageIetf).toBeUndefined();
  });

  it('lit les drapeaux avec leurs défauts Matroska (enabled et default à vrai, forced à faux)', () => {
    const { tracks } = parseMkv(
      buildMkv({
        tracks: [
          { number: 1, type: 'subtitle', codecId: 'S_TEXT/UTF8', language: 'eng', forced: true },
          { number: 2, type: 'audio', codecId: 'A_AAC', language: 'eng', defaultFlag: false },
        ],
      }),
    );

    expect(tracks[0]?.flags).toMatchObject({ enabled: true, default: true, forced: true });
    expect(tracks[1]?.flags).toMatchObject({ enabled: true, default: false, forced: false });
  });

  it('gère un Segment et un Cluster à taille inconnue', () => {
    const file = buildMkv({ unknownSegmentSize: true, unknownClusterSize: true, durationSec: 60 });

    const { tracks, durationSec } = parseMkv(file);

    expect(tracks.map((t) => t.codecId)).toEqual(['V_MPEG4/ISO/AVC', 'A_EAC3', 'A_AAC', 'S_TEXT/UTF8']);
    expect(durationSec).toBeCloseTo(60, 6);
  });

  it('renvoie les pistes complètes quand le fichier est tronqué au milieu d un TrackEntry', () => {
    const file = buildMkv();
    const cut = file.indexOf('A_AAC') + 2;

    const { tracks } = parseMkv(file.subarray(0, cut));

    expect(tracks.map((t) => t.codecId)).toEqual(['V_MPEG4/ISO/AVC', 'A_EAC3']);
  });

  it('ne lève jamais d exception, et renvoie un nombre de pistes croissant avec la longueur lue', () => {
    const file = buildMkv();
    let previous = 0;
    for (let cut = 0; cut <= file.length; cut++) {
      const count = parseMkv(file.subarray(0, cut)).tracks.length;
      expect(count).toBeGreaterThanOrEqual(previous);
      expect(count).toBeLessThanOrEqual(4);
      previous = count;
    }
    expect(previous).toBe(4);
  });

  it('renvoie un résultat vide sur un buffer qui n est pas du MKV', () => {
    expect(parseMkv(Buffer.alloc(0))).toEqual({ tracks: [] });
    expect(parseMkv(Buffer.from('pas un fichier media du tout'))).toEqual({ tracks: [] });
  });

  it('ignore la durée si Info est tronqué', () => {
    const file = buildMkv({ durationSec: 120 });
    const infoEnd = file.indexOf(Buffer.from([0x44, 0x89])) + 2;

    expect(parseMkv(file.subarray(0, infoEnd)).durationSec).toBeUndefined();
  });

  it('lit toutes les pistes même si le Cluster qui suit est volumineux', () => {
    const tracks = defaultMkvTracks();
    const { tracks: parsed } = parseMkv(buildMkv({ tracks, clusterBytes: 4096 }));

    expect(parsed).toHaveLength(tracks.length);
  });
});

describe('isEbml', () => {
  it('reconnaît le magic EBML et rejette un MP4', () => {
    expect(isEbml(buildMkv())).toBe(true);
    expect(isEbml(buildMp4Head())).toBe(false);
    expect(isEbml(Buffer.from([0x1a, 0x45]))).toBe(false);
  });
});

function buildMp4Head(): Buffer {
  return buildMp4({ layout: 'moov-first' }).subarray(0, 32);
}
