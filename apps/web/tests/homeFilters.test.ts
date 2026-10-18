import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAccountFilters, bannedGenreIds, EMPTY_FILTERS, GENRE_OPTIONS, HOME_FILTERS_KEY_PREFIX, hideTitle, homeVisibility,
  isBannedGenre, isHiddenKey, keepVisible, MAX_HIDDEN, normalizeFilters, packFilters, resetFiltersCache, setFiltersPusher,
  setGenreBanned, setSeriesCompleted, unhideTitle, unpackFilters, type HiddenEntry, type HomeFilters,
} from '../src/data/homeFilters';
import { PROFILES_KEY, userStore } from '../src/data/userStore';
import type { SeenStore } from '../src/data/seen';

const DEFAULT_KEY = HOME_FILTERS_KEY_PREFIX + 'default';

describe('filtre combiné de l’accueil (vu, masqué, genre banni)', () => {
  const seen = new Set(['movie:1']);
  const progress: Record<string, { position: number; duration: number }> = { 'movie:7': { position: 95, duration: 100 } };
  const store: SeenStore = {
    isWatched: (k) => seen.has(k),
    getProgress: (k) => progress[k] ?? null,
  };
  const filters: HomeFilters = {
    hidden: [{ key: 'movie:2', title: 'Masqué', poster: '', addedAt: 1 }],
    genres: [27],
    completed: ['tv:4'],
  };
  const visible = homeVisibility(store, filters);

  it('retire un film vu, un film masqué, un genre banni, une série entière vue, un film regardé à 95 %', () => {
    expect(visible({ type: 'movie', id: 1 })).toBe(false);
    expect(visible({ type: 'movie', id: 2 })).toBe(false);
    expect(visible({ type: 'movie', id: 3, genreIds: [35, 27] })).toBe(false);
    expect(visible({ type: 'tv', id: 4, genreIds: [10765] })).toBe(false);
    expect(visible({ type: 'movie', id: 7 })).toBe(false);
  });

  it('garde les titres neutres, y compris une série commencée', () => {
    expect(visible({ type: 'movie', id: 5, genreIds: [35] })).toBe(true);
    expect(visible({ type: 'tv', id: 6, genreIds: [18] })).toBe(true);
  });

  it('une puce de genre couvre les deux identifiants TMDB (films et séries)', () => {
    const sf = GENRE_OPTIONS.find((g) => g.ids.includes(878));
    expect(sf?.ids).toEqual([878, 10765]);
    expect(isBannedGenre({ genreIds: [10765] }, new Set(sf!.ids))).toBe(true);
  });
});

describe('filtres du profil (stockage, actions, filtre central)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetFiltersCache();
    setFiltersPusher(null);
  });

  it('masque et réaffiche un titre, retiré de keepVisible', () => {
    expect(hideTitle({ key: 'movie:11', title: 'Film', poster: '/f.jpg' })).toBe(true);
    expect(isHiddenKey('movie:11')).toBe(true);
    expect(keepVisible([{ type: 'movie', id: 11 }, { type: 'movie', id: 12 }]).map((x) => x.id)).toEqual([12]);
    const removed = unhideTitle('movie:11');
    expect(removed?.title).toBe('Film');
    expect(keepVisible([{ type: 'movie', id: 11 }])).toHaveLength(1);
  });

  it('un film marqué vu sort de l’accueil, et y revient s’il est décoché', async () => {
    await userStore.setWatched('movie:21', null, true);
    expect(keepVisible([{ type: 'movie', id: 21 }, { type: 'movie', id: 22 }]).map((x) => x.id)).toEqual([22]);
    await userStore.setWatched('movie:21', null, false);
    expect(keepVisible([{ type: 'movie', id: 21 }])).toHaveLength(1);
  });

  it('bannit et lève un genre (deux identifiants à la fois)', () => {
    setGenreBanned([28, 10759], true);
    expect(bannedGenreIds().has(10759)).toBe(true);
    expect(keepVisible([{ type: 'tv', id: 31, genreIds: [10759] }])).toHaveLength(0);
    setGenreBanned([28, 10759], false);
    expect(bannedGenreIds().size).toBe(0);
  });

  it('une série marquée vue en entier sort de l’accueil ; un épisode non vu la fait revenir', () => {
    setSeriesCompleted('tv:1399', true);
    expect(keepVisible([{ type: 'tv', id: 1399 }])).toHaveLength(0);
    setSeriesCompleted('tv:1399', false);
    expect(keepVisible([{ type: 'tv', id: 1399 }])).toHaveLength(1);
  });

  it('isole les filtres par profil', () => {
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'default', name: 'A' }, { id: 'autre', name: 'B' }]));
    userStore.setProfile('default');
    hideTitle({ key: 'movie:50', title: 'Sur default', poster: '' });
    expect(JSON.parse(localStorage.getItem(DEFAULT_KEY)!).hidden).toHaveLength(1);
    userStore.setProfile('autre');
    expect(isHiddenKey('movie:50')).toBe(false);
    userStore.setProfile('default');
    expect(isHiddenKey('movie:50')).toBe(true);
  });

  it('refuse un titre masqué au-delà de la capacité', () => {
    const many: HiddenEntry[] = Array.from({ length: MAX_HIDDEN }, (_, i) => ({ key: `movie:${i + 100}`, title: 't', poster: '', addedAt: i }));
    localStorage.setItem(DEFAULT_KEY, JSON.stringify({ hidden: many, genres: [], completed: [] }));
    resetFiltersCache();
    expect(hideTitle({ key: 'movie:999999', title: 'x', poster: '' })).toBe(false);
  });

  it('envoie les réglages au compte à chaque changement, avec le profil concerné', () => {
    const pusher = vi.fn();
    setFiltersPusher(pusher);
    setGenreBanned([16], true);
    expect(pusher).toHaveBeenCalledWith('default', expect.objectContaining({ homeGenres: [16] }));
  });

  it('à la connexion, les réglages du compte priment ; sans réglages sur le compte, les locaux partent', () => {
    hideTitle({ key: 'movie:60', title: 'Local', poster: '' });
    const pusher = vi.fn();
    setFiltersPusher(pusher);
    expect(applyAccountFilters('default', {})).toBe(false);
    expect(pusher).toHaveBeenCalledWith('default', expect.objectContaining({ homeHidden: 1 }));

    const remote = packFilters({ hidden: [{ key: 'movie:70', title: 'Compte', poster: '', addedAt: 1 }], genres: [35], completed: [] });
    expect(applyAccountFilters('default', remote)).toBe(true);
    expect(isHiddenKey('movie:60')).toBe(false);
    expect(isHiddenKey('movie:70')).toBe(true);
    expect(bannedGenreIds().has(35)).toBe(true);
  });
});

