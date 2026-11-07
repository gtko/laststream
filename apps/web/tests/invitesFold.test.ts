// Billets de parrainage, carte repliable (ODY-150) : repliée par défaut, ouverture mémorisée, résumé calculé, aucun billet
// présélectionné, composeur seulement après le choix d'un billet disponible, états lisibles (texte et icône), billet révoqué
// inactif, clavier (flèches, Début/Fin, Échap), points de position du carrousel, feuille du bas sur mobile.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { userStore } from '../src/data/userStore';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const DAY = 86_400_000;
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const OPEN_KEY = 'ls_tickets_open';

let list: Array<Record<string, any>> = [];
let mod: typeof import('../src/ui/invites.js');
let mobile = false;

const BASE = { createdAt: '2026-10-01T10:00:00.000Z', sentAt: null, usedAt: null, invitee: null, revokedAt: null, message: null, picks: [] as unknown[] };

function freshList(): void {
  list = [
    { ...BASE, id: 'i1', code: 'FreeCode1', state: 'free', number: 1039 },
    { ...BASE, id: 'i2', code: 'SentCode2', state: 'sent', sentAt: '2026-10-15T10:00:00.000Z', expiresAt: future(9 * DAY - 60_000), number: 1040 },
    { ...BASE, id: 'i3', code: 'UsedCode3', state: 'used', invitee: 'Noé', usedAt: '2026-10-12T10:00:00.000Z', number: 1041 },
    { ...BASE, id: 'i4', code: 'FreeCode4', state: 'free', number: 1042 },
    { ...BASE, id: 'i5', code: 'GoneCode5', state: 'free', revokedAt: '2026-10-19T08:00:00.000Z', number: 1043 },
  ];
}

const $ = (sel: string) => document.querySelector<HTMLElement>('#detail ' + sel);
const tickets = () => Array.from(document.querySelectorAll<HTMLElement>('#detail .tk-ticket'));
const fold = () => $('[data-tk-fold]')!;
const region = () => $('#tk-fold-r')!;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

async function mount(): Promise<void> {
  document.getElementById('detail')!.innerHTML = mod.invitesCard();
  await mod.refreshInvites();
}

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  // dom.js attend ces éléments à l'import (détail, modale, toast).
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal"><div class="modal"></div></div>' +
    '<div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  userStore.addToLibrary({ id: 550, type: 'movie', title: 'Fight Club', poster: '/fc.jpg' } as never);
  // Écran étroit simulé : la feuille du bas ne s'ouvre que si `mobile` est vrai.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: q.includes('max-width: 640px') ? mobile : false, media: q, addEventListener() {}, removeEventListener() {} }),
  });
  mod = await import('../src/ui/invites.js');
});

