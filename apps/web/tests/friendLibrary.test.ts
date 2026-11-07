// Bibliothèque d'un ami (ODY-222) : modèle (recherche, filtres, tri, badges) et écran #/friend/<pid>.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { applyView, countsOf, DEFAULT_VIEW, keyOfItem, nothingToShow, usable } from '../src/data/friendLibraryView';
import type { LibraryItem } from '../src/data/socialV2Api';

const it1 = (type: 'movie' | 'series', tmdbId: number | null, title: string, addedAt = '2026-01-01'): LibraryItem => ({ type, tmdbId, imdbId: null, title, poster: null, addedAt });
const ITEMS: LibraryItem[] = [
  it1('series', 95396, 'Severance'),
  it1('movie', 693134, 'Dune : Deuxième partie'),
  it1('movie', 603, 'Matrix'),
  it1('movie', null, 'Sans TMDB'),
  it1('series', 136315, 'The Bear'),
  it1('movie', 329865, 'Éclair'),
];
const ctx = { have: (k: string) => k === 'tv:95396' || k === 'movie:603', seen: (k: string) => k === 'movie:603' };
const titles = (rows: LibraryItem[]) => rows.map((x) => x.title);

describe('modèle de la bibliothèque d’un ami', () => {
  it('ignore les titres sans identifiant TMDB et construit la clé de catalogue', () => {
    expect(usable(ITEMS)).toHaveLength(5);
    expect(keyOfItem(ITEMS[0])).toBe('tv:95396');
    expect(keyOfItem(ITEMS[1])).toBe('movie:693134');
  });

  it('compte par type, en commun et pas encore vus', () => {
    expect(countsOf(ITEMS, ctx)).toEqual({ all: 5, movie: 3, tv: 2, common: 2, unseen: 4 });
  });

  it('filtre par type, recherche sans accents ni casse, vues rapides', () => {
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, type: 'tv' }, ctx))).toEqual(['Severance', 'The Bear']);
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, type: 'movie' }, ctx))).toEqual(['Dune : Deuxième partie', 'Matrix', 'Éclair']);
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, q: 'ECLAIR' }, ctx))).toEqual(['Éclair']);
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, q: '  deuxieme ' }, ctx))).toEqual(['Dune : Deuxième partie']);
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, mode: 'common' }, ctx))).toEqual(['Severance', 'Matrix']);
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, mode: 'unseen' }, ctx))).not.toContain('Matrix');
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, type: 'movie', mode: 'common' }, ctx))).toEqual(['Matrix']);
  });

  it('trie : récent = ordre du serveur, A → Z et Z → A', () => {
    expect(titles(applyView(ITEMS, DEFAULT_VIEW, ctx))[0]).toBe('Severance');
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, sort: 'az' }, ctx))).toEqual(['Dune : Deuxième partie', 'Éclair', 'Matrix', 'Severance', 'The Bear']);
    expect(titles(applyView(ITEMS, { ...DEFAULT_VIEW, sort: 'za' }, ctx))).toEqual(['The Bear', 'Severance', 'Matrix', 'Éclair', 'Dune : Deuxième partie']);
  });

  it('« rien à montrer » : chargé et vide seulement', () => {
    expect(nothingToShow({ status: 'ok', items: [] })).toBe(true);
    expect(nothingToShow({ status: 'ok', items: [ITEMS[3]] })).toBe(true);
    expect(nothingToShow({ status: 'ok', items: [ITEMS[0]] })).toBe(false);
    expect(nothingToShow({ status: 'loading', items: [] })).toBe(false);
    expect(nothingToShow({ status: 'error', items: [] })).toBe(false);
  });
});

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const detail = () => document.getElementById('detail')!;
const calls: string[] = [];
let routes: (p: string) => Response | undefined = () => undefined;
const shareDialog = vi.fn();

vi.mock('../src/ui/socialHooks.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openShareDialog: (...a: unknown[]) => shareDialog(...a),
}));

const tileKeys = () => Array.from(detail().querySelectorAll<HTMLElement>('[data-fr-key]')).map((e) => e.dataset.frKey);
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

const API = [
  ...ITEMS.map((x, i) => ({ ...x, addedAt: '2026-01-0' + (9 - i) })),
];

