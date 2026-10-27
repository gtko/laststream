// Rail d'amis de l'accueil et ligne sociale du héros (LAST-193) : rendu, groupes par présence, profil enfant, temps réel, clics.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { setEveningJoin, setEveningSource } from '../src/data/homeSocial';

const h = vi.hoisted(() => {
  const subs = new Set<(s: any) => void>();
  const st: any = { friends: [], activity: [], listDetails: {}, badge: 0 };
  return { st, subs, emit: () => subs.forEach((f) => f(st)) };
});

vi.mock('../src/data/socialStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => {
    h.subs.add(fn);
    return () => h.subs.delete(fn);
  },
}));

const sidebar = vi.hoisted(() => ({ openSidebar: vi.fn(), openFriendCard: vi.fn() }));
vi.mock('../src/ui/socialSidebar.js', () => sidebar);

let railSlotHTML: () => string;
let mountRail: () => void;
let railHTML: (s: any) => string;
let heroSocialHTML: (it: any) => string;
let heroEveningHTML: (it: any) => string;
let watchHeroSocial: (items: () => any[]) => void;
let paintHeroSocial: (items: any[], s?: any) => void;
let viewA: (d: any) => string;

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ({ railSlotHTML, mountRail } = await import('../src/ui/friendRailSlot.js'));
  ({ railHTML } = await import('../src/ui/friendRail.js'));
  ({ heroSocialHTML, heroEveningHTML, watchHeroSocial, paintHeroSocial } = await import('../src/ui/heroSocial.js'));
  ({ viewA } = await import('../src/ui/home.js'));
});

type Prof = { id: string; name: string; avatarColor: string; isKid: boolean; kidMaxAge: number | null; hasPin: boolean; allowedCatalogs: never[]; createdAt: string };
const ADULT: Prof = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' };
const KID = { ...ADULT, id: 'k1', name: 'Léo', isKid: true, kidMaxAge: 10 };
function setAccount(profile: Prof | null): void {
  auth.status = profile ? 'ready' : 'local';
  auth.profile = profile as unknown as typeof auth.profile;
}

const friend = (pid: string, name: string, extra: Record<string, unknown> = {}) => ({
  pid, handle: { name, tag: 'A7K2', full: name + '#A7K2' }, avatarColor: '#3b82f6', household: false, status: 'online', favorite: false, muted: false, ...extra,
});
const playing = { type: 'movie', tmdbId: 1, title: 'Dune', paused: false };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const rail = () => document.getElementById('friend-rail') as HTMLElement;
const names = (group: string) => Array.from(rail().querySelectorAll(`[role="group"][aria-label^="${group}"] button`)).map((b) => b.getAttribute('title'));

function mountHome(): void {
  document.body.innerHTML = '<div id="app" class="s-a">' + railSlotHTML() + '</div>';
  mountRail();
}

beforeEach(() => {
  setAccount(ADULT);
  h.st.friends = [];
  h.st.activity = [];
  h.st.listDetails = {};
  sidebar.openSidebar.mockClear();
  sidebar.openFriendCard.mockClear();
});
afterEach(() => {
  setAccount(null);
  setEveningSource(() => []);
  setEveningJoin(null);
  document.body.innerHTML = '';
});

