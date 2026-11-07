import { describe, expect, it } from 'vitest';
import { parseLanguages } from '../src/language.js';

describe('parseLanguages : variantes audio françaises', () => {
  it('VFF', () => {
    expect(parseLanguages('Movie.2020.1080p.BluRay.VFF.x264')).toEqual({
      languages: ['fr'],
      frVariant: 'VFF',
      multi: false,
      subsFr: false,
    });
  });

  it('VF France est reconnu comme VFF', () => {
    expect(parseLanguages('Film Titre VF France 720p')).toEqual({
      languages: ['fr'],
      frVariant: 'VFF',
      multi: false,
      subsFr: false,
    });
  });

  it('VFQ', () => {
    expect(parseLanguages('Film.2019.720p.HDTV.VFQ.x264')).toEqual({
      languages: ['fr'],
      frVariant: 'VFQ',
      multi: false,
      subsFr: false,
    });
  });

  it('VF Québec (accent) est reconnu comme VFQ', () => {
    expect(parseLanguages('Film.2019.720p.VF Québec.HDTV').frVariant).toBe('VFQ');
  });

  it('VF2 donne fr avec la variante VF2', () => {
    expect(parseLanguages('Serie.S01E02.1080p.WEB.VF2')).toEqual({
      languages: ['fr'],
      frVariant: 'VF2',
      multi: false,
      subsFr: false,
    });
  });

  it('TRUEFRENCH en un mot', () => {
    expect(parseLanguages('Movie.2017.TRUEFRENCH.1080p').frVariant).toBe('TRUEFRENCH');
  });

  it('TRUE.FRENCH avec séparateur est reconnu comme TRUEFRENCH', () => {
    expect(parseLanguages('Movie.2017.TRUE.FRENCH.1080p')).toEqual({
      languages: ['fr'],
      frVariant: 'TRUEFRENCH',
      multi: false,
      subsFr: false,
    });
  });

  it('FRENCH', () => {
    expect(parseLanguages('Le.Parrain.1972.FRENCH.BluRay.1080p')).toEqual({
      languages: ['fr'],
      frVariant: 'FRENCH',
      multi: false,
      subsFr: false,
    });
  });

  it('Français (accent) donne FRENCH', () => {
    expect(parseLanguages('Le Parrain 1972 Français 1080p')).toEqual({
      languages: ['fr'],
      frVariant: 'FRENCH',
      multi: false,
      subsFr: false,
    });
  });

  it('VF isolé donne FRENCH', () => {
    expect(parseLanguages('Movie.2001.VF.720p').frVariant).toBe('FRENCH');
  });

  it('FR isolé donne FRENCH', () => {
    expect(parseLanguages('Movie.2001.FR.720p').frVariant).toBe('FRENCH');
  });

  it('la casse est ignorée', () => {
    expect(parseLanguages('movie.vff.1080p').frVariant).toBe('VFF');
  });
});

describe('parseLanguages : sous-titres français', () => {
  it('VOSTFR : pas de fr, original présent, subsFr vrai', () => {
    expect(parseLanguages('Movie.2018.1080p.VOSTFR.WEB-DL')).toEqual({
      languages: ['original'],
      frVariant: 'VOSTFR',
      multi: false,
      subsFr: true,
    });
  });

  it('VO STFR est reconnu comme VOSTFR', () => {
    expect(parseLanguages('Movie.2018.VO.STFR.720p')).toEqual({
      languages: ['original'],
      frVariant: 'VOSTFR',
      multi: false,
      subsFr: true,
    });
  });

  it('SUBFRENCH en un mot', () => {
    expect(parseLanguages('Movie.2018.SUBFRENCH.1080p')).toEqual({
      languages: ['original'],
      frVariant: 'SUBFRENCH',
      multi: false,
      subsFr: true,
    });
  });

  it('SUB FRENCH ne donne pas FRENCH audio', () => {
    expect(parseLanguages('Movie.2018.SUB.FRENCH.1080p')).toEqual({
      languages: ['original'],
      frVariant: 'SUBFRENCH',
      multi: false,
      subsFr: true,
    });
  });

  it('STFR est traité comme sous-titres français', () => {
    const result = parseLanguages('Movie.2018.STFR.1080p');
    expect(result.subsFr).toBe(true);
    expect(result.languages).toEqual(['original']);
  });

  it('VOST FR (avec séparateur) ne donne pas fr audio', () => {
    expect(parseLanguages('Movie.2018.VOST.FR.720p')).toEqual({
      languages: ['original'],
      frVariant: 'VOSTFR',
      multi: false,
      subsFr: true,
    });
  });

  it('FRENCH sans VOSTFR : subsFr faux', () => {
    expect(parseLanguages('Movie.FRENCH.1080p').subsFr).toBe(false);
  });

  it('FRENCH.VOSTFR : audio fr conservé, original retiré', () => {
    expect(parseLanguages('Movie.FRENCH.VOSTFR.1080p')).toEqual({
      languages: ['fr'],
      frVariant: 'FRENCH',
      multi: false,
      subsFr: true,
    });
  });
});

