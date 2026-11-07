// Panneau de création du salon (watch party) : amis proposés puis invités à la création ; rien pour un profil enfant.
// Fichier à part de partyPanelUi.test.ts : il mocke le store social et l’API d’invitation, et monte le panneau avec un
// adaptateur de lecteur réglable (le montage de partyPanelUi.test.ts fige un adaptateur nul).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

const panelOf = () => document.querySelector('aside.lp-party') as HTMLElement;

const social = vi.hoisted(() => ({ friends: [] as unknown[] }));
const api = vi.hoisted(() => ({ inviteFriendToParty: vi.fn() }));

vi.mock('../src/data/socialStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/socialStore')>();
  return { ...real, getState: () => ({ ...real.getState(), friends: social.friends, household: [] }) };
});
vi.mock('../src/data/socialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialApi')>()),
  inviteFriendToParty: api.inviteFriendToParty,
}));

let panel: typeof import('../src/ui/partypanel.js');
let partyBridge: typeof import('../src/party/bridge')['partyBridge'];
let auth: typeof import('../src/data/auth')['auth'];
let isKidProfile: typeof import('../src/data/auth')['isKidProfile'];

/** Lecteur prêt : le bouton « Créer le salon » est actif. */
const READY_ADAPTER = { ready: true, req: { type: 'movie', id: '693134', name: 'Dune', season: null, episode: null, key: 'movie:693134' }, poster: null };
let adapter: object | null = null;

const PARENT = { id: 'p1', name: 'Greg', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isMainProfile: true };
const ENFANT = { id: 'k1', name: 'Léo', isKid: true, kidMaxAge: 10, hasPin: false, allowedCatalogs: [], isMainProfile: false };
const AMI = { pid: 'pid-ami', handle: { name: 'Léa', tag: '1234', full: 'Léa#1234' }, avatarColor: '#7b5bf5', status: 'online' };

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  panel = await import('../src/ui/partypanel.js');
  ({ partyBridge } = await import('../src/party/bridge'));
  ({ auth, isKidProfile } = await import('../src/data/auth'));
  const root = document.createElement('div');
  document.body.appendChild(root);
  panel.mountPartyPanel(root, { adapter: () => adapter });
});

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
  partyBridge.client = null;
  auth.status = 'ready';
  auth.profile = PARENT as never;
  social.friends = [AMI];
  adapter = READY_ADAPTER;
  api.inviteFriendToParty.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  auth.status = 'local';
  auth.profile = null;
});

describe('création du salon : invitation d’amis', () => {
  it('en mode serveur, l’ami est proposé à la création ; coché, il est invité dans le salon créé', async () => {
    const create = vi.spyOn(partyBridge, 'create').mockResolvedValue({ id: 'r1' } as never);
    vi.spyOn(partyBridge, 'waitForHost').mockResolvedValue(true);
    vi.spyOn(partyBridge, 'createInvite').mockResolvedValue({ roomId: 'r1', token: 'tok-abcdefgh12', expiresAt: '2026-01-01T00:00:00Z' });
    panel.togglePartyPanel(true);
    const cards = panelOf().querySelectorAll<HTMLInputElement>('input[name="friend"]');
    expect(cards).toHaveLength(1);
    expect(cards[0].value).toBe('pid-ami');
    cards[0].checked = true;
    (panelOf().querySelector('[data-wp-create]') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(api.inviteFriendToParty).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(READY_ADAPTER, 'private');
    expect(api.inviteFriendToParty).toHaveBeenCalledWith('r1', 'pid-ami', 'p1');
  });

  it('profil enfant : aucune carte d’ami à la création, même avec un ami dans le store', () => {
    auth.profile = ENFANT as never;
    expect(isKidProfile()).toBe(true);
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-create]')).not.toBeNull();
    expect(panelOf().querySelector('input[name="friend"]')).toBeNull();
  });
});
