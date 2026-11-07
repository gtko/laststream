import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAccountFilters, bannedGenreIds, DERIVED_KEYS, GENRE_OPTIONS, HOME_FILTERS_KEY_PREFIX, homeFacts, isBannedGenre,
  keepVisible, mergeFilters, normalizeFilters, packFilters, resetFiltersCache, setGenreBanned, unpackFilters,
  type HomeFilters, type HomeItemLike,
} from '../src/data/homeFilters';

const DEFAULT_KEY = HOME_FILTERS_KEY_PREFIX + 'default';
const stored = (): HomeFilters => JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? 'null');

/** Nombre de puces cochées, comme le compteur « N genres exclus » des réglages. */
const bannedChips = (): number => {
  const b = bannedGenreIds();
  return GENRE_OPTIONS.filter((g) => g.ids.some((id) => b.has(id))).length;
};

beforeEach(() => {
  localStorage.clear();
  resetFiltersCache();
});

describe('catégorie Anime (Animation et origine japonaise)', () => {
  // Un dessin animé américain, un anime japonais (série, film), une série japonaise en prise de vue réelle, des cas incomplets.
  const items: HomeItemLike[] = [
    { type: 'tv', id: 1, genreIds: [16], originalLanguage: 'en', originCountry: ['US'] },
    { type: 'tv', id: 2, genreIds: [16], originalLanguage: 'ja', originCountry: ['JP'] },
    { type: 'movie', id: 3, genreIds: [16], originalLanguage: 'ja' },
    { type: 'tv', id: 4, genreIds: [16], originalLanguage: 'en', originCountry: ['JP'] },
    { type: 'tv', id: 5, genreIds: [18], originalLanguage: 'ja', originCountry: ['JP'] },
    { type: 'tv', id: 6, genreIds: [16] },
  ];

  it('bannir « Anime » retire les anime japonais, garde le dessin animé américain', () => {
    setGenreBanned(['anime'], true);
    expect(keepVisible(items).map((x) => x.id)).toEqual([1, 5, 6]);
  });

  it('une série japonaise sans animation n’est pas un anime', () => {
    setGenreBanned(['anime'], true);
    expect(keepVisible([items[4]])).toHaveLength(1);
  });

  it('sans langue ni pays connus, rien n’est exclu (pas de faux positif)', () => {
    setGenreBanned(['anime'], true);
    expect(keepVisible([{ type: 'tv', id: 7, genreIds: [16] }, { type: 'movie', id: 8, genreIds: [16], originalLanguage: '' }])).toHaveLength(2);
  });

  it('bannir l’identifiant TMDB 16 (Animation) exclut toujours tous les dessins animés', () => {
    setGenreBanned([16], true);
    expect(keepVisible(items).map((x) => x.id)).toEqual([5]);
  });
});

describe('autres catégories dérivées', () => {
  it('K-drama : langue coréenne seulement', () => {
    setGenreBanned(['kdrama'], true);
    expect(keepVisible([{ type: 'tv', id: 1, originalLanguage: 'ko' }, { type: 'tv', id: 2, originalLanguage: 'en' }]).map((x) => x.id)).toEqual([2]);
  });

  it.each(['hi', 'ta', 'te', 'ml', 'kn'])('Bollywood : la langue %s est exclue, le français reste', (lang) => {
    setGenreBanned(['bollywood'], true);
    expect(keepVisible([{ type: 'movie', id: 1, originalLanguage: lang }, { type: 'movie', id: 2, originalLanguage: 'fr' }]).map((x) => x.id)).toEqual([2]);
  });

  it.each(['zh', 'cn'])('Cinéma chinois : la langue %s est exclue, le japonais reste', (lang) => {
    setGenreBanned(['chinese'], true);
    expect(keepVisible([{ type: 'movie', id: 1, originalLanguage: lang }, { type: 'movie', id: 2, originalLanguage: 'ja' }]).map((x) => x.id)).toEqual([2]);
  });

  it('Télénovelas : feuilleton en espagnol ou portugais, pas un drame espagnol', () => {
    setGenreBanned(['telenovela'], true);
    const kept = keepVisible([
      { type: 'tv', id: 1, genreIds: [10766], originalLanguage: 'es' },
      { type: 'tv', id: 2, genreIds: [10766], originalLanguage: 'pt' },
      { type: 'tv', id: 3, genreIds: [18], originalLanguage: 'es' },
      { type: 'tv', id: 4, genreIds: [10766], originalLanguage: 'en' },
    ]);
    expect(kept.map((x) => x.id)).toEqual([3, 4]);
  });

  it('Classiques : sorties avant 1980 (film ou première diffusion), sans date rien n’est exclu', () => {
    setGenreBanned(['classics'], true);
    const kept = keepVisible([
      { type: 'movie', id: 1, date: '1979-12-31' },
      { type: 'movie', id: 2, date: '1980-01-01' },
      { type: 'tv', id: 3, date: '1975-09-14' },
      { type: 'tv', id: 4, date: '' },
      { type: 'tv', id: 5 },
    ]);
    expect(kept.map((x) => x.id)).toEqual([2, 4, 5]);
  });

  it('une catégorie dérivée et un genre numérique se combinent (chacun suffit à exclure)', () => {
    setGenreBanned(['kdrama', 27], true);
    expect(isBannedGenre({ genreIds: [27] })).toBe(true);
    expect(isBannedGenre({ originalLanguage: 'ko' })).toBe(true);
    expect(isBannedGenre({ originalLanguage: 'fr', genreIds: [18] })).toBe(false);
  });

  it('homeFacts lit langue, pays, date et genres d’un résultat TMDB brut', () => {
    expect(homeFacts({ id: 1, genre_ids: [16, 'x'], original_language: 'ja', origin_country: ['JP'], first_air_date: '1999-10-01' })).toEqual({
      genreIds: [16], originalLanguage: 'ja', originCountry: ['JP'], date: '1999-10-01',
    });
    setGenreBanned(['classics'], true);
    expect(isBannedGenre(homeFacts({ id: 2, first_air_date: '1975-09-14', genre_ids: [18] }))).toBe(true);
    setGenreBanned(['anime'], true);
    expect(isBannedGenre(homeFacts({ id: 3, genre_ids: [16], original_language: 'ja' }))).toBe(true);
  });
});

