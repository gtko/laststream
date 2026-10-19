// Panneau hôte de la watch party, rendu hors de l'application avec des données factices (scripts/relay-e2e/party.mjs, capture
// 07-hote-panneau.png) : participants, bandeau d'attente, lien d'invitation, avertissement de compatibilité et chat (HTML à
// échapper). Seule l'état du salon est simulé : le panneau réel (src/ui/partypanel.js) est celui de l'application.
import '../../../src/styles/styles.css';
import '../../../src/styles/app.css';
import '../../../src/styles/social.css';
import '../../../src/styles/player.css';
import '../../../src/styles/player-ui.css';
import '../../../src/styles/player-panels.css';
import { partyBridge } from '../../../src/party/bridge';
import { mountPartyPanel, togglePartyPanel } from '../../../src/ui/partypanel.js';

const NOW = Date.now();
const room = { id: 'room-demo', title: 'Clip de test', visibility: 'private', media: { type: 'movie', tmdbId: 603 } };

const client = {
  status: 'open',
  isHost: true,
  room,
  you: { username: 'hote', host: true, muted: false },
  state: { playing: false, pos: 754.2, at: NOW, rev: 7 },
  participants: [
    { username: 'hote', host: true, avatarColor: '#aa5500' },
    { username: 'Ana', guest: true, avatarColor: '#2b6cb0' },
    { username: 'Bob', guest: true, avatarColor: '#2f855a' },
  ],
  chat: [
    { id: 'c1', from: 'hote', text: 'Bienvenue, on lance le clip dans un instant.', at: NOW - 150_000 },
    { id: 'c2', from: 'Ana', text: 'Prête, le son est bon de mon côté.', at: NOW - 90_000 },
    { id: 'c3', from: 'Bob', text: 'Message avec du <b>gras</b> et <img src=x alt="faux">', at: NOW - 30_000 },
  ],
  waiting: { who: ['Bob'], since: NOW - 8000, maxMs: 45000, resumeAhead: 10 },
  serverNow: () => Date.now(),
  on: () => undefined,
  off: () => undefined,
  sendChat: () => true,
  sendReact: () => true,
  control: () => true,
};

const bridge = partyBridge as unknown as Record<string, unknown> & { emit(): void };
Object.assign(bridge, {
  client,
  room,
  relayStats: () => ({ guests: 2, links: 1, bytesSent: 3456789, rateBps: 1200000 }),
  relayRefused: () => false,
  guestWarning: () => 'Ana ne lit pas le même format audio : sa lecture reste en stéréo.',
  guestVerdicts: () => new Map(),
  createInvite: async () => ({ roomId: room.id, token: 'jeton-factice-demo-0001' }),
});

const root = document.getElementById('player') as HTMLElement;
mountPartyPanel(root, { adapter: () => ({ ready: true, title: room.title }) });
togglePartyPanel(true);
bridge.emit();

// Lien d'invitation : le bouton « Inviter » crée un lien factice (aucun jeton réel).
async function showInviteLink(): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>('[data-wp-invite]');
  btn?.click();
  for (let i = 0; i < 40 && !document.querySelector('[data-wp-invite-link]'); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  bridge.emit();
}

void showInviteLink().then(() => {
  (window as unknown as { __panel: unknown }).__panel = {
    ready: true,
    users: document.querySelectorAll('[data-wp-users] li').length,
    waitText: document.querySelector('[data-wp-wait]')?.textContent ?? '',
    waitVisible: !(document.querySelector('[data-wp-wait]') as HTMLElement | null)?.hidden,
    inviteLink: (document.querySelector('[data-wp-invite-link]') as HTMLInputElement | null)?.value ?? '',
    chatText: document.querySelector('[data-wp-chat]')?.textContent ?? '',
    // Balises actives dans le texte d'un message (le nom d'auteur en gras est du balisage attendu, hors de ce compte).
    chatTags: document.querySelectorAll('[data-wp-chat] span b, [data-wp-chat] span img').length,
  };
});
