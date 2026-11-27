import { afterEach, describe, expect, it } from 'vitest';
import { CTX_SEP, PLURAL_SEP, LOCALES, getLocale, isRtl, localeInfo, resolveLocale, t, tc, tn, useLocale } from '../src/i18n';
import { matchLocale } from '../src/i18n/locales';

afterEach(() => useLocale('fr'));

describe('langues', () => {
  it('codes uniques, nom natif, bases existantes', () => {
    const codes = LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const l of LOCALES) {
      expect(l.name).toBeTruthy();
      if (l.base) expect(localeInfo(l.base)).toBeTruthy();
    }
  });

  it('langues de droite à gauche', () => {
    expect(LOCALES.filter((l) => l.rtl).map((l) => l.code).sort()).toEqual(['ar', 'fa', 'he', 'ur']);
  });

  it('rapproche une préférence du navigateur d’une langue proposée', () => {
    const all = new Set(LOCALES.map((l) => l.code));
    expect(matchLocale('fr-BE', all)).toBe('fr');
    expect(matchLocale('fr-CA', all)).toBe('fr-CA');
    expect(matchLocale('pt', all)).toBe('pt-BR');
    expect(matchLocale('pt-PT', all)).toBe('pt-PT');
    expect(matchLocale('zh', all)).toBe('zh-CN');
    expect(matchLocale('zh-Hant-TW', all)).toBe('zh-TW');
    expect(matchLocale('es-MX', all)).toBe('es-419');
    expect(matchLocale('es-ES', all)).toBe('es');
    expect(matchLocale('no', all)).toBe('nb');
    expect(matchLocale('iw', all)).toBe('he');
    expect(matchLocale('xx', all)).toBeNull();
  });

  it('langue du navigateur si elle a un catalogue, sinon l’anglais ; le choix de l’appareil passe avant', () => {
    expect(resolveLocale('', ['en-US'])).toBe('en');
    expect(resolveLocale('', ['en-GB'])).toBe('en-GB');
    expect(resolveLocale('', ['fr-CA'])).toBe('fr-CA');
    expect(resolveLocale('', ['xx-YY'])).toBe('en');
    expect(resolveLocale('fr', ['en-US'])).toBe('fr');
  });
});

describe('traduction', () => {
  it('rend le texte source sans catalogue et remplace les paramètres', () => {
    expect(t('Bonjour {name}', { name: 'Léa' })).toBe('Bonjour Léa');
    expect(t('Reste {x}')).toBe('Reste {x}');
  });

  it('traduit, retombe sur la langue de base puis sur le français', () => {
    useLocale('en-GB', [{ Couleur: 'Colour' }, { Couleur: 'Color', Film: 'Movie' }]);
    expect(getLocale()).toBe('en-GB');
    expect(t('Couleur')).toBe('Colour');
    expect(t('Film')).toBe('Movie');
    expect(t('Série')).toBe('Série');
  });

  it('contexte : même texte français, traductions différentes', () => {
    useLocale('en', [{ ['verbe' + CTX_SEP + 'Lire']: 'Play', Lire: 'Read' }]);
    expect(tc('verbe', 'Lire')).toBe('Play');
    expect(t('Lire')).toBe('Read');
  });

  it('pluriels selon les règles de la langue', () => {
    expect(tn(1, '{n} titre', '{n} titres')).toBe('1 titre');
    expect(tn(3, '{n} titre', '{n} titres')).toBe('3 titres');
    useLocale('ru', [{ ['{n} titre' + PLURAL_SEP + '{n} titres']: { one: '{n} фильм', few: '{n} фильма', many: '{n} фильмов', other: '{n} фильма' } }]);
    expect(tn(1, '{n} titre', '{n} titres')).toBe('1 фильм');
    expect(tn(3, '{n} titre', '{n} titres')).toBe('3 фильма');
    expect(tn(5, '{n} titre', '{n} titres')).toBe('5 фильмов');
  });

  it('sens de lecture et langue sur la page', () => {
    useLocale('ar', []);
    expect(isRtl()).toBe(true);
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    useLocale('fr');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
