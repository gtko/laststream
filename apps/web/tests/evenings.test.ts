// Soirées planifiées (LAST-199, lot A) : trames, magasin (pagination, génération périmée, trames), cartes, réponses, ouverture du
// salon, onglets de la page Ensemble, accueil. Le client REST est simulé (voir eveningsApi.test.ts pour les routes).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { UserApiError } from '../src/data/userApi';

const api = vi.hoisted(() => ({ listEvenings: vi.fn(), getEvening: vi.fn(), respondToEvening: vi.fn(), openEvening: vi.fn() }));
vi.mock('../src/data/socialV3Api', async (orig) => ({ ...(await orig<typeof import('../src/data/socialV3Api')>()), ...api }));

let store: typeof import('../src/data/eveningsStore');
let home: typeof import('../src/data/eveningsHome');
let live: typeof import('../src/data/socialLive');
let card: any;
let pane: any;
let showEnsemble: (tab?: string) => void;
let homeSocial: typeof import('../src/data/homeSocial');

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true, createdAt: '2026-01-01T00:00:00Z' };
const KID = { ...ADULT, id: 'k1', name: 'Léo', isKid: true, kidMaxAge: 10 };
const setAccount = (p: any) => { auth.status = p ? 'ready' : 'local'; auth.profile = p; };
const tick = () => new Promise((r) => setTimeout(r, 20));
const detail = () => document.getElementById('detail')!;
const HOUR = 3_600_000;

const friend = (pid: string, name: string) => ({ pid, handle: { name, tag: 'A1B2', full: name + '#A1B2' }, avatarColor: '#a00' });
function ev(o: Record<string, unknown> = {}): any {
  return { id: 'e1', title: 'Dune 2', startsAt: Date.now() + 2 * HOUR, tz: 'Europe/Paris', host: friend('p2', 'Tom'), isHost: false, myResponse: 'pending',
    guests: [{ profile: friend('p1', 'Greg'), response: 'pending' }, { profile: friend('p3', 'Léa'), response: 'yes' }], status: 'scheduled', overridden: false, ...o };
}
const page = (items: any[], nextCursor: string | null = null) => ({ items, nextCursor });

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  store = await import('../src/data/eveningsStore');
  home = await import('../src/data/eveningsHome');
  live = await import('../src/data/socialLive');
  homeSocial = await import('../src/data/homeSocial');
  card = await import('../src/ui/eveningCard.js');
  pane = await import('../src/ui/eveningsPane.js');
  ({ showEnsemble } = await import('../src/ui/ensemble.js'));
});

beforeEach(() => {
  setAccount(ADULT);
  store.resetEvenings();
  Object.values(api).forEach((f) => f.mockReset());
  api.listEvenings.mockResolvedValue(page([]));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rooms: [], nextCursor: null, items: [] }), { status: 200 })));
});
afterEach(() => { setAccount(null); location.hash = ''; vi.unstubAllGlobals(); });

describe('trames evening', () => {
  it('reconnues par type avec leurs champs ; type inconnu, champs manquants ou forme étrangère : ignorés', () => {
    const e = { type: 'evening_response', eveningId: 'e1', pid: 'p2', response: 'yes' };
    expect(live.parseLiveEvent({ t: 'evening', event: e })).toEqual({ t: 'evening', event: e });
    const up = { type: 'evening_update', eveningId: 'e1', change: 'cancelled' };
    expect(live.parseLiveEvent(JSON.stringify({ t: 'evening', event: up }))).toEqual({ t: 'evening', event: up });
    expect(live.parseLiveEvent({ t: 'evening', event: { type: 'evening_open', eveningId: 'e1', party: { partyId: 'x', title: 'T' } } })).not.toBeNull();
    expect(live.parseLiveEvent({ t: 'evening', event: { type: 'evening_inconnu', eveningId: 'e1' } })).toBeNull();
    expect(live.parseLiveEvent({ t: 'evening', event: { type: 'evening_response', eveningId: 'e1', pid: 'p2', response: 'pending' } })).toBeNull();
    expect(live.parseLiveEvent({ t: 'evening', event: { type: 'evening_update', eveningId: '', change: 'updated' } })).toBeNull();
    expect(live.parseLiveEvent({ t: 'evening' })).toBeNull();
    expect(live.parseLiveEvent({ type: 'evening_update', eveningId: 'e1', change: 'updated' })).toBeNull();
  });
});