describe('rail d’amis', () => {
  it('compte connecté : un rail « Amis » avec le bouton d’ajout, même sans ami', async () => {
    mountHome();
    await tick();
    expect(rail().getAttribute('aria-label')).toBe('Amis');
    expect(rail().querySelector('[data-fr-add]')?.getAttribute('aria-label')).toBe('Ajouter un ami');
    expect(rail().querySelectorAll('[data-fr-pid]')).toHaveLength(0);
    expect(rail().querySelector('.fr-sep')).toBeNull();
  });

  it('profil enfant ou mode local : aucun rail', () => {
    setAccount(KID);
    expect(railSlotHTML()).toBe('');
    setAccount(null);
    expect(railSlotHTML()).toBe('');
    mountHome();
    expect(document.getElementById('friend-rail')).toBeNull();
  });

  it('groupe les amis : en train de regarder, en ligne, hors ligne, avec leur présence', async () => {
    h.st.friends = [
      friend('p1', 'Zoé', { status: 'offline' }), friend('p2', 'Tom', { watching: playing }), friend('p3', 'Léa'),
      friend('p4', 'Sam', { status: 'away' }), friend('p5', 'Ina', { status: 'dnd', favorite: true }),
    ];
    mountHome();
    await tick();
    expect(names('En train de regarder')).toEqual(['Tom']);
    expect(names('En ligne')).toEqual(['Ina', 'Léa', 'Sam']); // favoris d’abord, puis par nom
    expect(names('Hors ligne')).toEqual(['Zoé']);
    expect(rail().querySelectorAll('.fr-sep')).toHaveLength(3);
    expect(rail().querySelector('[data-fr-pid="p2"] .ss-pdot')?.classList.contains('is-watch')).toBe(true);
    expect(rail().querySelector('[data-fr-pid="p4"] .ss-pdot')?.classList.contains('is-away')).toBe(true);
    expect(rail().querySelector('[data-fr-pid="p1"] .ss-pdot')?.classList.contains('is-offline')).toBe(true);
    expect(rail().querySelector('[data-fr-pid="p2"]')?.getAttribute('aria-label')).toBe('Tom, regarde Dune');
    expect(rail().querySelector('[data-fr-pid="p1"]')?.getAttribute('aria-label')).toBe('Zoé, hors ligne');
  });

  it('suit la présence en temps réel (abonnement au store) sans redessiner à vide', async () => {
    h.st.friends = [friend('p1', 'Léa'), friend('p2', 'Tom')];
    mountHome();
    await tick();
    h.st.friends = [friend('p1', 'Léa'), friend('p2', 'Tom', { status: 'offline' })];
    h.emit();
    expect(names('Hors ligne')).toEqual(['Tom']);
    expect(names('En ligne')).toEqual(['Léa']);
    const first = rail().querySelector('[data-fr-pid="p1"]');
    h.emit(); // événement sans effet visible : le rail n’est pas redessiné
    expect(rail().querySelector('[data-fr-pid="p1"]')).toBe(first);
    h.st.friends = [];
    h.emit();
    expect(rail().querySelectorAll('[data-fr-pid]')).toHaveLength(0);
  });

  it('échappe les noms venant du serveur', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const out = railHTML({ friends: [friend('p1', evil)] });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img');
  });

  it('un clic sur un ami ouvre sa fiche dans la barre des amis ; le bouton « + » ouvre la barre', async () => {
    h.st.friends = [friend('p1', 'Léa')];
    mountHome();
    await tick();
    rail().querySelector<HTMLElement>('[data-fr-pid="p1"]')!.click();
    await tick();
    expect(sidebar.openFriendCard).toHaveBeenCalledWith('p1');
    rail().querySelector<HTMLElement>('[data-fr-add]')!.click();
    await tick();
    expect(sidebar.openSidebar).toHaveBeenCalledTimes(1);
  });

  it('accueil : le rail est posé par le gabarit (classe has-rail), absent pour un profil enfant', () => {
    const data = { heroes: [], rows: { start: [], top: [] } };
    const adult = viewA(data);
    expect(adult).toContain('class="page-a has-rail"');
    expect(adult).toContain('id="friend-rail"');
    setAccount(KID);
    const kid = viewA(data);
    expect(kid).not.toContain('has-rail');
    expect(kid).not.toContain('friend-rail');
  });

  it('accueil : le rail vient après l’en-tête, donc avant les rangées dans l’ordre de tabulation', () => {
    const adult = viewA({ heroes: [], rows: { start: [], top: [] } });
    expect(adult.indexOf('id="friend-rail"')).toBeGreaterThan(adult.indexOf('class="topbar"'));
    expect(adult.indexOf('id="friend-rail"')).toBeLessThan(adult.indexOf('class="rows"'));
  });
});

