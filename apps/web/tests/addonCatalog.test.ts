import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpFn } from '../src/sources/debrid/http';
import {
  ADDON_CATALOGS_KEY,
  addonBaseOf,
  addonKeyOf,
  CATALOG_MAX_BODY_BYTES,
  CATALOG_TIMEOUT_MS,
  catalogDisplay,
  catalogUrl,
  fetchCatalogPage,
  isAddonId,
  isTmdbOrImdb,
  mappedIds,
  metaUrl,
  parseManifestCatalogs,
  pruneAddonCatalogs,
  readAddonCatalogs,
  setAddonCatalog,
  streamUrl,
  type AddonCatalogEntry,
} from '../src/data/addonCatalog';

const BASE = 'https://addon.example.test/cfg-abc';
const MANIFEST = `${BASE}/manifest.json`;
const TOP = { type: 'movie', id: 'top' };
const EMPTY_MANIFEST = { catalogs: [], idPrefixes: [], types: [], resources: { meta: false, stream: false } };

const reply = (body: unknown, status = 200) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });

const entryOf = (over: Partial<AddonCatalogEntry> = {}): AddonCatalogEntry => ({
  manifestUrl: MANIFEST,
  name: 'Addon test',
  home: true,
  catalogs: [],
  idPrefixes: ['tt'],
  types: ['movie'],
  resources: { meta: true, stream: true },
  at: 1_700_000_000_000,
  ...over,
});

describe('parseManifestCatalogs', () => {
  it('lit les catalogues avec leurs extras (genre, skip, search) et leurs options', () => {
    const parsed = parseManifestCatalogs({
      resources: ['catalog', 'meta', 'stream'],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [{ type: 'movie', id: 'top', name: 'Populaires', extra: [{ name: 'genre', options: ['Action', 'Drame'] }, { name: 'skip' }, { name: 'search' }] }],
    });
    expect(parsed.catalogs).toEqual([
      { type: 'movie', id: 'top', name: 'Populaires', extra: [{ name: 'genre', options: ['Action', 'Drame'] }, { name: 'skip' }, { name: 'search' }] },
    ]);
    expect(parsed.types).toEqual(['movie', 'series']);
    expect(parsed.idPrefixes).toEqual(['tt']);
    expect(parsed.resources).toEqual({ meta: true, stream: true });
  });

  it('convertit l’ancien format extraSupported / extraRequired en extra', () => {
    const parsed = parseManifestCatalogs({ catalogs: [{ type: 'movie', id: 'old', extraSupported: ['search', 'genre'], extraRequired: ['search'] }] });
    expect(parsed.catalogs).toEqual([{ type: 'movie', id: 'old', name: 'old', extra: [{ name: 'search', isRequired: true }, { name: 'genre' }] }]);
  });

  it('manifest sans catalogs, avec catalogs vide ou invalide : aucune erreur, listes vides', () => {
    expect(parseManifestCatalogs({})).toEqual(EMPTY_MANIFEST);
    expect(parseManifestCatalogs({ catalogs: [] }).catalogs).toEqual([]);
    expect(parseManifestCatalogs({ catalogs: 'pas une liste' }).catalogs).toEqual([]);
    expect(parseManifestCatalogs(null)).toEqual(EMPTY_MANIFEST);
    expect(parseManifestCatalogs('texte').catalogs).toEqual([]);
  });

  it('ignore les catalogues sans type ou sans id, et prend l’id comme nom par défaut', () => {
    const parsed = parseManifestCatalogs({ catalogs: [{ type: 'movie' }, null, { id: 'x' }, { type: 'movie', id: 'top' }] });
    expect(parsed.catalogs).toEqual([{ type: 'movie', id: 'top', name: 'top', extra: [] }]);
  });

  it('ressources en objet : idPrefixes fusionnés sans doublon, types et drapeaux lus', () => {
    const parsed = parseManifestCatalogs({
      idPrefixes: ['tt'],
      types: ['movie'],
      resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['fk:', 'tt'] }, { name: 'meta', types: ['movie'], idPrefixes: [] }],
    });
    expect(parsed.idPrefixes).toEqual(['tt', 'fk:']);
    expect(parsed.types).toEqual(['movie', 'series']);
    expect(parsed.resources).toEqual({ meta: true, stream: true });
  });

  it('manifest dont les ressources n’ont que le préfixe fk: : identifiants propres à l’addon, ni IMDb ni TMDB', () => {
    const parsed = parseManifestCatalogs({
      resources: [{ name: 'meta', types: ['movie'], idPrefixes: ['fk:'] }, { name: 'stream', types: ['movie'], idPrefixes: ['fk:'] }],
    });
    expect(parsed.idPrefixes).toEqual(['fk:']);
    expect(parsed.resources).toEqual({ meta: true, stream: true });
    expect(isAddonId('fk:42', parsed.idPrefixes)).toBe(true);
    expect(isTmdbOrImdb('fk:42')).toBe(false);
    expect(isAddonId('tt0111161', parsed.idPrefixes)).toBe(false);
  });
});

