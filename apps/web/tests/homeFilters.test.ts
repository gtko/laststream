import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAccountFilters, bannedGenreIds, byteSize, CHUNK_MAX_BYTES, chunkItems, EMPTY_FILTERS, flushSync, GENRE_OPTIONS,
  HOME_FILTERS_KEY_PREFIX, hideTitle, homeVisibility, isBannedGenre, isHiddenKey, keepVisible, MAX_CHUNKS, mergeFilters,
  normalizeFilters, packFilters, resetFiltersCache, SYNC_DELAY_MS, setFiltersPusher, setGenreBanned, setSeriesCompleted,
  unhideTitle, unpackFilters, type HiddenEntry, type HomeFilters,
} from '../src/data/homeFilters';
import { PROFILES_KEY, userStore } from '../src/data/userStore';
import type { SeenStore } from '../src/data/seen';

const DEFAULT_KEY = HOME_FILTERS_KEY_PREFIX + 'default';

/** Titre japonais de 60 caractères (180 octets UTF-8) : le cas qui fait déborder un découpage en caractères. */
const JP_TITLE = '日'.repeat(60);
const jp = (i: number): HiddenEntry => ({ key: `movie:${100000 + i}`, title: JP_TITLE, poster: '/' + 'p'.repeat(39), addedAt: 1700000000000 + i });

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
    vi.useFakeTimers();
    localStorage.clear();
    resetFiltersCache();
    setFiltersPusher(null);
  });
  afterEach(() => {
    vi.useRealTimers();
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
    flushSync();
    expect(JSON.parse(localStorage.getItem(DEFAULT_KEY)!).hidden).toHaveLength(1);
    userStore.setProfile('autre');
    expect(isHiddenKey('movie:50')).toBe(false);
    userStore.setProfile('default');
    expect(isHiddenKey('movie:50')).toBe(true);
  });

  it('refuse un titre masqué quand la liste ne tient plus dans les morceaux du compte', () => {
    let added = 0;
    for (let i = 0; i < 500; i++) {
      if (!hideTitle({ key: `movie:${100000 + i}`, title: JP_TITLE, poster: '/' + 'p'.repeat(39) })) break;
      added++;
    }
    expect(added).toBeGreaterThan(100);
    expect(added).toBeLessThan(200);
    expect(hideTitle({ key: 'movie:999999', title: 'x', poster: '' })).toBe(false);
    expect(packFilters(currentStored()).homeHidden).toBeLessThanOrEqual(MAX_CHUNKS);
  });

  it('envoie les réglages au compte après le délai d’anti-rebond, avec le dernier état seulement', () => {
    const pusher = vi.fn();
    setFiltersPusher(pusher);
    hideTitle({ key: 'movie:1', title: 'A', poster: '' });
    hideTitle({ key: 'movie:2', title: 'B', poster: '' });
    setGenreBanned([16], true);
    expect(pusher).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SYNC_DELAY_MS);
    expect(pusher).toHaveBeenCalledTimes(1);
    const [id, settings] = pusher.mock.calls[0];
    expect(id).toBe('default');
    expect(unpackFilters(settings as Record<string, unknown>)).toEqual({ hidden: expect.any(Array), genres: [16], completed: [] });
    expect((unpackFilters(settings as Record<string, unknown>)?.hidden ?? []).map((h) => h.key)).toEqual(['movie:1', 'movie:2']);
  });

  it('n’envoie que les clés modifiées, et null pour les morceaux devenus inutiles', () => {
    const pusher = vi.fn();
    setFiltersPusher(pusher);
    for (let i = 0; i < 40; i++) hideTitle(jp(i));
    flushSync();
    const first = pusher.mock.calls[0][1] as Record<string, unknown>;
    expect(first.homeHidden).toBeGreaterThan(1);

    setGenreBanned([35], true);
    flushSync();
    expect(Object.keys(pusher.mock.calls[1][1] as object)).toEqual(['homeGenres']);

    for (let i = 1; i < 40; i++) unhideTitle(jp(i).key);
    flushSync();
    const shrink = pusher.mock.calls[2][1] as Record<string, unknown>;
    expect(shrink.homeHidden).toBe(1);
    expect(shrink.homeHidden1).toBeNull();
    expect(shrink).not.toHaveProperty('homeGenres');
  });

  it('au login, fusionne les filtres locaux et ceux du compte, puis renvoie l’union', () => {
    hideTitle({ key: 'movie:60', title: 'Local', poster: '' });
    setGenreBanned([27], true);
    flushSync();
    const pusher = vi.fn();
    setFiltersPusher(pusher);
    const remote = packFilters({ hidden: [{ key: 'movie:70', title: 'Compte', poster: '', addedAt: 1 }], genres: [35], completed: ['tv:9'] });
    expect(applyAccountFilters('default', remote)).toBe(true);
    expect(isHiddenKey('movie:60')).toBe(true);
    expect(isHiddenKey('movie:70')).toBe(true);
    expect(bannedGenreIds()).toEqual(new Set([27, 35]));
    expect(currentStored().completed).toEqual(['tv:9']);
    // L'union part au compte : seules les clés qui diffèrent de son état (titres et genres) sont envoyées.
    expect(pusher).toHaveBeenCalledTimes(1);
    const sent = pusher.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('homeCompleted');
    expect(sent.homeGenres).toEqual([27, 35]);
  });

  it('au login, n’envoie rien si le compte a déjà l’union', () => {
    hideTitle({ key: 'movie:80', title: 'Même', poster: '' });
    const pusher = vi.fn();
    setFiltersPusher(pusher);
    const remote = packFilters(currentStored());
    expect(applyAccountFilters('default', remote)).toBe(false);
    expect(pusher).not.toHaveBeenCalled();
  });

  it('sans réglages sur le compte, les filtres locaux partent vers le compte', () => {
    hideTitle({ key: 'movie:60', title: 'Local', poster: '' });
    const pusher = vi.fn();
    setFiltersPusher(pusher);
    expect(applyAccountFilters('default', {})).toBe(false);
    expect(pusher).toHaveBeenCalledWith('default', expect.objectContaining({ homeHidden: 1 }));
  });
});

