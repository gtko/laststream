// Collections : mapping des filtres vers TMDB, sources ignorées, fusion / dédoublonnage / filtres, rotation « En vedette »,
// hub (recherche, pastilles) et GIF chargé seulement au survol. Aucun réseau : tmdb() est simulé.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ path: string; params: Record<string, unknown> }> = [];
let handler: (path: string, params: Record<string, unknown>) => unknown = () => ({ results: [] });
vi.mock('../src/data/lt', () => ({
  tmdb: vi.fn(async (path: string, params: Record<string, unknown> = {}) => {
    calls.push({ path, params });
    return handler(path, params);
  }),
}));

import {
  buildCatalog, featuredDayIndex, featuredFolders, folderById, rotatingRows, searchCatalog, spotlightArtVersion, versionArt, discoverFolders, normalizeText,
} from '../src/data/collections/catalog';
import {
  buildDiscoverFolder, buildRequest, interleave, mapFilters, newCtx, resetListSupport, resolveFolder, resolveUntil, usableSources,
  folderBackdrop, resetBackdrops, type Folder, type Source,
} from '../src/data/collections/engine';
import { hideTitle, resetFiltersCache, setGenreBanned } from '../src/data/homeFilters';

const TODAY = '2026-10-18';
const movie = (id: number, extra: Record<string, unknown> = {}) => ({
  id, title: 'Film ' + id, poster_path: '/p' + id + '.jpg', backdrop_path: '/b' + id + '.jpg', release_date: '2024-05-01', genre_ids: [28],
  popularity: id, vote_average: 5 + (id % 5), ...extra,
});

beforeEach(() => { calls.length = 0; handler = () => ({ results: [] }); resetListSupport(); localStorage.clear(); resetFiltersCache(); });

describe('mapFilters : filtres du catalogue -> paramètres TMDB', () => {
  const all = {
    voteCountGte: 100, voteAverageGte: 7.2, withOriginalLanguage: 'ja', withGenres: '16,28', withoutGenres: '99', withKeywords: '1|2', withoutKeywords: '3',
    watchRegion: 'CA', withWatchProviders: '8|1796', withOriginCountry: 'JP|KR', releaseDateGte: '2020-01-01', releaseDateLte: '2022-12-31',
    withNetworks: '213', withCompanies: '5438', year: 2021,
  };

  it('traduit tous les filtres d’un film', () => {
    expect(mapFilters(all, 'movie', 'FR', TODAY)).toEqual({
      'vote_count.gte': '100', 'vote_average.gte': '7.2', with_original_language: 'ja', with_genres: '16,28', without_genres: '99',
      with_keywords: '1|2', without_keywords: '3', with_origin_country: 'JP|KR', with_companies: '5438',
      'primary_release_date.gte': '2020-01-01', 'primary_release_date.lte': '2022-12-31', primary_release_year: '2021',
      watch_region: 'FR', with_watch_providers: '8|1796', with_watch_monetization_types: 'flatrate|free|ads',
    });
  });

  it('utilise les champs séries (dates de première diffusion, réseaux, année)', () => {
    const p = mapFilters(all, 'tv', 'FR', TODAY);
    expect(p['first_air_date.gte']).toBe('2020-01-01');
    expect(p['first_air_date.lte']).toBe('2022-12-31');
    expect(p.first_air_date_year).toBe('2021');
    expect(p.with_networks).toBe('213');
    expect(p['primary_release_date.gte']).toBeUndefined();
  });

  it('force la région de l’utilisateur pour les fournisseurs et borne les titres non sortis', () => {
    expect(mapFilters({ watchRegion: 'CA', withWatchProviders: '337' }, 'movie', 'BE', TODAY).watch_region).toBe('BE');
    expect(mapFilters({ releaseDateLte: '2029-12-31' }, 'movie', 'FR', TODAY)['primary_release_date.lte']).toBe(TODAY);
    expect(mapFilters({}, 'tv', 'FR', TODAY)['first_air_date.lte']).toBe(TODAY);
    expect(mapFilters({}, 'movie', 'FR', TODAY).watch_region).toBeUndefined();
  });

  it('n’utilise que des paramètres de la liste blanche du serveur (lastaddon TMDB_PUBLIC_PARAMS)', () => {
    const allowed = new Set(['language', 'region', 'page', 'sort_by', 'with_genres', 'with_watch_providers', 'watch_region', 'with_watch_monetization_types',
      'with_companies', 'with_networks', 'without_genres', 'with_keywords', 'without_keywords', 'primary_release_date.gte', 'primary_release_date.lte',
      'first_air_date.gte', 'first_air_date.lte', 'vote_count.gte', 'with_original_language', 'include_adult', 'vote_average.gte', 'with_origin_country',
      'first_air_date_year', 'primary_release_year']);
    for (const media of ['movie', 'tv'] as const) {
      const src: Source = { kind: 'DISCOVER', media, filters: all, sort: 'vote_average.desc' };
      for (const k of Object.keys(buildRequest(src, 2, { region: 'FR', today: TODAY })!.params)) expect(allowed.has(k), k).toBe(true);
    }
  });
});