describe('parseLanguages : priorités des variantes', () => {
  it('VFF l\'emporte sur FRENCH', () => {
    expect(parseLanguages('Movie.FRENCH.VFF.1080p').frVariant).toBe('VFF');
  });

  it('TRUEFRENCH l\'emporte sur FRENCH', () => {
    expect(parseLanguages('Movie.TRUEFRENCH.FRENCH.1080p').frVariant).toBe('TRUEFRENCH');
  });

  it('VF2 l\'emporte sur VFQ', () => {
    expect(parseLanguages('Movie.VFQ.VF2.1080p').frVariant).toBe('VF2');
  });

  it('VFQ l\'emporte sur FRENCH', () => {
    expect(parseLanguages('Movie.VFQ.FRENCH.1080p').frVariant).toBe('VFQ');
  });
});

describe('parseLanguages : MULTI et DUAL', () => {
  it('MULTi.VFF : multi, fr, original et variante VFF', () => {
    expect(parseLanguages('Movie.2020.MULTi.VFF.1080p')).toEqual({
      languages: ['fr', 'multi', 'original'],
      frVariant: 'VFF',
      multi: true,
      subsFr: false,
    });
  });

  it('MULTI seul : pas de variante', () => {
    expect(parseLanguages('Movie.2020.MULTI.1080p')).toEqual({
      languages: ['fr', 'multi', 'original'],
      multi: true,
      subsFr: false,
    });
  });

  it('MULTi VF2 (séparé par un espace) donne VF2', () => {
    expect(parseLanguages('Movie MULTi VF2 1080p')).toEqual({
      languages: ['fr', 'multi', 'original'],
      frVariant: 'VF2',
      multi: true,
      subsFr: false,
    });
  });

  it('DUAL AUDIO : multi sans fr', () => {
    expect(parseLanguages('Movie.2020.DUAL.AUDIO.1080p')).toEqual({
      languages: ['multi', 'original'],
      multi: true,
      subsFr: false,
    });
  });

  it('DUAL avec ENG ajoute en', () => {
    expect(parseLanguages('Movie.DUAL.ENG.1080p')).toEqual({
      languages: ['multi', 'en', 'original'],
      multi: true,
      subsFr: false,
    });
  });
});

describe('parseLanguages : autres langues', () => {
  it('ENGLISH', () => {
    expect(parseLanguages('Movie.ENGLISH.1080p').languages).toEqual(['en']);
  });

  it('ENG', () => {
    expect(parseLanguages('Movie.2020.ENG.1080p').languages).toEqual(['en']);
  });

  it('EN isolé', () => {
    expect(parseLanguages('Movie.2020.EN.720p').languages).toEqual(['en']);
  });

  it('VOSTEN donne en sans sous-titres FR', () => {
    expect(parseLanguages('Movie.2020.VOSTEN.1080p')).toEqual({
      languages: ['en'],
      multi: false,
      subsFr: false,
    });
  });

  it.each([
    ['Movie.SPANISH.1080p'],
    ['Serie.ESP.720p'],
    ['Film.LATINO.1080p'],
    ['Film.CASTELLANO.1080p'],
  ])('espagnol : %s', (name) => {
    expect(parseLanguages(name).languages).toEqual(['es']);
  });

  it.each([['Movie.GERMAN.1080p'], ['Film.DEUTSCH.720p'], ['Film.GER.1080p']])('allemand : %s', (name) => {
    expect(parseLanguages(name).languages).toEqual(['de']);
  });

  it.each([['Movie.ITALIAN.1080p'], ['Film.ITA.720p']])('italien : %s', (name) => {
    expect(parseLanguages(name).languages).toEqual(['it']);
  });

  it('ordre stable et pas de doublons', () => {
    expect(parseLanguages('Movie.ITA.ENG.GER.1080p').languages).toEqual(['en', 'de', 'it']);
    expect(parseLanguages('Film.FRENCH.VF.Français.1080p').languages).toEqual(['fr']);
  });
});

describe('parseLanguages : faux positifs', () => {
  it('le titre Fast.and.the.Furious ne donne pas fr', () => {
    expect(parseLanguages('The.Fast.and.the.Furious.2001.1080p.BluRay')).toEqual({
      languages: ['original'],
      multi: false,
      subsFr: false,
    });
  });

  it('IT isolé n\'est pas détecté comme italien', () => {
    expect(parseLanguages('Movie.IT.1080p').languages).toEqual(['original']);
  });

  it('ES isolé n\'est pas détecté comme espagnol', () => {
    expect(parseLanguages('Movie.ES.1080p').languages).toEqual(['original']);
  });

  it('les mots qui contiennent un code ne sont pas des marqueurs', () => {
    const result = parseLanguages('Frenchman.Engel.Gerard.Multiverse.2020.1080p');
    expect(result).toEqual({ languages: ['original'], multi: false, subsFr: false });
  });
});