describe('stockage des nouvelles clés', () => {
  it('enregistre la clé à côté des identifiants numériques et la relit après rechargement', () => {
    setGenreBanned(['anime', 16], true);
    expect(stored().genres).toEqual(expect.arrayContaining(['anime', 16]));
    resetFiltersCache();
    expect(bannedGenreIds()).toEqual(new Set(['anime', 16]));
  });

  it('valide à la lecture : clés connues et entiers gardés, le reste écarté, doublons retirés', () => {
    expect(normalizeFilters({ genres: ['anime', 'inconnu', 16, 16, 1.5, null, 'classics', { k: 1 }] }).genres).toEqual(['anime', 16, 'classics']);
    expect(normalizeFilters({ genres: 'anime' }).genres).toEqual([]);
  });

  it('chaque clé dérivée déclarée est acceptée au stockage', () => {
    expect(normalizeFilters({ genres: [...DERIVED_KEYS] }).genres).toEqual([...DERIVED_KEYS]);
  });

  it('aller-retour compte : les clés dérivées passent par les réglages du profil', () => {
    const f = normalizeFilters({ genres: [28, 'anime', 'kdrama'] });
    const settings = packFilters(f);
    expect(settings.homeGenres).toEqual([28, 'anime', 'kdrama']);
    expect(unpackFilters(settings)?.genres).toEqual([28, 'anime', 'kdrama']);
  });

  it('la fusion locale et compte garde les deux sortes, numériques d’abord, sans NaN', () => {
    const merged = mergeFilters(normalizeFilters({ genres: [16, 'anime'] }), normalizeFilters({ genres: ['classics', 10766] }));
    expect(merged.genres).toEqual([16, 10766, 'anime', 'classics']);
  });

  it('un compte qui envoie des clés dérivées les applique au profil local', () => {
    applyAccountFilters('default', { homeGenres: [16, 'anime'] });
    expect(bannedGenreIds()).toEqual(new Set([16, 'anime']));
    expect(keepVisible([{ type: 'tv', id: 1, genreIds: [16], originalLanguage: 'ja' }])).toHaveLength(0);
    expect(stored().genres).toEqual([16, 'anime']);
  });

  it('compteur « genres exclus » et réinitialisation couvrent les catégories dérivées', () => {
    setGenreBanned(['anime', 'kdrama', 16], true);
    expect(bannedChips()).toBe(3); // Anime, K-drama et Animation : trois puces
    setGenreBanned([...bannedGenreIds()], false);
    expect(bannedGenreIds().size).toBe(0);
    expect(bannedChips()).toBe(0);
  });
});

describe('anciens profils intacts', () => {
  it('un profil enregistré avec seulement des identifiants numériques garde son filtre', () => {
    localStorage.setItem(DEFAULT_KEY, JSON.stringify({ hidden: [], genres: [28, 10759, 27], completed: [] }));
    resetFiltersCache();
    expect(bannedGenreIds()).toEqual(new Set([28, 10759, 27]));
    expect(keepVisible([{ type: 'movie', id: 1, genreIds: [27] }])).toHaveLength(0);
    expect(keepVisible([{ type: 'movie', id: 2, genreIds: [35], originalLanguage: 'ja' }])).toHaveLength(1);
    expect(stored()).toEqual({ hidden: [], genres: [28, 10759, 27], completed: [] });
  });

  it('un ancien profil sans champ genres reste sans genre banni', () => {
    localStorage.setItem(DEFAULT_KEY, JSON.stringify({ hidden: [], completed: [] }));
    resetFiltersCache();
    expect(bannedGenreIds().size).toBe(0);
  });

  it('les réglages du compte d’avant (homeGenres numériques) se lisent comme avant', () => {
    expect(unpackFilters({ homeGenres: [16] })?.genres).toEqual([16]);
    expect(packFilters(normalizeFilters({ genres: [16, 28] })).homeGenres).toEqual([16, 28]);
  });
});

describe('libellés des réglages', () => {
  it('« Anime » vient juste après « Animation », et chaque clé dérivée a une puce', () => {
    const labels = GENRE_OPTIONS.map((g) => g.label);
    expect(labels[labels.indexOf('Animation') + 1]).toBe('Anime');
    for (const key of DERIVED_KEYS) expect(GENRE_OPTIONS.some((g) => g.ids.includes(key))).toBe(true);
  });
});
