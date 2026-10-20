// Billets de parrainage : enregistrement des mots et coups de cœur. Une réponse PUT tardive ne remplace pas l'état local plus récent
// (révisions), un échec recharge l'état du serveur (sans ancien coup de cœur rétabli), un serveur sans personnalisation (404/405)
// garde le billet copiable, un seul PUT part pour un même état, et un type de coup de cœur inconnu est gardé.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { userStore } from '../src/data/userStore';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call { method: string; path: string; body: any }
type Reply = Response | Promise<Response> | undefined;
const calls: Call[] = [];
let routes: (c: Call) => Reply = () => undefined;
let list: Array<Record<string, any>> = [];
let mod: typeof import('../src/ui/invites.js');

// Bibliothèque du profil actif : les titres proposés comme coups de cœur.
const LIB: Array<{ id: number; type: 'movie' | 'tv'; title: string; poster: string }> = [
  { id: 550, type: 'movie', title: 'Fight Club', poster: '/fc.jpg' },
  { id: 1399, type: 'tv', title: 'Game of Thrones', poster: '/got.jpg' },
  { id: 603, type: 'movie', title: 'Matrix', poster: '/mx.jpg' },
];

const BASE = { createdAt: '2026-10-01T10:00:00.000Z', sentAt: null, usedAt: null, invitee: null, revokedAt: null, message: null, picks: [] as unknown[] };

/** Réponse dont on décide le moment : elle n'arrive qu'à `resolve`. */
function deferred(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Serveur nominal : GET de la liste, PUT qui enregistre (l'état serveur change), envoi marqué. */
function serverRoutes(c: Call): Reply {
  if (c.method === 'GET' && c.path === '/user/invites') return json({ quota: 4, invites: list });
  if (c.method === 'PUT' && c.path === '/user/invites/i1') {
    list[0] = { ...list[0], message: c.body.message, picks: c.body.picks };
    return json({ invite: list[0] });
  }
  if (c.method === 'PUT' && c.path.endsWith('/sent')) return new Response(null, { status: 204 });
  return undefined;
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const call: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return (await routes(call)) ?? json({ error: 'not_found' }, 404);
  }));
}

const tickets = () => Array.from(document.querySelectorAll<HTMLElement>('#detail .tk-ticket'));
const $ = (sel: string) => document.querySelector<HTMLElement>('#detail ' + sel);
const msgField = () => document.querySelector<HTMLTextAreaElement>('#detail #tk-msg');
const toastText = () => document.getElementById('toast')!.textContent ?? '';
const puts = () => calls.filter((c) => c.method === 'PUT' && c.path === '/user/invites/i1');
const copies = () => (navigator.clipboard.writeText as any).mock.calls.length as number;
const click = (el: Element | null) => {
  if (!el) throw new Error('élément introuvable');
  (el as HTMLElement).click();
};
const typeInto = (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  // dom.js attend ces éléments à l'import (détail, modale, toast).
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal"><div class="modal"></div></div>' +
    '<div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  for (const e of LIB) userStore.addToLibrary({ ...e });
  mod = await import('../src/ui/invites.js');
});

