import { beforeEach, describe, expect, it } from 'vitest';
import { setAddonCatalog, type AddonCatalogEntry } from '../src/data/addonCatalog';
import { addonCatalogHash, addonMetaHash, addonSlug, parseAddonHash, resolveAddonSlug } from '../src/ui/addonRoutes.js';

const KEY = 'https://addon.example.test/cfg-abc';
const OTHER = 'https://addon.example.test/cfg-xyz';
/** Empreinte FNV-1a 64 bits de KEY : valeur fixée, le slug ne doit pas changer d'une version à l'autre. */
const SLUG = '5db8ab527dfabfa2';
/** Ancienne forme de route (clé encodée en base64url) : ne doit plus être reconnue. */
const OLD_B64_KEY = 'aHR0cHM6Ly9hZGRvbi5leGFtcGxlLnRlc3QvY2ZnLWFiYw';

const ENTRY: AddonCatalogEntry = {
  manifestUrl: `${KEY}/manifest.json`,
  name: 'Addon test',
  home: false,
  catalogs: [],
  idPrefixes: [],
  types: [],
  resources: { meta: true, stream: true },
  at: 1_700_000_000_000,
};

beforeEach(() => {
  localStorage.clear();
});

describe('routes des catalogues et fiches d’addon', () => {
  it('forme exacte de la route catalogue et de la route fiche', () => {
    expect(addonCatalogHash(KEY, 'movie', 'top')).toBe(`#/addon/${SLUG}/movie/top`);
    expect(addonMetaHash(KEY, 'movie', 'tt0111161')).toBe(`#/addon/${SLUG}/movie/meta/tt0111161`);
  });

  it('aller-retour catalogue : slug, type et identifiant de catalogue retrouvés', () => {
    const parsed = parseAddonHash(addonCatalogHash(KEY, 'series', 'popular'));
    expect(parsed).toEqual({ kind: 'catalog', addonSlug: SLUG, type: 'series', catId: 'popular' });
  });

  it('aller-retour fiche avec un identifiant contenant « : » et « / »', () => {
    const id = 'fk:1/saison 2?x&y';
    const parsed = parseAddonHash(addonMetaHash(KEY, 'tv', id));
    expect(parsed).toEqual({ kind: 'meta', addonSlug: SLUG, type: 'tv', id });
  });

  it('aller-retour catalogue avec un identifiant de catalogue contenant « / » et « : »', () => {
    const parsed = parseAddonHash(addonCatalogHash(KEY, 'movie', 'a/b:c'));
    expect(parsed).toEqual({ kind: 'catalog', addonSlug: SLUG, type: 'movie', catId: 'a/b:c' });
  });

  it('aller-retour catalogue avec une adresse d’addon non ASCII : le slug reste une empreinte hexadécimale', () => {
    const url = 'https://a.test/é?x=1';
    expect(addonSlug(url)).toMatch(/^[0-9a-f]{16}$/);
    expect(parseAddonHash(addonCatalogHash(url, 'movie', 'top'))).toEqual({ kind: 'catalog', addonSlug: addonSlug(url), type: 'movie', catId: 'top' });
  });

  it('accepte la route avec ou sans « # » en tête', () => {
    const hash = addonCatalogHash(KEY, 'movie', 'top');
    expect(parseAddonHash(hash.slice(1))).toEqual(parseAddonHash(hash));
  });

  it('une route invalide donne null', () => {
    const slug = addonSlug(KEY);
    expect(parseAddonHash('')).toBeNull();
    expect(parseAddonHash(undefined as unknown as string)).toBeNull();
    expect(parseAddonHash('#/browse/films')).toBeNull();
    expect(parseAddonHash('#/addon/')).toBeNull();
    expect(parseAddonHash('#/addon/!!!/movie/top')).toBeNull();
    expect(parseAddonHash(`#/addon/${slug.toUpperCase()}/movie/top`)).toBeNull();
    expect(parseAddonHash(`#/addon/${slug}/movie`)).toBeNull();
    expect(parseAddonHash(`#/addon/${slug}/movie/meta/`)).toBeNull();
    expect(parseAddonHash(`#/addon/${slug}/movie/top/extra`)).toBeNull();
    expect(parseAddonHash(`#/addon/${slug}/movie/%E0%A4%A`)).toBeNull();
    expect(parseAddonHash(`#/addon/${slug}//top`)).toBeNull();
  });

  it('l’ancienne forme (clé encodée en base64) n’est plus une route d’addon', () => {
    expect(parseAddonHash(`#/addon/${OLD_B64_KEY}/movie/top`)).toBeNull();
  });

  it('un catalogue dont l’identifiant vaut « meta » reste un catalogue (pas une fiche)', () => {
    expect(parseAddonHash(addonCatalogHash(KEY, 'movie', 'meta'))).toEqual({ kind: 'catalog', addonSlug: SLUG, type: 'movie', catId: 'meta' });
  });
});

describe('empreinte de clé (slug) des adresses d’addon', () => {
  it('stable, 16 caractères hexadécimaux, valeur fixée', () => {
    expect(addonSlug(KEY)).toBe(SLUG);
    expect(addonSlug(KEY)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('différente pour un autre addon, même sur le même domaine', () => {
    expect(addonSlug(OTHER)).not.toBe(addonSlug(KEY));
  });

  it('l’adresse ne contient ni la clé, ni son domaine, ni son encodage', () => {
    const hashes = [addonCatalogHash(KEY, 'movie', 'top'), addonMetaHash(KEY, 'movie', 'tt0111161')];
    for (const hash of hashes) {
      expect(hash).not.toContain('cfg-abc');
      expect(hash).not.toContain('addon.example');
      expect(hash).not.toContain(OLD_B64_KEY);
    }
  });
});

describe('résolution du slug vers la clé du registre', () => {
  const registry = { [KEY]: ENTRY, [OTHER]: ENTRY };

  it('retrouve la clé de chaque addon du registre', () => {
    expect(resolveAddonSlug(SLUG, registry)).toBe(KEY);
    expect(resolveAddonSlug(addonSlug(OTHER), registry)).toBe(OTHER);
  });

  it('slug inconnu, mal formé ou absent : null', () => {
    expect(resolveAddonSlug('0000000000000000', registry)).toBeNull();
    expect(resolveAddonSlug('ABC', registry)).toBeNull();
    expect(resolveAddonSlug(undefined as unknown as string, registry)).toBeNull();
    expect(resolveAddonSlug(SLUG, {})).toBeNull();
  });

  it('lit le registre local par défaut, et ne le trouve plus une fois l’addon retiré', () => {
    setAddonCatalog(KEY, ENTRY);
    expect(resolveAddonSlug(SLUG)).toBe(KEY);
    setAddonCatalog(KEY, null);
    expect(resolveAddonSlug(SLUG)).toBeNull();
  });

  it('parseAddonHash garde le slug sans le résoudre : un addon retiré reste une route lisible', () => {
    expect(parseAddonHash(`#/addon/0000000000000000/movie/top`)).toEqual({ kind: 'catalog', addonSlug: '0000000000000000', type: 'movie', catId: 'top' });
  });
});
