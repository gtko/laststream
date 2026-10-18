import { afterEach, describe, expect, it, vi } from 'vitest';
import { bitrateMbps, filterCandidates, limitPerResolution } from '../src/engine/filter.js';
import type { ContentMeta } from '../src/engine/types.js';
import { cand, cfg, GB, titles } from './engine-fixtures.js';

const HOUR_SECONDS = 3600;
/** Taille correspondant à 2 Mbit/s sur une heure. */
const TWO_MBPS_BYTES = 900_000_000;
const DIRECT_URL = 'https://up.example.com/v.mkv';

describe('filterCandidates : compatibilité', () => {
  it('sans meta ni réglage v2, le résultat est inchangé (le troisième argument est optionnel)', () => {
    const config = cfg({});
    const input = [
      cand({ raw: { title: 'Movie.2024.1080p.WEB-DL.DDP5.1.HEVC' } }),
      cand({ parsed: { resolution: '720p' }, raw: { title: 'Movie.2024.720p.BluRay' } }),
    ];
    expect(titles(filterCandidates(input, config))).toEqual(titles(filterCandidates(input, config, undefined)));
    expect(titles(filterCandidates(input, config))).toEqual(['Movie.2024.1080p.WEB-DL.DDP5.1.HEVC', 'Movie.2024.720p.BluRay']);
  });
});

describe('filterCandidates : limite d\'âge', () => {
  const candidates = [cand({ raw: { title: 'x' } })];

  it('avec une limite, garde la certification égale ou inférieure à la limite', () => {
    const config = cfg({ filters: { ageLimit: 12 } });
    const keep = (certificationFr: ContentMeta['certificationFr']) =>
      filterCandidates(candidates, config, { certificationFr }).length === 1;
    expect(keep(0)).toBe(true);
    expect(keep(10)).toBe(true);
    expect(keep(12)).toBe(true);
    expect(keep(16)).toBe(false);
    expect(keep(18)).toBe(false);
  });

  it('exclut un titre sans certification FR connue quand une limite est active', () => {
    const config = cfg({ filters: { ageLimit: 18 } });
    expect(filterCandidates(candidates, config, {})).toEqual([]);
    expect(filterCandidates(candidates, config, { certificationFr: 'none' })).toEqual([]);
    expect(filterCandidates(candidates, config)).toEqual([]);
  });

  it('sans limite (none), garde tout, certification connue ou non', () => {
    const config = cfg({ filters: { ageLimit: 'none' } });
    expect(filterCandidates(candidates, config)).toHaveLength(1);
    expect(filterCandidates(candidates, config, { certificationFr: 18 })).toHaveLength(1);
  });
});

describe('filterCandidates : sortie non publiée', () => {
  const candidates = [cand({ raw: { title: 'x' } })];

  it('masque une date de sortie future par défaut, garde une date passée ou inconnue', () => {
    const config = cfg({});
    expect(config.filters.hideUnreleased).toBe(true);
    expect(filterCandidates(candidates, config, { releaseDate: '2999-01-01' })).toEqual([]);
    expect(filterCandidates(candidates, config, { releaseDate: '2000-01-01' })).toHaveLength(1);
    expect(filterCandidates(candidates, config, {})).toHaveLength(1);
    expect(filterCandidates(candidates, config, { releaseDate: 'pas-une-date' })).toHaveLength(1);
  });

  it('garde les sorties futures quand hideUnreleased est désactivé', () => {
    const config = cfg({ filters: { hideUnreleased: false } });
    expect(filterCandidates(candidates, config, { releaseDate: '2999-01-01' })).toHaveLength(1);
  });
});

