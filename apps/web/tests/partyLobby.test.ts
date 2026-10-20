// Salon d'attente (F6) : rendu des participants (avatar, état prêt, recherche de source), boutons de l'hôte (« Démarrer sans »,
// « Lancer dans 5 s »), réglages, vote, échappement du texte utilisateur, compte à rebours, bandeau et événements en lecture.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const lobby = () => document.querySelector('.pl') as HTMLElement | null;

type Handler = (payload: any) => void;
function fakeClient(isHost: boolean, over: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const c: any = {
    status: 'open',
    room: { id: 'r1', visibility: 'private', title: 'Dune : Deuxième partie', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 693134 }, fingerprint: null, host: 'Greg', maxParticipants: 20 },
    you: { username: isHost ? 'Greg' : 'Léa', host: isHost, muted: false },
    participants: [
      { username: 'Greg', host: true, avatarColor: '#ff5a36', ready: true, quality: '4K HDR', status: 'ready' },
      { username: 'Léa', avatarColor: '#7b5cff', ready: true, quality: '1080p', status: 'ready' },
      { username: 'Hugo', avatarColor: '#e0912f', ready: false, quality: null, status: 'searching' },
      { username: 'Julie', guest: true, avatarColor: '#3a3647' },
    ],
    chat: [],
    state: { playing: false, pos: 0, at: 0, rev: 1 },
    settings: { control: 'all', waitLate: '10s', reactions: 'float' },
    countdownAt: null,
    vote: null,
    get isHost() { return !!this.you.host; },
    serverNow: () => Date.now(),
    on(event: string, fn: Handler) { const l = handlers.get(event) ?? []; l.push(fn); handlers.set(event, l); return () => { l.splice(l.indexOf(fn), 1); }; },
    emit(event: string, payload?: unknown) { (handlers.get(event) ?? []).slice().forEach((fn) => fn(payload)); },
    sendReady: vi.fn(() => true), sendStatus: vi.fn(() => true), sendSettings: vi.fn(() => true), startPlayback: vi.fn(() => true),
    sendChat: vi.fn(() => true), sendReact: vi.fn(() => true), castVote: vi.fn(() => true), openVote: vi.fn(() => true), closeVote: vi.fn(() => true),
    kick: vi.fn(), transfer: vi.fn(),
    ...over,
  };
  return c;
}

let mod: typeof import('../src/ui/partylobby.js');
let panel: typeof import('../src/ui/partypanel.js');
let partyBridge: typeof import('../src/party/bridge')['partyBridge'];
let auth: typeof import('../src/data/auth')['auth'];

beforeAll(async () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  ({ auth } = await import('../src/data/auth'));
  ({ partyBridge } = await import('../src/party/bridge'));
  panel = await import('../src/ui/partypanel.js');
  mod = await import('../src/ui/partylobby.js');
});

beforeEach(() => {
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg', isKid: false } as never;
  // Recherche de sources : le réseau échoue, la préparation retombe sur « aucune source » sans bruit.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
});