describe('buildRequest : une requête par type de source', () => {
  it('DISCOVER, COMPANY, COLLECTION et LIST', () => {
    const d = buildRequest({ kind: 'DISCOVER', media: 'tv', sort: 'primary_release_date.desc', filters: { withGenres: '18' } }, 3, { region: 'FR', today: TODAY })!;
    expect(d.path).toBe('discover/tv');
    expect(d.params).toMatchObject({ sort_by: 'first_air_date.desc', with_genres: '18', page: '3', include_adult: 'false' });
    const c = buildRequest({ kind: 'COMPANY', media: 'movie', id: 127928, filters: { voteCountGte: 10 } }, 1, { region: 'FR', today: TODAY })!;
    expect(c.path).toBe('discover/movie');
    expect(c.params).toMatchObject({ with_companies: '127928', 'vote_count.gte': '10' });
    expect(buildRequest({ kind: 'COLLECTION', media: 'movie', id: 14890 }, 1)).toMatchObject({ path: 'collection/14890' });
    expect(buildRequest({ kind: 'COLLECTION', media: 'movie', id: 14890 }, 2)).toBeNull(); // une seule page
    expect(buildRequest({ kind: 'LIST', media: 'movie', id: 8679739 }, 2)).toMatchObject({ path: 'list/8679739', params: { page: '2' } });
  });

  it('le tri demandé remplace celui de la source ; la note impose un minimum de votes', () => {
    const src: Source = { kind: 'DISCOVER', media: 'movie', sort: 'popularity.desc' };
    expect(buildRequest(src, 1, { sort: 'recent', today: TODAY })!.params.sort_by).toBe('primary_release_date.desc');
    const r = buildRequest(src, 1, { sort: 'rating', today: TODAY })!;
    expect(r.params.sort_by).toBe('vote_average.desc');
    expect(r.params['vote_count.gte']).toBe('200');
  });

  it('ignore les sources Trakt et addon', () => {
    expect(buildRequest({ kind: 'TRAKT', media: 'tv', id: 1 } as unknown as Source, 1)).toBeNull();
    expect(buildRequest({ kind: 'ADDON', media: 'movie' } as unknown as Source, 1)).toBeNull();
    const cat = buildCatalog({ categories: [{ id: 'c', title: 'C', folders: [
      { id: 'f1', title: 'Que Trakt', sources: [{ kind: 'TRAKT', media: 'tv', id: 1 }, { provider: 'trakt', kind: 'DISCOVER', media: 'tv' }, { kind: 'ADDON', media: 'movie' }] },
      { id: 'f2', title: 'Mixte', sources: [{ kind: 'TRAKT', media: 'tv', id: 1 }, { kind: 'DISCOVER', media: 'movie' }] },
    ] }] });
    expect(cat.byId.has('f1')).toBe(false); // dossier sans source TMDB : masqué
    expect(cat.byId.get('f2')!.sources).toHaveLength(1);
  });
});

