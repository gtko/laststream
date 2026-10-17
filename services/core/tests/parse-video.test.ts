import { describe, expect, it } from 'vitest';
import { parseVideo } from '../src/parse/video.js';

describe('parseVideo : résolution', () => {
  it('détecte 1080p', () => {
    const info = parseVideo('Movie.2020.1080p.BluRay.x264');
    expect(info.resolution).toBe('1080p');
    expect(info.height).toBe(1080);
  });

  it('traite 4K, UHD et 2160p comme 2160p', () => {
    expect(parseVideo('Movie.2019.4K.WEB.x265')).toMatchObject({ resolution: '2160p', height: 2160 });
    expect(parseVideo('Movie.2019.UHD.BluRay.HEVC')).toMatchObject({ resolution: '2160p', height: 2160 });
    expect(parseVideo('Movie.2019.2160p.WEB-DL')).toMatchObject({ resolution: '2160p', height: 2160 });
  });

  it('traite FHD comme 1080p', () => {
    expect(parseVideo('Film.FHD.x264')).toMatchObject({ resolution: '1080p', height: 1080 });
  });

  it('détecte 720p et 480p', () => {
    expect(parseVideo('Serie.S01E01.720p.HDTV.x264')).toMatchObject({ resolution: '720p', height: 720 });
    expect(parseVideo('Movie.2003.480p.DVDRip.XviD')).toMatchObject({ resolution: '480p', height: 480 });
  });

  it('range DVDRip et SD dans SD avec une hauteur de 480 par défaut', () => {
    expect(parseVideo('Film.1995.DVDRip.XviD')).toMatchObject({ resolution: 'SD', height: 480, source: 'DVDRip' });
    expect(parseVideo('Movie.1990.SD.DVDRip')).toMatchObject({ resolution: 'SD', height: 480 });
  });

  it('range 576p dans SD avec une hauteur de 576', () => {
    expect(parseVideo('Movie.2003.576p.DVDRip.XviD')).toMatchObject({ resolution: 'SD', height: 576 });
  });

  it('renvoie unknown et 0 sans information de résolution', () => {
    expect(parseVideo('Some Random Title')).toMatchObject({ resolution: 'unknown', height: 0 });
  });
});

describe('parseVideo : source', () => {
  it('reconnaît REMUX, même en BDRemux, avec priorité sur BluRay', () => {
    expect(parseVideo('Movie.2022.REMUX.2160p.HDR10+.TrueHD.Atmos.7.1.HEVC-GRP').source).toBe('REMUX');
    expect(parseVideo('Movie.2022.BDRemux.1080p.AVC')).toMatchObject({ source: 'REMUX' });
  });

  it('reconnaît BluRay, BDRip et BRRip', () => {
    expect(parseVideo('Movie.2020.1080p.BluRay.x264').source).toBe('BluRay');
    expect(parseVideo('Movie.2010.720p.BRRip.XviD.AC3-GRP').source).toBe('BluRay');
    expect(parseVideo('Movie.2011.1080p.Blu-ray.x264').source).toBe('BluRay');
  });

  it('reconnaît WEB-DL et WEBRip sans les confondre', () => {
    expect(parseVideo('Movie.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HEVC-FLUX').source).toBe('WEB-DL');
    expect(parseVideo('Movie.2021.1080p.WEBDL.x264').source).toBe('WEB-DL');
    expect(parseVideo('Movie.2020.720p.WEBRip.x264-RARBG').source).toBe('WEBRip');
  });

  it('reconnaît HDTV et DVDRip', () => {
    expect(parseVideo('Serie.S02E05.FRENCH.720p.HDTV.x264-FW').source).toBe('HDTV');
    expect(parseVideo('Film 2019 TRUEFRENCH DVDRip XviD AC3').source).toBe('DVDRip');
  });

  it('reconnaît les sources de mauvaise qualité CAM, TS et SCR', () => {
    expect(parseVideo('Movie.2024.HDCAM.x264').source).toBe('CAM');
    expect(parseVideo('Movie.2024.CAM.x264').source).toBe('CAM');
    expect(parseVideo('Movie.2023.TELESYNC.XviD').source).toBe('TS');
    expect(parseVideo('Movie.2023.DVDSCR.XviD').source).toBe('SCR');
  });

  it('renvoie unknown sans source reconnue', () => {
    expect(parseVideo('Some Random Title').source).toBe('unknown');
  });
});