describe('sérialisation des réglages du profil', () => {
  const entry = (i: number): HiddenEntry => ({ key: `movie:${i}`, title: 'T'.repeat(60), poster: '/' + 'p'.repeat(38), addedAt: 1700000000000 + i });

  it('fait l’aller-retour JSON sans perte', () => {
    const f: HomeFilters = { hidden: [entry(1), entry(2)], genres: [28, 10759], completed: ['tv:9', 'tv:10'] };
    const wire = JSON.parse(JSON.stringify(packFilters(f)));
    expect(unpackFilters(wire)).toEqual(f);
  });

  it('découpe les longues listes en morceaux de moins de 4 Ko', () => {
    const f: HomeFilters = { hidden: Array.from({ length: MAX_HIDDEN }, (_, i) => entry(i)), genres: [], completed: [] };
    const out = packFilters(f);
    const chunks = Object.keys(out).filter((k) => /^homeHidden\d$/.test(k));
    expect(chunks.length).toBeGreaterThan(1);
    for (const k of chunks) expect(JSON.stringify(out[k]).length).toBeLessThanOrEqual(4096);
    expect(unpackFilters(JSON.parse(JSON.stringify(out)))?.hidden).toHaveLength(MAX_HIDDEN);
  });

  it('efface les anciens morceaux quand la liste raccourcit', () => {
    const big = packFilters({ hidden: Array.from({ length: 60 }, (_, i) => entry(i)), genres: [], completed: [] });
    const small = packFilters({ hidden: [entry(1)], genres: [], completed: [] });
    const merged = { ...big, ...small };
    expect(merged.homeHidden).toBe(1);
    expect(merged.homeHidden1).toBeNull();
    expect(unpackFilters(merged)?.hidden).toEqual([entry(1)]);
  });

  it('renvoie null sans aucune clé de filtre, des filtres vides avec des clés vides', () => {
    expect(unpackFilters({ theme: { id: 'x' } })).toBeNull();
    expect(unpackFilters({ homeGenres: [], homeHidden: 0, homeCompleted: 0 })).toEqual(EMPTY_FILTERS);
  });

  it('ignore les entrées abîmées', () => {
    const n = normalizeFilters({
      hidden: [{ key: 'film:1', title: 'x', poster: '', addedAt: 1 }, { key: 'movie:2', title: 'ok', poster: '', addedAt: 2 }, null],
      genres: [28, 28, 'x', 1.5],
      completed: ['tv:3', 'movie:4'],
    });
    expect(n.hidden.map((h) => h.key)).toEqual(['movie:2']);
    expect(n.genres).toEqual([28]);
    expect(n.completed).toEqual(['tv:3']);
  });
});