describe('magasin des soirées', () => {
  it('pagination : la page suivante s’ajoute avec son curseur, sans doublon', async () => {
    api.listEvenings.mockResolvedValueOnce(page([ev({ id: 'a' })], 'c2')).mockResolvedValueOnce(page([ev({ id: 'a' }), ev({ id: 'b' })], null));
    await store.loadEvenings('upcoming');
    expect(store.getEveningList('upcoming').nextCursor).toBe('c2');
    await store.loadEvenings('upcoming', { more: true });
    expect(api.listEvenings).toHaveBeenLastCalledWith('upcoming', { cursor: 'c2', limit: 20 });
    expect(store.getEveningList('upcoming').items.map((e) => e.id)).toEqual(['a', 'b']);
    expect(store.getEveningList('upcoming').nextCursor).toBeNull();
  });

  it('réponse périmée : un changement de profil pendant l’appel la rend sans effet', async () => {
    let done!: (p: any) => void;
    api.listEvenings.mockReturnValueOnce(new Promise((r) => { done = r; }));
    const p = store.loadEvenings('upcoming');
    store.resetEvenings();
    done(page([ev()]));
    await p;
    expect(store.getEveningList('upcoming').items).toEqual([]);
    expect(store.getEveningList('upcoming').loaded).toBe(false);
  });

  it('profil enfant ou hors compte : aucun appel', async () => {
    setAccount(KID);
    await store.loadEvenings('upcoming');
    setAccount(null);
    await store.loadEvenings('past');
    expect(api.listEvenings).not.toHaveBeenCalled();
  });

  it('trames : réponse -> soirée relue et remplacée ; annulation affichée ; 404 -> retirée ; type inconnu ignoré ; sans liste lue, rien', async () => {
    store.handleEveningEvent({ type: 'evening_update', eveningId: 'e1', change: 'updated' });
    expect(api.getEvening).not.toHaveBeenCalled();
    api.listEvenings.mockResolvedValue(page([ev()]));
    await store.loadEvenings('upcoming');
    api.getEvening.mockResolvedValueOnce(ev({ guests: [{ profile: friend('p3', 'Léa'), response: 'no' }] }));
    store.handleEveningEvent({ type: 'evening_response', eveningId: 'e1', pid: 'p3', response: 'no' });
    await tick();
    expect(store.getEveningList('upcoming').items[0].guests[0].response).toBe('no');
    api.getEvening.mockResolvedValueOnce(ev({ status: 'cancelled' }));
    store.handleEveningEvent({ type: 'evening_update', eveningId: 'e1', change: 'cancelled' });
    await tick();
    expect(store.getEveningList('upcoming').items[0].status).toBe('cancelled');
    store.handleEveningEvent({ type: 'evening_x', eveningId: 'e1' } as any);
    expect(api.getEvening).toHaveBeenCalledTimes(2);
    api.getEvening.mockRejectedValueOnce(new UserApiError(404, 'evening_not_found'));
    store.handleEveningEvent({ type: 'evening_update', eveningId: 'e1', change: 'updated' });
    await tick();
    expect(store.getEveningList('upcoming').items).toEqual([]);
  });

  it('invitation reçue : les listes lues sont relues', async () => {
    await store.loadEvenings('upcoming');
    api.listEvenings.mockResolvedValue(page([ev({ id: 'new' })]));
    store.handleEveningEvent({ type: 'evening_invite', eveningId: 'new', title: 'T', startsAt: 1, tz: 'UTC', host: friend('p2', 'Tom') });
    await tick();
    expect(store.getEveningList('upcoming').items.map((e) => e.id)).toEqual(['new']);
  });
});