describe('parseVideo : faux positifs de TS', () => {
  it('ne prend pas DTS pour TS', () => {
    const info = parseVideo('Movie.2020.1080p.BluRay.DTS.x264');
    expect(info.source).toBe('BluRay');
    expect(info.tags).not.toContain('TS');
    expect(info.audio).toEqual(['DTS']);
  });

  it('ne prend pas une minuscule "Ts" ni un mot comme TSUNAMI pour TS', () => {
    expect(parseVideo('Ts.Movie.2019.720p.WEB-DL.x264')).toMatchObject({ source: 'WEB-DL', tags: [] });
    expect(parseVideo('TSUNAMI.2012.1080p.BluRay.x264').tags).toEqual([]);
  });

  it('reconnaît TS isolé en majuscules comme source TS', () => {
    const info = parseVideo('Movie.2008.TS.XviD.avi');
    expect(info.source).toBe('TS');
    expect(info.tags).toContain('TS');
  });

  it('ne lit pas une extension .ts en minuscules comme tag', () => {
    expect(parseVideo('Movie.2008.ts')).toMatchObject({ source: 'unknown', tags: [] });
  });
});

describe('parseVideo : codec', () => {
  it('reconnaît HEVC, x265 et H.265', () => {
    expect(parseVideo('Movie.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HEVC-FLUX').codec).toBe('HEVC');
    expect(parseVideo('Movie.2019.1080p.BluRay.x265-GRP').codec).toBe('HEVC');
    expect(parseVideo('Movie.2022.1080p.H.265.AAC').codec).toBe('HEVC');
  });

  it('reconnaît AVC via x264, H.264 et AVC', () => {
    expect(parseVideo('Serie.S02E05.FRENCH.720p.HDTV.x264-FW').codec).toBe('AVC');
    expect(parseVideo('Movie.2024.1080p.WEB-DL.H.264').codec).toBe('AVC');
  });

  it('reconnaît AV1', () => {
    expect(parseVideo('Movie.2024.1080p.WEB-DL.AV1.Opus').codec).toBe('AV1');
  });

  it('renvoie unknown pour un codec absent ou hors liste (XviD)', () => {
    expect(parseVideo('Film 2019 TRUEFRENCH DVDRip XviD AC3').codec).toBe('unknown');
    expect(parseVideo('Some Random Title').codec).toBe('unknown');
  });
});

describe('parseVideo : HDR', () => {
  it('reconnaît HDR10+ sous ses différentes écritures, sans ajouter HDR10', () => {
    expect(parseVideo('Movie.2022.REMUX.2160p.HDR10+.TrueHD.Atmos.7.1.HEVC-GRP').hdr).toEqual(['HDR10+']);
    expect(parseVideo('Movie.2022.2160p.HDR10Plus.x265').hdr).toEqual(['HDR10+']);
  });

  it('traite HDR seul comme HDR10', () => {
    expect(parseVideo('Movie.2020.2160p.UHD.BluRay.REMUX.HDR.HEVC-GRP').hdr).toEqual(['HDR10']);
  });

  it('reconnaît Dolby Vision (DV, DoVi, Dolby Vision) et HLG', () => {
    expect(parseVideo('Movie.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HEVC-FLUX').hdr).toEqual(['DV']);
    expect(parseVideo('Movie.2022.2160p.DOLBY.VISION.HDR10PLUS.x265').hdr).toEqual(['HDR10+', 'DV']);
    expect(parseVideo('Movie.2021.2160p.HLG.WEB-DL.x265').hdr).toEqual(['HLG']);
  });

  it('renvoie une liste vide sans HDR', () => {
    expect(parseVideo('Movie.2020.1080p.BluRay.x264').hdr).toEqual([]);
  });

  it('combine HDR10 et DV quand les deux sont présents', () => {
    expect(parseVideo('Movie.2019.1080p.BluRay.DV.HDR10.DTS-HDMA.5.1.x265').hdr).toEqual(['HDR10', 'DV']);
  });
});

describe('parseVideo : audio et canaux', () => {
  it('garde DTS-HD MA seul, sans DTS générique', () => {
    const info = parseVideo('Le.Seigneur.des.Anneaux.2001.MULTi.1080p.BluRay.x265.HDR10.DTS-HD.MA.5.1-GROUP');
    expect(info.audio).toEqual(['DTS-HD MA']);
    expect(info.channels).toBe('5.1');
  });

  it('range Atmos avant DDP dans l\'ordre de qualité', () => {
    expect(parseVideo('Movie.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HEVC-FLUX').audio).toEqual(['Atmos', 'DDP']);
  });

  it('reconnaît AC3, DD et DD5.1', () => {
    expect(parseVideo('Film 2019 TRUEFRENCH DVDRip XviD AC3').audio).toEqual(['AC3']);
    expect(parseVideo('Movie.2005.DD5.1.x264').audio).toEqual(['AC3']);
    expect(parseVideo('Film.1999.720p.BluRay.AC3.5.1.x264').audio).toEqual(['AC3']);
  });

  it('reconnaît EAC3 comme DDP et lit le canal 5.1', () => {
    const info = parseVideo('Movie.2020.1080p.WEB-DL.EAC3.5.1');
    expect(info.audio).toEqual(['DDP']);
    expect(info.channels).toBe('5.1');
  });

  it('lit le canal 2.0 d\'une piste DDP', () => {
    const info = parseVideo('Serie.S01E01.1080p.WEB-DL.DDP2.0.H.264');
    expect(info.audio).toEqual(['DDP']);
    expect(info.channels).toBe('2.0');
  });

  it('retourne les pistes AAC, FLAC et Opus dans l\'ordre de la liste', () => {
    expect(parseVideo('Film.2021.1080p.BluRay.Opus.FLAC.AAC').audio).toEqual(['AAC', 'FLAC', 'Opus']);
  });

  it('préfère 7.1 quand plusieurs canaux sont annoncés', () => {
    expect(parseVideo('Movie.2022.REMUX.2160p.TrueHD.Atmos.7.1.HEVC-GRP').channels).toBe('7.1');
  });

  it('n\'annonce pas de canal sans information', () => {
    const info = parseVideo('Film 2019 TRUEFRENCH DVDRip XviD');
    expect(info.channels).toBeUndefined();
    expect(info.audio).toEqual([]);
  });
});

