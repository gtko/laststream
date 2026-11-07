// Accueil mobile social (LAST-195) : rangée d'avatars en haut, carte « regarde en ce moment », absence sans données / enfant.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';

const h = vi.hoisted(() => ({ st: { friends: [] as any[], activity: [], listDetails: {}, badge: 0 } as any }));
vi.mock('../src/data/socialStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getState: () => h.st,
  subscribe: () => () => undefined,
}));
const sidebar = vi.hoisted(() => ({ openSidebar: vi.fn(), openFriendCard: vi.fn() }));
vi.mock('../src/ui/socialSidebar.js', () => sidebar);
const api = vi.hoisted(() => ({ listParties: vi.fn(), homeWatching: vi.fn(), homeRecommendations: vi.fn() }));
vi.mock('../src/data/socialApi', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), listParties: api.listParties }));
vi.mock('../src/data/socialV3Api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), homeWatching: api.homeWatching, homeRecommendations: api.homeRecommendations,
}));

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null as number | null, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' };
function setAccount(p: typeof ADULT | null): void {
  auth.status = p ? 'ready' : 'local';
  auth.profile = p as unknown as typeof auth.profile;
}
const LEA = { pid: 'f1', handle: { name: 'Léa', full: 'Léa#1' }, avatarColor: '#ff5a36', muted: false, status: 'online', watching: { title: 'Severance' } };
const TOM = { pid: 'f2', handle: { name: 'Tom', full: 'Tom#1' }, avatarColor: '#2d5d73', muted: false, status: 'offline' };
const room = { id: 'r1', title: 'Severance', poster: null, language: 'fr', mediaType: 'series', host: 'Léa', participants: 2, maxParticipants: 6, createdAt: '2026-10-27T10:00:00Z' };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function mountHome(): Promise<void> {
  const { stripSlotHTML, mountRail } = await import('../src/ui/friendRailSlot.js');
  const { homeSocialMobileSlotHTML, mountHomeSocial } = await import('../src/ui/homeSocialSlot.js');
  document.body.innerHTML = '<main>' + stripSlotHTML() + homeSocialMobileSlotHTML() + '<aside id="friend-rail"></aside></main>';
  mountRail();
  mountHomeSocial();
  await flush();
  if (h.st.friends.length && auth.profile && !auth.profile.isKid) { // modules chargés à la demande : attendre leur premier dessin
    await vi.waitFor(() => expect(document.getElementById('friend-strip')!.innerHTML).not.toBe(''));
    await vi.waitFor(() => expect(api.listParties).toHaveBeenCalled());
    await flush();
  }
}

beforeAll(async () => { // dom.js lit des éléments de la page au chargement : modules chargés avant de vider la page
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await import('../src/ui/homeSocialRows.js');
});

beforeEach(() => {
  setAccount(ADULT);
  h.st.friends = [LEA, TOM];
  api.listParties.mockReset().mockResolvedValue({ rooms: [room], nextCursor: null });
  api.homeWatching.mockReset().mockResolvedValue({ items: [] });
  api.homeRecommendations.mockReset().mockResolvedValue({ items: [] });
  sidebar.openFriendCard.mockReset();
});
afterEach(() => { setAccount(null); document.body.innerHTML = ''; });

describe('accueil mobile social', () => {
  it('rangée d\'avatars des amis et carte du salon avec Rejoindre', async () => {
    await mountHome();
    const strip = document.getElementById('friend-strip')!;
    expect(strip.querySelectorAll('button[data-fr-pid]')).toHaveLength(2);
    expect(strip.querySelector('[data-fr-add]')).not.toBeNull();
    const live = document.querySelector('#social-mobile .hsr-mlive')!;
    expect(live.textContent).toContain('Léa regarde en ce moment');
    expect(live.querySelector<HTMLAnchorElement>('a[href="#/party/r1"]')?.textContent).toBe('Rejoindre le salon');
  });

  it('un tap sur un avatar ouvre la fiche de l\'ami', async () => {
    await mountHome();
    document.querySelector<HTMLElement>('#friend-strip [data-fr-pid="f2"]')!.click();
    await flush();
    expect(sidebar.openFriendCard).toHaveBeenCalledWith('f2');
  });

  it('sans salon d\'ami : pas de carte ; sans ami : rangée vide', async () => {
    api.listParties.mockResolvedValue({ rooms: [], nextCursor: null });
    h.st.friends = [];
    await mountHome();
    expect(document.getElementById('social-mobile')!.innerHTML).toBe('');
    expect(document.querySelectorAll('#friend-strip [data-fr-pid]')).toHaveLength(0);
  });

  it('profil enfant ou hors compte : aucun emplacement, aucune requête', async () => {
    setAccount({ ...ADULT, isKid: true, kidMaxAge: 10 } as typeof ADULT);
    await mountHome();
    expect(document.getElementById('friend-strip')).toBeNull();
    expect(document.getElementById('social-mobile')).toBeNull();
    expect(api.listParties).not.toHaveBeenCalled();
  });
});
