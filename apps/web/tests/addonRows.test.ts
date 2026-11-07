import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addonKeyOf, setAddonCatalog, type AddonCatalogEntry, type Catalog } from '../src/data/addonCatalog';
import { addonCatalogHash, addonMetaHash, addonSlug } from '../src/ui/addonRoutes.js';
import { addonHomeRows, addonItemOf, addonPreviewKey, addonRowId, rememberMetaPreview, resolveAddonRow } from '../src/ui/addonRows.js';

const BASE = 'https://addon.example.test/cfg-abc';
const MANIFEST = `${BASE}/manifest.json`;
const KEY = addonKeyOf(MANIFEST);

const TOP: Catalog = { type: 'movie', id: 'top', name: 'Populaires', extra: [] };

const entryOf = (catalogs: Catalog[], over: Partial<AddonCatalogEntry> = {}): AddonCatalogEntry => ({
  manifestUrl: MANIFEST,
  name: 'Addon test',
  home: true,
  catalogs,
  idPrefixes: ['tt'],
  types: ['movie'],
  resources: { meta: true, stream: true },
  at: 1_700_000_000_000,
  ...over,
});

const reply = (body: unknown, status = 200) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });

const METAS = [
  { id: 'tt0000001', type: 'movie', name: 'Premier film', poster: 'https://img.example.test/1.jpg', releaseInfo: '2019', genres: ['Drame'] },
  { id: 'tt0000002', type: 'movie', name: 'Deuxième film', poster: 'javascript:alert(1)', releaseInfo: '2021' },
];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('rangées d’accueil des catalogues d’addon', () => {
  it('registre vide : aucune rangée', () => {
    expect(addonHomeRows()).toEqual([]);
  });

  it('addon dont l’accueil est désactivé : aucune rangée', () => {
    setAddonCatalog(KEY, entryOf([TOP], { home: false }));
    expect(addonHomeRows()).toEqual([]);
  });

  it('catalogues search-only, cachés ou sans genre proposé : exclus de l’accueil', () => {
    setAddonCatalog(
      KEY,
      entryOf([
        { type: 'movie', id: 'search', name: 'Recherche', extra: [{ name: 'search', isRequired: true }] },
        { type: 'movie', id: 'hidden', name: 'Caché', extra: [{ name: 'skip', isRequired: true }] },
        { type: 'movie', id: 'nogenre', name: 'Sans genre', extra: [{ name: 'genre', isRequired: true }] },
      ]),
    );
    expect(addonHomeRows()).toEqual([]);
  });

  it('catalogue « home » : une rangée, titre « catalogue · addon », lien vers la page du catalogue', () => {
    setAddonCatalog(KEY, entryOf([TOP, { type: 'movie', id: 'search', name: 'Recherche', extra: [{ name: 'search', isRequired: true }] }]));
    const rows = addonHomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: addonRowId(KEY, 'movie', 'top'),
      title: 'Populaires · Addon test',
      kind: 'poster',
      fetch: { k: 'addon', addonKey: KEY, type: 'movie', catId: 'top' },
      minItems: 1,
      browseHref: addonCatalogHash(KEY, 'movie', 'top'),
    });
  });

  it('un catalogue à recherche facultative reste affiché sur l’accueil', () => {
    setAddonCatalog(KEY, entryOf([{ type: 'movie', id: 'top', name: 'Populaires', extra: [{ name: 'search' }] }]));
    expect(addonHomeRows()).toHaveLength(1);
  });

  it('rangée : première page du catalogue, titres convertis, URL de catalogue sur la base de l’addon', async () => {
    setAddonCatalog(KEY, entryOf([TOP]));
    const def = addonHomeRows()[0];
    const http = vi.fn(async (_req: { url: string }) => reply({ metas: METAS }));
    const res = await resolveAddonRow(def, 1, http);
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0].url).toBe(`${BASE}/catalog/movie/top.json`);
    expect(res?.title).toBe('Populaires · Addon test');
    expect(res?.raw).toBe(2);
    expect(res?.items.map((it: { name: string }) => it.name)).toEqual(['Premier film', 'Deuxième film']);
    expect(res?.items[0]).toMatchObject({ key: expect.stringMatching(/^addon:/), href: addonMetaHash(KEY, 'movie', 'tt0000001'), poster: 'https://img.example.test/1.jpg', year: '2019', genre: 'Drame' });
    // Affiche non http(s) écartée.
    expect(res?.items[1].poster).toBe('');
  });

  it('la page suivante d’une rangée est vide : la rangée ne lit qu’une page', async () => {
    setAddonCatalog(KEY, entryOf([TOP]));
    const def = addonHomeRows()[0];
    const http = vi.fn(async () => reply({ metas: METAS }));
    expect(await resolveAddonRow(def, 2, http)).toEqual({ title: def.title, raw: 0, items: [] });
    expect(http).not.toHaveBeenCalled();
  });

  it('rangée masquée (null) si vide, en erreur, ou si le catalogue ou l’addon ne sont plus dans le registre', async () => {
    setAddonCatalog(KEY, entryOf([TOP]));
    const def = addonHomeRows()[0];
    expect(await resolveAddonRow(def, 1, async () => reply({ metas: [] }))).toBeNull();
    expect(await resolveAddonRow(def, 1, async () => reply({ metas: METAS }, 500))).toBeNull();
    expect(await resolveAddonRow(def, 1, async () => { throw new Error('réseau'); })).toBeNull();
    setAddonCatalog(KEY, null);
    expect(await resolveAddonRow(def, 1, async () => reply({ metas: METAS }))).toBeNull();
  });

  it('une rangée dont le catalogue n’est plus affiché sur l’accueil ne se charge pas', async () => {
    setAddonCatalog(KEY, entryOf([TOP]));
    const def = addonHomeRows()[0];
    setAddonCatalog(KEY, entryOf([{ type: 'movie', id: 'top', name: 'Populaires', extra: [{ name: 'search', isRequired: true }] }]));
    const http = vi.fn(async () => reply({ metas: METAS }));
    expect(await resolveAddonRow(def, 1, http)).toBeNull();
    expect(http).not.toHaveBeenCalled();
  });

  it('un titre converti ne contient ni l’adresse de l’addon ni son jeton', () => {
    const item = addonItemOf(METAS[0], KEY, 'movie');
    expect(JSON.stringify(item)).not.toContain('cfg-abc');
    expect(JSON.stringify(item)).not.toContain('addon.example.test');
  });

  it('l’aperçu de fiche part en sessionStorage sous la clé attendue ; stockage plein : sans exception', () => {
    const item = addonItemOf(METAS[0], KEY, 'movie');
    rememberMetaPreview(item);
    const saved = JSON.parse(sessionStorage.getItem(addonPreviewKey(addonSlug(KEY), 'movie', 'tt0000001')) ?? 'null');
    expect(saved).toMatchObject({ id: 'tt0000001', name: 'Premier film', releaseInfo: '2019' });
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => rememberMetaPreview(item)).not.toThrow();
    spy.mockRestore();
  });
});