describe('filterCandidates : qualités autorisées', () => {
  it('ne garde que les sources listées', () => {
    const config = cfg({ filters: { qualities: ['BluRay', 'WEB-DL'] } });
    const result = filterCandidates(
      [
        cand({ parsed: { source: 'BluRay' }, raw: { title: 'bluray' } }),
        cand({ parsed: { source: 'WEB-DL' }, raw: { title: 'webdl' } }),
        cand({ parsed: { source: 'WEBRip' }, raw: { title: 'webrip' } }),
        cand({ parsed: { source: 'unknown' }, raw: { title: 'unk' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['bluray', 'webdl']);
  });

  it('exclut CAM, TS et SCR par défaut, même sans liste excludedTags', () => {
    const config = cfg({ excludedTags: [] });
    const result = filterCandidates(
      [
        cand({ parsed: { source: 'SCR' }, raw: { title: 'scr' } }),
        cand({ parsed: { source: 'TS' }, raw: { title: 'ts' } }),
        cand({ parsed: { source: 'REMUX' }, raw: { title: 'remux' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['remux']);
  });
});

describe('bitrateMbps', () => {
  it('vaut taille × 8 / durée réelle, en Mbit/s décimaux', () => {
    expect(bitrateMbps(TWO_MBPS_BYTES, HOUR_SECONDS)).toBe(2);
  });

  it('renvoie undefined si la taille ou la durée est inconnue ou nulle', () => {
    expect(bitrateMbps(undefined, HOUR_SECONDS)).toBeUndefined();
    expect(bitrateMbps(TWO_MBPS_BYTES, undefined)).toBeUndefined();
    expect(bitrateMbps(TWO_MBPS_BYTES, 0)).toBeUndefined();
  });
});

describe('filterCandidates : débit', () => {
  const candidates = [
    cand({ parsed: { sizeBytes: TWO_MBPS_BYTES }, raw: { title: 'two-mbps' } }),
    cand({ parsed: { sizeBytes: 1.8 * TWO_MBPS_BYTES }, raw: { title: 'four-mbps' } }),
    cand({ parsed: { sizeBytes: undefined }, raw: { title: 'size-unknown' } }),
  ];
  const meta: ContentMeta = { runtimeSeconds: HOUR_SECONDS };

  it('applique le minimum et le maximum avec la durée réelle', () => {
    expect(titles(filterCandidates(candidates, cfg({ filters: { bitrate: { minMbps: 3 } } }), meta))).toEqual([
      'four-mbps',
      'size-unknown',
    ]);
    expect(titles(filterCandidates(candidates, cfg({ filters: { bitrate: { maxMbps: 3 } } }), meta))).toEqual([
      'two-mbps',
      'size-unknown',
    ]);
  });

  it('est ignoré sans durée réelle connue', () => {
    const config = cfg({ filters: { bitrate: { minMbps: 3 } } });
    expect(titles(filterCandidates(candidates, config))).toEqual(['two-mbps', 'four-mbps', 'size-unknown']);
  });
});

describe('limitPerResolution', () => {
  it('garde les N premiers de chaque résolution limitée, dans l\'ordre reçu', () => {
    const config = cfg({ filters: { maxPerResolution: { '1080p': 2 } } });
    const ranked = [
      cand({ parsed: { resolution: '1080p' }, raw: { title: 'fhd-1' } }),
      cand({ parsed: { resolution: '720p' }, raw: { title: 'hd-1' } }),
      cand({ parsed: { resolution: '1080p' }, raw: { title: 'fhd-2' } }),
      cand({ parsed: { resolution: '1080p' }, raw: { title: 'fhd-3' } }),
      cand({ parsed: { resolution: '720p' }, raw: { title: 'hd-2' } }),
    ];
    expect(titles(limitPerResolution(ranked, config))).toEqual(['fhd-1', 'hd-1', 'fhd-2', 'hd-2']);
  });

  it('ne limite pas unknown, ni les résolutions sans plafond, et sans réglage renvoie tout', () => {
    const ranked = [
      cand({ parsed: { resolution: 'unknown' }, raw: { title: 'u1' } }),
      cand({ parsed: { resolution: 'unknown' }, raw: { title: 'u2' } }),
      cand({ parsed: { resolution: '2160p' }, raw: { title: 'uhd' } }),
    ];
    const limited = limitPerResolution(ranked, cfg({ filters: { maxPerResolution: { '1080p': 1 } } }));
    expect(titles(limited)).toEqual(['u1', 'u2', 'uhd']);
    expect(titles(limitPerResolution(ranked, cfg({})))).toEqual(['u1', 'u2', 'uhd']);
  });
});

describe('filterCandidates : 3D', () => {
  it('exclut 3D, SBS, HSBS et HOU par défaut, en mot entier', () => {
    const config = cfg({});
    const result = filterCandidates(
      [
        cand({ raw: { title: 'Movie.2024.3D.1080p.BluRay' } }),
        cand({ raw: { title: 'Movie.2024.HSBS.1080p' } }),
        cand({ raw: { title: 'Movie.2024.H-SBS.1080p' } }),
        cand({ raw: { title: 'Movie.2024.HOU.1080p' } }),
        cand({ raw: { title: 'Movie.2024.1080p.WEB' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['Movie.2024.1080p.WEB']);
  });

  it('garde les flux 3D si allow3d est vrai', () => {
    const result = filterCandidates([cand({ raw: { title: 'Movie.2024.3D.HSBS' } })], cfg({ filters: { allow3d: true } }));
    expect(result).toHaveLength(1);
  });
});

describe('filterCandidates : mots interdits', () => {
  it('exclut un mot entier, insensible à la casse, y compris dans le groupe de release', () => {
    const config = cfg({ filters: { bannedWords: ['Dual Audio', 'yts'] } });
    const result = filterCandidates(
      [
        cand({ raw: { title: 'Movie.Dual.Audio.1080p' } }),
        cand({ raw: { title: 'Movie.2024.1080p' }, parsed: { group: 'YTS' } }),
        cand({ raw: { title: 'Movie.YTSArchive.1080p' } }),
        cand({ raw: { title: 'Movie.DualAudioless.1080p' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['Movie.YTSArchive.1080p', 'Movie.DualAudioless.1080p']);
  });
});

describe('filterCandidates : liens directs vérifiés', () => {
  it('exclut les liens directs non vérifiés seulement si directVerifiedOnly est actif', () => {
    const direct = cand({ raw: { title: 'direct-raw', sourceKind: 'upstream', url: DIRECT_URL } });
    const verified = cand({ raw: { title: 'direct-ok', sourceKind: 'upstream', url: DIRECT_URL }, directVerified: true });
    const torrent = cand({ raw: { title: 'torrent' } });
    const input = [direct, verified, torrent];

    expect(titles(filterCandidates(input, cfg({})))).toEqual(['direct-raw', 'direct-ok', 'torrent']);
    expect(titles(filterCandidates(input, cfg({ filters: { directVerifiedOnly: true } })))).toEqual(['direct-ok', 'torrent']);
  });
});

describe('filterCandidates : canaux audio', () => {
  const withChannels = (channels: string | undefined, title: string) =>
    cand({ parsed: { channels, audio: ['AAC'] }, raw: { title } });

  it('require5_1 garde 5.1 et 7.1, exclut 2.0 et les canaux inconnus', () => {
    const config = cfg({ audio: { multichannel: 'require5_1' } });
    const result = filterCandidates(
      [withChannels('5.1', 'a51'), withChannels('7.1', 'a71'), withChannels('2.0', 'a20'), withChannels(undefined, 'anone')],
      config,
    );
    expect(titles(result)).toEqual(['a51', 'a71']);
  });

  it('require7_1 ne garde que le 7.1', () => {
    const config = cfg({ audio: { multichannel: 'require7_1' } });
    const result = filterCandidates([withChannels('5.1', 'a51'), withChannels('7.1', 'a71')], config);
    expect(titles(result)).toEqual(['a71']);
  });

  it('prefer5_1 n\'exclut rien', () => {
    const config = cfg({ audio: { multichannel: 'prefer5_1' } });
    const result = filterCandidates([withChannels('2.0', 'a20'), withChannels(undefined, 'anone')], config);
    expect(titles(result)).toEqual(['a20', 'anone']);
  });
});

describe('filterCandidates : Atmos', () => {
  it('require exclut les flux sans Atmos (nom ou piste)', () => {
    const config = cfg({ audio: { atmos: 'require' } });
    const result = filterCandidates(
      [
        cand({ parsed: { audio: ['TrueHD', 'Atmos'] }, raw: { title: 'with-atmos' } }),
        cand({ parsed: { audio: ['AAC'] }, raw: { title: 'Movie.Atmos.1080p' } }),
        cand({ parsed: { audio: ['DDP'] }, raw: { title: 'plain' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['with-atmos', 'Movie.Atmos.1080p']);
  });
});

describe('filterCandidates : formats audio non supportés', () => {
  it('mode exclude retire les flux dont le format est listé (piste parsée ou nom)', () => {
    const config = cfg({ audio: { unsupportedFormats: ['DTS-HD', 'TrueHD', 'EAC3'], unsupportedMode: 'exclude' } });
    const result = filterCandidates(
      [
        cand({ parsed: { audio: ['DTS-HD MA'] }, raw: { title: 'dts-hd-ma' } }),
        cand({ parsed: { audio: ['TrueHD'] }, raw: { title: 'truehd' } }),
        cand({ parsed: { audio: ['DDP'] }, raw: { title: 'ddp' } }),
        cand({ parsed: { audio: ['AAC'] }, raw: { title: 'Movie.E-AC-3.5.1' } }),
        cand({ parsed: { audio: ['DTS'] }, raw: { title: 'plain-dts' } }),
        cand({ parsed: { audio: ['AAC'] }, raw: { title: 'Movie.DTS-HD.MA.1080p' } }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['plain-dts']);
  });

  it('mode deprioritize ne retire rien (le déclassement est testé dans le classement)', () => {
    const config = cfg({ audio: { unsupportedFormats: ['TrueHD'], unsupportedMode: 'deprioritize' } });
    const result = filterCandidates([cand({ parsed: { audio: ['TrueHD'] }, raw: { title: 'truehd' } })], config);
    expect(titles(result)).toEqual(['truehd']);
  });
});

describe('filterCandidates : langues vérifiées seulement', () => {
  const strict = cfg({
    languages: { preferred: ['fr'], acceptVostfr: false, fallbackToOthers: false },
    audio: { verifiedLanguagesOnly: true },
  });

  it('exclut un flux non sondé même si son titre annonce le français', () => {
    const result = filterCandidates([cand({ parsed: { languages: ['fr'] }, raw: { title: 'unprobed' } })], strict);
    expect(result).toEqual([]);
  });

  it('garde un flux dont la langue préférée est vérifiée par sonde', () => {
    const result = filterCandidates(
      [cand({ parsed: { languages: ['fr'] }, raw: { title: 'probed-fr' }, verifiedLanguages: ['fr'] })],
      strict,
    );
    expect(titles(result)).toEqual(['probed-fr']);
  });

  it('n\'accepte pas une langue préférée annoncée mais non vérifiée par sonde', () => {
    const result = filterCandidates(
      [cand({ parsed: { languages: ['fr'] }, raw: { title: 'claims-fr' }, verifiedLanguages: ['en'] })],
      strict,
    );
    expect(result).toEqual([]);
  });

  it('une piste multi vérifiée compte comme français', () => {
    const result = filterCandidates(
      [cand({ parsed: { languages: ['multi'] }, raw: { title: 'multi' }, verifiedLanguages: ['multi'] })],
      strict,
    );
    expect(titles(result)).toEqual(['multi']);
  });

  it('sans l\'option, un flux non sondé est gardé', () => {
    const config = cfg({ languages: { preferred: ['fr'], acceptVostfr: false, fallbackToOthers: false } });
    expect(titles(filterCandidates([cand({ parsed: { languages: ['fr'] }, raw: { title: 'unprobed' } })], config))).toEqual([
      'unprobed',
    ]);
  });

  it('en repli, ne garde que les autres langues sondées', () => {
    const config = cfg({ languages: { preferred: ['fr'], acceptVostfr: false }, audio: { verifiedLanguagesOnly: true } });
    const result = filterCandidates(
      [
        cand({ parsed: { languages: ['en'] }, raw: { title: 'en-unprobed' } }),
        cand({ parsed: { languages: ['en'] }, raw: { title: 'en-probed' }, verifiedLanguages: ['en'] }),
      ],
      config,
    );
    expect(titles(result)).toEqual(['en-probed']);
    expect(result[0]?.languageFallback).toBe(true);
  });
});

describe('filterCandidates : réglages cumulés', () => {
  it('applique la qualité, la limite d\'âge et la taille ensemble', () => {
    const config = cfg({
      filters: { ageLimit: 12, qualities: ['BluRay'] },
      size: { maxGb: 10 },
    });
    const meta: ContentMeta = { certificationFr: 10 };
    const result = filterCandidates(
      [
        cand({ parsed: { source: 'BluRay', sizeBytes: 4 * GB }, raw: { title: 'ok' } }),
        cand({ parsed: { source: 'WEB-DL', sizeBytes: 4 * GB }, raw: { title: 'wrong-source' } }),
        cand({ parsed: { source: 'BluRay', sizeBytes: 20 * GB }, raw: { title: 'too-big' } }),
      ],
      config,
      meta,
    );
    expect(titles(result)).toEqual(['ok']);
  });
});

describe('filterCandidates : sortie du jour au fuseau de diffusion', () => {
  const candidates = [cand({ raw: { title: 'x' } })];

  afterEach(() => {
    vi.useRealTimers();
  });

  it('épisode : fenêtre de 14 jours avant la diffusion (jour de Paris inclus), au-delà masqué', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    const episode: ContentMeta = { releaseDate: '2026-11-01', releaseWindowDays: 14 };
    expect(filterCandidates(candidates, cfg({}), episode)).toHaveLength(1);
    expect(filterCandidates(candidates, cfg({}), { ...episode, releaseDate: '2026-11-02' })).toEqual([]);
  });

  it('film : sans fenêtre, une sortie à venir reste masquée jusqu’à son jour', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    expect(filterCandidates(candidates, cfg({}), { releaseDate: '2026-10-19' })).toEqual([]);
    expect(filterCandidates(candidates, cfg({}), { releaseDate: '2026-10-18' })).toHaveLength(1);
  });

  it('épisode diffusé aujourd’hui à Paris (01 h 03 le 19, 23 h 03 UTC la veille) : gardé', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T23:03:00Z'));
    expect(filterCandidates(candidates, cfg({}), { releaseDate: '2026-10-19' })).toHaveLength(1);
  });
});
