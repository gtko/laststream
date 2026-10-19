// Panneau de l’hôte (watch party) : participants à l’initiale colorée avec pastille d’état, ligne de débit compacte,
// bandeau de compatibilité discret, retour « Copié » sur le lien d’invitation, zones réservées aux lots suivants.
// Le lien d’invitation n’est jamais journalisé.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import type { GuestVerdict } from '../src/party/compat';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const panelOf = () => document.querySelector('aside.lp-party') as HTMLElement;
const rowOf = (name: string) => [...panelOf().querySelectorAll<HTMLElement>('.wp-user')].find((li) => li.querySelector('.wp-name')?.textContent === name)!;

type Participant = { username: string; host?: boolean; guest?: boolean; muted?: boolean; avatarColor?: string; state?: string };

/** Client de salon minimal : les propriétés lues par le panneau et le pont. */
const fakeClient = (isHost: boolean, participants: Participant[]) => ({
  status: 'open',
  room: { id: 'r1', visibility: 'private', title: 'Severance' } as { id: string; visibility: string; title: string } | null,
  you: { username: isHost ? 'alice' : 'bob', host: isHost, muted: false } as { username: string; host: boolean; muted: boolean } | null,
  participants,
  chat: [],
  get isHost(): boolean { return !!this.you?.host; },
  on() { return () => undefined; },
});

const hostParticipants = (): Participant[] => [
  { username: 'alice', host: true, avatarColor: '#ff5a36' },
  { username: 'bob', avatarColor: '#ffffff' },
  { username: 'carl', guest: true, avatarColor: '#1e3a8a' },
  { username: 'dana', guest: true },
];

let panel: typeof import('../src/ui/partypanel.js');
let partyBridge: typeof import('../src/party/bridge')['partyBridge'];
let clip: { writeText: ReturnType<typeof vi.fn> };
const TOKEN = 'tok-abcdefgh12';

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  panel = await import('../src/ui/partypanel.js');
  ({ partyBridge } = await import('../src/party/bridge'));
  const root = document.createElement('div');
  document.body.appendChild(root);
  panel.mountPartyPanel(root, { adapter: () => null });
});

beforeEach(() => {
  clip = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clip });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: TOKEN, expiresAt: '2026-01-01T00:00:00Z' }), { status: 200 })));
  partyBridge.client = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('participants : avatar et pastille d’état', () => {
  it('chaque participant a une initiale colorée ; une couleur claire donne une initiale sombre', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    expect(rowOf('bob').querySelector('.wp-av-ini')!.textContent).toBe('B');
    expect(rowOf('bob').querySelector('.wp-av')!.classList.contains('is-light')).toBe(true); // #ffffff
    expect(rowOf('carl').querySelector('.wp-av')!.classList.contains('is-light')).toBe(false); // #1e3a8a
    expect(rowOf('carl').querySelector('.wp-av')!.getAttribute('style')).toContain('#1e3a8a');
  });

  it('pastille « Prêt » par défaut ; « Sans son » et « Illisible » selon le verdict de l’invité', () => {
    vi.spyOn(partyBridge, 'guestVerdicts').mockReturnValue(new Map<string, GuestVerdict>([['carl', 'no-audio'], ['dana', 'unplayable']]));
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    expect(rowOf('bob').querySelector('.wp-state')!.classList.contains('is-ready')).toBe(true);
    expect(rowOf('bob').querySelector('.wp-state')!.getAttribute('aria-label')).toBe('Prêt');
    expect(rowOf('carl').querySelector('.wp-state')!.getAttribute('title')).toBe('Sans son');
    expect(rowOf('carl').querySelector('.wp-state')!.classList.contains('is-no-audio')).toBe(true);
    expect(rowOf('dana').querySelector('.wp-state')!.classList.contains('is-unplayable')).toBe(true);
  });

  it('un état « tampon » fourni par le salon prime sur le reste', () => {
    partyBridge.client = fakeClient(true, [{ username: 'bob', state: 'buffering' }]) as any;
    panel.togglePartyPanel(true);
    expect(rowOf('bob').querySelector('.wp-state')!.classList.contains('is-buffering')).toBe(true);
    expect(rowOf('bob').querySelector('.wp-state')!.getAttribute('aria-label')).toBe('Tampon');
  });
});

describe('ligne de débit : compacte et secondaire', () => {
  it('« ↑ 2,4 Mo/s · 3 invités » en une ligne', () => {
    vi.spyOn(partyBridge, 'relayStats').mockReturnValue({ rateBps: 2516582, links: 3 } as any);
    partyBridge.client = fakeClient(true, [
      { username: 'alice', host: true }, { username: 'carl', guest: true }, { username: 'dana', guest: true }, { username: 'erin', guest: true },
    ]) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-relay]')!.textContent).toBe('↑ 2,4 Mo/s · 3 invités');
    expect(panelOf().querySelector('[data-wp-guests]')!.textContent).toBe('3');
  });

  it('sans partage actif : « Partage inactif · 1 invité »', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-relay]')!.textContent).toBe('Partage inactif · 2 invités');
  });

  it('navigateur qui bloque le partage : avertissement court, le détail reste dans l’infobulle', () => {
    vi.spyOn(partyBridge, 'relayRefused').mockReturnValue(true);
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    const warn = panelOf().querySelector('.wp-rate-warn') as HTMLElement;
    expect(warn.textContent).toBe('Partage bloqué');
    expect(warn.title).toContain('les invités ne reçoivent pas la vidéo');
  });
});

describe('bandeau de compatibilité', () => {
  it('un avertissement s’affiche dans un bandeau discret avec sa bascule', () => {
    vi.spyOn(partyBridge, 'guestWarning').mockReturnValue('1 invité ne peut pas lire cette vidéo (HEVC)');
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    const banner = panelOf().querySelector('.wp-banner') as HTMLElement;
    expect(banner.textContent).toContain('1 invité ne peut pas lire cette vidéo (HEVC)');
    expect(banner.querySelector('[data-wp-compat]')).not.toBeNull();
  });

  it('sans avertissement, pas de bandeau', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('.wp-banner')).toBeNull();
  });
});

describe('lien d’invitation : retour « Copié »', () => {
  it('après la copie, le bouton affiche « Copié » ; le lien n’est écrit dans aucun journal', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m as 'log'));
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    const button = panelOf().querySelector('[data-wp-invite]') as HTMLElement;
    expect(button.textContent).toBe('Copier le lien d’invitation');
    button.click();
    await tick();
    const after = panelOf().querySelector('[data-wp-invite]') as HTMLElement;
    expect(after.textContent).toBe('Copié');
    expect(after.classList.contains('is-done')).toBe(true);
    expect((panelOf().querySelector('[data-wp-invite-link]') as HTMLInputElement).value).toContain('#/party/join/r1?t=' + TOKEN);
    expect(clip.writeText).toHaveBeenCalledTimes(1);
    for (const spy of logs) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });
});

describe('zones réservées aux lots suivants', () => {
  it('.wp-wait est présent, vide et masqué ; la zone de chat existe', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    const wait = panelOf().querySelector('.wp-wait') as HTMLElement;
    expect(wait).not.toBeNull();
    expect(wait.hidden).toBe(true);
    expect(wait.textContent).toBe('');
    expect(panelOf().querySelector('.wp-chat')).not.toBeNull();
  });
});