beforeEach(() => {
  calls.length = 0;
  list = [{ ...BASE, id: 'i1', code: 'FreeCode1', state: 'free', number: '0039' }];
  routes = serverRoutes;
  stubFetch();
  document.getElementById('detail')!.innerHTML = mod.invitesCard();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

describe('enregistrement : réponse tardive, révisions', () => {
  it('une réponse PUT arrivée après une modification locale ne remet pas l’ancien état ; le PUT suivant envoie l’état courant', async () => {
    const first = deferred();
    routes = (c) => (c.method === 'PUT' && puts().length === 1 ? first.promise : serverRoutes(c));
    await mod.refreshInvites();
    await tick(10);
    click($('[data-tk-pick="movie:550"]'));
    await tick();
    click($('[data-tk-pick="series:1399"]'));
    await tick();
    // Le second état attend derrière le premier PUT : un seul PUT est parti.
    expect(puts()).toHaveLength(1);
    // Réponse tardive du premier PUT, qui ne contient que 550 : elle ne doit pas écraser 550 + 1399.
    first.resolve(json({ invite: { ...BASE, id: 'i1', code: 'FreeCode1', state: 'free', number: '0039', picks: [{ id: 550, type: 'movie', name: 'Fight Club', poster: null, background: null }] } }));
    await tick(60);
    expect(puts()).toHaveLength(2);
    expect(puts()[1].body.picks.map((p: any) => p.id)).toEqual([550, 1399]);
    expect($('.tk-picks-n')!.textContent).toBe('2 / 3');
    expect($('[data-tk-pick="series:1399"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('enregistrement : échec et serveur ancien', () => {
  it('échec : le billet reprend l’état du serveur (pas d’ancien coup de cœur rétabli), avec le message d’erreur', async () => {
    routes = (c) => (c.method === 'PUT' && c.path === '/user/invites/i1' ? json({ error: 'boom' }, 500) : serverRoutes(c));
    await mod.refreshInvites();
    calls.length = 0;
    await tick(10);
    click($('[data-tk-pick="movie:550"]'));
    await tick(80);
    expect(puts()).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/user/invites')).toHaveLength(1);
    expect(toastText()).toContain('Billet non enregistré : réessaie');
    expect($('.tk-picks-n')!.textContent).toBe('0 / 3');
    expect($('[data-tk-pick="movie:550"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('PUT 404/405 au choix d’un coup de cœur : composeur en lecture seule avec mention, coups de cœur désactivés', async () => {
    routes = (c) => (c.method === 'PUT' && c.path === '/user/invites/i1' ? json({ error: 'not_found' }, 404) : serverRoutes(c));
    await mod.refreshInvites();
    await tick(10);
    click($('[data-tk-pick="movie:550"]'));
    await tick(60);
    expect(puts()).toHaveLength(1);
    expect(msgField()!.readOnly).toBe(true);
    expect($('.tk-note-warn')!.textContent).toContain('Personnalisation indisponible');
    expect($('[data-tk-pick="movie:603"]')!.hasAttribute('disabled')).toBe(true);
    click($('[data-tk-pick="movie:603"]'));
    await tick(40);
    expect(puts()).toHaveLength(1);
  });

  it.each([404, 405])('PUT %i : Copier fonctionne quand même, le mot n’est pas renvoyé', async (status) => {
    routes = (c) => (c.method === 'PUT' && c.path === '/user/invites/i1' ? json({ error: 'not_found' }, status) : serverRoutes(c));
    await mod.refreshInvites();
    await tick(10);
    typeInto(msgField()!, 'Bienvenue !');
    click($('[data-tk-copy]'));
    await tick(80);
    expect(puts()).toHaveLength(1);
    expect(copies()).toBe(1);
    expect(toastText()).toContain('Lien copié');
    expect($('[data-tk-copy]')!.textContent).toBe('Copier à nouveau');
    // Une nouvelle copie ne renvoie rien au serveur qui ne sait pas l'enregistrer.
    click($('[data-tk-copy]'));
    await tick(80);
    expect(puts()).toHaveLength(1);
    expect(copies()).toBe(2);
  });
});

describe('enregistrement : un seul PUT par état', () => {
  it('blur puis Copier pendant le PUT : un seul PUT pour le même mot, la copie attend sa réponse', async () => {
    const pending = deferred();
    routes = (c) => (c.method === 'PUT' && c.path === '/user/invites/i1' ? pending.promise : serverRoutes(c));
    await mod.refreshInvites();
    await tick(10);
    typeInto(msgField()!, 'Salut');
    msgField()!.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    click($('[data-tk-copy]'));
    await tick(20);
    expect(puts()).toHaveLength(1);
    expect(copies()).toBe(0);
    pending.resolve(json({ invite: { ...list[0], message: 'Salut' } }));
    await tick(80);
    expect(puts()).toHaveLength(1);
    expect(copies()).toBe(1);
  });
});

describe('coups de cœur : types', () => {
  it('un type inconnu (16 caractères au plus) est gardé tel quel ; un type trop long est écarté', () => {
    const html = mod.invitesBodyHTML({
      quota: 4,
      invites: [{
        ...BASE, id: 'i1', code: 'C1', state: 'free', number: '0001',
        picks: [
          { id: 7, type: 'anime', name: 'Titre gardé', poster: null, background: null },
          { id: 8, type: 'x'.repeat(17), name: 'Titre écarté', poster: null, background: null },
        ],
      }],
    } as never);
    expect(html).toMatch(/tk-pick is-on"[^>]*data-tk-pick="anime:7"/);
    expect(html).toContain('aria-live="polite">1 / 3<');
    expect(html).not.toContain('Titre écarté');
  });
});
