// LAST-162 : ••• et ✕ des cartes sont de vrais <button> nommés, atteignables au clavier ; leur clic n'ouvre pas la carte.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let ctx: typeof import('../src/ui/ctxmenu.js');
let cont: typeof import('../src/ui/continue.js');
let tiles: typeof import('../src/ui/tiles.js');
let userStore: any;
let auth: any;
let navItems: typeof import('../src/ui/events.js').navItems;

const P = { key: 'movie:100', type: 'movie', id: 100, title: 'Dune', poster: '/p.jpg', backdrop: '/b.jpg', position: 600, duration: 3600, finished: false };

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ctx = await import('../src/ui/ctxmenu.js');
  cont = await import('../src/ui/continue.js');
  tiles = await import('../src/ui/tiles.js');
  ({ navItems } = await import('../src/ui/events.js'));
  ({ userStore } = await import('../src/data/userStore'));
  ({ auth } = await import('../src/data/auth'));
});

beforeEach(() => {
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg', avatarColor: '#3b82f6', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [] };
  document.getElementById('probe')?.remove();
  const host = document.createElement('div');
  host.id = 'probe';
  host.innerHTML = cont.continueCardHTML(P);
  document.body.appendChild(host);
});
afterEach(() => { ctx.closeCtx(false); vi.restoreAllMocks(); });

const card = () => document.querySelector('#probe .cont-card') as HTMLElement;
const more = () => card().querySelector('.t-more') as HTMLButtonElement;
const remove = () => card().querySelector('.t-remove') as HTMLButtonElement;

describe('boutons ••• et ✕ de la carte « Reprendre »', () => {
  it('sont de vrais <button type="button"> nommés par le titre, dans l’ordre de tabulation', () => {
    expect(more().tagName).toBe('BUTTON');
    expect(more().type).toBe('button');
    expect(more().getAttribute('aria-label')).toBe('Plus d’actions pour Dune');
    expect(remove().tagName).toBe('BUTTON');
    expect(remove().type).toBe('button');
    expect(remove().getAttribute('aria-label')).toBe('Retirer Dune de Reprendre');
    // La carte puis ••• puis ✕ : ce que Tab parcourt dans l'ordre du document.
    const tabbable = Array.from(card().querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])'));
    expect([card(), ...tabbable].map((e) => e.className.split(' ').find((c) => ['cont-card', 't-more', 't-remove'].includes(c)))).toEqual(['cont-card', 't-more', 't-remove']);
    expect(card().getAttribute('tabindex')).toBe('0');
    more().focus();
    expect(document.activeElement).toBe(more());
    remove().focus();
    expect(document.activeElement).toBe(remove());
  });

  it('la carte reste un role="button" activable à Entrée et Espace, pas depuis ses boutons', () => {
    expect(card().getAttribute('role')).toBe('button');
    const onClick = vi.spyOn(card(), 'click').mockImplementation(() => undefined);
    card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    card().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(2);
    onClick.mockClear();
    more().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    remove().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('une touche maintenue (répétition automatique) n’ouvre pas la carte à chaque tic', () => {
    const onClick = vi.spyOn(card(), 'click').mockImplementation(() => undefined);
    card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
    card().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }));
    expect(onClick).not.toHaveBeenCalled();
    card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('✕ retire le titre de « Reprendre » sans ouvrir la carte', async () => {
    const onCardClick = vi.fn();
    card().addEventListener('click', onCardClick);
    remove().click();
    await vi.waitFor(() => expect(userStore.hiddenKeys()).toContain('movie:100'));
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('••• ouvre le menu contextuel sans ouvrir la carte', () => {
    const onCardClick = vi.fn();
    card().addEventListener('click', onCardClick);
    more().click();
    expect(document.querySelector('.ctxmenu')).not.toBeNull();
    expect(onCardClick).not.toHaveBeenCalled();
  });
});

describe('tuiles du catalogue', () => {
  it('portent le même bouton ••• nommé, et ✕ seulement quand elles sont retirables', () => {
    const it = { key: 'tv:7', type: 'tv', id: 7, name: 'Sherlock', year: 2010, poster: '/p.jpg', backdrop: '', overview: '' } as any;
    const host = document.getElementById('probe')!;
    host.innerHTML = tiles.tileCard(it, {}) + tiles.tileCard(it, { removable: true });
    const [plain, removable] = Array.from(host.querySelectorAll<HTMLElement>('.card'));
    expect(plain.getAttribute('role')).toBe('button');
    expect(plain.querySelector('button.t-more')!.getAttribute('aria-label')).toBe('Plus d’actions pour Sherlock');
    expect(plain.querySelector('.t-remove')).toBeNull();
    expect(removable.querySelector('button.t-remove')!.getAttribute('aria-label')).toBe('Retirer Sherlock de Reprendre');
    expect(host.querySelectorAll('.card').length).toBe(2); // pas de <button> imbriqué qui casserait le balisage
  });
});

describe('navigation flèches / télécommande dans une rangée de cartes', () => {
  it('une rangée de deux cartes ne propose que les deux cartes, ni leurs ••• ni leur ✕', () => {
    const one = { key: 'movie:1', type: 'movie', id: 1, name: 'Dune', year: 2021, poster: '/p.jpg', backdrop: '', overview: '' } as any;
    const two = { key: 'movie:2', type: 'movie', id: 2, name: 'Arrival', year: 2016, poster: '/q.jpg', backdrop: '', overview: '' } as any;
    const host = document.getElementById('probe')!;
    host.innerHTML = '<div data-nav>' + tiles.posterCard(one, {}) + tiles.posterCard(two, { removable: true }) + '</div>';
    // jsdom n'a pas de mise en page : tout élément compte comme visible pour la navigation.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    const row = host.querySelector<HTMLElement>('[data-nav]')!;
    expect(row.querySelectorAll('.t-more, .t-remove').length).toBe(3); // les boutons sont bien là
    const [a, b] = Array.from(row.querySelectorAll<HTMLElement>('.card'));
    const items = navItems(row);
    expect(items).toHaveLength(2);
    expect(items[0]).toBe(a);
    expect(items[1]).toBe(b);
  });
});

describe('CSS d’accessibilité des cartes', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '../src/styles/' + f), 'utf8');
  it('boutons de 44 px, visibles au toucher, au survol et au focus, anneau de 3 px', () => {
    const css = read('app.css');
    expect(css).toMatch(/\.t-more, \.t-remove \{[^}]*width: 44px; height: 44px/);
    expect(css).toContain('@media (hover: none) and (pointer: coarse) { .t-more, .t-remove { opacity: 1; } }');
    expect(css).not.toMatch(/@media \(hover: none\) \{ \.t-more \{ display: none/);
    expect(css).toContain('.card:focus-within .t-more');
    expect(css).toContain('.t-more:focus-visible');
    expect(css).toMatch(/\.t-remove:focus-visible::before \{ outline: 3px solid var\(--accent\)/);
  });
  it('mouvement réduit : animations et transitions coupées globalement (0.01 ms, pas 0)', () => {
    const css = read('styles.css');
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{[^}]*animation-duration: 0\.01ms !important[^}]*transition-duration: 0\.01ms !important/);
  });
  it('la palette admin garde un indicateur de focus visible', () => {
    expect(read('admin-palette.css')).toContain('.adm-pal-head:focus-within');
  });
});
