// Page « Titres masqués » (#/hidden) : route, pagination, recherche, tri, sélection et réaffichage groupé, réglages.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

function mockFetch(url: string): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') return json({ services: {}, languages: { preferred: ['fr'], acceptVostfr: true }, sources: [] });
  return json({ error: 'not_found' }, 404);
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
/** Laisse la grille se redessiner (le rendu des pages est asynchrone). */
const tick = () => settle(60);
const $ = (sel: string) => document.querySelector('#detail ' + sel) as HTMLElement | null;
const click = (el: Element | null) => {
  if (!el) throw new Error('élément absent');
  (el as HTMLElement).click();
};
const tiles = () => Array.from(document.querySelectorAll('#detail #hid-grid [data-hid-sel]')) as HTMLElement[];
const keysOf = (els: HTMLElement[]) => els.map((e) => e.dataset.hidSel);
const toastText = () => document.getElementById('toast')?.textContent ?? '';
const title = (i: number) => 'Titre ' + String(i).padStart(3, '0');

let hf: typeof import('../src/data/homeFilters');

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
  hf = await import('../src/data/homeFilters');
});

/** Vide la liste des titres masqués (les tests se suivent dans le même jeu de données). */
function reset(): void {
  hf.unhideTitles(hf.hiddenTitles().map((h) => h.key));
}

/** Ajoute n titres, alternativement films et séries (n/2 de chaque). */
function seed(n: number): void {
  for (let i = 0; i < n; i++) hf.hideTitle({ key: (i % 2 ? 'tv:' : 'movie:') + (1000 + i), title: title(i), poster: i % 3 ? '/p' + i + '.jpg' : '' });
}

/** Ouvre #/hidden depuis les réglages, puis remet recherche, filtre et tri par défaut (la vue reste en mémoire d'une ouverture à l'autre). */
async function openHidden(): Promise<void> {
  location.hash = '#/settings';
  await settle(300);
  location.hash = '#/hidden';
  await settle(300);
  click($('[data-hid-qclear]'));
  click($('[data-hid-type="all"]'));
  click($('[data-hid-sort="recent"]'));
  await tick();
}

describe('route et ouverture', () => {
  it('#/hidden est une route reconnue', async () => {
    const { parseRoute } = await import('../src/ui/router.js');
    location.hash = '#/hidden';
    expect(parseRoute()).toEqual({ kind: 'hidden' });
  });

  it('« Gérer » dans les réglages ouvre la page', async () => {
    reset();
    hf.hideTitle({ key: 'movie:9', title: 'Neuf', poster: '' });
    location.hash = '#/settings';
    await settle(300);
    click($('#set-p-home [data-hidden-nav]'));
    await settle(300);
    expect(location.hash).toBe('#/hidden');
    expect($('.hid-page')).not.toBeNull();
    expect(tiles()).toHaveLength(1);
  });

  it('liste vide : message, aucune tuile, aucune barre d’action', async () => {
    reset();
    await openHidden();
    expect($('.hid-empty')!.textContent).toContain('Aucun titre masqué');
    expect(tiles()).toHaveLength(0);
    expect($('#hid-bar')!.hidden).toBe(true);
  });
});

describe('grille paginée', () => {
  it('60 tuiles par page, puis la suite au clic sur « Charger plus »', async () => {
    reset();
    seed(130);
    await openHidden();
    expect(tiles()).toHaveLength(60);
    expect($('#hid-summary')!.textContent).toBe('130 titres masqués');
    click($('.inf-more'));
    await settle(150);
    expect(tiles()).toHaveLength(120);
    click($('.inf-more'));
    await settle(150);
    expect(tiles()).toHaveLength(130);
    expect($('.inf-end')!.hidden).toBe(false);
  });
});