describe('resolveFolder : fusion, dédoublonnage et filtres', () => {
  const folder: Folder = {
    id: 'fo', title: 'Test',
    sources: [
      { kind: 'DISCOVER', media: 'movie', name: 'A' },
      { kind: 'DISCOVER', media: 'movie', name: 'B' },
      { kind: 'COLLECTION', media: 'movie', id: 99 },
    ],
  };
  const respond = () => {
    handler = (path) => {
      if (path === 'collection/99') return { parts: [movie(1), movie(9)] };
      return { results: [movie(1), movie(2), movie(3)], total_pages: 1, total_results: 3 };
    };
  };

  it('fusionne en alternant les sources, dédoublonne et garde l’ordre', async () => {
    respond();
    const r = await resolveFolder(folder, 1, newCtx(), { region: 'FR', today: TODAY });
    expect(r.items.map((t) => t.id)).toEqual([1, 2, 9, 3]); // film 1 présent dans les 3 sources : une seule fois
    expect(r.items.every((t) => t.media_type === 'movie')).toBe(true);
    expect(r.done).toBe(true);
  });

  it('limite la concurrence : au plus 3 sources par page', async () => {
    const many: Folder = { id: 'm', title: 'M', sources: Array.from({ length: 7 }, (_, i) => ({ kind: 'DISCOVER' as const, media: 'movie' as const, name: 's' + i, filters: { withGenres: String(i) } })) };
    handler = (_p, params) => ({ results: [movie(100 + Number(params.with_genres))], total_pages: 5 });
    const ctx = newCtx();
    const p1 = await resolveFolder(many, 1, ctx, { region: 'FR', today: TODAY });
    expect(calls).toHaveLength(3);
    expect(p1.done).toBe(false);
    await resolveFolder(many, 3, ctx, { region: 'FR', today: TODAY });
    expect(calls).toHaveLength(4); // 3 lots par tour : le 3e lot n’a qu’une source
    expect(calls[3].params.with_genres).toBe('6');
    await resolveFolder(many, 4, ctx, { region: 'FR', today: TODAY }); // tour suivant : page 2 de TMDB
    expect(calls[4].params.page).toBe('2');
  });

  it('retire les titres vus, masqués, aux genres bannis, sans affiche et non sortis', async () => {
    hideTitle({ key: 'movie:2', title: 'Masqué', poster: '' });
    setGenreBanned([27], true);
    handler = () => ({ results: [
      movie(1), movie(2), movie(3, { genre_ids: [27] }), movie(4, { poster_path: null }), movie(5, { release_date: '2027-01-01' }), movie(6, { release_date: '' }), movie(7),
    ], total_pages: 1 });
    const r = await resolveFolder({ id: 'x', title: 'X', sources: [{ kind: 'DISCOVER', media: 'movie' }] }, 1, newCtx(), { region: 'FR', today: TODAY });
    expect(r.items.map((t) => t.id)).toEqual([1, 7]);
  });

  it('profil enfant : seulement les genres jeunesse', async () => {
    handler = () => ({ results: [movie(1, { genre_ids: [16] }), movie(2, { genre_ids: [28] }), movie(3, { genre_ids: [10751, 35] })], total_pages: 1 });
    const r = await resolveFolder({ id: 'k', title: 'K', sources: [{ kind: 'DISCOVER', media: 'movie' }] }, 1, newCtx(), { region: 'FR', today: TODAY, kid: true });
    expect(r.items.map((t) => t.id)).toEqual([1, 3]);
  });

  it('ne repropose pas deux fois un titre sur les pages suivantes et trie à la demande', async () => {
    handler = (_p, params) => ({ results: params.page === '1' ? [movie(1), movie(2)] : [movie(2), movie(3), movie(4)], total_pages: 2 });
    const f: Folder = { id: 'p', title: 'P', sources: [{ kind: 'DISCOVER', media: 'movie' }] };
    const ctx = newCtx({ sort: 'popularity' });
    const a = await resolveFolder(f, 1, ctx, { region: 'FR', today: TODAY });
    const b = await resolveFolder(f, 2, ctx, { region: 'FR', today: TODAY });
    expect(a.items.map((t) => t.id)).toEqual([2, 1]); // popularité décroissante
    expect(b.items.map((t) => t.id)).toEqual([4, 3]);
    expect(b.done).toBe(true);
  });

  it('resolveUntil enchaîne les pages vides', async () => {
    handler = (_p, params) => ({ results: params.page === '3' ? [movie(8)] : [movie(1)], total_pages: 3 });
    const f: Folder = { id: 'u', title: 'U', sources: [{ kind: 'DISCOVER', media: 'movie' }] };
    const r = await resolveUntil(f, 1, newCtx(), { region: 'FR', today: TODAY }, 2);
    expect(r.items.map((t) => t.id)).toEqual([1, 8]);
    expect(r.advance).toBe(3);
  });

  it('LIST : route list/ fermée côté serveur -> repli discover, sans planter', async () => {
    const lst: Folder = { id: 'l', title: 'L', sources: [{ kind: 'LIST', media: 'movie', id: 8687275, sort: 'vote_average.desc' }] };
    handler = (path) => {
      if (path.startsWith('list/')) throw Object.assign(new Error('not_found'), { status: 404 });
      return { results: [movie(5)], total_pages: 1 };
    };
    const r = await resolveFolder(lst, 1, newCtx(), { region: 'FR', today: TODAY });
    expect(r.items.map((t) => t.id)).toEqual([5]);
    expect(calls.map((c) => c.path)).toEqual(['list/8687275', 'discover/movie']);
    calls.length = 0;
    await resolveFolder(lst, 1, newCtx(), { region: 'FR', today: TODAY });
    expect(calls.map((c) => c.path)).toEqual(['discover/movie']); // on ne retente plus la route fermée
  });

  it('LIST : lit `items` (v3) et ne garde que le type demandé ; les autres sources suffisent si la route est fermée', async () => {
    handler = () => ({ items: [{ ...movie(1), media_type: 'movie' }, { ...movie(2), media_type: 'tv', name: 'S', first_air_date: '2023-01-01' }], total_pages: 1 });
    const r = await resolveFolder({ id: 'l2', title: 'L2', sources: [{ kind: 'LIST', media: 'movie', id: 1 }] }, 1, newCtx(), { region: 'FR', today: TODAY });
    expect(r.items.map((t) => t.id)).toEqual([1]);
    const mixed: Folder = { id: 'mx', title: 'Mx', sources: [{ kind: 'LIST', media: 'movie', id: 1 }, { kind: 'DISCOVER', media: 'movie' }] };
    expect(usableSources(mixed, 'all', true).map((s) => s.kind)).toEqual(['DISCOVER']);
  });

  it('interleave alterne les listes', () => {
    expect(interleave<number | string>([[1, 2, 3], ['a'], ['x', 'y']])).toEqual([1, 'a', 'x', 2, 'y', 3]);
  });
});

