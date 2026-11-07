// Billets de parrainage (Réglages > Mes billets de parrainage) : 4 billets et leur état, composeur, mot (280 caractères, compteur),
// 3 coups de cœur au plus (le 4e est refusé), enregistrement PUT /user/invites/:id avec {message, picks}, copier et annuler.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { userStore } from '../src/data/userStore';

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const DAY = 86_400_000;
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

interface Call { method: string; path: string; body: any }
const calls: Call[] = [];
let routes: (c: Call) => Response | undefined = () => undefined;
let list: Array<Record<string, any>> = [];
let mod: typeof import('../src/ui/invites.js');

// Bibliothèque du profil actif : les 4 titres proposés comme coups de cœur (type local « tv » = série côté serveur).
const LIB: Array<{ id: number; type: 'movie' | 'tv'; title: string; poster: string }> = [
  { id: 550, type: 'movie', title: 'Fight Club', poster: '/fc.jpg' },
  { id: 1399, type: 'tv', title: 'Game of Thrones', poster: '/got.jpg' },
  { id: 603, type: 'movie', title: 'Matrix', poster: '/mx.jpg' },
  { id: 27205, type: 'movie', title: 'Inception', poster: '/in.jpg' },
];

const BASE = { createdAt: '2026-10-01T10:00:00.000Z', sentAt: null, usedAt: null, invitee: null, revokedAt: null, message: null, picks: [] as unknown[] };

function freshList(): void {
  list = [
    { ...BASE, id: 'i1', code: 'FreeCode1', state: 'free', number: 1039 },
    { ...BASE, id: 'i2', code: 'SentCode2', state: 'sent', sentAt: '2026-10-15T10:00:00.000Z', expiresAt: future(9 * DAY - 60_000), number: 1040 },
    { ...BASE, id: 'i3', code: 'UsedCode3', state: 'used', invitee: 'Noé', usedAt: '2026-10-12T10:00:00.000Z', number: 1041 },
    { ...BASE, id: 'i4', code: 'FreeCode4', state: 'free', number: 1042 },
  ];
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const call: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return routes(call) ?? json({ error: 'not_found' }, 404);
  }));
}

const tickets = () => Array.from(document.querySelectorAll<HTMLElement>('#detail .tk-ticket'));
const $ = (sel: string) => document.querySelector<HTMLElement>('#detail ' + sel);
const msgField = () => document.querySelector<HTMLTextAreaElement>('#detail #tk-msg');
const click = (el: Element | null) => {
  if (!el) throw new Error('élément introuvable');
  (el as HTMLElement).click();
};
const typeInto = (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const puts = () => calls.filter((c) => c.method === 'PUT' && c.path === '/user/invites/i1');

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
  freshList();
  routes = (c) => {
    if (c.method === 'GET' && c.path === '/user/invites') return json({ quota: 4, invites: list });
    if (c.method === 'PUT' && c.path === '/user/invites/i1') return json({ invite: { ...list[0], message: c.body.message, picks: c.body.picks } });
    if (c.method === 'PUT' && /\/user\/invites\/[^/]+\/sent$/.test(c.path)) return new Response(null, { status: 204 });
    if (c.method === 'DELETE' && c.path === '/user/invites/i2') {
      list[1] = { ...list[1], state: 'free', sentAt: null, expiresAt: null, code: 'NewCode2' };
      return json({ invite: list[1] });
    }
    return undefined;
  };
  stubFetch();
  document.getElementById('detail')!.innerHTML = mod.invitesCard();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  vi.stubGlobal('confirm', () => true);
  window.confirm = () => true;
});

