// LAST-1200 : retour à l'accueil en un clic depuis une page profonde (lien Accueil de la barre du haut).
// LAST-488 : sur les pages hub et recherche, l'onglet Accueil de la barre du bas reste un lien vers #/.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { state } from '../src/ui/state.js';

let topBar: (withActions: boolean) => string;
let tabbar: (current?: string) => string;

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true, createdAt: '2026-01-01T00:00:00Z' };

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** Fragment posé hors de #detail (remplacé à chaque appel). */
function scratch(html: string): void {
  document.getElementById('scratch')?.remove();
  document.body.insertAdjacentHTML('beforeend', '<div id="scratch">' + html + '</div>');
}

/** Session simulée : profil actif ; sans profil, mode local (barre du bas d'origine). */
function setAccount(profile: typeof ADULT | null): void {
  auth.status = profile ? 'ready' : 'local';
  auth.profile = profile as unknown as typeof auth.profile;
}

/** L'onglet Accueil de la barre du bas (ou d'un conteneur donné) doit être un vrai lien, pas un élément inerte. */
function expectAccueilCliquable(root: ParentNode = document): void {
  const accueil = root.querySelector<HTMLAnchorElement>('.tabbar a[href="#/"]');
  expect(accueil, 'onglet Accueil').not.toBeNull();
  expect(accueil!.hasAttribute('data-noop')).toBe(false);
  expect(accueil!.hasAttribute('data-go')).toBe(true);
  expect(accueil!.classList.contains('is-current')).toBe(false);
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ({ topBar } = await import('../src/ui/fragments.js'));
  ({ tabbar } = await import('../src/ui/home.js'));
  // Enregistre le délégué de clics (events.js) : le lien Accueil passe par go().
  await import('../src/ui/events.js');
});

beforeEach(() => {
  setAccount(ADULT);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rows: [], items: [], nextCursor: null }), { status: 200 })));
});

afterEach(() => {
  setAccount(null);
  state.inDetail = false;
  location.hash = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LAST-1200 : lien Accueil dans la barre du haut', () => {
  it('juste après le bouton retour, un lien Accueil vers #/ (avec ou sans actions)', () => {
    for (const withActions of [false, true]) {
      scratch(topBar(withActions));
      const back = $('#scratch [data-back]');
      const home = $<HTMLAnchorElement>('#scratch .f-top a.f-home');
      expect(home, 'lien Accueil').not.toBeNull();
      expect(home.getAttribute('href')).toBe('#/');
      expect(home.getAttribute('aria-label')).toBe('Accueil');
      expect(back.nextElementSibling).toBe(home);
    }
  });

  it('le lien Accueil navigue par go() (data-go), sans être neutralisé', () => {
    scratch(topBar(false));
    const home = $<HTMLAnchorElement>('#scratch a.f-home');
    expect(home.hasAttribute('data-go')).toBe(true);
    expect(home.hasAttribute('data-noop')).toBe(false);
  });

  it('clic depuis une page profonde : on revient à #/', () => {
    scratch(topBar(true));
    state.inDetail = true;
    location.hash = '#/person/31';
    $<HTMLAnchorElement>('#scratch a.f-home').click();
    expect(location.hash).toBe('#/');
  });
});

describe('LAST-488 : onglet Accueil de la barre du bas hors de l’accueil', () => {
  it('compte connecté : Accueil reste un lien sur un hub et sur la recherche', () => {
    scratch(tabbar('hub'));
    expectAccueilCliquable();
    scratch(tabbar('search'));
    expectAccueilCliquable();
  });

  it('sans compte connecté : Accueil reste un lien sur un hub et sur la recherche', () => {
    setAccount(null);
    scratch(tabbar('hub'));
    expectAccueilCliquable();
    scratch(tabbar('search'));
    expectAccueilCliquable();
  });

  it('la page Recherche rend sa barre sans neutraliser Accueil', async () => {
    const { showSearch } = await import('../src/ui/search.js');
    document.getElementById('detail')!.hidden = false;
    showSearch();
    expectAccueilCliquable(document.getElementById('detail')!);
  });

  it('la page hub rend sa barre sans neutraliser Accueil', async () => {
    const registry = await import('../src/ui/registry.js');
    vi.spyOn(registry, 'loadHubRows').mockImplementation(async (_ids: string[], slot: HTMLElement) => {
      slot.innerHTML = '';
      return 0;
    });
    const { showHub } = await import('../src/ui/hubs.js');
    document.getElementById('detail')!.hidden = false;
    await showHub('films');
    expectAccueilCliquable(document.getElementById('detail')!);
  });

  it('l’accueil garde son onglet courant, inerte (comportement inchangé)', () => {
    scratch(tabbar());
    const accueil = $('#scratch .tabbar a[href="#/"]');
    expect(accueil.hasAttribute('data-noop')).toBe(true);
    expect(accueil.getAttribute('aria-current')).toBe('page');
  });
});