describe('cartes', () => {
  it('titre, hôte, invités échappés ; heure locale ; récurrence ; invitation en avant ; réponse courante aria-pressed', () => {
    const now = new Date(2026, 9, 25, 12, 0).getTime();
    const start = new Date(2026, 9, 25, 21, 0).getTime();
    const html = card.eveningCardHTML(ev({ title: '<img src=x onerror=alert(1)>', startsAt: start, host: friend('p2', '<b>Tom</b>'), myResponse: 'maybe', recurrence: { freq: 'weekly', interval: 1 } }), { now });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Tom');
    expect(html).toContain('Ce soir');
    expect(html).toContain('21:00');
    expect(html).toContain('Chaque dimanche');
    expect(html).toContain('Léa : vient');
    expect(html).toMatch(/data-evening-act="e1:maybe" aria-pressed="true"/);
    expect(html).toMatch(/data-evening-act="e1:yes" aria-pressed="false"/);
    const invite = card.eveningCardHTML(ev({ startsAt: start }), { now });
    expect(invite).toContain('is-invite');
    expect(invite).toContain('Invitation');
  });

  it('annulée : pastille, aucun bouton ; hôte : pas de réponse ; fenêtre d’ouverture T-15 min à T+2 h ; salon présent : Rejoindre', () => {
    const now = Date.now();
    const cancelled = card.eveningCardHTML(ev({ status: 'cancelled' }), { now });
    expect(cancelled).toContain('Annulée');
    expect(cancelled).not.toContain('data-evening-act');
    const hostAt = (dt: number, extra = {}) => card.eveningCardHTML(ev({ isHost: true, myResponse: undefined, startsAt: now + dt, ...extra }), { now });
    expect(hostAt(20 * 60_000)).not.toContain(':open"');
    expect(hostAt(10 * 60_000)).toContain('data-evening-act="e1:open"');
    expect(hostAt(-HOUR)).toContain(':open"');
    expect(hostAt(-3 * HOUR)).not.toContain(':open"');
    expect(hostAt(-HOUR)).not.toContain(':yes"');
    const joined = hostAt(10 * 60_000, { party: { partyId: 'pty/1', title: 'Dune 2' } });
    expect(joined).toContain('href="#/party/pty%2F1"');
    expect(joined).not.toContain(':open"');
  });
});

describe('onglets de la page Ensemble', () => {
  const mount = async (tab: string) => { detail().innerHTML = ''; showEnsemble(tab); await tick(); };

  it('états vides honnêtes quand le serveur ne renvoie rien', async () => {
    for (const t of ['ce-soir', 'a-venir', 'passees']) {
      await mount(t);
      expect(detail().querySelector('.ens-empty')).not.toBeNull();
      expect(detail().querySelector('.ev-card')).toBeNull();
    }
  });

  it('« À venir » : invitation en avant puis la suite ; « Voir plus » demande la page suivante', async () => {
    const inv = ev({ id: 'inv', title: 'Cycle Villeneuve' });
    api.listEvenings.mockImplementation(async (scope: string, o: any = {}) =>
      scope === 'invites' ? page([inv]) : o.cursor ? page([ev({ id: 'z', title: 'Dernière', startsAt: Date.now() + 90 * 24 * HOUR })]) : page([ev({ id: 'y', title: 'Suivante', startsAt: Date.now() + 40 * 24 * HOUR })], 'c2'));
    await mount('a-venir');
    expect(detail().querySelector('#ev-h-inv')?.textContent).toBe('Invitations reçues');
    expect(detail().querySelector('[data-evening="inv"]')?.classList.contains('is-invite')).toBe(true);
    expect(detail().querySelector('[data-evening="y"]')).not.toBeNull();
    detail().querySelector<HTMLElement>('[data-evening-act="upcoming:more"]')!.click();
    await tick();
    expect(api.listEvenings).toHaveBeenCalledWith('upcoming', { cursor: 'c2', limit: 20 });
    expect(detail().querySelector('[data-evening="z"]')).not.toBeNull();
    expect(detail().querySelector('[data-evening-act="upcoming:more"]')).toBeNull();
  });

  it('« Ce soir » : Je viens appelle la réponse, relit la soirée et met en évidence le choix', async () => {
    const soon = Date.now() + 10 * 60_000;
    const e = ev({ startsAt: soon });
    api.listEvenings.mockImplementation(async (scope: string) => (scope === 'upcoming' ? page([e]) : page([])));
    api.respondToEvening.mockResolvedValue(undefined);
    api.getEvening.mockResolvedValue({ ...e, myResponse: 'yes' });
    await mount('ce-soir');
    const btn = () => detail().querySelector<HTMLElement>('[data-evening-act="e1:yes"]')!;
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    btn().click();
    await tick();
    expect(api.respondToEvening).toHaveBeenCalledWith('e1', 'yes');
    expect(btn().getAttribute('aria-pressed')).toBe('true');
  });

  it('échec d’une réponse : le toast s’affiche et la carte reste interactive', async () => {
    api.listEvenings.mockImplementation(async (scope: string) => (scope === 'upcoming' ? page([ev({ startsAt: Date.now() + 600_000 })]) : page([])));
    api.respondToEvening.mockRejectedValue(new UserApiError(409, 'evening_closed'));
    await mount('ce-soir');
    detail().querySelector<HTMLElement>('[data-evening-act="e1:no"]')!.click();
    await tick();
    expect(document.getElementById('toast')?.textContent).toContain('annulée ou a déjà commencé');
    expect(detail().querySelector('[data-evening-act="e1:no"]')!.getAttribute('aria-disabled')).toBeNull();
  });

  it('l’hôte ouvre le salon : openEvening puis page du salon ; réponse caduque après un nouveau montage', async () => {
    const e = ev({ isHost: true, myResponse: undefined, startsAt: Date.now() + 5 * 60_000 });
    api.listEvenings.mockImplementation(async (scope: string) => (scope === 'upcoming' ? page([e]) : page([])));
    api.openEvening.mockResolvedValue({ ...e, party: { partyId: 'pty9', title: 'Dune 2' } });
    await mount('ce-soir');
    detail().querySelector<HTMLElement>('[data-evening-act="e1:open"]')!.click();
    await tick();
    expect(api.openEvening).toHaveBeenCalledWith('e1');
    expect(location.hash).toBe('#/party/pty9');
    // ouverture en vol puis changement de page : la réponse tardive n’écrit plus rien
    location.hash = '';
    let done!: (v: any) => void;
    api.openEvening.mockReturnValueOnce(new Promise((r) => { done = r; }));
    store.putEvening(e);
    await mount('ce-soir');
    detail().querySelector<HTMLElement>('[data-evening-act="e1:open"]')?.click();
    await mount('a-venir');
    done({ ...e, party: { partyId: 'late', title: 'x' } });
    await tick();
    expect(location.hash).toBe('');
  });

  it('profil enfant : message, aucun appel de soirée', async () => {
    setAccount(KID);
    await mount('a-venir');
    expect(api.listEvenings).not.toHaveBeenCalled();
    expect(detail().querySelector('.ev-card')).toBeNull();
  });

  it('trame reçue : la carte affichée se met à jour sans rechargement de la page', async () => {
    const e = ev({ startsAt: Date.now() + 600_000 });
    api.listEvenings.mockImplementation(async (scope: string) => (scope === 'upcoming' ? page([e]) : page([])));
    await mount('ce-soir');
    expect(detail().textContent).not.toContain('Annulée');
    api.getEvening.mockResolvedValue({ ...e, status: 'cancelled' });
    store.handleEveningEvent({ type: 'evening_update', eveningId: 'e1', change: 'cancelled' });
    await tick();
    expect(detail().textContent).toContain('Annulée');
    expect(pane.EVENING_TABS).toEqual(['ce-soir', 'a-venir', 'passees']);
  });
});

