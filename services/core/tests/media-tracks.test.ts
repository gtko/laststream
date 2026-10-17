import { describe, expect, it } from 'vitest';
import {
  buildAudioTrack,
  detectAtmos,
  mkvCodecName,
  mp4CodecName,
  normalizeLanguageTag,
  toIso639_1,
} from '../src/media/tracks.js';

describe('toIso639_1', () => {
  it('convertit les codes ISO 639-2 courants, bibliographiques et terminologiques', () => {
    expect(toIso639_1('fre')).toBe('fr');
    expect(toIso639_1('fra')).toBe('fr');
    expect(toIso639_1('eng')).toBe('en');
    expect(toIso639_1('ger')).toBe('de');
    expect(toIso639_1('deu')).toBe('de');
    expect(toIso639_1('jpn')).toBe('ja');
    expect(toIso639_1('chi')).toBe('zh');
    expect(toIso639_1('zho')).toBe('zh');
  });

  it('renvoie les codes inconnus bruts, et les codes à deux lettres tels quels', () => {
    expect(toIso639_1('xyz')).toBe('xyz');
    expect(toIso639_1('und')).toBe('und');
    expect(toIso639_1('FR')).toBe('fr');
  });
});

describe('normalizeLanguageTag', () => {
  it('garde la sous-balise principale d une étiquette BCP 47', () => {
    expect(normalizeLanguageTag('fr-CA')).toBe('fr');
    expect(normalizeLanguageTag('en-US')).toBe('en');
    expect(normalizeLanguageTag('pt_BR')).toBe('pt');
    expect(normalizeLanguageTag('zh-Hant')).toBe('zh');
  });

  it('normalise les codes ISO 639-2', () => {
    expect(normalizeLanguageTag('fre')).toBe('fr');
    expect(normalizeLanguageTag('eng')).toBe('en');
  });

  it("renvoie 'und' pour une valeur vide ou invalide", () => {
    expect(normalizeLanguageTag('')).toBe('und');
    expect(normalizeLanguageTag(undefined)).toBe('und');
    expect(normalizeLanguageTag(null)).toBe('und');
    expect(normalizeLanguageTag('12345')).toBe('und');
  });
});

describe('mkvCodecName', () => {
  it('traduit les CodecID courants', () => {
    expect(mkvCodecName('A_EAC3')).toBe('EAC3');
    expect(mkvCodecName('A_AC3')).toBe('AC3');
    expect(mkvCodecName('A_AAC/MPEG4/LC')).toBe('AAC');
    expect(mkvCodecName('A_TRUEHD')).toBe('TrueHD');
    expect(mkvCodecName('A_OPUS')).toBe('Opus');
    expect(mkvCodecName('A_FLAC')).toBe('FLAC');
  });

  it('distingue DTS-HD de DTS grâce au nom de piste', () => {
    expect(mkvCodecName('A_DTS', 'DTS-HD MA 7.1')).toBe('DTS-HD');
    expect(mkvCodecName('A_DTS', 'DTS 5.1')).toBe('DTS');
    expect(mkvCodecName('A_DTS')).toBe('DTS');
  });

  it('renvoie le CodecID brut pour un codec inconnu', () => {
    expect(mkvCodecName('A_INCONNU/X')).toBe('A_INCONNU/X');
  });
});

describe('mp4CodecName', () => {
  it('traduit les fourcc courants', () => {
    expect(mp4CodecName('mp4a')).toBe('AAC');
    expect(mp4CodecName('ac-3')).toBe('AC3');
    expect(mp4CodecName('ec-3')).toBe('EAC3');
    expect(mp4CodecName('dtsh')).toBe('DTS-HD');
    expect(mp4CodecName('mlpa')).toBe('TrueHD');
    expect(mp4CodecName('fLaC')).toBe('FLAC');
  });

  it('renvoie le fourcc brut pour un codec inconnu', () => {
    expect(mp4CodecName('zzzz')).toBe('zzzz');
  });
});

describe('detectAtmos', () => {
  it('détecte Atmos sur E-AC-3 et TrueHD via le nom de piste', () => {
    expect(detectAtmos('EAC3', 'Français Atmos')).toBe(true);
    expect(detectAtmos('EAC3', 'English JOC')).toBe(true);
    expect(detectAtmos('TrueHD', 'Atmos 7.1.4')).toBe(true);
    expect(detectAtmos('EAC3', 'Français')).toBe(false);
    expect(detectAtmos('EAC3')).toBe(false);
  });

  it('reste indéterminé pour les autres codecs', () => {
    expect(detectAtmos('AAC', 'Atmos')).toBeUndefined();
    expect(detectAtmos('AC3')).toBeUndefined();
  });
});

describe('buildAudioTrack', () => {
  it('normalise la langue et n ajoute que les champs renseignés', () => {
    expect(buildAudioTrack({ language: 'fre', codec: 'EAC3', channels: 6, atmos: true, name: ' Atmos ' })).toEqual({
      lang: 'fr',
      codec: 'EAC3',
      channels: 6,
      atmos: true,
      name: 'Atmos',
    });
    expect(buildAudioTrack({ language: 'und', codec: 'AAC' })).toEqual({ lang: 'und', codec: 'AAC' });
  });
});
