// Lien d’invitation : un seul bouton côté hôte (lien #/party/join/<id>?t=<jeton>), lien de salon pour les participants non hôtes,
// page d’un salon sans compte (message et connexion), et route d’invitation accessible à un compte connecté.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { parseJoinHash } from '../src/party/join';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const detail = () => document.getElementById('detail')!;
const panelOf = () => document.querySelector('aside.lp-party') as HTMLElement;

/** Client de salon minimal : seules les propriétés lues par le panneau et le pont sont présentes. */
const fakeClient = (isHost: boolean) => ({
  status: 'open',
  room: { id: 'r1', visibility: 'private', title: 'Severance' },
  isHost,
  you: { username: isHost ? 'alice' : 'bob', host: isHost, muted: false },
  participants: [{ username: 'alice', host: true }, { username: 'bob' }, { username: 'carl', guest: true }],
  chat: [],
  on: () => undefined,
});

let panel: typeof import('../src/ui/partypanel.js');
let partyBridge: typeof import('../src/party/bridge')['partyBridge'];
let clip: { writeText: ReturnType<typeof vi.fn> };
let calls: { method: string; path: string }[] = [];

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  // Les modules lisent #detail au chargement : le DOM est prêt avant les imports.
  panel = await import('../src/ui/partypanel.js');
  ({ partyBridge } = await import('../src/party/bridge'));
  const root = document.createElement('div');
  document.body.appendChild(root);
  panel.mountPartyPanel(root, { adapter: () => null });
});

beforeEach(() => {
  clip = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clip });
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ method: init?.method ?? 'GET', path: u.pathname });
    return new Response(JSON.stringify({ token: 'tok-abcdefgh12', expiresAt: '2026-01-01T00:00:00Z' }), { status: 200 });
  }));
  partyBridge.client = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panneau de la watch party : lien d’invitation', () => {
  it('l’hôte a un seul bouton « Copier le lien d’invitation », sans lien de salon, et garde le compteur d’invités', () => {
    partyBridge.client = fakeClient(true) as any;
    panel.togglePartyPanel(true);
    const labels = [...panelOf().querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
    expect(labels.filter((t) => t.startsWith('Copier le lien'))).toEqual(['Copier le lien d’invitation']);
    expect(panelOf().querySelector('[data-wp-copy]')).toBeNull();
    expect(panelOf().textContent).not.toContain('Inviter (lien)');
    expect(panelOf().querySelector('[data-wp-guests]')!.textContent).toBe('1');
  });

  it('l’hôte : le clic crée un jeton et copie le lien #/party/join/<id>?t=<jeton>, affiché dans le champ', async () => {
    partyBridge.client = fakeClient(true) as any;
    panel.togglePartyPanel(true);
    (panelOf().querySelector('[data-wp-invite]') as HTMLElement).click();
    await tick();
    expect(calls).toEqual([{ method: 'POST', path: '/party/r1/invite' }]);
    const copied = clip.writeText.mock.calls[0][0] as string;
    expect(copied).toMatch(/#\/party\/join\/r1\?t=tok-abcdefgh12$/);
    // Le lien copié est bien un lien invité que la route relit.
    expect(parseJoinHash(copied.slice(copied.indexOf('#')))).toEqual({ roomId: 'r1', token: 'tok-abcdefgh12' });
    expect((panelOf().querySelector('[data-wp-invite-link]') as HTMLInputElement).value).toBe(copied);
  });

  it('participant non hôte : « Copier le lien » copie le lien du salon, sans créer d’invitation', async () => {
    partyBridge.client = fakeClient(false) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-invite]')).toBeNull();
    (panelOf().querySelector('[data-wp-copy]') as HTMLElement).click();
    await tick();
    expect(calls).toHaveLength(0);
    const copied = clip.writeText.mock.calls[0][0] as string;
    expect(copied).toMatch(/\/#\/party\/r1$/);
    expect(copied).not.toContain('/party/join/');
  });
});

describe('page d’un salon sans compte', () => {
  it('affiche le message « réservé aux comptes » et un bouton de connexion, sans l’ancien texte', async () => {
    const { auth } = await import('../src/data/auth');
    const p = await import('../src/ui/parties.js');
    const before = auth.status;
    auth.status = 'local';
    try {
      detail().innerHTML = '';
      await p.showParty('r1');
      expect(detail().textContent).toContain('Ce lien est réservé aux comptes Laststream. Demande à l’hôte un lien d’invitation.');
      expect(detail().textContent).not.toContain('Connecte-toi');
      expect(detail().querySelector('[data-wp-login]')).not.toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      auth.status = before;
    }
  });

  it('le bouton « Se connecter » ouvre l’écran de connexion', async () => {
    const { auth } = await import('../src/data/auth');
    const p = await import('../src/ui/parties.js');
    const before = auth.status;
    auth.status = 'local';
    try {
      detail().innerHTML = '';
      await p.showParty('r1');
      (detail().querySelector('[data-wp-login]') as HTMLElement).click();
      const authRoot = document.getElementById('auth')!;
      expect(authRoot.hidden).toBe(false);
      expect(authRoot.querySelector('input[name="username"]')).not.toBeNull();
      authRoot.hidden = true;
    } finally {
      auth.status = before;
    }
  });
});

describe('invitation ouverte par un compte connecté', () => {
  it.each(['ready', 'local'] as const)('la route d’invitation mène au formulaire invité (statut %s), sans écran de connexion', async (status) => {
    const { auth } = await import('../src/data/auth');
    const { parseRoute } = await import('../src/ui/router.js');
    const { showPartyJoin } = await import('../src/ui/partyjoin.js');
    const before = { status: auth.status, profile: auth.profile };
    auth.status = status;
    auth.profile = status === 'ready' ? ({ id: 'p1', name: 'Greg', isKid: false } as any) : null;
    try {
      location.hash = '#/party/join/r1?t=abcdefgh12';
      const r = parseRoute();
      expect(r).toEqual({ kind: 'partyjoin', id: 'r1', token: 'abcdefgh12' });
      showPartyJoin(r!.kind === 'partyjoin' ? r!.id : '', r!.kind === 'partyjoin' ? r!.token : '');
      const form = detail().querySelector('[data-pj-form]') as HTMLFormElement;
      expect(form.hidden).toBe(false);
      expect(form.querySelector('input[name="name"]')).not.toBeNull();
      expect(form.querySelector('[data-pj-join]')).not.toBeNull();
    } finally {
      auth.status = before.status;
      auth.profile = before.profile;
      location.hash = '';
    }
  });
});