describe('identifiants', () => {
  it('reconnaît les identifiants IMDb, TMDB et Kitsu', () => {
    expect(isTmdbOrImdb('tt0111161')).toBe(true);
    expect(isTmdbOrImdb('tmdb:550')).toBe(true);
    expect(isTmdbOrImdb('kitsu:1')).toBe(true);
    expect(isTmdbOrImdb('fk:1')).toBe(false);
  });

  it('isAddonId : préfixe déclaré par l’addon, jamais IMDb, TMDB ou Kitsu', () => {
    expect(isAddonId('fk:1', ['fk:'])).toBe(true);
    expect(isAddonId('fk:1', [])).toBe(false);
    expect(isAddonId('fk:1', ['tt'])).toBe(false);
    expect(isAddonId('tt1', ['tt'])).toBe(false);
    expect(isAddonId('tmdb:1', ['tmdb'])).toBe(false);
    expect(isAddonId('fk:1', [''])).toBe(false);
  });

  it('mappedIds : IMDb et TMDB présents', () => {
    expect(mappedIds({ imdb_id: 'tt0111161', moviedb_id: 278 })).toEqual({ imdb: 'tt0111161', tmdb: 278 });
  });

  it('mappedIds : identifiants absents ou invalides ignorés', () => {
    expect(mappedIds({})).toEqual({});
    expect(mappedIds({ imdb_id: 'xx12', moviedb_id: 'abc' })).toEqual({});
    expect(mappedIds({ imdb_id: 42, moviedb_id: -3 })).toEqual({});
  });

  it('mappedIds : moviedb_id prioritaire, tmdb_id en repli', () => {
    expect(mappedIds({ moviedb_id: 278, tmdb_id: 1 })).toEqual({ tmdb: 278 });
    expect(mappedIds({ tmdb_id: 42 })).toEqual({ tmdb: 42 });
    expect(mappedIds({ moviedb_id: '603' })).toEqual({ tmdb: 603 });
  });
});

describe('catalogDisplay', () => {
  it('aucun extra requis : accueil', () => {
    expect(catalogDisplay({ extra: [{ name: 'skip' }, { name: 'search' }] })).toBe('home');
  });

  it('search requis : recherche seulement', () => {
    expect(catalogDisplay({ extra: [{ name: 'search', isRequired: true }] })).toBe('search-only');
  });

  it('genre requis avec options : accueil (première option par défaut)', () => {
    expect(catalogDisplay({ extra: [{ name: 'genre', options: ['Action'], isRequired: true }] })).toBe('home');
  });

  it('genre requis sans option : masqué', () => {
    expect(catalogDisplay({ extra: [{ name: 'genre', isRequired: true }] })).toBe('hidden');
  });

  it('autre extra requis : masqué', () => {
    expect(catalogDisplay({ extra: [{ name: 'skip', isRequired: true }] })).toBe('hidden');
  });

  it('search et genre (avec options) requis : recherche seulement', () => {
    expect(catalogDisplay({ extra: [{ name: 'genre', options: ['Action'], isRequired: true }, { name: 'search', isRequired: true }] })).toBe('search-only');
  });
});