describe('parseVideo : groupe', () => {
  it('prend le dernier -GROUPE du nom', () => {
    expect(parseVideo('Serie.S02E05.FRENCH.720p.HDTV.x264-FW').group).toBe('FW');
    expect(parseVideo('Movie.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HEVC-FLUX').group).toBe('FLUX');
  });

  it('ne prend pas un suffixe technique comme groupe', () => {
    expect(parseVideo('Movie.2020.1080p.WEB-DL').group).toBeUndefined();
    expect(parseVideo('Movie.2020.1080p.BluRay-Rip').group).toBeUndefined();
  });

  it('prend [Groupe] en tête si le nom n\'a pas de -GROUPE', () => {
    expect(parseVideo('[YTS] Movie Title 2018 1080p BluRay x264').group).toBe('YTS');
  });

  it('ignore un crochet technique en tête', () => {
    expect(parseVideo('[1080p] Movie.2018.BluRay.x264').group).toBeUndefined();
  });

  it('ne renvoie pas de groupe sans information', () => {
    expect(parseVideo('Film 2019 TRUEFRENCH DVDRip XviD AC3').group).toBeUndefined();
  });
});

describe('parseVideo : tags', () => {
  it('ajoute la famille CAM à HDCAM pour le filtrage excludedTags', () => {
    expect(parseVideo('Movie.2024.HDCAM.x264').tags).toEqual(['HDCAM', 'CAM']);
  });

  it('remonte les tags de release REPACK, PROPER, EXTENDED, 3D, HC', () => {
    expect(parseVideo('Movie.2020.1080p.BluRay.REPACK.x264-GRP').tags).toEqual(['REPACK']);
    expect(parseVideo('Movie.2011.3D.1080p.BluRay.x264').tags).toEqual(['3D']);
    expect(parseVideo('Movie.2010.HC.720p.BluRay').tags).toEqual(['HC']);
    expect(parseVideo('Movie.2015.EXTENDED.PROPER.1080p.BluRay.x264').tags).toEqual(['PROPER', 'EXTENDED']);
  });

  it('renvoie une liste vide sans tag notable', () => {
    expect(parseVideo('Movie.2020.1080p.BluRay.x264').tags).toEqual([]);
  });

  it('ajoute TS et SCR comme famille pour TELESYNC et DVDSCR', () => {
    expect(parseVideo('Movie.2023.TELESYNC.XviD').tags).toEqual(['TELESYNC', 'TS']);
    expect(parseVideo('Movie.2023.DVDSCR.XviD').tags).toEqual(['DVDSCR', 'SCR']);
  });
});

describe('parseVideo : cas limites', () => {
  it('renvoie une analyse vide pour une chaîne vide', () => {
    expect(parseVideo('')).toEqual({
      resolution: 'unknown',
      height: 0,
      source: 'unknown',
      codec: 'unknown',
      hdr: [],
      audio: [],
      tags: [],
    });
  });

  it('ne lit pas un nombre de 4 chiffres comme résolution', () => {
    expect(parseVideo('Movie.2023.1920x1080.BluRay').resolution).toBe('unknown');
  });

  it('analyse une release complète FR de bout en bout', () => {
    expect(parseVideo('Movie.2022.REMUX.2160p.HDR10+.TrueHD.Atmos.7.1.HEVC-GRP')).toEqual({
      resolution: '2160p',
      height: 2160,
      source: 'REMUX',
      codec: 'HEVC',
      hdr: ['HDR10+'],
      audio: ['TrueHD', 'Atmos'],
      channels: '7.1',
      group: 'GRP',
      tags: [],
    });
  });
});