beforeEach(() => {
  mobile = false;
  freshList();
  localStorage.removeItem(OPEN_KEY);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if ((init?.method ?? 'GET') === 'GET' && u.pathname === '/user/invites') return json({ quota: 5, invites: list });
    if (init?.method === 'PUT') return json({ invite: {} });
    return json({ error: 'not_found' }, 404);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('carte repliable', () => {
  it('repliée par défaut : en-tête bouton (aria-expanded, aria-controls), région masquée, miniatures par état', async () => {
    await mount();
    expect(fold().tagName).toBe('BUTTON');
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(fold().getAttribute('aria-controls')).toBe('tk-fold-r');
    expect(region().hidden).toBe(true);
    const minis = Array.from(document.querySelectorAll('#detail .tk-minis .tk-mini'));
    expect(minis.map((m) => m.className.match(/tk-is-(\w+)/)![1])).toEqual(['free', 'sent', 'used', 'free', 'revoked']);
    expect($('.tk-minis')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('résumé calculé depuis les billets : disponibles (hors révoqués), envoyés, validés', async () => {
    await mount();
    expect($('.tk-fold-s')!.textContent).toBe('2 billets disponibles · 1 envoyé · 1 validé');
    list = [{ ...BASE, id: 'a', code: 'A', state: 'free', number: 1 }, { ...BASE, id: 'b', code: 'B', state: 'free', number: 2 },
      { ...BASE, id: 'c', code: 'C', state: 'free', number: 3 }, { ...BASE, id: 'd', code: 'D', state: 'free', number: 4 }];
    await mod.refreshInvites();
    expect($('.tk-fold-s')!.textContent).toBe('4 billets disponibles · 0 validé');
  });

  it('chargement et erreur : le résumé le dit, la région garde les messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('hors ligne'); }));
    await mount();
    expect($('.tk-fold-s')!.textContent).toBe('Billets indisponibles pour le moment');
    expect(region().querySelector('[data-inv-reload]')).not.toBeNull();
  });

  it('ouvrir puis replier : aria-expanded suit, le focus reste sur l’en-tête, l’état est mémorisé', async () => {
    await mount();
    fold().focus();
    fold().click();
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(region().hidden).toBe(false);
    expect(document.activeElement).toBe(fold());
    expect(localStorage.getItem(OPEN_KEY)).toBe('1');
    // Nouvelle ouverture des réglages : la carte revient ouverte.
    await mount();
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(region().hidden).toBe(false);
    fold().click();
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(region().hidden).toBe(true);
    expect(localStorage.getItem(OPEN_KEY)).toBe('0');
  });
});

describe('rangée de billets et panneau', () => {
  it('aucun billet présélectionné : pas de composeur ni de panneau à l’ouverture', async () => {
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    expect(tickets()).toHaveLength(5);
    expect(tickets().filter((t) => t.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
    expect($('#tk-msg')).toBeNull();
    expect($('[data-tk-pane]')).toBeNull();
  });

  it('composeur seulement après le choix d’un billet disponible ; choisi à nouveau, il se referme', async () => {
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    tickets()[1].click();
    expect($('#tk-msg')).toBeNull();
    expect($('.tk-panel-sent')).not.toBeNull();
    tickets()[0].click();
    expect(tickets()[0].getAttribute('aria-pressed')).toBe('true');
    expect($('#tk-msg')).not.toBeNull();
    expect($('.tk-count')!.textContent).toBe('0 / 280');
    expect($('[data-tk-copy]')!.textContent).toBe('Copier le lien');
    expect($('[data-tk-share]')!.textContent).toBe('Partager…');
    expect($('.tk-compose')!.textContent).toContain('Valable 14 jours après l’envoi · révocable · le billet revient si personne ne l’utilise');
    expect($('.tk-picks-t')!.textContent).toContain('Tes 3 coups de cœur');
    expect($('.tk-picks-n')!.textContent).toBe('0 / 3');
    // Bureau : panneau sous la rangée, pas de fenêtre modale.
    expect($('.tk-compose')!.getAttribute('role')).toBeNull();
    tickets()[0].click();
    expect($('#tk-msg')).toBeNull();
    expect(tickets()[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('états explicites : texte et icône sur chaque billet, légende sous la rangée', async () => {
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    const labels = tickets().map((t) => t.getAttribute('aria-label'));
    expect(labels[0]).toBe('Billet 1039 · Disponible, à offrir');
    expect(labels[1]).toContain('Billet 1040 · Envoyé, en attente');
    expect(labels[2]).toContain('Billet 1041 · Validé par Noé');
    expect(labels[4]).toBe('Billet 1043 · Révoqué par l’administrateur, ne peut plus être envoyé');
    for (const t of tickets()) expect(t.querySelector('.tk-sub .tk-ico')).not.toBeNull();
    expect(Array.from(document.querySelectorAll('#detail .tk-legend li')).map((li) => li.textContent)).toEqual(['Disponible', 'Envoyé, en attente', 'Validé', 'Révoqué']);
  });

  it('billet révoqué : aria-disabled, ni aria-pressed ni panneau au clic ou à Entrée', async () => {
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    const gone = tickets()[4];
    expect(gone.getAttribute('aria-disabled')).toBe('true');
    expect(gone.hasAttribute('aria-pressed')).toBe(false);
    gone.click();
    expect($('[data-tk-pane]')).toBeNull();
  });
});

describe('clavier', () => {
  it('flèches gauche/droite, Début et Fin déplacent le focus dans la rangée (bornes comprises)', async () => {
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    tickets()[0].focus();
    expect(key(tickets()[0], 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tickets()[1]);
    key(tickets()[1], 'ArrowLeft');
    expect(document.activeElement).toBe(tickets()[0]);
    key(tickets()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tickets()[0]);
    key(tickets()[0], 'End');
    expect(document.activeElement).toBe(tickets()[4]);
    key(tickets()[4], 'Home');
    expect(document.activeElement).toBe(tickets()[0]);
  });

  it('Échap ferme le panneau, rend le focus au billet et ne remonte pas à la navigation globale', async () => {
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    tickets()[3].click();
    const field = $('#tk-msg') as HTMLTextAreaElement;
    field.focus();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    const e = key(field, 'Escape');
    document.removeEventListener('keydown', outer);
    expect(e.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect($('#tk-msg')).toBeNull();
    expect(document.activeElement).toBe(tickets()[3]);
  });

  it('Échap sans panneau ouvert : laissé à la navigation globale', async () => {
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    tickets()[0].focus();
    expect(key(tickets()[0], 'Escape').defaultPrevented).toBe(false);
  });
});

describe('mobile', () => {
  it('feuille du bas : fenêtre modale, bouton Fermer, Échap la ferme et rend le focus au billet', async () => {
    mobile = true;
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    tickets()[0].click();
    const sheet = $('[data-tk-sheet]')!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.getAttribute('aria-labelledby')).toBe('tk-compose-t');
    expect(document.activeElement).toBe(sheet.querySelector('.tk-close'));
    key(document.activeElement!, 'Escape');
    expect($('[data-tk-sheet]')).toBeNull();
    expect(document.activeElement).toBe(tickets()[0]);
    tickets()[0].click();
    $('.tk-close')!.click();
    expect($('[data-tk-sheet]')).toBeNull();
    expect(document.activeElement).toBe(tickets()[0]);
  });

  it('feuille du bas : Tab reste dans la fenêtre', async () => {
    mobile = true;
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    tickets()[0].click();
    const sheet = $('[data-tk-sheet]')!;
    const items = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled]), textarea'));
    items.at(-1)!.focus();
    expect(key(items.at(-1)!, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(key(items[0], 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items.at(-1));
  });

  it('points de position : « Billet n sur N » suit le défilement du carrousel', async () => {
    mobile = true;
    localStorage.setItem(OPEN_KEY, '1');
    await mount();
    expect(document.querySelectorAll('#detail .tk-dot')).toHaveLength(5);
    expect($('[data-tk-pos]')!.textContent).toBe('Billet 1 sur 5');
    const row = $('[data-tk-row]')!;
    tickets().forEach((t, i) => Object.defineProperty(t, 'offsetLeft', { configurable: true, value: i * 284 }));
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 5 * 284 });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 330 });
    Object.defineProperty(row, 'scrollLeft', { configurable: true, value: 570 });
    row.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 40));
    expect($('[data-tk-pos]')!.textContent).toBe('Billet 3 sur 5');
    const dots = Array.from(document.querySelectorAll('#detail .tk-dot'));
    expect(dots.map((d) => d.classList.contains('is-on'))).toEqual([false, false, true, false, false]);
  });
});
