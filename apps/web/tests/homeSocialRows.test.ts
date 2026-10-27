// Sections sociales de l'accueil (LAST-194) : absence sans données / enfant / hors compte, rendu, clic Rejoindre, échappement.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { setEveningJoin, setEveningSource } from '../src/data/homeSocial';

const h = vi.hoisted(() => {
  const st: any = { friends: [], activity: [], listDetails: {}, badge: 0 };
  return { st, subs: new Set<(s: any) => void>() };
});
vi.mock('../src/data/socialStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getState: () => h.st,
  subscribe: (fn: (s: any) => void) => { h.subs.add(fn); return () => h.subs.delete(fn); },
}));
const api = vi.hoisted(() => ({
  listParties: vi.fn(), homeWatching: vi.fn(), homeRecommendations: vi.fn(),
}));
vi.mock('../src/data/socialApi', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), listParties: api.listParties }));
vi.mock('../src/data/socialV3Api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), homeWatching: api.homeWatching, homeRecommendations: api.homeRecommendations,
}));

let slotHTML: () => string;
let mount: () => void;
let rows: typeof import('../src/ui/homeSocialRows.js');

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ({ homeSocialSlotHTML: slotHTML, mountHomeSocial: mount } = await import('../src/ui/homeSocialSlot.js'));
  rows = await import('../src/ui/homeSocialRows.js');
});

type Prof = { id: string; name: string; avatarColor: string; isKid: boolean; kidMaxAge: number | null; hasPin: boolean; allowedCatalogs: never[]; createdAt: string };
const ADULT: Prof = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' };
function setAccount(p: Prof | null): void {
  auth.status = p ? 'ready' : 'local';
  auth.profile = p as unknown as typeof auth.profile;
}
const LEA = { pid: 'f1', handle: { name: 'Léa', full: 'Léa#0001' }, avatarColor: '#ff5a36', muted: false, status: 'online' };
const friend = (name: string) => ({ pid: 'x', handle: { name, full: name + '#1' }, avatarColor: '#fff', nickname: undefined });
const room = (o: object = {}) => ({ id: 'r/1', title: 'Severance', poster: null, language: 'fr', mediaType: 'series', host: 'Léa', participants: 2, maxParticipants: 6, createdAt: '2026-10-27T10:00:00Z', ...o });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function mountWith(): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app">' + slotHTML() + '</div>';
  mount();
  await flush();
  return document.getElementById('social-slot') as HTMLElement;
}

beforeEach(() => {
  setAccount(ADULT);
  h.st.friends = [LEA];
  api.listParties.mockReset().mockResolvedValue({ rooms: [], nextCursor: null });
  api.homeWatching.mockReset().mockResolvedValue({ items: [] });
  api.homeRecommendations.mockReset().mockResolvedValue({ items: [] });
});
afterEach(() => {
  setAccount(null);
  setEveningSource(() => []);
  setEveningJoin(() => false);
  document.body.innerHTML = '';
});