describe('accueil', () => {
  it('soirées à venir -> source de l’accueil ; « Je viens » = réponse oui ; ni hôte ni déjà inscrit ne propose le bouton', async () => {
    const list = [ev({ id: 'a', host: friend('p2', 'Tom') }), ev({ id: 'b', isHost: true }), ev({ id: 'c', myResponse: 'yes' }), ev({ id: 'd', myResponse: 'no' }), ev({ id: 'x', status: 'cancelled' })];
    const mapped = home.toHomeEvenings(list);
    expect(mapped.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(mapped.map((m) => m.joinable)).toEqual([true, false, false]);
    expect(mapped[0]).toMatchObject({ host: 'Tom', title: 'Dune 2', going: ['p3'] });
    api.listEvenings.mockResolvedValue(page(list));
    api.respondToEvening.mockResolvedValue(undefined);
    api.getEvening.mockResolvedValue(list[0]);
    homeSocial.setEveningJoin(null);
    expect(homeSocial.hasEveningJoin()).toBe(false);
    home.connectHomeEvenings();
    expect(homeSocial.hasEveningJoin()).toBe(true);
    expect(homeSocial.upcomingEvenings()).toEqual([]);
    await home.loadHomeEvenings();
    expect(homeSocial.upcomingEvenings().map((m) => m.id)).toEqual(['a', 'b', 'c']);
    await expect(homeSocial.joinEvening('a')).resolves.toBe(true);
    expect(api.respondToEvening).toHaveBeenCalledWith('a', 'yes');
    api.respondToEvening.mockRejectedValue(new Error('x'));
    await expect(homeSocial.joinEvening('a')).resolves.toBe(false);
    store.resetEvenings();
    expect(homeSocial.upcomingEvenings()).toEqual([]);
  });
});