describe('Découvrir : filtres libres', () => {
  it('construit une requête discover à partir de la sélection', async () => {
    const f = buildDiscoverFolder({ media: 'tv', genre: 18, decade: '1990', country: 'JP', minRating: 7, providers: '8|1796' });
    const req = buildRequest(f.sources[0], 1, { region: 'FR', today: TODAY })!;
    expect(req.path).toBe('discover/tv');
    expect(req.params).toMatchObject({
      with_genres: '18', 'first_air_date.gte': '1990-01-01', 'first_air_date.lte': '1999-12-31', with_origin_country: 'JP', 'vote_average.gte': '7',
      with_watch_providers: '8|1796', watch_region: 'FR', sort_by: 'popularity.desc',
    });
    expect(buildDiscoverFolder({ media: 'movie', decade: 'before' }).sources[0].filters!.releaseDateLte).toBe('1969-12-31');
  });
});

// ---- Catalogue : hub, rotation ----

const FIXTURE = {
  categories: [
    { id: 'collection-ERFS5GWK', title: 'Services de streaming', folders: [
      { id: 'svc-netflix', title: 'Netflix', cover: 'https://img.example/n.webp', gif: 'https://img.example/n.gif', logo: 'https://img.example/n-logo.png', sources: [{ kind: 'DISCOVER', media: 'movie' }] },
      { id: 'svc-mubi', title: 'Mubi', cover: 'https://img.example/m.webp', sources: [{ kind: 'DISCOVER', media: 'movie' }] },
    ] },
    { id: 'collection-SPOTLIGHTS', title: 'En vedette', folders: ['A', 'B', 'C'].map((n) => ({
      id: 'sp-' + n, title: 'Spot ' + n, sources: [{ kind: 'LIST', media: 'movie', id: 1 }],
      cover: `https://raw.githubusercontent.com/x/y/main/art/spotlights/${n}/cover.png`, gif: `https://raw.githubusercontent.com/x/y/main/art/spotlights/${n}/hover.png?v=0`,
    })) },
    { id: 'collection-UGED6TEZ', title: 'Découvrir', folders: [
      { id: 'folder-9D1C5A0D', title: 'Nouveaux films', sources: [{ kind: 'DISCOVER', media: 'movie' }] },
      { id: 'folder-25429024', title: 'Pour vous', hidden: true, cover: 'https://img.example/fy.png', sources: [] },
      { id: 'folder-XUX2DKEX', title: 'Meilleures séries', hidden: true, cover: 'https://img.example/bs.png', sources: [] },
    ] },
    { id: 'cat-actors', title: 'Acteurs', folders: ['Brad Pitt', 'Léa Seydoux', 'Tom Hanks', 'Omar Sy'].map((n, i) => ({
      id: 'act-' + i, title: n, sources: [{ kind: 'DISCOVER', media: 'movie', name: 'Films de ' + n }] })) },
    { id: 'cat-genres', title: 'Genres', folders: ['Action', 'Comédie', 'Drame', 'Horreur', 'Réalisateurs'].map((n, i) => ({
      id: 'gen-' + i, title: n, sources: [{ kind: 'DISCOVER', media: 'movie' }] })) },
    { id: 'cat-studios', title: 'Studios', folders: ['A24', 'Pixar', 'Ghibli', 'Marvel'].map((n, i) => ({ id: 'stu-' + i, title: n, sources: [{ kind: 'COMPANY', media: 'movie', id: i + 1 }] })) },
  ],
};

