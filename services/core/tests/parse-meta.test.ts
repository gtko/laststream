import { describe, expect, it } from 'vitest';
import { extractInfoHash, parseEpisode, parseSeeders, parseSize } from '../src/parse/meta.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const HASH = '0123456789abcdef0123456789abcdef01234567';

describe('parseSize', () => {
  it('lit les gigaoctets décimaux avec point', () => {
    expect(parseSize('4.2 GB')).toBe(Math.round(4.2 * GIB));
  });

  it('accepte la virgule décimale et l\'unité Go', () => {
    expect(parseSize('4,2 Go')).toBe(Math.round(4.2 * GIB));
    expect(parseSize('1,5 Go')).toBe(Math.round(1.5 * GIB));
  });

  it('lit les mégaoctets et les unités en Mo', () => {
    expect(parseSize('850 MB')).toBe(850 * MIB);
    expect(parseSize('700Mo')).toBe(700 * MIB);
  });

  it('lit les tébioctets TiB et les kilooctets', () => {
    expect(parseSize('1.5 TiB')).toBe(Math.round(1.5 * 1024 ** 4));
    expect(parseSize('512 KB')).toBe(512 * 1024);
  });

  it('lit une taille GiB précédée d\'un libellé', () => {
    expect(parseSize('Size: 1.2 GiB')).toBe(Math.round(1.2 * GIB));
  });

  it('ignore l\'icône 💾 qui précède la taille', () => {
    expect(parseSize('💾 4.2 GB')).toBe(Math.round(4.2 * GIB));
  });

  it('trouve la taille au milieu d\'une description multi-champs', () => {
    expect(parseSize('Movie.2020.1080p 4.5 GB x264')).toBe(Math.round(4.5 * GIB));
  });

  it('lit un nombre brut seul comme des octets quand il vaut au moins 1000', () => {
    expect(parseSize('123456789')).toBe(123456789);
  });

  it('ignore un nombre brut inférieur à 1000', () => {
    expect(parseSize('999')).toBeUndefined();
  });

  it('ne prend pas l\'année d\'un nom de release pour une taille brute', () => {
    expect(parseSize('Movie 2023 1080p')).toBeUndefined();
  });

  it('renvoie undefined sans taille ni texte vide', () => {
    expect(parseSize('')).toBeUndefined();
    expect(parseSize('no size here')).toBeUndefined();
    expect(parseSize('0 GB')).toBeUndefined();
  });
});

describe('parseSeeders', () => {
  it('lit l\'icône 👤 suivie du nombre', () => {
    expect(parseSeeders('👤 123')).toBe(123);
  });

  it('lit l\'icône 👥 suivie du nombre', () => {
    expect(parseSeeders('👥 8')).toBe(8);
  });

  it('lit Seeders: avec deux-points', () => {
    expect(parseSeeders('Seeders: 45')).toBe(45);
    expect(parseSeeders('Seeders: 0')).toBe(0);
  });

  it('lit "seeds" sans deux-points', () => {
    expect(parseSeeders('seeds 7')).toBe(7);
  });

  it('lit la forme courte S: 12', () => {
    expect(parseSeeders('S: 12')).toBe(12);
    expect(parseSeeders('S:12')).toBe(12);
  });

  it('trouve le nombre dans une description avec d\'autres icônes', () => {
    expect(parseSeeders('🎬 Movie 💾 4.2 GB 👤 300')).toBe(300);
  });

  it('ne prend pas "Season:" pour la forme courte S:', () => {
    expect(parseSeeders('Season: 2')).toBeUndefined();
  });

  it('renvoie undefined sans information de seeders', () => {
    expect(parseSeeders('')).toBeUndefined();
    expect(parseSeeders('No seeders info')).toBeUndefined();
    expect(parseSeeders('Movie 2024 1080p')).toBeUndefined();
  });
});

describe('extractInfoHash', () => {
  it('extrait un hash hexadécimal de 40 caractères depuis le texte', () => {
    expect(extractInfoHash(`Movie 1080p ${HASH}`)).toBe(HASH);
  });

  it('normalise le hash hexadécimal en minuscules', () => {
    expect(extractInfoHash(HASH.toUpperCase())).toBe(HASH);
  });

  it('extrait le hash d\'un lien magnet btih', () => {
    expect(extractInfoHash(`magnet:?xt=urn:btih:${HASH}&dn=Movie`)).toBe(HASH);
  });

  it('convertit un hash base32 de 32 caractères d\'un magnet en hexadécimal', () => {
    expect(extractInfoHash(`magnet:?xt=urn:btih:${'A'.repeat(32)}&dn=Movie`)).toBe('0'.repeat(40));
    expect(extractInfoHash(`magnet:?xt=urn:btih:${'7'.repeat(32)}`)).toBe('f'.repeat(40));
  });

  it('accepte le base32 en minuscules dans un magnet', () => {
    expect(extractInfoHash(`btih:${'a'.repeat(32)}`)).toBe('0'.repeat(40));
  });

  it('ignore un base32 contenant des caractères hors alphabet', () => {
    expect(extractInfoHash(`btih:${'1'.repeat(32)}`)).toBeUndefined();
  });

  it('ne prend pas un hexadécimal de 41 caractères', () => {
    expect(extractInfoHash('a'.repeat(41))).toBeUndefined();
  });

  it('renvoie undefined quand il n\'y a pas de hash', () => {
    expect(extractInfoHash('Movie 1080p BluRay')).toBeUndefined();
  });
});

describe('parseEpisode', () => {
  it('lit le format SxxEyy', () => {
    expect(parseEpisode('Serie.S02E05.FRENCH.720p')).toEqual({ season: 2, episode: 5 });
  });

  it('lit le format minuscule s1e2 et le format avec point S01.E02', () => {
    expect(parseEpisode('show s1e2')).toEqual({ season: 1, episode: 2 });
    expect(parseEpisode('Show.S01.E02')).toEqual({ season: 1, episode: 2 });
  });

  it('lit le format NxMM', () => {
    expect(parseEpisode('Show.1x02.HDTV')).toEqual({ season: 1, episode: 2 });
  });

  it('lit "Saison 1 Épisode 2" en français', () => {
    expect(parseEpisode('Série Saison 1 Épisode 2')).toEqual({ season: 1, episode: 2 });
  });

  it('lit "Season 3 Episode 10" en anglais', () => {
    expect(parseEpisode('Show Season 3 Episode 10')).toEqual({ season: 3, episode: 10 });
  });

  it('prend le premier épisode quand le nom en annonce plusieurs', () => {
    expect(parseEpisode('S01E02E03')).toEqual({ season: 1, episode: 2 });
  });

  it('lit une saison seule (pack complet)', () => {
    expect(parseEpisode('Show.S03.COMPLETE')).toEqual({ season: 3 });
  });

  it('lit un épisode seul', () => {
    expect(parseEpisode('Episode 7')).toEqual({ episode: 7 });
  });

  it('ne lit pas une résolution 1920x1080 comme NxMM', () => {
    expect(parseEpisode('Movie.2020.1920x1080.BluRay')).toEqual({});
  });

  it('renvoie un objet vide sans information d\'épisode', () => {
    expect(parseEpisode('Movie.2023.1080p.BluRay')).toEqual({});
    expect(parseEpisode('Movie.2023.2160p.WEB-DL')).toEqual({});
    expect(parseEpisode('')).toEqual({});
  });
});