describe('billets de parrainage', () => {
  it('affiche 4 billets : libre, envoyé, validé (nom du filleul), chacun avec son numéro', async () => {
    await mod.refreshInvites();
    const t = tickets();
    expect(t).toHaveLength(4);
    expect(t.map((b) => b.className.match(/tk-is-(\w+)/)![1])).toEqual(['free', 'sent', 'used', 'free']);
    expect(t[0].textContent).toContain('Billet N° 1039');
    expect(t[0].textContent).toContain('Offrir ce billet');
    expect(t[1].textContent).toContain('Billet N° 1040');
    expect(t[1].textContent).toContain('Envoyé · expire dans 9 j');
    expect(t[2].textContent).toContain('Billet N° 1041');
    expect(t[2].textContent).toContain('Validé');
    expect(t[2].textContent).toContain('Noé');
    expect(t[3].textContent).toContain('Billet N° 1042');
  });

  it('sélectionner un billet libre ouvre le composeur ; un billet validé montre le nom du filleul', async () => {
    await mod.refreshInvites();
    click(tickets()[3]);
    await tick(10);
    expect(tickets()[3].getAttribute('aria-pressed')).toBe('true');
    expect($('#tk-compose-t')!.textContent).toContain('1042');
    expect(msgField()).not.toBeNull();
    click(tickets()[2]);
    await tick(10);
    expect(msgField()).toBeNull();
    expect($('.tk-panel-used')!.textContent).toContain('Noé a validé ce billet');
  });

  it('mot : compteur, 280 caractères au plus, enregistré quand le champ perd le focus', async () => {
    await mod.refreshInvites();
    click(tickets()[0]);
    await tick(10);
    const field = msgField()!;
    typeInto(field, 'x'.repeat(300));
    expect(field.value).toHaveLength(280);
    expect($('.tk-count')!.textContent).toBe('280 / 280');
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.message).toHaveLength(280);
    expect(puts()[0].body.picks).toEqual([]);
  });

  it('coups de cœur : 3 au plus, le 4e est refusé sans appel ; chaque choix enregistre {message, picks}', async () => {
    await mod.refreshInvites();
    click(tickets()[0]);
    await tick(10);
    typeInto(msgField()!, 'Tu vas adorer.');
    expect(document.querySelectorAll('#detail [data-tk-pick]')).toHaveLength(4);
    click($('[data-tk-pick="movie:550"]'));
    await tick();
    click($('[data-tk-pick="series:1399"]'));
    await tick();
    click($('[data-tk-pick="movie:603"]'));
    await tick();
    expect(puts()).toHaveLength(3);
    const last = puts().at(-1)!.body;
    expect(last.message).toBe('Tu vas adorer.');
    expect(last.picks.map((p: any) => p.id)).toEqual(['550', '1399', '603']);
    expect(last.picks[1].type).toBe('series');
    expect(last.picks[0].poster).toBe('https://image.tmdb.org/t/p/w342/fc.jpg');
    expect($('.tk-picks-n')!.textContent).toBe('3 / 3');

    click($('[data-tk-pick="movie:27205"]'));
    await tick();
    expect(puts()).toHaveLength(3);
    expect($('[data-tk-pick="movie:27205"]')!.getAttribute('aria-disabled')).toBe('true');
    expect($('#tk-pick-status')!.textContent).toContain('Trois coups de cœur au maximum');

    click($('[data-tk-pick="movie:550"]'));
    await tick();
    expect(puts().at(-1)!.body.picks.map((p: any) => p.id)).toEqual(['1399', '603']);
  });

  it('copier : le mot est enregistré avant le lien, puis le billet passe à « envoyé » (API existante)', async () => {
    await mod.refreshInvites();
    click(tickets()[0]);
    await tick(10);
    typeInto(msgField()!, 'Bienvenue !');
    click($('[data-tk-copy]'));
    await tick(80);
    const putIdx = calls.findIndex((c) => c.method === 'PUT' && c.path === '/user/invites/i1' && c.body.message === 'Bienvenue !');
    const sentIdx = calls.findIndex((c) => c.path === '/user/invites/i1/sent');
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(sentIdx).toBeGreaterThan(putIdx);
    expect(calls[sentIdx].body).toEqual({ sent: true });
    expect((navigator.clipboard.writeText as any).mock.calls[0][0]).toMatch(/\/\?invite=FreeCode1$/);
    expect(tickets()[0].className).toContain('tk-is-sent');
    expect($('[data-tk-copy]')!.textContent).toBe('Copier à nouveau');
    expect($('[data-tk-revoke]')!.textContent).toBe('Annuler le billet');
  });

  it('billet envoyé : « Annuler le billet » révoque le lien et rend le billet libre', async () => {
    await mod.refreshInvites();
    click(tickets()[1]);
    await tick(10);
    expect($('.tk-panel-sent')!.textContent).toContain('Le lien expire dans 9 j');
    click($('[data-tk-revoke]'));
    await tick(80);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/user/invites/i2')).toBe(true);
    expect(tickets()[1].className).toContain('tk-is-free');
    expect(msgField()).not.toBeNull();
  });

  it('échappe les textes du serveur et n’affiche que des images https', () => {
    const html = mod.invitesBodyHTML({
      quota: 4,
      invites: [
        { ...BASE, id: 'i9', code: 'X9', state: 'used', invitee: '<img src=x onerror="alert(1)">', number: 1099 },
        { ...BASE, id: 'i8', code: 'X8', state: 'free', picks: [{ id: '1', type: 'movie', name: 'Titre', poster: 'http://insecure.example/x.jpg', background: '' }] },
      ],
    } as never);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('insecure.example');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('composeur : seules les affiches acceptées par le serveur', () => {
  /** Ajoute des titres à la bibliothèque le temps d'un test, puis les retire (la bibliothèque est partagée par le fichier). */
  function withLibrary(entries: Array<{ id: number; type: 'movie' | 'tv'; title: string; poster: string; addedAt: number }>, run: () => Promise<void>) {
    return async () => {
      for (const e of entries) userStore.addToLibrary(e);
      try {
        await run();
      } finally {
        for (const e of entries) userStore.removeFromLibrary(`${e.type}:${e.id}`);
      }
    };
  }

  it('un titre dont l’affiche n’est pas une adresse acceptée (vide, hôte inconnu) n’est pas proposé ; une affiche TMDB l’est', withLibrary(
    [
      { id: 880001, type: 'movie', title: 'Sans affiche', poster: '', addedAt: 2 },
      { id: 880002, type: 'tv', title: 'Affiche étrangère', poster: 'https://evil.example/p.jpg', addedAt: 1 },
    ],
    async () => {
      await mod.refreshInvites();
      click(tickets()[0]);
      expect(document.querySelector('#detail [data-tk-pick="movie:880001"]')).toBeNull();
      expect(document.querySelector('#detail [data-tk-pick="series:880002"]')).toBeNull();
      expect(document.querySelector('#detail [data-tk-pick="movie:550"]')).not.toBeNull();
    },
  ));

  it('une affiche metahub est acceptée : le titre est proposé avec son affiche en https', withLibrary(
    [{ id: 880003, type: 'tv', title: 'Metahub', poster: 'https://images.metahub.space/poster/small/tt0944947/img', addedAt: 1 }],
    async () => {
      await mod.refreshInvites();
      click(tickets()[0]);
      const pick = document.querySelector<HTMLElement>('#detail [data-tk-pick="series:880003"]');
      expect(pick).not.toBeNull();
      expect(pick!.querySelector('img')!.getAttribute('src')).toBe('https://images.metahub.space/poster/small/tt0944947/img');
    },
  ));
});