describe('catalogue et rotations', () => {
  const cat = buildCatalog(FIXTURE);

  it('masque les dossiers « art seul » du hub mais les garde pour Découvrir', () => {
    expect(cat.byId.has('folder-25429024')).toBe(false);
    expect(discoverFolders(cat).map((f) => f.id)).toEqual(['folder-25429024', 'folder-9D1C5A0D', 'folder-XUX2DKEX']);
    expect(folderById(cat, 'folder-XUX2DKEX')!.sources[0]).toMatchObject({ kind: 'DISCOVER', media: 'tv', sort: 'vote_average.desc' });
    expect(folderById(cat, 'folder-25429024')).toBeNull(); // « Pour vous » : recommandations IA
  });

  it('hub : recherche instantanée (accents, nom de source) et pastille de catégorie', () => {
    expect(normalizeText('Réalisateurs')).toBe('realisateurs');
    expect(searchCatalog(cat, { query: 'realisateur' }).map((g) => g.folders.map((f) => f.title))).toEqual([['Réalisateurs']]);
    expect(searchCatalog(cat, { query: 'films de omar' })[0].folders.map((f) => f.title)).toEqual(['Omar Sy']);
    expect(searchCatalog(cat, { query: 'acteurs' })[0].folders).toHaveLength(4); // la catégorie correspond : tous ses dossiers
    expect(searchCatalog(cat, { category: 'cat-studios' }).map((g) => g.category.id)).toEqual(['cat-studios']);
    expect(searchCatalog(cat, { category: 'cat-studios', query: 'pix' })[0].folders.map((f) => f.title)).toEqual(['Pixar']);
    expect(searchCatalog(cat, { query: 'zzz' })).toEqual([]);
  });

  it('visuels « En vedette » : version par cycle de 14 jours, posée sur les adresses', () => {
    expect(spotlightArtVersion(new Date(Date.UTC(2026, 9, 3)))).toBe('0');
    expect(spotlightArtVersion(new Date(Date.UTC(2026, 9, 16, 12)))).toBe('1');
    expect(spotlightArtVersion(new Date(Date.UTC(2026, 9, 30, 12)))).toBe('2');
    expect(spotlightArtVersion(new Date(Date.UTC(2026, 8, 1)))).toBe('0'); // avant la première rotation
    const v = versionArt(cat.byId.get('sp-A')!, '3');
    expect(v.cover).toBe('https://raw.githubusercontent.com/x/y/main/art/spotlights/A/cover.png?v=3');
    expect(v.gif).toBe('https://raw.githubusercontent.com/x/y/main/art/spotlights/A/hover.png?v=3'); // l’ancienne version est remplacée
    expect(versionArt(cat.byId.get('svc-netflix')!, '3').cover).toBe('https://img.example/n.webp'); // hors spotlights : inchangé
    const ids = (d: Date) => featuredFolders(cat, d).map((f) => f.id);
    expect(featuredDayIndex(new Date(2026, 9, 2))).toBe(0);
    expect(featuredDayIndex(new Date(2026, 8, 1))).toBe(0); // avant l'ancre
    expect(ids(new Date(2026, 9, 3, 8))).toEqual(['sp-B', 'sp-C', 'sp-A']);
    expect(ids(new Date(2026, 9, 3, 23, 59))).toEqual(ids(new Date(2026, 9, 3, 0, 1))); // stable toute la journée
    expect(ids(new Date(2026, 9, 4))).toEqual(['sp-C', 'sp-A', 'sp-B']); // l'ordre tourne chaque jour
    expect(ids(new Date(2026, 9, 5))).toEqual(['sp-A', 'sp-B', 'sp-C']); // et boucle après 3 dossiers (8 en réel)
    expect(featuredFolders(cat, new Date(2026, 9, 4))[0].cover).toMatch(/\?v=0$/); // visuels : même version dans le cycle
    expect(featuredFolders(cat, new Date(2026, 9, 17, 12))[0].cover).toMatch(/\?v=1$/);
  });

  it('rangées du jour : choix stable dans la journée, variable d’un jour à l’autre, sans services ni vedette', () => {
    const d = new Date(2026, 9, 18, 9);
    const a = rotatingRows(cat, d, 2, 3);
    expect(rotatingRows(cat, new Date(2026, 9, 18, 22), 2, 3)).toEqual(a);
    expect(a).toHaveLength(2);
    expect(a.every((r) => r.folders.length === 3 && !['collection-ERFS5GWK', 'collection-SPOTLIGHTS'].includes(r.category.id))).toBe(true);
    const picks = new Set(Array.from({ length: 12 }, (_, i) => rotatingRows(cat, new Date(2026, 9, 1 + i), 1, 2)[0].category.id));
    expect(picks.size).toBeGreaterThan(1);
  });
});

