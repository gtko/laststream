// Discussion (Social v2, lot 3a) : bulles, échappement, pagination, saisie, lu, contexte cliquable. Le store est un faux
// (abonnements capturés) ; la lecture est un faux `launch`. Seul le DOM du contenu de la discussion est testé.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const subs = new Set<(s: any) => void>();
  const st: any = {};
  const fire = () => subs.forEach((f) => f(st));
  return { st, subs, fire };
});

vi.mock('../src/data/socialStore', () => ({
  MESSAGE_MAX: 1000,
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => {
    h.subs.add(fn);
    return () => {
      h.subs.delete(fn);
    };
  },
  markRead: vi.fn(() => Promise.resolve()),
  loadMessages: vi.fn(() => Promise.resolve([])),
  sendMessage: vi.fn(() => Promise.resolve({})),
}));

import * as store from '../src/data/socialStore';
import { createConversationRenderer, posLabel, sendErrorMessage } from '../src/ui/socialChat.js';
import { state } from '../src/ui/state.js';

const ME = 'me';
const PID = 'p1';
const flush = () => new Promise((r) => setTimeout(r, 0));
const ts = (h: number, m: number) => new Date(2026, 0, 5, h, m).getTime();
const msg = (id: string, from: string, body: string, createdAt: number, extra: Record<string, unknown> = {}) =>
  ({ id, from, to: from === ME ? PID : ME, body, createdAt, ...extra });

/** Remplace l’état du faux store (moi, une conversation avec PID, messages de PID) et prévient les abonnés. */
function setStore(messages: unknown[], unread = 0) {
  Object.assign(h.st, {
    me: { pid: ME, handle: { name: 'Moi', tag: 'ZZ22', full: 'Moi#ZZ22' }, status: 'online', avatarColor: '#ff5a36' },
    messages: { [PID]: messages },
    conversations: [{ pid: PID, handle: { name: 'Ami', tag: 'AB23', full: 'Ami#AB23' }, avatarColor: '#3b82f6', unread }],
  });
}

/** Monte la discussion dans un conteneur attaché au document ; renvoie les faux et le conteneur. */
function mount(friend: unknown = null) {
  const el = document.createElement('div');
  el.id = 'ss-conv';
  document.body.append(el);
  const launch = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
  const toast = vi.fn();
  createConversationRenderer({ launch, toast })({ el, pid: PID, friend });
  return { el, launch, toast };
}

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

beforeEach(() => {
  document.body.innerHTML = '';
  h.subs.clear();
  state.byKey.clear();
  vi.mocked(store.markRead).mockReset().mockResolvedValue(undefined);
  vi.mocked(store.loadMessages).mockReset().mockResolvedValue([] as never);
  vi.mocked(store.sendMessage).mockReset().mockResolvedValue({} as never);
});