describe('URLs des routes', () => {
  it('catalog sans paramètre : chemin simple', () => {
    expect(catalogUrl(BASE, 'movie', 'top')).toBe(`${BASE}/catalog/movie/top.json`);
  });

  it('skip seul ; skip à 0 omis', () => {
    expect(catalogUrl(BASE, 'movie', 'top', { skip: 40 })).toBe(`${BASE}/catalog/movie/top/skip=40.json`);
    expect(catalogUrl(BASE, 'movie', 'top', { skip: 0 })).toBe(`${BASE}/catalog/movie/top.json`);
  });

  it('genre accentué encodé', () => {
    expect(catalogUrl(BASE, 'movie', 'top', { genre: 'Comédie' })).toBe(`${BASE}/catalog/movie/top/genre=Com%C3%A9die.json`);
  });

  it('search avec espaces et & encodé ; ordre genre, search, skip', () => {
    expect(catalogUrl(BASE, 'movie', 'top', { skip: 20, search: 'a b & c', genre: 'Drame' })).toBe(
      `${BASE}/catalog/movie/top/genre=Drame&search=a%20b%20%26%20c&skip=20.json`,
    );
  });

  it('valeurs vides, blanches ou undefined ignorées', () => {
    expect(catalogUrl(BASE, 'movie', 'top', { genre: '', search: '   ', skip: undefined })).toBe(`${BASE}/catalog/movie/top.json`);
  });

  it('identifiant fk:a/b encodé dans le chemin', () => {
    expect(catalogUrl(BASE, 'movie', 'fk:a/b')).toBe(`${BASE}/catalog/movie/fk%3Aa%2Fb.json`);
    expect(catalogUrl(BASE, 'movie', 'fk:a/b', { skip: 20 })).toBe(`${BASE}/catalog/movie/fk%3Aa%2Fb/skip=20.json`);
  });

  it('base avec préfixe de configuration', () => {
    expect(catalogUrl('https://h.example.test/a/b', 'movie', 'top')).toBe('https://h.example.test/a/b/catalog/movie/top.json');
  });

  it('routes meta et stream : identifiant encodé (fk:1 devient fk%3A1)', () => {
    expect(metaUrl(BASE, 'movie', 'fk:1')).toBe(`${BASE}/meta/movie/fk%3A1.json`);
    expect(streamUrl(BASE, 'movie', 'fk:1')).toBe(`${BASE}/stream/movie/fk%3A1.json`);
  });
});

describe('addonBaseOf / addonKeyOf', () => {
  it('retire manifest.json, la query et le slash final ; garde le préfixe de configuration', () => {
    expect(addonBaseOf('https://addon.example.test/manifest.json')).toBe('https://addon.example.test');
    expect(addonBaseOf('https://addon.example.test/cfg-abc/manifest.json?x=1')).toBe(BASE);
    expect(addonBaseOf('https://addon.example.test/cfg-abc/')).toBe(BASE);
    expect(addonBaseOf('stremio://addon.example.test/manifest.json')).toBe('https://addon.example.test');
  });

  it('clé du registre identique à la base ; adresse invalide : vide', () => {
    expect(addonKeyOf(MANIFEST)).toBe(BASE);
    expect(addonBaseOf('pas une url')).toBe('');
    expect(addonKeyOf('pas une url')).toBe('');
  });
});

describe('registre des catalogues d’addon (stockage local)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('désactivé par défaut : aucune entrée, aucune écriture', () => {
    expect(readAddonCatalogs()).toEqual({});
    expect(localStorage.getItem(ADDON_CATALOGS_KEY)).toBeNull();
  });

  it('enregistre, relit puis retire une entrée (format {v:1, addons})', () => {
    const entry = entryOf({ catalogs: [{ type: 'movie', id: 'top', name: 'Populaires', extra: [] }] });
    setAddonCatalog('k1', entry);
    expect(readAddonCatalogs()).toEqual({ k1: entry });
    expect(JSON.parse(localStorage.getItem(ADDON_CATALOGS_KEY) ?? 'null')).toEqual({ v: 1, addons: { k1: entry } });
    setAddonCatalog('k1', null);
    expect(readAddonCatalogs()).toEqual({});
  });

  it('pruneAddonCatalogs ne garde que les clés connues', () => {
    setAddonCatalog('a', entryOf());
    setAddonCatalog('b', entryOf());
    setAddonCatalog('c', entryOf());
    pruneAddonCatalogs(['a', 'c']);
    expect(Object.keys(readAddonCatalogs()).sort()).toEqual(['a', 'c']);
  });

  it('JSON invalide : registre vide sans exception ; l’écriture suivante le remplace', () => {
    localStorage.setItem(ADDON_CATALOGS_KEY, '{pas du json');
    expect(readAddonCatalogs()).toEqual({});
    expect(() => setAddonCatalog('a', entryOf())).not.toThrow();
    expect(Object.keys(readAddonCatalogs())).toEqual(['a']);
  });

  it('autre version ignorée ; entrées mal formées écartées', () => {
    localStorage.setItem(ADDON_CATALOGS_KEY, JSON.stringify({ v: 2, addons: { a: entryOf() } }));
    expect(readAddonCatalogs()).toEqual({});
    localStorage.setItem(ADDON_CATALOGS_KEY, JSON.stringify({ v: 1, addons: { bad: { manifestUrl: 3 }, good: entryOf() } }));
    expect(Object.keys(readAddonCatalogs())).toEqual(['good']);
  });

  it('stockage qui lève une exception : lecture vide, écriture silencieuse', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readAddonCatalogs()).toEqual({});
    expect(() => setAddonCatalog('a', entryOf())).not.toThrow();
    expect(() => pruneAddonCatalogs([])).not.toThrow();
  });
});