// ---- UI : hub et GIF ----

function mountDom() {
  // Coque de l'application (index.html) : les modules d'interface y cherchent leurs conteneurs à l'import.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body + '<div id="host"></div>';
}

describe('hub (UI)', () => {
  it('pastilles de catégorie et recherche instantanée', async () => {
    mountDom();
    const { renderHub } = await import('../src/ui/collections.js');
    const root = document.getElementById('host')!;
    renderHub(root, buildCatalog(FIXTURE), '');
    const pills = () => Array.from(root.querySelectorAll('.pills button')).map((b) => [b.textContent, b.getAttribute('aria-pressed')]);
    expect(pills()[0]).toEqual(['Toutes', 'true']);
    expect(root.querySelectorAll('.pills button')).toHaveLength(7); // Toutes + 6 catégories
    expect(root.querySelectorAll('.ct').length).toBe(2 + 3 + 1 + 4 + 5 + 4); // « Découvrir » : 1 dossier visible, 2 « art seul » masqués
    (root.querySelector('[data-hubcat="cat-studios"]') as HTMLButtonElement).click();
    expect(pills().find((p) => p[1] === 'true')![0]).toBe('Studios');
    expect(Array.from(root.querySelectorAll('.ct')).map((t) => t.getAttribute('aria-label'))).toEqual(['A24', 'Pixar', 'Ghibli', 'Marvel']);
    const input = root.querySelector('#hub-q') as HTMLInputElement;
    input.value = 'pix';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(Array.from(root.querySelectorAll('.ct')).map((t) => t.getAttribute('aria-label'))).toEqual(['Pixar']);
    input.value = 'introuvable';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('.row-msg')!.textContent).toContain('Aucune collection');
    expect(root.textContent).toContain('Collections inspirées de Focale (MIT) et Kaptain');
  });
});