describe('ligne sociale du héros', () => {
  const dune = { key: 'movie:438631', type: 'movie', id: 438631 };
  const act = (pid: string, tmdbId = 438631) => ({ id: pid + tmdbId, pid, handle: { name: pid }, avatarColor: '#fff', kind: 'listed', media: { type: 'movie', tmdbId, title: 'Dune' }, at: Date.now() });
  const line = () => document.querySelector('.hero-social')?.textContent ?? '';

  it('absente sans ami concerné : conteneur vide', () => {
    h.st.friends = [friend('p1', 'Léa')];
    h.st.activity = [act('p1', 999)];
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + '</div>';
    expect(line()).toBe('');
    expect(document.querySelector('.hero-social')?.children).toHaveLength(0);
  });

  it('« Léa, Tom et Sam veulent le voir », avatars en initiales', () => {
    h.st.friends = [friend('p1', 'Tom'), friend('p2', 'Léa'), friend('p3', 'Sam')];
    h.st.activity = [act('p1'), act('p2'), act('p3')];
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + '</div>';
    expect(document.querySelector('.hs-text')?.textContent).toBe('Léa, Sam et Tom veulent le voir');
    expect(document.querySelectorAll('.hs-av')).toHaveLength(3);
    expect(document.querySelector('.hs-stack')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('un seul ami : « veut le voir » ; plus de trois : « et N autres »', () => {
    h.st.friends = [friend('p1', 'Léa')];
    h.st.activity = [act('p1')];
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + '</div>';
    expect(line()).toContain('Léa veut le voir');
    h.st.friends = ['A', 'B', 'C', 'D', 'E'].map((n, i) => friend('q' + i, n));
    h.st.activity = h.st.friends.map((f: any) => act(f.pid));
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + '</div>';
    expect(document.querySelector('.hs-text')?.textContent).toBe('A, B, C et 2 autres veulent le voir');
  });

  it('échappe le nom d’un ami', () => {
    h.st.friends = [friend('p1', '<b onclick=x>Eve</b>')];
    h.st.activity = [act('p1')];
    expect(heroSocialHTML(dune)).not.toContain('<b onclick');
  });

  it('une série du catalogue (type tv) se lit comme une série du protocole', () => {
    h.st.friends = [friend('p1', 'Léa')];
    h.st.activity = [{ ...act('p1', 77), media: { type: 'series', tmdbId: 77, title: 'Slow Horses' } }];
    document.body.innerHTML = '<div id="app">' + heroSocialHTML({ key: 'tv:77', type: 'tv', id: 77 }) + '</div>';
    expect(line()).toContain('Léa veut le voir');
  });

  it('profil enfant et mode local : ni ligne ni bouton', () => {
    h.st.friends = [friend('p1', 'Léa')];
    h.st.activity = [act('p1')];
    setAccount(KID);
    expect(heroSocialHTML(dune)).toBe('');
    expect(heroEveningHTML(dune)).toBe('');
    setAccount(null);
    expect(heroSocialHTML(dune)).toBe('');
  });

  it('repeint la ligne sans la réécrire quand rien n’a changé (le HTML relu ne ressemble pas au HTML écrit)', () => {
    h.st.friends = [friend('p1', "Léa d'Or")];
    h.st.activity = [act('p1')];
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + '</div>';
    paintHeroSocial([dune]);
    const first = document.querySelector('.hero-social')!.firstChild;
    paintHeroSocial([dune]);
    paintHeroSocial([dune]);
    expect(document.querySelector('.hero-social')!.firstChild).toBe(first);
    expect(line()).toContain("Léa d'Or veut le voir");
  });

  it('« Je viens » absent tant qu’aucune action n’est branchée, même avec une soirée proposée', () => {
    h.st.friends = [friend('p1', 'Léa')];
    h.st.activity = [act('p1')];
    setEveningSource(() => [{ id: 'e1', type: 'movie', tmdbId: 438631, startsAt: Date.now() + 3_600_000 }]);
    setEveningJoin(null);
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + heroEveningHTML(dune) + '</div>';
    expect(document.querySelector('[data-hero-evening]')).toBeNull();
    expect(heroEveningHTML(dune)).toBe('<span class="hs-evening" data-hero-evening-slot="movie:438631"></span>');
  });

  it('suit le store en direct : la ligne apparaît quand un ami ajoute le titre', () => {
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + heroEveningHTML(dune) + '</div>';
    watchHeroSocial(() => [dune]);
    expect(line()).toBe('');
    h.st.friends = [friend('p1', 'Léa')];
    h.st.activity = [act('p1')];
    h.emit();
    expect(line()).toContain('Léa veut le voir');
  });

  it('« Je viens à 21 h » : seulement quand une soirée existe, et il l’annonce dans la ligne', async () => {
    h.st.friends = [friend('p1', 'Léa')];
    h.st.activity = [act('p1')];
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + heroEveningHTML(dune) + '</div>';
    expect(document.querySelector('[data-hero-evening]')).toBeNull();
    const startsAt = Date.now() + 3_600_000;
    const joined = vi.fn(async () => true);
    setEveningSource(() => [{ id: 'e1', type: 'movie', tmdbId: 438631, startsAt }]);
    setEveningJoin(joined);
    document.body.innerHTML = '<div id="app">' + heroSocialHTML(dune) + heroEveningHTML(dune) + '</div>';
    const btn = document.querySelector<HTMLElement>('[data-hero-evening="e1"]')!;
    expect(btn.textContent).toMatch(/^Je viens à \d+ h/);
    expect(line()).toContain('soirée proposée à');
    btn.click();
    await tick();
    expect(joined).toHaveBeenCalledWith('e1');
  });
});
