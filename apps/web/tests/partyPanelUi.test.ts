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

describe('réactions de salon : une par seconde (LAST-1615)', () => {
  it('le bouton d’emoji n’envoie qu’une réaction par seconde, la suivante est ignorée sans erreur', () => {
    const sendReact = vi.fn(() => true);
    partyBridge.client = { ...fakeClient(false, hostParticipants()), sendReact } as any;
    panel.togglePartyPanel(true);
    const btn = panelOf().querySelector<HTMLButtonElement>('[data-wp-react]')!;
    btn.click();
    btn.click();
    expect(sendReact).toHaveBeenCalledTimes(1);
  });
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

  it('source non relayable (torrent, lien protégé) avec des invités : « Partage impossible avec cette source » et le compte d’invités', () => {
    vi.spyOn(partyBridge, 'relayUnavailable').mockReturnValue(true);
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    const warn = panelOf().querySelector('.wp-rate-warn') as HTMLElement;
    expect(warn.textContent).toBe('Partage impossible avec cette source');
    expect(warn.title).toContain('torrent ou lien protégé');
    expect(panelOf().querySelector('[data-wp-guests]')!.textContent).toBe('2');
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

describe('bandeau d’attente : masqué hors attente', () => {
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

describe('en-tête du salon et menu « … »', () => {
  it('titre « Salon de l’hôte », film dessous ; menu replié par défaut, « … » et Échap le basculent', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('.wp-title')!.textContent).toBe('Salon de alice');
    expect(panelOf().querySelector('.wp-film')!.textContent).toBe('Severance');
    const menu = () => panelOf().querySelector('#wp-menu') as HTMLElement;
    const btn = () => panelOf().querySelector('[data-wp-menu]') as HTMLElement;
    expect(btn().getAttribute('aria-label')).toBe('Réglages du salon');
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(menu().hidden).toBe(true);
    btn().click();
    expect(menu().hidden).toBe(false);
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(menu().querySelector('[data-wp-leave]')).not.toBeNull();
    expect(menu().querySelector('[data-wp-end]')).not.toBeNull();
    expect(menu().querySelectorAll('.wp-user')).toHaveLength(4);
    panelOf().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(btn().getAttribute('aria-expanded')).toBe('false');
  });

  it('« Inviter » ouvre le menu sur l’invitation ; le bouton d’envoi est nommé « Envoyer »', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    (panelOf().querySelector('[data-wp-open-invite]') as HTMLElement).click();
    expect((panelOf().querySelector('#wp-menu') as HTMLElement).hidden).toBe(false);
    expect(document.activeElement).toBe(panelOf().querySelector('[data-wp-invite]'));
    expect(panelOf().querySelector('[data-wp-send] [type=submit]')!.getAttribute('aria-label')).toBe('Envoyer');
    (panelOf().querySelector('[data-wp-menu]') as HTMLElement).click();
  });

  it('badge de visibilité sur sa ligne, « Inviter » à côté, fermeture dans l’en-tête (rien ne se chevauche)', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    const sub = panelOf().querySelector('.wp-subrow') as HTMLElement;
    expect(sub.querySelector('.wp-vis')!.textContent).toBe('Privé');
    expect(sub.querySelector('[data-wp-open-invite]')).not.toBeNull();
    expect(sub.textContent).toContain('Chacun lit avec sa propre source');
    expect(panelOf().querySelector('.wp-head [data-wp-close]')).not.toBeNull();
    expect(panelOf().querySelector('#wp-menu .wp-vis')).toBeNull();
  });

  it('l’hôte termine pour tous, un invité ne voit pas « Terminer »', () => {
    partyBridge.client = fakeClient(true, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-end]')!.textContent).toBe('Terminer pour tous');
    partyBridge.client = fakeClient(false, hostParticipants()) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-end]')).toBeNull();
  });

  it('sans invité par lien ni partage : on dit seulement que chacun lit avec sa source (pas de « Partage inactif »)', () => {
    partyBridge.client = fakeClient(true, [{ username: 'alice', host: true }, { username: 'bob' }]) as any;
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-relay]')!.textContent).toBe('Chacun lit avec sa propre source');
  });
});

describe('création du salon', () => {
  it('visibilité en choix visuel, bouton de création épinglé, fermeture dans l’en-tête, aucune promesse de flux partagé', () => {
    partyBridge.client = null;
    panel.togglePartyPanel(true);
    const p = panelOf();
    expect(p.querySelector('.wp-cbar [data-wp-close]')).not.toBeNull();
    expect(p.querySelector('.wp-title')!.textContent).toBe('Watch party');
    const radios = [...p.querySelectorAll<HTMLInputElement>('.wp-vopts input[name="vis"]')];
    expect(radios[0].value).toBe('private');
    expect(radios[0].checked).toBe(true);
    const submit = p.querySelector('.wp-cfoot [type=submit]') as HTMLButtonElement;
    expect(submit.textContent).toBe('Créer le salon');
    expect(p.textContent).toContain('Chacun lit avec sa propre source');
    expect(p.textContent).toContain('aucun flux vidéo n’est partagé');
  });
});