describe('écran #/friend/<pid>', () => {
  let show: (pid: string) => void;
  beforeAll(async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
    reloadSettings();
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    window.scrollTo = () => undefined;
    Element.prototype.scrollIntoView = () => undefined;
    const { auth } = await import('../src/data/auth');
    auth.status = 'ready';
    auth.profile = { id: 'p1', name: 'Greg', isKid: false } as never;
    ({ showFriendLibrary: show } = await import('../src/ui/friendLibrary.js'));
  });

  beforeEach(() => {
    calls.length = 0;
    shareDialog.mockClear();
    routes = (p) => (p.startsWith('/user/social/friends/AMYPID/library') ? json({ items: API, total: API.length, limit: 100, offset: 0 }) : undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(String(url));
      calls.push(u.pathname + u.search);
      return routes(u.pathname + u.search) ?? json({ error: 'not_found' }, 404);
    }));
    detail().innerHTML = '';
  });

  it('charge la liste entière (100 par appel) et affiche les titres exploitables avec leurs compteurs', async () => {
    show('AMYPID');
    await tick(120);
    expect(calls.find((c) => c.includes('/library'))).toContain('limit=100');
    expect(tileKeys()).toEqual(['tv:95396', 'movie:693134', 'movie:603', 'tv:136315', 'movie:329865']);
    expect(detail().querySelector('h1')!.textContent).toBe('Bibliothèque de Un ami');
    expect(detail().querySelector('#fl-sub')!.textContent).toBe('5 titres');
    expect(Array.from(detail().querySelectorAll('[data-fl-type]')).map((b) => b.textContent)).toEqual(['Tout · 5', 'Films · 3', 'Séries · 2']);
  });

  it('pagine tant que le total n’est pas atteint', async () => {
    routes = (p) => {
      const off = Number(new URL('http://x' + p).searchParams.get('offset'));
      const rows = Array.from({ length: 100 }, (_, i) => it1('movie', 1000 + off + i, 'Film ' + (off + i)));
      return p.startsWith('/user/social/friends/AMYPID/library') ? json({ items: off === 0 ? rows : rows.slice(0, 20), total: 120, limit: 100, offset: off }) : undefined;
    };
    show('AMYPID');
    await tick(150);
    const pages = calls.filter((c) => c.includes('/library'));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain('offset=100');
    expect(detail().querySelectorAll('[data-fr-key]')).toHaveLength(60); // premier lot affiché
    (detail().querySelector('[data-fl-more]') as HTMLElement).click();
    expect(detail().querySelectorAll('[data-fr-key]')).toHaveLength(120);
  });

  it('recherche, filtre Séries, tri et réinitialisation', async () => {
    show('AMYPID');
    await tick(120);
    type(detail().querySelector('#fl-q') as HTMLInputElement, 'matrix');
    expect(tileKeys()).toEqual(['movie:603']);
    type(detail().querySelector('#fl-q') as HTMLInputElement, 'zzz');
    expect(detail().querySelector('.fl-empty')!.textContent).toContain('Aucun résultat');
    (detail().querySelector('[data-fl-reset]') as HTMLElement).click();
    expect((detail().querySelector('#fl-q') as HTMLInputElement).value).toBe('');
    expect(tileKeys()).toHaveLength(5);
    (detail().querySelector('[data-fl-type="tv"]') as HTMLElement).click();
    expect(tileKeys()).toEqual(['tv:95396', 'tv:136315']);
    expect(detail().querySelector('[data-fl-type="tv"]')!.getAttribute('aria-pressed')).toBe('true');
    const sort = detail().querySelector('#fl-sort') as HTMLSelectElement;
    sort.value = 'za';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tileKeys()).toEqual(['tv:136315', 'tv:95396']);
  });

  it('ajoute à ma bibliothèque, badge « En commun », et envoie un titre à l’ami', async () => {
    const { userStore } = await import('../src/data/userStore');
    show('AMYPID');
    await tick(120);
    expect(userStore.inLibrary('movie:693134')).toBe(false);
    const media = detail().querySelector('[data-fr-key="movie:693134"] .fl-media')!;
    media.insertAdjacentHTML('beforeend', '<span class="fl-badge">Déjà vu</span>'); // titre déjà vu par moi
    const before = detail().querySelector('[data-fl-mode="common"]')!.textContent;
    (detail().querySelector('[data-fr-save="movie:693134"]') as HTMLElement).click();
    expect(userStore.inLibrary('movie:693134')).toBe(true);
    expect(media.querySelectorAll('.fl-badge')).toHaveLength(1);
    expect(media.querySelector('.fl-badge')!.className).toContain('is-common');
    expect(detail().querySelector('[data-fl-mode="common"]')!.textContent).not.toBe(before);
    expect((detail().querySelector('[data-fr-save="movie:693134"]') as HTMLButtonElement).disabled).toBe(true);
    expect(detail().querySelector('#fl-sub')!.textContent).toContain('déjà dans ta bibliothèque');
    (detail().querySelector('[data-fl-mode="common"]') as HTMLElement).click();
    expect(tileKeys()).toContain('movie:693134');
    expect(detail().querySelector('.fl-badge.is-common')).not.toBeNull();
    (detail().querySelector('[data-fr-send="movie:693134"]') as HTMLElement).click();
    expect(shareDialog).toHaveBeenCalledWith({ media: { type: 'movie', tmdbId: 693134, title: 'Dune : Deuxième partie', poster: undefined }, to: ['AMYPID'] });
    (detail().querySelector('[data-fl-send-friend]') as HTMLElement).click();
    expect(shareDialog).toHaveBeenLastCalledWith({ media: null, to: ['AMYPID'] });
  });

  it('rien de partagé ou bibliothèque fermée : message simple, sans filtres', async () => {
    routes = (p) => (p.startsWith('/user/social/friends/AMYPID/library') ? json({ items: [], total: 0, limit: 100, offset: 0 }) : undefined);
    show('AMYPID');
    await tick(120);
    expect(detail().querySelector('#fl-body')!.textContent).toContain('n’a rien partagé avec toi');
    expect(detail().querySelector('#fl-q')).toBeNull();
  });

  it('lien refusé (404) : « pas partagée avec toi » ; erreur réseau : bouton Réessayer', async () => {
    routes = () => undefined; // 404 par défaut
    show('GHOSTPID');
    await tick(120);
    expect(detail().querySelector('#fl-body')!.textContent).toContain('n’est pas partagée avec toi');
    expect(detail().querySelectorAll('[data-fr-key]')).toHaveLength(0);

    routes = () => json({ error: 'boom' }, 500);
    show('AMYPID');
    await tick(120);
    expect(detail().querySelector('[data-fl-retry]')).not.toBeNull();
    routes = (p) => (p.startsWith('/user/social/friends/AMYPID/library') ? json({ items: API, total: API.length }) : undefined);
    (detail().querySelector('[data-fl-retry]') as HTMLElement).click();
    await tick(120);
    expect(tileKeys()).toHaveLength(5);
  });
});
