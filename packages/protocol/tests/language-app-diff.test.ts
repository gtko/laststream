import { describe, expect, it } from 'vitest';
import { parseLanguages } from '../src/language.js';

/**
 * Cas où le résultat de l'application change en adoptant le parseur du serveur (avant : regex simplifiées de
 * deviceFetch.ts). Chaque ligne : release, langues et variante historiques de l'application (documentaire), puis
 * résultat attendu du parseur unique.
*/
const CASES: ReadonlyArray<{ text: string; was: string; languages: string[]; frVariant?: string }> = [
  { text: "Film VFQC 1080p", was: "['original']", languages: ["fr"], frVariant: 'VFQ' },
  { text: "Film VF Quebec 1080p", was: "['fr']", languages: ["fr"], frVariant: 'VFQ' },
  { text: "Film VF QC 1080p", was: "['fr']", languages: ["fr"], frVariant: 'VFQ' },
  { text: "Movie.2020.1080p.WEB.FRENCH.x264", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie.2020.FRENCH.1080p", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "The.French.Dispatch.2021.1080p", was: "['fr']", languages: ["original"] },
  { text: "French Kiss 1995 720p", was: "['fr']", languages: ["original"] },
  { text: "Movie 2020 1080p FR x264", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie 2020 1080p VF2 x265", was: "['fr']", languages: ["fr"], frVariant: 'VF2' },
  { text: "Movie 2020 1080p VF 5.1", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie.2020.1080p.VF.WEB", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie VF", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie.2020.MULTi.1080p", was: "['multi']", languages: ["fr", "multi", "original"] },
  { text: "Movie.2020.MULTI.VFF.1080p", was: "['multi', 'fr'] VFF", languages: ["fr", "multi", "original"], frVariant: 'VFF' },
  { text: "Movie.2020.MULTi.VFQ.1080p", was: "['multi', 'fr'] VFQ", languages: ["fr", "multi", "original"], frVariant: 'VFQ' },
  { text: "Movie.2020.MULTi.TRUEFRENCH.1080p", was: "['multi', 'fr'] TRUEFRENCH", languages: ["fr", "multi", "original"], frVariant: 'TRUEFRENCH' },
  { text: "Movie.2020.DUAL.1080p", was: "['original']", languages: ["multi", "original"] },
  { text: "Movie.2020.VOST FR.1080p", was: "['fr']", languages: ["original"], frVariant: 'VOSTFR' },
  { text: "Movie 2020 SUBFRENCH 1080p", was: "['original'] VOSTFR", languages: ["original"], frVariant: 'SUBFRENCH' },
  { text: "Movie 2020 SUB FRENCH 1080p", was: "['fr']", languages: ["original"], frVariant: 'SUBFRENCH' },
  { text: "Movie.2020.STFR.1080p", was: "['original']", languages: ["original"], frVariant: 'SUBFRENCH' },
  { text: "Movie.2020.MULTI.VOSTFR", was: "['multi', 'original'] VOSTFR", languages: ["fr", "multi", "original"], frVariant: 'VOSTFR' },
  { text: "Movie 2020 1080p FRENCH VOSTFR", was: "['original'] VOSTFR", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie.2020.VFF.VOSTFR", was: "['original'] VOSTFR", languages: ["fr"], frVariant: 'VFF' },
  { text: "Movie 2020 TRUEFRENCH VOSTFR", was: "['original'] VOSTFR", languages: ["fr"], frVariant: 'TRUEFRENCH' },
  { text: "Movie 🇺🇸 1080p", was: "['en']", languages: ["original"] },
  { text: "Movie 2020 EN 1080p", was: "['original']", languages: ["en"] },
  { text: "Movie 2020 ESP", was: "['original']", languages: ["es"] },
  { text: "Movie.2020.Espanol.1080p", was: "['es']", languages: ["original"] },
  { text: "Movie 2020 Latino", was: "['original']", languages: ["es"] },
  { text: "Movie 2020 GER", was: "['original']", languages: ["de"] },
  { text: "Movie 2020 ITA", was: "['original']", languages: ["it"] },
  { text: "Movie.2020.VF.1080p.English", was: "['fr', 'en']", languages: ["fr", "en"], frVariant: 'FRENCH' },
  { text: "Movie 2020 MULTI ENG", was: "['multi', 'en']", languages: ["fr", "multi", "en", "original"] },
  { text: "Movie MULTI 2020 1080p", was: "['multi']", languages: ["fr", "multi", "original"] },
  { text: "Movie.2020.Francais.1080p", was: "['original']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie 2020 Français 1080p", was: "['original']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie 2020 VOSTEN", was: "['original']", languages: ["en"] },
  { text: "Movie 2020 VO anglais", was: "['original']", languages: ["en"] },
  { text: "Le Fabuleux Destin d Amelie Poulain 2001 FR 1080p", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Fr Movie", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie 2020 1080p fr audio", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Serie.S01E01.FRENCH.720p.HDTV", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Serie.S01E01.VF.720p", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie MULTI VFF VFQ 2020", was: "['multi', 'fr'] VFF", languages: ["fr", "multi", "original"], frVariant: 'VFF' },
  { text: "Movie 2020 VF2 VFQ", was: "['fr'] VFQ", languages: ["fr"], frVariant: 'VF2' },
  { text: "Movie MULTI.TRUEFRENCH.VFQ", was: "['multi', 'fr'] TRUEFRENCH", languages: ["fr", "multi", "original"], frVariant: 'TRUEFRENCH' },
  { text: "Movie (MULTi) 2160p", was: "['multi']", languages: ["fr", "multi", "original"] },
  { text: "Movie French 2020 1080p", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie 2020 french 1080p", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie 2020 1080p French", was: "['fr']", languages: ["fr"], frVariant: 'FRENCH' },
  { text: "Movie VF-FR 2020", was: "['fr']", languages: ["original"] },
];

describe('parseLanguages : cas qui diffèrent de l ancien parseur de l application', () => {
  for (const c of CASES) {
    it(`${c.text} -> ${c.languages.join('+')}${c.frVariant ? ' ' + c.frVariant : ''} (avant : ${c.was})`, () => {
      const r = parseLanguages(c.text);
      expect(r.languages).toEqual(c.languages);
      expect(r.frVariant).toBe(c.frVariant);
    });
  }
});