describe('fetchCatalogPage', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('réponse 200 valide : ne garde que les fiches avec identifiant et nom', async () => {
    const http = vi.fn<HttpFn>(async () =>
      reply({
        metas: [
          { id: 'tt1', name: 'Un', type: 'movie', poster: 'p' },
          { id: '', name: 'Sans identifiant' },
          { id: 'tt2' },
          { name: 'Sans id non plus' },
          { id: 'tt3', name: '   ' },
          null,
          { id: 'fk:9', name: 'Neuf' },
        ],
      }),
    );
    const page = await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, http);
    expect(page.error).toBeUndefined();
    expect(page.metas.map((m) => m.id)).toEqual(['tt1', 'fk:9']);
    expect(page.metas[0]).toMatchObject({ name: 'Un', poster: 'p' });
    expect(http).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${BASE}/catalog/movie/top.json`, timeoutMs: CATALOG_TIMEOUT_MS, headers: { Accept: 'application/json' } }),
    );
  });

  it('statut HTTP en erreur : error http', async () => {
    const http = vi.fn<HttpFn>(async () => reply({ error: 'boom' }, 500));
    expect(await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, http)).toEqual({ metas: [], error: 'http' });
  });

  it('rejet réseau : error network, sans exception', async () => {
    const http = vi.fn<HttpFn>(async () => {
      throw new Error('boom');
    });
    expect(await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, http)).toEqual({ metas: [], error: 'network' });
  });

  it('JSON invalide : error invalid', async () => {
    const http = vi.fn<HttpFn>(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('{pas du json') }));
    expect(await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, http)).toEqual({ metas: [], error: 'invalid' });
  });

  it('JSON sans liste metas : error invalid', async () => {
    expect(await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, vi.fn<HttpFn>(async () => reply({ metas: 'x' })))).toEqual({
      metas: [],
      error: 'invalid',
    });
    expect(await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, vi.fn<HttpFn>(async () => reply(['a'])))).toEqual({
      metas: [],
      error: 'invalid',
    });
  });

  it('réponse au-delà de 4 Mo rejetée : error too_large', async () => {
    const http = vi.fn<HttpFn>(async () => ({ status: 200, headers: {}, body: new Uint8Array(CATALOG_MAX_BODY_BYTES + 1) }));
    expect(await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, http)).toEqual({ metas: [], error: 'too_large' });
  });

  it('délai dépassé (10 s) : error timeout, requête annulée', async () => {
    vi.useFakeTimers();
    const http = vi.fn<HttpFn>(
      (req) =>
        new Promise<never>((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, {}, http);
    await vi.advanceTimersByTimeAsync(CATALOG_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ metas: [], error: 'timeout' });
    expect(http.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  it('adresse d’addon invalide : error invalid, sans appel', async () => {
    const http = vi.fn<HttpFn>(async () => reply({ metas: [] }));
    expect(await fetchCatalogPage({ manifestUrl: 'pas une url' }, TOP, {}, http)).toEqual({ metas: [], error: 'invalid' });
    expect(http).not.toHaveBeenCalled();
  });

  it('sans transport injecté : une seule requête, vers l’URL du catalogue (jamais /config/test)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ metas: [{ id: 'tt1', name: 'Un' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await fetchCatalogPage({ manifestUrl: MANIFEST }, TOP, { genre: 'Drame' });
    expect(page.metas.map((m) => m.id)).toEqual(['tt1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`${BASE}/catalog/movie/top/genre=Drame.json`);
    expect(url).not.toContain('/config/test');
  });
});