describe('tuile et GIF au survol', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

  const folder = { id: 'svc-netflix', title: 'Netflix', cover: 'https://img.example/n.webp', gif: 'https://img.example/n.gif', logo: 'https://img.example/n-logo.png', sources: [] };
  const other = { id: 'svc-mubi', title: 'Mubi', cover: 'https://img.example/m.webp', gif: 'https://img.example/m.gif', sources: [] };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('le GIF n’est pas dans le HTML ; il se charge au survol, un seul à la fois, et s’arrête à la sortie', async () => {
    mountDom();
    const { folderTile, stopGif } = await import('../src/ui/collections.js');
    const host = document.getElementById('host')!;
    host.innerHTML = folderTile(folder) + folderTile(other);
    expect(host.querySelector('img[src$="n.gif"]')).toBeNull(); // seule l’adresse est notée (data-gif) : rien n’est chargé avant le survol
    expect(host.querySelectorAll('img.ct-gif')).toHaveLength(0);
    const [a, b] = Array.from(host.querySelectorAll('.ct')) as HTMLElement[];
    expect(a.querySelector('.ct-img')!.getAttribute('src')).toBe('https://img.example/n.webp');
    expect(a.querySelector(".ct-logo")).toBeNull(); // la couverture porte déjà le logo : pas de doublon
    expect(a.dataset.logo).toBe("https://img.example/n-logo.png"); // gardé pour le repli si la couverture casse
    expect(folderTile({ ...folder, cover: "" })).toContain("ct-logo"); // sans couverture : logo en surimpression
    expect(b.querySelector('.ct-logo')).toBeNull(); // sinon le nom
    expect(b.querySelector('.ct-name')!.textContent).toBe('Mubi');

    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(host.querySelectorAll('img.ct-gif')).toHaveLength(0); // légère intention avant de charger
    await wait(220);
    expect(a.querySelector('img.ct-gif')!.getAttribute('src')).toBe('https://img.example/n.gif');
    b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await wait(220);
    expect(host.querySelectorAll('img.ct-gif')).toHaveLength(1); // jamais deux GIF en même temps
    expect(b.querySelector('img.ct-gif')).not.toBeNull();
    b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    expect(host.querySelectorAll('img.ct-gif')).toHaveLength(0);
    // Focus clavier
    a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await wait(220);
    expect(a.querySelector('img.ct-gif')).not.toBeNull();
    stopGif();
    expect(host.querySelectorAll('img.ct-gif')).toHaveLength(0);
  });

  it('prefers-reduced-motion : aucun GIF', async () => {
    vi.resetModules();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    mountDom();
    const { folderTile } = await import('../src/ui/collections.js');
    const host = document.getElementById('host')!;
    host.innerHTML = folderTile(folder);
    host.querySelector('.ct')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await wait(220);
    expect(host.querySelectorAll('img.ct-gif')).toHaveLength(0);
  });

  it('mode ?still : aucun GIF', async () => {
    vi.resetModules();
    window.history.replaceState(null, '', '/?still');
    mountDom();
    const { folderTile } = await import('../src/ui/collections.js');
    const host = document.getElementById('host')!;
    host.innerHTML = folderTile(folder);
    host.querySelector('.ct')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await wait(220);
    expect(host.querySelectorAll('img.ct-gif')).toHaveLength(0);
  });

  it('image cassée sans repli TMDB : dégradé et nom', async () => {
    vi.resetModules();
    mountDom();
    const { folderTile } = await import('../src/ui/collections.js');
    const host = document.getElementById('host')!;
    host.innerHTML = folderTile({ ...other, gif: undefined });
    const img = host.querySelector('.ct-img') as HTMLImageElement;
    img.dispatchEvent(new Event('error')); // catalogue pas encore chargé : pas de repli possible
    await wait(10);
    expect(host.querySelector('.ct-img')).toBeNull();
    expect(host.querySelector('.ct')!.classList.contains('no-img')).toBe(true);
    expect(host.querySelector('.ct-name')!.textContent).toBe('Mubi');
  });
});