/** Filtres actuellement stockés pour le profil par défaut. */
function currentStored(): HomeFilters {
  return normalizeFilters(JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? 'null'));
}

describe('sérialisation des réglages du profil', () => {
  const entry = (i: number): HiddenEntry => ({ key: `movie:${i}`, title: 'T'.repeat(60), poster: '/' + 'p'.repeat(38), addedAt: 1700000000000 + i });

  it('fait l’aller-retour JSON sans perte', () => {
    const f: HomeFilters = { hidden: [entry(1), entry(2)], genres: [28, 10759], completed: ['tv:9', 'tv:10'] };
    const wire = JSON.parse(JSON.stringify(packFilters(f)));
    expect(unpackFilters(wire)).toEqual(f);
  });

  it('découpe des titres japonais en morceaux de moins de 3500 octets UTF-8', () => {
    const items = Array.from({ length: 60 }, (_, i) => jp(i));
    const parts = chunkItems(items);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(byteSize(p)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
    expect(parts.flat()).toEqual(items);
    const wire = JSON.parse(JSON.stringify(packFilters({ hidden: items, genres: [], completed: [] })));
    expect(unpackFilters(wire)?.hidden).toEqual(items);
  });

  it('avertit dans la console quand une liste dépasse 12 morceaux, au lieu de tronquer en silence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = packFilters({ hidden: Array.from({ length: 300 }, (_, i) => jp(i)), genres: [], completed: [] });
    expect(warn).toHaveBeenCalled();
    expect(out.homeHidden).toBe(MAX_CHUNKS);
    warn.mockRestore();
  });

  it('efface les anciens morceaux quand la liste raccourcit', () => {
    const big = packFilters({ hidden: Array.from({ length: 60 }, (_, i) => jp(i)), genres: [], completed: [] });
    const small = packFilters({ hidden: [jp(1)], genres: [], completed: [] });
    const merged = { ...big, ...small };
    expect(merged.homeHidden).toBe(1);
    expect(merged.homeHidden1).toBeNull();
    expect(unpackFilters(merged)?.hidden).toEqual([jp(1)]);
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

  it('fusion : le titre le plus récent gagne, les genres et séries sont réunis', () => {
    const a: HomeFilters = { hidden: [{ key: 'movie:1', title: 'ancien', poster: '', addedAt: 1 }], genres: [18], completed: ['tv:1'] };
    const b: HomeFilters = { hidden: [{ key: 'movie:1', title: 'récent', poster: '', addedAt: 5 }, entry(2)], genres: [18, 53], completed: ['tv:2'] };
    const m = mergeFilters(a, b);
    expect(m.hidden.find((h) => h.key === 'movie:1')?.title).toBe('récent');
    expect(m.hidden).toHaveLength(2);
    expect(m.genres).toEqual([18, 53]);
    expect(m.completed).toEqual(['tv:1', 'tv:2']);
  });

  it('fusion au-delà de la capacité : les plus anciens sont écartés avec un avertissement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const m = mergeFilters({ hidden: Array.from({ length: 300 }, (_, i) => jp(i)), genres: [], completed: [] }, EMPTY_FILTERS);
    expect(warn).toHaveBeenCalled();
    expect(chunkItems(m.hidden).length).toBeLessThanOrEqual(MAX_CHUNKS);
    expect(m.hidden[m.hidden.length - 1].key).toBe(jp(299).key);
    warn.mockRestore();
  });
});