describe('parseLanguages : drapeaux emoji', () => {
  it('drapeau français seul : fr sans variante', () => {
    expect(parseLanguages('Movie 2020 \u{1F1EB}\u{1F1F7} 1080p')).toEqual({
      languages: ['fr'],
      multi: false,
      subsFr: false,
    });
  });

  it('drapeaux britannique et allemand', () => {
    expect(parseLanguages('Movie \u{1F1EC}\u{1F1E7} \u{1F1E9}\u{1F1EA}').languages).toEqual(['en', 'de']);
  });

  it('drapeaux espagnol et italien', () => {
    expect(parseLanguages('Movie \u{1F1EA}\u{1F1F8} \u{1F1EE}\u{1F1F9}').languages).toEqual(['es', 'it']);
  });
});

describe('parseLanguages : cas limites', () => {
  it('aucune langue détectée : hypothèse VO', () => {
    expect(parseLanguages('Movie.2020.1080p.WEB-DL.x265')).toEqual({
      languages: ['original'],
      multi: false,
      subsFr: false,
    });
  });

  it('chaîne vide : hypothèse VO', () => {
    expect(parseLanguages('')).toEqual({ languages: ['original'], multi: false, subsFr: false });
  });

  it('une sortie sans variante ne contient pas de clé frVariant', () => {
    expect('frVariant' in parseLanguages('Movie.ENG.1080p')).toBe(false);
  });
});

describe('parseLanguages : mots français génériques après le titre', () => {
  it('The.French.Dispatch : le mot French du titre ne donne pas fr', () => {
    expect(parseLanguages('The.French.Dispatch.2021.1080p.WEB-DL')).toEqual({
      languages: ['original'],
      multi: false,
      subsFr: false,
    });
  });

  it('The.French.Connection.1971.MULTI : multi', () => {
    const info = parseLanguages('The.French.Connection.1971.MULTI.1080p');
    expect(info.multi).toBe(true);
    expect(info.languages).toContain('multi');
  });

  it('The French Kiss et Frenchie (titres) : pas de fr', () => {
    expect(parseLanguages('The French Kiss 1995 720p').languages).toEqual(['original']);
    expect(parseLanguages('Frenchie.2020.1080p').languages).toEqual(['original']);
  });

  it('Film.2021.FRENCH.1080p : fr avec la variante FRENCH', () => {
    expect(parseLanguages('Film.2021.FRENCH.1080p')).toEqual({
      languages: ['fr'],
      frVariant: 'FRENCH',
      multi: false,
      subsFr: false,
    });
  });

  it('un titre commençant par une année (1917) reste évalué en entier', () => {
    expect(parseLanguages('1917.FRENCH.1080p').frVariant).toBe('FRENCH');
  });

  it('les jetons spécifiques (TRUEFRENCH, VFF, VOSTFR) restent évalués sur tout le texte', () => {
    expect(parseLanguages('The.French.Dispatch.TRUEFRENCH.1080p').frVariant).toBe('TRUEFRENCH');
    expect(parseLanguages('Frenchie.VFF.1080p').frVariant).toBe('VFF');
    expect(parseLanguages('The.Movie.2019.VOSTFR.1080p').subsFr).toBe(true);
  });
});

describe('parseLanguages : règles de balise FRENCH (après titre, marqueur proche, majuscules)', () => {
  it('Movie.FRENCH.1080p sans année : fr, variante FRENCH', () => {
    expect(parseLanguages('Movie.FRENCH.1080p')).toMatchObject({ languages: ['fr'], frVariant: 'FRENCH' });
  });

  it('Titre.FRENCH.720p.WEB sans année : fr', () => {
    expect(parseLanguages('Titre.FRENCH.720p.WEB').languages).toEqual(['fr']);
  });

  it('french en minuscules suivi d une source (règle b) : fr', () => {
    expect(parseLanguages('Titre.french.720p.WEB').languages).toEqual(['fr']);
  });

  it('vf suivi d une résolution (règle b) : fr', () => {
    expect(parseLanguages('Movie.vf.1080p').frVariant).toBe('FRENCH');
  });

  it('french après un SxxEyy (règle a) : fr', () => {
    expect(parseLanguages('Serie.S01E02.french.720p').languages).toEqual(['fr']);
  });

  it('The.French.Dispatch.2021.HDTV : non FR (ni après le titre, ni marqueur proche, ni majuscules)', () => {
    expect(parseLanguages('The.French.Dispatch.2021.HDTV').languages).toEqual(['original']);
  });

  it('French.Kiss.1995.1080p : non FR', () => {
    expect(parseLanguages('French.Kiss.1995.1080p').languages).toEqual(['original']);
  });

  it('limite connue de la règle b : résolution dans les 2 jetons suivants sans année, The.French.Dispatch.1080p.WEB reste FR', () => {
    expect(parseLanguages('The.French.Dispatch.1080p.WEB').languages).toEqual(['fr']);
  });
});