afterEach(() => {
  document.querySelectorAll('.pl').forEach((el) => el.remove());
  partyBridge.client = null;
  auth.status = 'local';
  auth.profile = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(c: any) {
  partyBridge.client = c;
  await mod.openLobby('r1');
  await tick();
}

describe('salon d’attente : participants et états', () => {
  it('carte par participant : avatar, état prêt avec qualité, recherche, invité « via le lien », tuile Inviter', async () => {
    await open(fakeClient(true));
    const cards = [...lobby()!.querySelectorAll('.pl-card:not(.is-invite)')] as HTMLElement[];
    expect(cards).toHaveLength(4);
    expect(cards[0].textContent).toContain('Greg');
    expect(cards[0].textContent).toContain('hôte');
    expect(cards[0].querySelector('.pl-state')!.textContent).toBe('Prêt · 4K HDR');
    expect(cards[2].querySelector('.pl-state')!.classList.contains('is-searching')).toBe(true);
    expect(cards[2].textContent).toContain('Cherche une source…');
    expect(cards[3].textContent).toContain('invité');
    expect(cards[3].querySelector('.pl-state')!.textContent).toBe('Prêt · via le lien');
    expect(cards[3].querySelector('.pl-av-ini')!.textContent).toBe('JU');
    expect(lobby()!.querySelector('.pl-card.is-invite')).not.toBeNull();
    expect(lobby()!.querySelector('.pl-ready')!.textContent).toBe('3 prêts sur 4');
    expect(lobby()!.querySelector('.pl-lb.pl-grow')!.textContent).toBe('Participants · 4 / 20');
  });

  it('pseudo, titre et message échappés (aucun balisage venu d’un participant)', async () => {
    const evil = '<img src=x onerror="alert(1)">';
    const c = fakeClient(true);
    c.participants[1].username = evil;
    c.room.title = evil;
    c.chat = [{ id: 'm1', from: evil, text: evil, at: 1 }];
    await open(c);
    expect(lobby()!.querySelector('img')).toBeNull();
    expect(lobby()!.textContent).toContain(evil);
  });
});

describe('salon d’attente : départ', () => {
  it('hôte avec un retardataire : « Démarrer sans Hugo » actif, « Lancer » désactivé ; clic = départ en 1 s', async () => {
    const c = fakeClient(true);
    await open(c);
    const start = lobby()!.querySelector('[data-pl-start]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.textContent).toContain('Lancer dans 5 s');
    const now = lobby()!.querySelector('[data-pl-start-now]') as HTMLButtonElement;
    expect(now.textContent).toBe('Démarrer sans Hugo');
    now.click();
    expect(c.startPlayback).toHaveBeenCalledWith(1);
  });

  it('tout le monde prêt : « Lancer dans 5 s » actif, pas de bouton « Démarrer sans »', async () => {
    const c = fakeClient(true);
    c.participants[2] = { username: 'Hugo', ready: true, quality: '720p', status: 'ready' };
    await open(c);
    expect(lobby()!.querySelector('[data-pl-start-now]')).toBeNull();
    (lobby()!.querySelector('[data-pl-start]') as HTMLButtonElement).click();
    expect(c.startPlayback).toHaveBeenCalledWith(5);
    expect(lobby()!.querySelector('.pl-ready')!.textContent).toBe('Tout le monde est prêt');
  });

  it('invité (non hôte) : pas de bouton de départ, réglages en lecture seule', async () => {
    await open(fakeClient(false));
    expect(lobby()!.querySelector('[data-pl-start]')).toBeNull();
    expect((lobby()!.querySelector('[data-pl-set]') as HTMLButtonElement).disabled).toBe(true);
    expect(lobby()!.querySelector('.pl-wait')!.textContent).toContain('En attente du départ par Greg');
  });

  it('compte à rebours reçu : grand décompte affiché, bouton « Départ dans N s »', async () => {
    const c = fakeClient(true);
    c.participants[2] = { username: 'Hugo', ready: true, quality: null, status: 'ready' };
    await open(c);
    c.countdownAt = Date.now() + 4200;
    c.emit('countdown', c.countdownAt);
    await tick(60);
    expect(lobby()!.querySelector('.pl-count-n')!.textContent).toBe('5');
    expect((lobby()!.querySelector('[data-pl-start]') as HTMLButtonElement).textContent).toContain('Départ dans 5 s');
  });

  it('départ effectif : le salon se ferme et la lecture est lancée avec la source du participant', async () => {
    const launch = vi.spyOn(partyBridge, 'launchRoom').mockResolvedValue(undefined);
    const c = fakeClient(false);
    await open(c);
    c.state = { playing: true, pos: 0, at: 1, rev: 2 };
    c.emit('state', c.state);
    await tick();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(lobby()).toBeNull();
  });
});

describe('salon d’attente : réglages, vote, discussion', () => {
  it('l’hôte règle le salon (radio) ; le choix courant est coché', async () => {
    const c = fakeClient(true);
    await open(c);
    const checked = [...lobby()!.querySelectorAll('[role="radio"][aria-checked="true"]')].map((b) => (b as HTMLElement).dataset.value);
    expect(checked).toEqual(['all', '10s', 'float']);
    (lobby()!.querySelector('[data-pl-set="reactions"][data-value="off"]') as HTMLButtonElement).click();
    expect(c.sendSettings).toHaveBeenCalledWith({ reactions: 'off' });
  });

  it('vote ouvert : options avec voix et part ; voter envoie l’option ; l’hôte peut clore', async () => {
    const c = fakeClient(true);
    c.vote = [{ id: 'o0', type: 'movie', tmdbId: 1, title: 'Dune : Deuxième partie', votes: 3 }, { id: 'o1', type: 'movie', tmdbId: 2, title: 'Blade Runner 2049', votes: 1 }];
    await open(c);
    const opts = lobby()!.querySelectorAll('.pl-vote-o');
    expect(opts).toHaveLength(2);
    expect((opts[0].querySelector('.pl-vote-bar') as HTMLElement).style.width).toBe('75%');
    (opts[1] as HTMLButtonElement).click();
    expect(c.castVote).toHaveBeenCalledWith('o1');
    (lobby()!.querySelector('[data-pl-vote-close]') as HTMLButtonElement).click();
    expect(c.closeVote).toHaveBeenCalled();
  });

  it('discussion : l’envoi part sans position (aucune lecture), un message reçu s’affiche', async () => {
    const c = fakeClient(false);
    await open(c);
    const form = lobby()!.querySelector('[data-pl-send]') as HTMLFormElement;
    (form.elements.namedItem('text') as HTMLInputElement).value = 'salut';
    form.requestSubmit();
    expect(c.sendChat).toHaveBeenCalledWith('salut', null);
    c.chat = [{ id: 'm2', from: 'Hugo', text: 'ça charge', at: 2 }];
    c.emit('chat', c.chat[0]);
    await tick(60);
    expect(lobby()!.querySelector('.pl-feed')!.textContent).toContain('ça charge');
  });

  it('profil enfant : le salon d’attente ne s’ouvre pas', async () => {
    auth.profile = { id: 'k', name: 'Kid', isKid: true, kidMaxAge: 8 } as never;
    await open(fakeClient(true));
    expect(lobby()).toBeNull();
  });
});

describe('lecture : bandeau des participants et événements', () => {
  let shared: HTMLElement | null = null;
  const mount = () => {
    if (shared) return shared;
    shared = document.createElement('div');
    document.body.appendChild(shared);
    panel.mountPartyPanel(shared, { adapter: () => null });
    return shared;
  };

  it('bandeau « N en salle · Synchronisés », micro désactivé « bientôt », bouton masquer la discussion', async () => {
    const root = mount();
    const c = fakeClient(true);
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    await tick();
    const band = root.querySelector('.ps-band') as HTMLElement;
    expect(band.hidden).toBe(false);
    expect(band.querySelector('.ps-n')!.textContent).toBe('4 en salle');
    expect(band.querySelector('[data-ps-sync]')!.textContent).toBe('Synchronisés');
    const mic = band.querySelector('button[disabled]') as HTMLButtonElement;
    expect(mic.getAttribute('aria-label')).toContain('bientôt');
    (band.querySelector('[data-ps-chat]') as HTMLButtonElement).click();
    expect(panel.isPartyPanelOpen()).toBe(false);
  });

  it('événement « Hugo a reculé de 10 s » en bandeau, et chat horodaté en temps du film', async () => {
    const root = mount();
    const c = fakeClient(true);
    c.chat = [{ id: 'm1', from: 'Léa', text: 'regarde le ciel', at: 1, pos: 4354 }];
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    await tick();
    c.emit('event', { kind: 'seek', by: 'Hugo', pos: 100, delta: -10 });
    await tick(60);
    const ev = root.querySelector('.ps-event') as HTMLElement;
    expect(ev.hidden).toBe(false);
    expect(ev.textContent).toContain('Hugo a reculé de 10 s · pour tout le monde');
    expect(root.querySelector('.wp-time.is-film')!.textContent).toBe('1:12:34');
    expect(root.querySelector('.wp-sys')!.textContent).toBe('Hugo a reculé de 10 s');
  });

  it('réaction signée : avatar de l’auteur + emoji ; rien si les réactions sont coupées', async () => {
    const root = mount();
    const c = fakeClient(true);
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    await tick();
    c.emit('react', { user: 'Léa', by: 'Léa', emoji: '🔥', at: 1, pos: 10 });
    const fl = root.querySelector('.lp-party-floats .ps-float') as HTMLElement;
    expect(fl.querySelector('.ps-float-e')!.textContent).toBe('🔥');
    expect(fl.querySelector('.wp-av-ini')!.textContent).toBe('L');
    c.settings.reactions = 'off';
    root.querySelector('.lp-party-floats')!.innerHTML = '';
    c.emit('react', { user: 'Léa', by: 'Léa', emoji: '😂', at: 2, pos: null });
    expect(root.querySelectorAll('.lp-party-floats .ps-float')).toHaveLength(0);
  });
});