/** Client de salon avec bus d’événements : les écouteurs du panneau reçoivent ce que `emit` envoie, comme le vrai client. */
const busClient = (isHost: boolean, participants: Participant[]): any => {
  const handlers = new Map<string, Array<(p?: unknown) => void>>();
  return {
    status: 'open',
    room: { id: 'r1', visibility: 'private', title: 'Severance' },
    you: { username: isHost ? 'alice' : 'bob', host: isHost, muted: false },
    participants,
    chat: [] as Array<{ id: string; from: string; text: string; at: number }>,
    waiting: null as null | { who: string[]; since: number; maxMs: number; resumeAhead: number },
    serverNow: () => Date.now(),
    sendChat: vi.fn(() => true),
    sendReact: vi.fn(() => true),
    on(event: string, fn: (p?: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => undefined;
    },
    emit(event: string, payload?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
  };
};

const line = (id: string, from: string, text: string, at = Date.UTC(2026, 0, 1, 9, 5)) => ({ id, from, text, at });
const pad = (n: number) => String(n).padStart(2, '0');

describe('bandeau d’attente de tampon', () => {
  it('« En attente de Léa, Tom… » dès l’événement wait, avec compte à rebours ; les retardataires ont la pastille « Tampon »', async () => {
    const c = busClient(true, [{ username: 'alice', host: true }, { username: 'Léa', state: 'ready' }, { username: 'Tom' }, { username: 'bob' }]);
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    expect((panelOf().querySelector('.wp-wait') as HTMLElement).hidden).toBe(true);
    c.waiting = { who: ['Léa', 'Tom'], since: Date.now() - 5000, maxMs: 45000, resumeAhead: 10 };
    c.emit('wait', c.waiting);
    await tick();
    const wait = panelOf().querySelector('.wp-wait') as HTMLElement;
    expect(wait.hidden).toBe(false);
    expect(wait.querySelector('.wp-wait-txt')!.textContent).toBe('En attente de Léa, Tom…');
    expect(wait.querySelector('[data-wp-countdown]')!.textContent).toBe('40 s');
    expect(rowOf('Léa').querySelector('.wp-state')!.getAttribute('aria-label')).toBe('Tampon');
    expect(rowOf('Tom').querySelector('.wp-state')!.classList.contains('is-buffering')).toBe(true);
    expect(rowOf('bob').querySelector('.wp-state')!.getAttribute('aria-label')).toBe('Prêt');
  });

  it('masqué et vidé quand l’attente se ferme (wait à null)', async () => {
    const c = busClient(true, [{ username: 'alice', host: true }, { username: 'Tom' }]);
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    c.waiting = { who: ['Tom'], since: Date.now(), maxMs: 45000, resumeAhead: 10 };
    c.emit('wait', c.waiting);
    await tick();
    expect((panelOf().querySelector('.wp-wait') as HTMLElement).hidden).toBe(false);
    c.waiting = null;
    c.emit('wait', null);
    await tick();
    const wait = panelOf().querySelector('.wp-wait') as HTMLElement;
    expect(wait.hidden).toBe(true);
    expect(wait.textContent).toBe('');
    expect(rowOf('Tom').querySelector('.wp-state')!.getAttribute('aria-label')).toBe('Prêt');
  });

  it('pseudos des retardataires échappés', async () => {
    const c = busClient(true, [{ username: 'alice', host: true }]);
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    c.waiting = { who: ['<img src=x onerror="alert(1)">'], since: Date.now(), maxMs: 45000, resumeAhead: 10 };
    c.emit('wait', c.waiting);
    await tick();
    const wait = panelOf().querySelector('.wp-wait') as HTMLElement;
    expect(wait.querySelector('img')).toBeNull();
    expect(wait.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('compte à rebours borné à maxMs (début dans le futur ou délai absent)', () => {
    const c = busClient(true, [{ username: 'alice', host: true }]);
    partyBridge.client = c;
    c.waiting = { who: ['Tom'], since: Date.now() + 60000, maxMs: 45000, resumeAhead: 10 };
    panel.togglePartyPanel(true);
    expect(panelOf().querySelector('[data-wp-countdown]')!.textContent).toBe('45 s');
  });
});

describe('chat : rendu, échappement, envoi, limite', () => {
  it('pseudo et texte échappés ; heure HH:MM', async () => {
    const c = busClient(true, hostParticipants());
    c.chat = [line('m1', '<b>mal</b>', '<img src=x onerror="alert(1)">')];
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    const chat = panelOf().querySelector('.wp-chat') as HTMLElement;
    expect(chat.querySelector('img')).toBeNull();
    expect(chat.querySelectorAll('b')).toHaveLength(1); // seul le <b> du pseudo, jamais celui du texte
    expect(chat.textContent).toContain('<img src=x onerror="alert(1)">');
    const d = new Date(Date.UTC(2026, 0, 1, 9, 5));
    expect(chat.querySelector('.wp-time')!.textContent).toBe(pad(d.getHours()) + ':' + pad(d.getMinutes()));
  });

  it('Entrée envoie le texte (coupé à 500 caractères) ; le champ se vide et le compteur revient à 0/500', () => {
    const c = busClient(false, hostParticipants());
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    const form = panelOf().querySelector('[data-wp-send]') as HTMLFormElement;
    const input = form.querySelector('input[name="text"]') as HTMLInputElement;
    expect(input.maxLength).toBe(500);
    input.value = 'x'.repeat(600);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panelOf().querySelector('[data-wp-chars]')!.textContent).toBe('600/500');
    form.requestSubmit();
    expect(c.sendChat).toHaveBeenCalledTimes(1);
    expect(c.sendChat.mock.calls[0][0]).toHaveLength(500);
    expect(input.value).toBe('');
    expect(panelOf().querySelector('[data-wp-chars]')!.textContent).toBe('0/500');
  });

  it('compteur discret à la frappe', () => {
    const c = busClient(false, hostParticipants());
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    const input = panelOf().querySelector('input[name="text"]') as HTMLInputElement;
    input.value = 'salut';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panelOf().querySelector('[data-wp-chars]')!.textContent).toBe('5/500');
  });

  it('chat replié : badge « N nouveaux messages » pour ceux des autres ; ni historique ni mes messages ; ouvrir remet à zéro', async () => {
    const c = busClient(false, hostParticipants()); // je suis bob
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    const toggle = () => panelOf().querySelector('[data-wp-chat-toggle]') as HTMLElement;
    const badge = () => panelOf().querySelector('[data-wp-unread]') as HTMLElement | null;
    toggle().click();
    await tick();
    expect((panelOf().querySelector('[data-wp-chat-body]') as HTMLElement).hidden).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    // Reconnexion : l’historique arrive après « welcome », il ne compte pas.
    c.emit('welcome', {});
    c.chat = [line('h1', 'carl', 'ancien'), line('h2', 'dana', 'ancien aussi')];
    for (const l of c.chat) c.emit('chat', l);
    await tick();
    expect(badge()).toBeNull();
    await tick(5);
    c.emit('chat', line('n1', 'carl', 'salut'));
    await tick();
    expect(badge()!.textContent).toBe('1 nouveau message');
    c.emit('chat', line('n2', 'bob', 'moi')); // mon propre message ne compte pas
    c.emit('chat', line('n3', 'dana', 'coucou'));
    await tick();
    expect(badge()!.textContent).toBe('2 nouveaux messages');
    toggle().click();
    await tick();
    expect(badge()).toBeNull();
    expect((panelOf().querySelector('[data-wp-chat-body]') as HTMLElement).hidden).toBe(false);
  });

  it('historique de 50 lignes à la connexion : un seul rendu du panneau', async () => {
    const c = busClient(false, hostParticipants());
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    await tick();
    const history = Array.from({ length: 50 }, (_, i) => line('h' + i, 'carl', 'message ' + i, Date.UTC(2026, 0, 1, 9, i % 60)));
    let rebuilds = 0;
    const observer = new MutationObserver((records) => { rebuilds += records.filter((r) => r.target === panelOf()).length; });
    observer.observe(panelOf(), { childList: true });
    c.chat = history;
    c.emit('welcome', {});
    for (const l of history) c.emit('chat', l);
    await tick(60);
    observer.disconnect();
    expect(rebuilds).toBe(1);
    expect(panelOf().querySelectorAll('.wp-line')).toHaveLength(50);
  });

  it('une réaction de la barre part via sendReact', () => {
    const c = busClient(false, hostParticipants());
    partyBridge.client = c;
    panel.togglePartyPanel(true);
    const fire = [...panelOf().querySelectorAll<HTMLElement>('[data-wp-react]')].find((b) => b.dataset.wpReact === '\u{1F525}')!;
    fire.click();
    expect(c.sendReact).toHaveBeenCalledWith('\u{1F525}');
  });
});
