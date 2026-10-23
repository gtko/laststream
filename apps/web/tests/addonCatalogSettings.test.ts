// Réglages > Sources : catalogues d'un addon (ODY-252). Interrupteur « Afficher les catalogues de cet addon » (OFF par défaut),
// case « Rangée à l’accueil », avertissement permanent, registre local (src/data/addonCatalog.ts) mis à jour et nettoyé à l'enregistrement.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoFlags } from '../src/data/demo';
import { ADDON_CATALOGS_KEY, addonKeyOf, readAddonCatalogs, setAddonCatalog, type AddonCatalogEntry } from '../src/data/addonCatalog';

const WITH = 'https://catalog.example/cfg-abc/manifest.json'; // manifest avec un catalogue affichable
const WITHOUT = 'https://nocatalog.example/manifest.json'; // manifest sans catalogue
const HIDDEN = 'https://hidden.example/manifest.json'; // seul catalogue : paramètre requis masquant
const KEY = addonKeyOf(WITH);
const WARNING = 'N’ajoute jamais ta clé de débrideur dans l’adresse d’un addon : elle serait appelée depuis cet appareil.';

const CATALOG_MANIFEST = {
  name: 'Addon catalogues',
  version: '2.0.0',
  logo: 'https://catalog.example/logo.png',
  types: ['movie'],
  idPrefixes: ['cat:'],
  resources: ['catalog', 'meta', 'stream'],
  catalogs: [{ type: 'movie', id: 'top', name: 'Top', extra: [] }],
};

function mockFetch(url: string): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.pathname.includes('/stream/')) return json({ error: 'not_found' }, 404); // diagnostic « torrents seulement » : sans verdict
  if (u.hostname === 'catalog.example') return json(CATALOG_MANIFEST);
  if (u.hostname === 'nocatalog.example') return json({ name: 'Sans catalogue', version: '1.0.0', resources: ['stream'], types: ['movie'] });
  if (u.hostname === 'hidden.example') {
    return json({ name: 'Catalogue requis', version: '1.0.0', resources: ['catalog', 'stream'], types: ['movie'],
      catalogs: [{ type: 'movie', id: 'x', name: 'Privé', extra: [{ name: 'skip', isRequired: true }] }] });
  }
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') return json({ services: {}, languages: {}, sources: [] });
  return json({ error: 'not_found' }, 404);
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  location.hash = '#/settings';
  await import('../src/main.js');
  await settle(900);
});

beforeEach(() => {
  localStorage.removeItem(ADDON_CATALOGS_KEY);
  setDemoFlags({ on: false, clean: false, profile: '' });
});

// Ouverture de la page avec ces sources : relit les manifests (comme à l'ouverture réelle), puis rend la liste.
const openPage = async (sources: Array<Record<string, unknown>>): Promise<void> => {
  const { initSources, sourcesHTML } = await import('../src/ui/settings-sources.js');
  initSources(sources);
  const fresh = new DOMParser().parseFromString(sourcesHTML(), 'text/html').getElementById('set-sources')!;
  document.getElementById('set-sources')!.replaceWith(document.importNode(fresh, true));
  await settle(600);
};

const cards = () => Array.from(document.querySelectorAll('#set-sources .src-card')) as HTMLElement[];
const boxOf = (card: HTMLElement) => card.querySelector('.src-cats') as HTMLElement;
const switchOf = (card: HTMLElement) => card.querySelector('[data-addon-cat]') as HTMLButtonElement | null;
const homeRowOf = (card: HTMLElement) => card.querySelector('.src-cats-home') as HTMLElement;

const entryOf = (over: Partial<AddonCatalogEntry> = {}): AddonCatalogEntry => ({
  manifestUrl: WITH,
  name: 'Addon test',
  home: false,
  catalogs: [{ type: 'movie', id: 'top', name: 'Top', extra: [] }],
  idPrefixes: ['cat:'],
  types: ['movie'],
  resources: { meta: true, stream: true },
  at: 1_700_000_000_000,
  ...over,
});

describe('catalogues d’un addon : interrupteur et avertissement', () => {
  it('manifest avec catalogue : interrupteur présent et désactivé, avertissement permanent, aucune URL affichée', async () => {
    await openPage([{ type: 'upstream', name: 'Catalogues', url: WITH }]);
    const [card] = cards();
    expect(boxOf(card).hidden).toBe(false);
    expect(switchOf(card)).not.toBeNull();
    expect(switchOf(card)!.getAttribute('aria-checked')).toBe('false');
    expect(homeRowOf(card).hidden).toBe(true);
    expect(boxOf(card).textContent).toContain('Afficher les catalogues de cet addon');
    expect(boxOf(card).textContent).toContain(WARNING);
    expect(boxOf(card).textContent).not.toContain('cfg-abc');
    expect(readAddonCatalogs()).toEqual({});
  });

  it('manifestInfo garde les catalogues du manifest (parseManifestCatalogs)', async () => {
    const { manifestInfo } = await import('../src/ui/settings-sources.js');
    const info = manifestInfo(CATALOG_MANIFEST);
    expect(info.manifestCatalogs.catalogs.map((c) => c.id)).toEqual(['top']);
    expect(info.manifestCatalogs.idPrefixes).toEqual(['cat:']);
    expect(info.manifestCatalogs.resources).toEqual({ meta: true, stream: true });
    expect(manifestInfo({ name: 'A' }).manifestCatalogs.catalogs).toEqual([]);
  });

  it('manifest sans catalogue, ou dont le seul catalogue est masqué : aucun interrupteur', async () => {
    await openPage([
      { type: 'upstream', name: 'Sans', url: WITHOUT },
      { type: 'upstream', name: 'Masqué', url: HIDDEN },
    ]);
    const [without, hidden] = cards();
    for (const card of [without, hidden]) {
      expect(boxOf(card).hidden).toBe(true);
      expect(switchOf(card)).toBeNull();
      expect(boxOf(card).children.length).toBe(0);
    }
  });
});