describe('recherche, types et tri', () => {
  it('recherche sans accents ni casse, compteurs par type', async () => {
    reset();
    hf.hideTitle({ key: 'movie:1', title: 'Amélie Poulain', poster: '' });
    hf.hideTitle({ key: 'tv:2', title: 'Été 42', poster: '' });
    hf.hideTitle({ key: 'movie:3', title: 'Zorro', poster: '' });
    await openHidden();
    expect(tiles()).toHaveLength(3);
    expect($('[data-hid-count="all"]')!.textContent).toBe('3');
    expect($('[data-hid-count="movie"]')!.textContent).toBe('2');
    expect($('[data-hid-count="tv"]')!.textContent).toBe('1');

    const input = $('#hid-q') as HTMLInputElement;
    input.value = 'AMELIE';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(keysOf(tiles())).toEqual(['movie:1']);
    expect($('[data-hid-count="all"]')!.textContent).toBe('1');

    input.value = 'xyz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(tiles()).toHaveLength(0);
    expect($('.row-msg')!.textContent).toContain('ne correspond à ces filtres');

    click($('[data-hid-qclear]'));
    await tick();
    expect(input.value).toBe('');
    expect(tiles()).toHaveLength(3);

    click($('[data-hid-type="tv"]'));
    await tick();
    expect(keysOf(tiles())).toEqual(['tv:2']);
    expect($('[data-hid-type="tv"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('tri « Titre A→Z »', async () => {
    reset();
    hf.hideTitle({ key: 'movie:1', title: 'Zorro', poster: '' });
    hf.hideTitle({ key: 'movie:2', title: 'Alpha', poster: '' });
    await openHidden();
    click($('[data-hid-sort="title"]'));
    await tick();
    expect(keysOf(tiles())).toEqual(['movie:2', 'movie:1']);
    expect($('[data-hid-sort="title"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('sélection et réaffichage groupé', () => {
  it('« Réafficher (N) » : un seul envoi au compte, puis message avec « Annuler »', async () => {
    reset();
    seed(10);
    await openHidden();
    const spy = vi.fn();
    hf.setFiltersPusher(spy);
    hf.flushSync();
    spy.mockClear();
    const before = hf.hiddenTitles().length;

    const cards = tiles();
    click(cards[0]);
    click(cards[1]);
    click(cards[2]);
    expect(cards.slice(0, 3).map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true']);
    expect(cards[3].getAttribute('aria-pressed')).toBe('false');
    expect($('#hid-bar')!.hidden).toBe(false);
    expect($('[data-hid-bulk]')!.textContent).toBe('Réafficher (3)');

    click($('[data-hid-bulk]'));
    expect(hf.hiddenTitles()).toHaveLength(before - 3);
    expect(toastText()).toContain('3 titres réaffichés');
    hf.flushSync();
    expect(spy).toHaveBeenCalledTimes(1);

    click(document.querySelector('#toast .toast-action'));
    expect(hf.hiddenTitles()).toHaveLength(before);
    hf.flushSync();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('survol : « Réafficher » seul, sans passer par la sélection', async () => {
    reset();
    seed(4);
    await openHidden();
    const n = hf.hiddenTitles().length;
    click($('.hid-x'));
    await tick();
    expect(hf.hiddenTitles()).toHaveLength(n - 1);
    expect(tiles()).toHaveLength(n - 1);
    expect($('#hid-bar')!.hidden).toBe(true);
  });

  it('« Tout sélectionner (filtre courant) » couvre aussi les titres hors de la page affichée', async () => {
    reset();
    seed(130); // 65 films, 65 séries
    await openHidden();
    click($('[data-hid-type="movie"]'));
    await tick();
    expect(tiles()).toHaveLength(60);
    click($('[data-hid-all]'));
    expect($('[data-hid-bulk]')!.textContent).toBe('Réafficher (65)');
    expect(tiles().every((c) => c.getAttribute('aria-pressed') === 'true')).toBe(true);
    click($('[data-hid-clear]'));
    expect($('#hid-bar')!.hidden).toBe(true);
    expect(tiles().some((c) => c.getAttribute('aria-pressed') === 'true')).toBe(false);
  });
});
