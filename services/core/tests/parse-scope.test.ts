import { describe, expect, it } from 'vitest';
import { releaseScope, scopeCovers } from '../src/parse/scope.js';

describe('releaseScope : épisode exact', () => {
  it('SxxEyy, S4E4, séparateurs point, espace et tiret', () => {
    expect(releaseScope('Breaking.Bad.S04E04.720p.BluRay')).toEqual({ season: 4, episode: 4 });
    expect(releaseScope('Breaking Bad S4E4 VOSTFR')).toEqual({ season: 4, episode: 4 });
    expect(releaseScope('Breaking Bad S04 E04')).toEqual({ season: 4, episode: 4 });
    expect(releaseScope('Breaking_Bad_S04-E04')).toEqual({ season: 4, episode: 4 });
  });

  it('format NxNN (4x04) et « Saison 4 Episode 4 »', () => {
    expect(releaseScope('Breaking.Bad.4x04.HDTV')).toEqual({ season: 4, episode: 4 });
    expect(releaseScope('Breaking Bad Saison 4 Episode 4 FRENCH')).toEqual({ season: 4, episode: 4 });
    expect(releaseScope('Breaking Bad Season 4 Ep 4')).toEqual({ season: 4, episode: 4 });
  });

  it('un codec ou un canal n’est pas lu comme un épisode (5.1x264, x264, H.264)', () => {
    expect(releaseScope('Serie.2020.DDP5.1x264-GRP')).toEqual({});
    expect(releaseScope('Serie.1080p.WEB.H264')).toEqual({});
  });
});

describe('releaseScope : packs, intégrales, multi-saisons', () => {
  it('pack de saison : « S04 », « Saison 4 », « Season 4 » sans épisode', () => {
    expect(releaseScope('Breaking.Bad.S04.MULTI.VFF.1080p.WEB')).toEqual({ pack: 'season', season: 4 });
    expect(releaseScope('Breaking Bad Saison 4 FRENCH HDTV')).toEqual({ pack: 'season', season: 4 });
    expect(releaseScope('Breaking Bad Season 4 Complete 1080p')).toEqual({ pack: 'season', season: 4 });
  });

  it('intégrale : « Intégrale », « integrale », « complete » sans saison : toutes les saisons', () => {
    expect(releaseScope('Breaking Bad INTEGRALE MULTI 1080p')).toEqual({ pack: 'complete' });
    expect(releaseScope('Breaking Bad Intégrale CUSTOM 2160p')).toEqual({ pack: 'complete' });
    expect(releaseScope('Breaking.Bad.COMPLETE.SERIES.x264')).toEqual({ pack: 'complete' });
  });

  it('multi-saisons : « S01-S05 », « S01-05 », « Saison 1 à 5 » donnent une plage', () => {
    expect(releaseScope('Breaking.Bad.S01-S05.COMPLETE.1080p')).toEqual({ pack: 'complete', seasons: { from: 1, to: 5 } });
    expect(releaseScope('Breaking.Bad.S01-05.x264')).toEqual({ pack: 'complete', seasons: { from: 1, to: 5 } });
    expect(releaseScope('Breaking Bad Saisons 1 à 5 MULTI')).toEqual({ pack: 'complete', seasons: { from: 1, to: 5 } });
  });

  it('plusieurs saisons citées sans plage : intervalle couvrant les saisons citées', () => {
    expect(releaseScope('Serie.S02.S03.MULTI')).toEqual({ pack: 'complete', seasons: { from: 2, to: 3 } });
  });
});

describe('releaseScope : numéro absolu (anime) et texte sans indication', () => {
  it('« Titre - 05 » donne le numéro absolu ; une plage « - 01-12 » ou une année ne compte pas', () => {
    expect(releaseScope('[SubsPlease] Sousou no Frieren - 05 (1080p) [HEVC]')).toEqual({ absolute: 5 });
    expect(releaseScope('Frieren - 05v2 [1080p]')).toEqual({ absolute: 5 });
    expect(releaseScope('[Group] Frieren - 01-12 [batch]')).toEqual({});
    expect(releaseScope('Frieren Beyond 2024 1080p')).toEqual({});
  });

  it('texte sans indication : vide', () => {
    expect(releaseScope('Breaking Bad 1080p WEB-DL')).toEqual({});
    expect(releaseScope('')).toEqual({});
  });
});

describe('scopeCovers : ce qui est gardé pour un épisode demandé (S04E04)', () => {
  it('épisode exact : seulement le même numéro, jamais S04E05 ni S05E04', () => {
    expect(scopeCovers({ season: 4, episode: 4 }, 4, 4)).toBe(true);
    expect(scopeCovers({ season: 4, episode: 5 }, 4, 4)).toBe(false);
    expect(scopeCovers({ season: 5, episode: 4 }, 4, 4)).toBe(false);
    expect(scopeCovers({ season: 4, episode: 40 }, 4, 4)).toBe(false);
  });

  it('pack de la saison demandée seulement ; autre saison rejetée', () => {
    expect(scopeCovers({ pack: 'season', season: 4 }, 4, 4)).toBe(true);
    expect(scopeCovers({ pack: 'season', season: 3 }, 4, 4)).toBe(false);
  });

  it('intégrale sans plage : couvre toutes les saisons ; plage : seulement si la saison y est', () => {
    expect(scopeCovers({ pack: 'complete' }, 4, 4)).toBe(true);
    expect(scopeCovers({ pack: 'complete', seasons: { from: 1, to: 5 } }, 4, 4)).toBe(true);
    expect(scopeCovers({ pack: 'complete', seasons: { from: 1, to: 3 } }, 4, 4)).toBe(false);
  });

  it('portée vide (texte sans indication) : rejetée ; numéro absolu : seulement si le mapping donne le même', () => {
    expect(scopeCovers({}, 4, 4)).toBe(false);
    expect(scopeCovers({ absolute: 52 }, 4, 4)).toBe(false);
    expect(scopeCovers({ absolute: 52 }, 4, 4, 52)).toBe(true);
    expect(scopeCovers({ absolute: 52 }, 4, 4, 51)).toBe(false);
  });
});
