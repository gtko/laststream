import { describe, expect, it } from 'vitest';
import { filterCandidates } from '../src/engine/filter.js';
import { cand, cfg, GB, titles } from './engine-fixtures.js';

describe('filterCandidates : résolutions', () => {
  it('garde les résolutions autorisées et unknown, écarte le reste', () => {
    const config = cfg({ resolutions: { allowed: ['1080p', '720p'] } });
    const result = filterCandidates(
      [
        cand({ parsed: { resolution: '2160p' }, raw: { title: 'uhd' } }),
        cand({ parsed: { resolution: '1080p' }, raw: { title: 'fhd' } }),
        cand({ parsed: { resolution: 'unknown' }, raw: { title: 'unk' } }),
        cand({ parsed: { resolution: 'SD' }, raw: { title: 'sd' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['fhd', 'unk']);
  });

  it('applique le plafond resolutions.max, unknown reste autorisé', () => {
    const config = cfg({ resolutions: { max: '720p' } });
    const result = filterCandidates(
      [
        cand({ parsed: { resolution: '1080p' }, raw: { title: 'fhd' } }),
        cand({ parsed: { resolution: '720p' }, raw: { title: 'hd' } }),
        cand({ parsed: { resolution: 'SD' }, raw: { title: 'sd' } }),
        cand({ parsed: { resolution: 'unknown' }, raw: { title: 'unk' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['hd', 'sd', 'unk']);
  });
});

describe('filterCandidates : tags exclus', () => {
  it('exclut une source CAM/TS/SCR, insensible à la casse', () => {
    const config = cfg({ excludedTags: ['cam', 'ts'] });
    const result = filterCandidates(
      [
        cand({ parsed: { source: 'CAM' }, raw: { title: 'cam' } }),
        cand({ parsed: { source: 'TS' }, raw: { title: 'ts' } }),
        cand({ parsed: { source: 'WEB-DL' }, raw: { title: 'web' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['web']);
  });

  it('exclut un tag en mot entier dans titre, fichier ou nom, sans faux positif', () => {
    const config = cfg({});
    const result = filterCandidates(
      [
        cand({ raw: { title: 'Movie.2024.TS.x264' } }),
        cand({ raw: { title: 'Tsunami.2024.1080p' } }),
        cand({ raw: { title: 'Movie.CAMERA.edition' } }),
        cand({ raw: { title: 'Movie.2024', filename: 'movie.scr.mkv' } }),
        cand({ raw: { title: 'Movie.2024', name: 'x.SCR' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['Tsunami.2024.1080p', 'Movie.CAMERA.edition']);
  });
});

describe('filterCandidates : taille', () => {
  it('applique min/max global en Go (inclusif), garde la taille inconnue', () => {
    const config = cfg({ size: { minGb: 1, maxGb: 10 } });
    const result = filterCandidates(
      [
        cand({ parsed: { sizeBytes: 0.5 * GB }, raw: { title: 'small' } }),
        cand({ parsed: { sizeBytes: 1 * GB }, raw: { title: 'min' } }),
        cand({ parsed: { sizeBytes: 10 * GB }, raw: { title: 'max' } }),
        cand({ parsed: { sizeBytes: 10.5 * GB }, raw: { title: 'big' } }),
        cand({ parsed: { sizeBytes: undefined }, raw: { title: 'unknown-size' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['min', 'max', 'unknown-size']);
  });

  it('applique aussi la plage par résolution', () => {
    const config = cfg({ size: { perResolution: { '1080p': { maxGb: 3 } } } });
    const result = filterCandidates(
      [
        cand({ parsed: { resolution: '1080p', sizeBytes: 4 * GB }, raw: { title: 'fhd-big' } }),
        cand({ parsed: { resolution: '1080p', sizeBytes: 2 * GB }, raw: { title: 'fhd-ok' } }),
        cand({ parsed: { resolution: '720p', sizeBytes: 4 * GB }, raw: { title: 'hd-big' } }),
        cand({ parsed: { resolution: 'unknown', sizeBytes: 4 * GB }, raw: { title: 'unk-big' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['fhd-ok', 'hd-big', 'unk-big']);
  });
});

describe('filterCandidates : langues', () => {
  it('garde une langue préférée présente, multi compte comme fr', () => {
    const config = cfg({ languages: { preferred: ['fr'], acceptVostfr: false } });
    const result = filterCandidates(
      [
        cand({ parsed: { languages: ['fr'], frVariant: 'VFF' }, raw: { title: 'vff' } }),
        cand({ parsed: { languages: ['multi'], multi: true, frVariant: undefined }, raw: { title: 'multi' } }),
        cand({ parsed: { languages: ['en'], frVariant: undefined }, raw: { title: 'en' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['vff', 'multi']);
  });

  it('exclut une VO sans sous-titres FR quand des langues sont exigées', () => {
    const config = cfg({ languages: { preferred: ['fr', 'multi'], acceptVostfr: true, fallbackToOthers: false } });
    const result = filterCandidates(
      [cand({ parsed: { languages: ['en'], subsFr: false, frVariant: undefined }, raw: { title: 'vo' } })],
      config,
    );
    expect(result).toEqual([]);
  });

  it('garde un VOSTFR seulement si acceptVostfr est vrai', () => {
    const vostfr = cand({
      parsed: { languages: ['en'], subsFr: true, frVariant: 'VOSTFR' },
      raw: { title: 'vostfr' },
    });
    expect(titles(filterCandidates([vostfr], cfg({ languages: { acceptVostfr: true } })))).toEqual(['vostfr']);
    expect(filterCandidates([vostfr], cfg({ languages: { acceptVostfr: false, fallbackToOthers: false } }))).toEqual([]);
  });

  it('ne filtre pas sur la langue si la liste preferred est vide', () => {
    const config = cfg({ languages: { preferred: [], acceptVostfr: false } });
    const result = filterCandidates(
      [cand({ parsed: { languages: ['en'], subsFr: false, frVariant: undefined }, raw: { title: 'vo' } })],
      config,
    );
    expect(titles(result)).toEqual(['vo']);
  });
});

describe('filterCandidates : onlyCached', () => {
  it('ne garde que les cached ou les URL directes', () => {
    const config = cfg({ onlyCached: true });
    const result = filterCandidates(
      [
        cand({ raw: { title: 'torrent-nc' }, cached: false }),
        cand({ raw: { title: 'torrent-c' }, cached: true }),
        cand({ raw: { title: 'direct', sourceKind: 'upstream', url: 'https://up.example.com/v.mkv' } }),
        cand({ raw: { title: 'torrent-unknown' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['torrent-c', 'direct']);
  });
});