describe('bulles', () => {
  it('miennes à droite, les leurs à gauche, heure, « Lu » seulement sur mes messages lus', async () => {
    setStore([
      msg('a', PID, 'Salut', ts(12, 30)),
      msg('b', ME, 'Hello', ts(12, 31), { readAt: ts(12, 32) }),
      msg('c', ME, 'Non lu', ts(12, 33)),
    ]);
    const { el } = mount();
    await flush();
    const rows = el.querySelectorAll('.ss-bub-row');
    expect(rows.length).toBe(3);
    expect(rows[0].classList.contains('is-theirs')).toBe(true);
    expect(rows[1].classList.contains('is-mine')).toBe(true);
    expect(q(rows[1], 'time')?.textContent).toBe('12:31');
    expect(q(rows[1], '.ss-bub-meta')?.textContent).toContain('Lu');
    expect(q(rows[2], '.ss-bub-meta')?.textContent).not.toContain('Lu');
  });

  it('texte d’un message jamais interprété (HTML échappé)', async () => {
    const evil = '<img src="x" onerror="window.__pwned=1"><b>gras</b>';
    setStore([msg('a', PID, evil, ts(9, 5))]);
    const { el } = mount();
    await flush();
    expect(q(el, 'img')).toBeNull();
    expect(q(el, 'b')).toBeNull();
    expect(q(el, '.ss-bub-text')?.textContent).toBe(evil);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('aucun message : texte d’invitation à écrire', async () => {
    setStore([]);
    const { el } = mount();
    await flush();
    expect(q(el, '.wp-empty')?.textContent).toContain('Écris le premier');
  });
});

describe('lecture (lu)', () => {
  it('marque lu à l’ouverture', async () => {
    setStore([msg('a', PID, 'Salut', ts(12, 30))]);
    mount();
    await flush();
    expect(store.markRead).toHaveBeenCalledWith(PID);
  });

  it('marque lu à la réception quand la discussion est visible', async () => {
    setStore([msg('a', PID, 'Salut', ts(12, 30))]);
    const { el } = mount();
    await flush();
    vi.mocked(store.markRead).mockClear();
    setStore([msg('a', PID, 'Salut', ts(12, 30)), msg('b', PID, 'Au fait', ts(12, 31))], 1);
    h.fire();
    await flush();
    expect(store.markRead).toHaveBeenCalledWith(PID);
    expect(el.querySelectorAll('.ss-bub-row').length).toBe(2);
  });

  it('pas de marque lu quand la discussion est masquée', async () => {
    setStore([msg('a', PID, 'Salut', ts(12, 30))]);
    const { el } = mount();
    await flush();
    vi.mocked(store.markRead).mockClear();
    el.hidden = true;
    setStore([msg('a', PID, 'Salut', ts(12, 30)), msg('b', PID, 'Au fait', ts(12, 31))], 1);
    h.fire();
    await flush();
    expect(store.markRead).not.toHaveBeenCalled();
  });

  it('un nouvel affichage remplace le précédent : un seul abonnement au store', async () => {
    setStore([]);
    const el = document.createElement('div');
    document.body.append(el);
    const render = createConversationRenderer({ launch: vi.fn(), toast: vi.fn() });
    render({ el, pid: PID, friend: null });
    render({ el, pid: PID, friend: null });
    await flush();
    expect(h.subs.size).toBe(1);
  });
});

describe('pagination', () => {
  it('charge les messages précédents avant le plus ancien, puis masque le bouton quand la page n’apporte rien', async () => {
    const page = Array.from({ length: 50 }, (_, i) => msg('m' + (i + 1), i % 2 ? ME : PID, 'Message ' + (i + 1), 1000 * (i + 1)));
    setStore(page);
    vi.mocked(store.loadMessages).mockResolvedValue(page as never);
    const { el } = mount();
    await flush();
    expect(store.loadMessages).toHaveBeenCalledWith(PID, { limit: 50 });
    const more = q<HTMLButtonElement>(el, '.ss-chat-more');
    expect(more?.hidden).toBe(false);

    vi.mocked(store.loadMessages).mockResolvedValueOnce(page as never);
    more?.click();
    await flush();
    expect(store.loadMessages).toHaveBeenLastCalledWith(PID, { before: 1000, limit: 50 });
    expect(more?.hidden).toBe(true);
  });
});

describe('saisie', () => {
  it('soumettre (Entrée) envoie le texte rogné et vide la saisie', async () => {
    setStore([]);
    const { el } = mount();
    await flush();
    const input = q<HTMLInputElement>(el, 'input[name="text"]');
    if (!input) throw new Error('saisie absente');
    input.value = '  Bonjour  ';
    q<HTMLFormElement>(el, 'form')?.requestSubmit();
    expect(store.sendMessage).toHaveBeenCalledWith(PID, 'Bonjour');
    await flush();
    expect(input.value).toBe('');
  });

  it('plus de 1000 caractères : pas d’envoi, compteur en erreur, message FR', async () => {
    setStore([]);
    const { el } = mount();
    await flush();
    const input = q<HTMLInputElement>(el, 'input[name="text"]');
    if (!input) throw new Error('saisie absente');
    input.value = 'a'.repeat(1001);
    input.dispatchEvent(new Event('input'));
    const count = q(el, '.ss-chat-count');
    expect(count?.textContent).toBe('1001 / 1000');
    expect(count?.classList.contains('is-over')).toBe(true);
    expect(q<HTMLButtonElement>(el, 'button[type="submit"]')?.disabled).toBe(true);
    q<HTMLFormElement>(el, 'form')?.requestSubmit();
    expect(store.sendMessage).not.toHaveBeenCalled();
    expect(q(el, '.ss-chat-status')?.textContent).toContain('1000');
  });

  it('erreurs d’envoi 403 et 429 en français, la saisie est conservée', async () => {
    setStore([]);
    const { el } = mount();
    await flush();
    const input = q<HTMLInputElement>(el, 'input[name="text"]');
    const form = q<HTMLFormElement>(el, 'form');
    const status = q(el, '.ss-chat-status');
    if (!input || !form || !status) throw new Error('élément absent');

    vi.mocked(store.sendMessage).mockRejectedValueOnce({ status: 403, code: 'not_friend' } as never);
    input.value = 'Coucou';
    form.requestSubmit();
    await flush();
    expect(status.textContent).toContain('amis');
    expect(status.dataset.tone).toBe('error');
    expect(input.value).toBe('Coucou');

    vi.mocked(store.sendMessage).mockRejectedValueOnce({ status: 429, code: 'rate_limited' } as never);
    form.requestSubmit();
    await flush();
    expect(status.textContent).toContain('réessaie');
  });

  it('sendErrorMessage : réseau, 403, 429 et repli', () => {
    expect(sendErrorMessage({ status: 0, code: 'network' })).toBe('Serveur injoignable pour le moment.');
    expect(sendErrorMessage({ status: 403, code: 'x' })).toMatch(/amis/);
    expect(sendErrorMessage({ status: 429, code: 'x' })).toMatch(/réessaie/);
    expect(sendErrorMessage({ status: 500, code: 'boom' })).toBe('Message non envoyé. Réessaie.');
  });
});

describe('contexte cliquable', () => {
  it('« à 12:34 dans Dune » (titre du catalogue) ; clic lance le média à cette position', async () => {
    state.byKey.set('movie:9', { name: 'Dune' } as never);
    setStore([msg('c1', PID, 'Regarde ça', ts(12, 40), { context: { type: 'movie', tmdbId: 9, pos: 754 } })]);
    const { el, launch } = mount();
    await flush();
    const btn = q<HTMLButtonElement>(el, '.ss-chat-ctx');
    if (!btn) throw new Error('contexte absent');
    expect(btn.textContent).toBe('à 12:34 dans Dune');
    btn.click();
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'movie', id: '9', key: 'movie:9', name: 'Dune' }),
      btn,
      { resume: 'none', startAt: 754 },
    );
  });

  it('titre inconnu : « dans un titre » ; le relevé de l’ami sert de repli ; sans position, pas d’« à »', async () => {
    const friend = {
      watching: { type: 'series', tmdbId: 7, title: 'Severance', season: 1, episode: 3, pos: 60, paused: true, at: 0 },
    };
    setStore([
      msg('c1', PID, 'Vu ?', ts(12, 40), { context: { type: 'movie', tmdbId: 9 } }),
      msg('c2', PID, 'Et celui-là', ts(12, 41), { context: { type: 'series', tmdbId: 7, season: 1, episode: 3, pos: 60 } }),
    ]);
    const { el } = mount(friend);
    await flush();
    const labels = Array.from(el.querySelectorAll('.ss-chat-ctx')).map((b) => b.textContent);
    expect(labels).toEqual(['dans un titre', 'à 1:00 dans Severance']);
  });

  it('série sans épisode : clic = toast FR, aucune lecture', async () => {
    setStore([msg('c1', PID, 'Ce passage', ts(12, 40), { context: { type: 'series', tmdbId: 7, pos: 10 } })]);
    const { el, launch, toast } = mount();
    await flush();
    q<HTMLButtonElement>(el, '.ss-chat-ctx')?.click();
    expect(launch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('épisode'));
  });

  it('posLabel : m:ss, puis h:mm:ss à partir d’une heure', () => {
    expect(posLabel(754)).toBe('12:34');
    expect(posLabel(3723)).toBe('1:02:03');
    expect(posLabel(-5)).toBe('0:00');
  });
});