describe('sections sociales de l’accueil', () => {
  it('profil enfant ou hors compte : ni emplacement ni requête', async () => {
    setAccount({ ...ADULT, isKid: true, kidMaxAge: 10 });
    expect(slotHTML()).toBe('');
    mount();
    setAccount(null);
    expect(slotHTML()).toBe('');
    await flush();
    expect(api.listParties).not.toHaveBeenCalled();
    expect(api.homeWatching).not.toHaveBeenCalled();
    expect(api.homeRecommendations).not.toHaveBeenCalled();
  });

  it('sans donnée : aucune section, aucun titre vide', async () => {
    const slot = await mountWith();
    expect(slot.innerHTML).toBe('');
  });

  it('échec réseau : silencieux, la rangée n’apparaît pas', async () => {
    api.homeWatching.mockRejectedValue(new Error('boom'));
    api.homeRecommendations.mockRejectedValue(new Error('boom'));
    api.listParties.mockRejectedValue(new Error('boom'));
    const slot = await mountWith();
    expect(slot.innerHTML).toBe('');
  });

  it('salon d’un ami : carte en direct, Rejoindre mène à #/party/<id> ; salon d’un inconnu ou plein écarté', async () => {
    api.listParties.mockResolvedValue({ rooms: [room(), room({ id: 'r2', host: 'Inconnu' }), room({ id: 'r3', participants: 6 })], nextCursor: null });
    const slot = await mountWith();
    expect(slot.querySelector('#h-ensemble-ce-soir')?.textContent).toBe('Ensemble, ce soir');
    const join = slot.querySelectorAll<HTMLAnchorElement>('a.hsr-btn[href^="#/party/"]');
    expect(join).toHaveLength(1);
    expect(join[0].getAttribute('href')).toBe('#/party/r%2F1');
    expect(slot.textContent).toContain('En direct · 2 spectateurs');
    expect(slot.querySelector('a[href="#/ensemble"].hsr-btn')?.textContent).toBe('Proposer une soirée');
  });

  it('ami en sourdine : son salon n’apparaît pas', async () => {
    h.st.friends = [{ ...LEA, muted: true }];
    api.listParties.mockResolvedValue({ rooms: [room()], nextCursor: null });
    expect((await mountWith()).innerHTML).toBe('');
  });

  it('soirée proposée : carte « Je viens » qui appelle l’inscription ; échec : toast', async () => {
    const join = vi.fn().mockResolvedValue(true);
    setEveningJoin(join);
    setEveningSource(() => [{ id: 'e1', type: 'movie', tmdbId: 5, startsAt: Date.now() + 3600_000, title: 'Dune 2', host: 'Tom', going: ['f1'] }]);
    const slot = await mountWith();
    expect(slot.textContent).toContain('Dune 2');
    expect(slot.textContent).toContain('Proposée par Tom');
    slot.querySelector<HTMLElement>('[data-hsr-evening="e1"]')!.click();
    await flush();
    expect(join).toHaveBeenCalledWith('e1');
  });

  it('soirée proposée pour un autre jour : l’étiquette ne dit pas « Ce soir »', async () => {
    setEveningSource(() => [{ id: 'e2', type: 'movie', tmdbId: 5, startsAt: Date.now() + 3 * 86_400_000, title: 'Dune 2', host: 'Tom', going: [] }]);
    const slot = await mountWith();
    const eye = slot.querySelector('.hsr-eye')!.textContent!;
    expect(eye).not.toContain('Ce soir');
    expect(eye).toContain(' · ');
  });

  it('ce que regardent les amis : épisode, en cours, lien vers la fiche, échappement', async () => {
    api.homeWatching.mockResolvedValue({
      items: [
        { friend: friend('Tom'), media: { type: 'series', tmdbId: 42, title: 'The <b>Bear</b>', season: 3, episode: 6 }, pos: 10, duration: 100, finished: false, live: true, updatedAt: 1 },
        { friend: friend('Inès'), media: { type: 'movie', tmdbId: 7, title: 'Arrival' }, pos: 50, duration: 200, finished: false, live: false, updatedAt: 1 },
        { friend: friend('Sam'), media: { type: 'movie', tmdbId: 8 }, pos: 1, finished: true, live: false, updatedAt: 1 },
      ],
    });
    const slot = await mountWith();
    const cards = slot.querySelectorAll<HTMLAnchorElement>('#amis-regardent a.hsr-po');
    expect(cards).toHaveLength(2); // l'item sans titre est écarté
    expect(cards[0].getAttribute('href')).toBe('#/tv/42');
    expect(cards[0].textContent).toContain('S3·E6');
    expect(cards[0].querySelector('.hsr-live')?.textContent).toBe('En cours');
    expect(cards[0].querySelector('b')).toBeNull(); // le titre n’injecte pas de balise
    expect(cards[1].getAttribute('href')).toBe('#/movie/7');
    expect(cards[1].textContent).toContain('25 %');
  });

  it('coups de cœur : mot de l’ami échappé, mot vide écarté', async () => {
    api.homeRecommendations.mockResolvedValue({
      items: [
        { friend: friend('Léa'), media: { type: 'movie', tmdbId: 9, title: 'Past Lives' }, word: 'Vu <img src=x onerror=alert(1)> !', createdAt: 1 },
        { friend: friend('Tom'), media: { type: 'movie', tmdbId: 10, title: 'Vide' }, word: '  ', createdAt: 1 },
      ],
    });
    const slot = await mountWith();
    expect(slot.querySelectorAll('.hsr-reco')).toHaveLength(1);
    expect(slot.querySelector('img[onerror]')).toBeNull();
    expect(slot.querySelector('.hsr-quote')?.textContent).toContain('« Vu <img src=x onerror=alert(1)> ! »');
    expect(slot.querySelector('#h-coups-de-coeur')?.textContent).toBe('Coups de cœur de tes amis');
  });

  it('friendRooms : rapproche l’hôte des amis sans accent ni casse', () => {
    expect(rows.friendRooms([room({ host: 'LEA' })], [LEA] as any)).toHaveLength(1);
  });
});