describe('corrections de relecture', () => {
  it('catalogue : seules les URL http(s) sont gardées pour les visuels', () => {
    const cat = buildCatalog({ categories: [{ id: 'c', title: 'C', folders: [{ id: 'f', title: 'F', cover: 'javascript:alert(1)', gif: 'data:image/gif;base64,AAAA',
      logo: 'https://ok.example/l.png', hero: 'http://ok.example/h.jpg', sources: [{ kind: 'DISCOVER', media: 'movie' }] }] }] });
    const f = cat.byId.get('f')!;
    expect(f.cover).toBeUndefined();
    expect(f.gif).toBeUndefined();
    expect(f.logo).toBe('https://ok.example/l.png');
    expect(f.hero).toBe('http://ok.example/h.jpg');
  });

  it('fond de repli : 2 requêtes à la fois au plus, mis en cache par dossier', async () => {
    resetBackdrops();
    let live = 0; let peak = 0;
    handler = async () => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live -= 1; return { results: [movie(1)], total_pages: 1 }; };
    const mk = (id: string): Folder => ({ id, title: id, sources: [{ kind: 'DISCOVER', media: 'movie' }] });
    const out = await Promise.all(['a', 'b', 'c', 'd', 'a'].map((id) => folderBackdrop(mk(id), { region: 'FR', today: TODAY })));
    expect(out[0]).toBe('https://image.tmdb.org/t/p/w780/b1.jpg');
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls).toHaveLength(4); // « a » demandé deux fois, une seule requête
  });

  it('resolveUntil s’arrête quand la grille est relancée (annulation)', async () => {
    let n = 0;
    handler = async () => { n += 1; await new Promise((r) => setTimeout(r, 10)); return { results: [], total_pages: 50 }; };
    const f: Folder = { id: 'cx', title: 'CX', sources: [{ kind: 'DISCOVER', media: 'movie' }, { kind: 'DISCOVER', media: 'movie' }, { kind: 'DISCOVER', media: 'movie' }, { kind: 'DISCOVER', media: 'movie' }] };
    const ctx = newCtx();
    const p = resolveUntil(f, 1, ctx, { region: 'FR', today: TODAY });
    setTimeout(() => { ctx.cancelled = true; }, 5);
    const r = await p;
    expect(r.items).toEqual([]);
    expect(r.done).toBe(true);
    expect(n).toBeLessThanOrEqual(3); // pas de pages suivantes après l’annulation
  });

  it('[data-go] : ctrl, méta, maj et clic milieu ne sont pas interceptés', async () => {
    mountDom();
    await import('../src/ui/events.js');
    const host = document.getElementById('host')!;
    host.innerHTML = '<a href="#/collections" data-go id="g">Collections</a>';
    const a = document.getElementById('g')!;
    const fire = (init: MouseEventInit) => { const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...init }); a.dispatchEvent(ev); return ev.defaultPrevented; };
    expect(fire({ ctrlKey: true })).toBe(false);
    expect(fire({ metaKey: true })).toBe(false);
    expect(fire({ shiftKey: true })).toBe(false);
    expect(fire({ button: 1 })).toBe(false);
    expect(fire({})).toBe(true);
  });
});