describe('catalogues d’un addon : registre', () => {
  it('activer inscrit l’addon dans le registre, la case « Rangée à l’accueil » apparaît ; désactiver retire l’entrée', async () => {
    await openPage([{ type: 'upstream', name: 'Catalogues', url: WITH }]);
    const [card] = cards();
    switchOf(card)!.click();
    const entry = readAddonCatalogs()[KEY];
    expect(entry).toMatchObject({ manifestUrl: WITH, name: 'Addon catalogues', home: false, idPrefixes: ['cat:'], types: ['movie'] });
    expect(entry.catalogs.map((c) => c.id)).toEqual(['top']);
    expect(switchOf(card)!.getAttribute('aria-checked')).toBe('true');
    expect(homeRowOf(card).hidden).toBe(false);
    // La case « Rangée à l’accueil » écrit home dans l'entrée.
    const home = card.querySelector('[data-addon-cat-home]') as HTMLInputElement;
    home.checked = true;
    home.dispatchEvent(new Event('change', { bubbles: true }));
    expect(readAddonCatalogs()[KEY].home).toBe(true);
    // Désactiver : entrée retirée, case masquée.
    switchOf(card)!.click();
    expect(readAddonCatalogs()[KEY]).toBeUndefined();
    expect(switchOf(card)!.getAttribute('aria-checked')).toBe('false');
    expect(homeRowOf(card).hidden).toBe(true);
  });

  it('une entrée déjà présente au chargement affiche l’interrupteur activé', async () => {
    setAddonCatalog(KEY, entryOf({ home: true }));
    await openPage([{ type: 'upstream', name: 'Catalogues', url: WITH }]);
    const [card] = cards();
    expect(switchOf(card)!.getAttribute('aria-checked')).toBe('true');
    expect((card.querySelector('[data-addon-cat-home]') as HTMLInputElement).checked).toBe(true);
  });

  it('pruneCatalogsFor retire les addons absents des sources enregistrées, garde les autres ; une URL changée retire l’ancienne entrée', async () => {
    const { pruneCatalogsFor } = await import('../src/ui/addonCatalogSettings.js');
    setAddonCatalog(KEY, entryOf());
    setAddonCatalog('https://gone.example', entryOf({ manifestUrl: 'https://gone.example/manifest.json' }));
    pruneCatalogsFor(undefined); // sources inconnues : rien n'est retiré
    expect(Object.keys(readAddonCatalogs()).sort()).toEqual([KEY, 'https://gone.example'].sort());
    pruneCatalogsFor([{ type: 'upstream', url: WITH }, { type: 'torznab', baseUrl: 'https://x.example/api' }]);
    expect(Object.keys(readAddonCatalogs())).toEqual([KEY]);
    // Adresse changée (autre clé de configuration) : l'entrée de l'ancienne adresse est retirée.
    pruneCatalogsFor([{ type: 'upstream', url: 'https://catalog.example/cfg-new/manifest.json' }]);
    expect(readAddonCatalogs()).toEqual({});
  });

  it('relecture du manifest : l’entrée reprend ses catalogues et garde « Rangée à l’accueil » ; sans catalogue affichable elle est retirée ; échec de lecture sans effet', async () => {
    const { refreshCatalogs } = await import('../src/ui/addonCatalogSettings.js');
    setAddonCatalog(KEY, entryOf({ home: true, catalogs: [] }));
    refreshCatalogs(WITH, undefined); // pas de manifest lu (échec) : rien ne change
    expect(readAddonCatalogs()[KEY].home).toBe(true);
    refreshCatalogs(WITH, { name: 'Nouveau nom', logo: '', manifestCatalogs: { catalogs: [{ type: 'movie', id: 'top', name: 'Top', extra: [] }], idPrefixes: [], types: ['movie'], resources: { meta: true, stream: true } } });
    expect(readAddonCatalogs()[KEY]).toMatchObject({ name: 'Nouveau nom', home: true });
    expect(readAddonCatalogs()[KEY].catalogs.map((c) => c.id)).toEqual(['top']);
    refreshCatalogs(WITH, { name: 'Sans catalogue', manifestCatalogs: { catalogs: [], idPrefixes: [], types: [], resources: { meta: false, stream: true } } });
    expect(readAddonCatalogs()[KEY]).toBeUndefined();
  });

  it('mode démo : interrupteur désactivé et rien n’est écrit', async () => {
    setDemoFlags({ on: true, clean: false, profile: '' });
    await openPage([{ type: 'upstream', name: 'Catalogues', url: WITH }]);
    const [card] = cards();
    expect(switchOf(card)!.disabled).toBe(true);
    switchOf(card)!.click();
    expect(readAddonCatalogs()).toEqual({});
  });
});
