// Panneau du lecteur (src/ui/partypanel.js) branché sur un VRAI PartyClient du vrai salon (invité par lien), pour vérifier le trajet
// WebSocket du salon -> élément flottant du DOM (scripts/relay-e2e/party.mjs, contrôle des réactions en direct).
// Seul le lecteur vidéo manque : le panneau, le bridge et le client du salon sont ceux de l'application.
import '../../../src/styles/styles.css';
import '../../../src/styles/app.css';
import '../../../src/styles/social.css';
import '../../../src/styles/player.css';
import '../../../src/styles/player-ui.css';
import '../../../src/styles/player-panels.css';
import '../../../src/styles/partylobby.css';
import { PartyClient, type SocketLike } from '../../../src/party/client';
import { partyBridge } from '../../../src/party/bridge';
import { mountPartyPanel, togglePartyPanel } from '../../../src/ui/partypanel.js';

const ws = new URLSearchParams(location.search).get('ws') ?? '';
const reacts: Array<{ by: string; emoji: string }> = [];
const handle = {
  ready: false,
  error: null as string | null,
  closeCode: null as number | null,
  status: () => (partyBridge.client as PartyClient | null)?.status ?? 'idle',
  reacts: () => reacts.slice(),
  openPanel: () => togglePartyPanel(true),
};
(window as unknown as { __live: typeof handle }).__live = handle;

try {
  const client = new PartyClient({ connect: async () => {
    const sock = new WebSocket(ws);
    sock.addEventListener('close', (e) => { handle.closeCode = e.code; });
    return sock as unknown as SocketLike;
  } });
  const bridge = partyBridge as unknown as Record<string, unknown> & { emit(): void };
  bridge.client = client;
  client.on('status', () => bridge.emit());
  client.on('welcome', (w) => { bridge.room = w.room; bridge.emit(); });
  client.on('participants', () => bridge.emit());
  client.on('react', (r) => reacts.push({ by: r.by, emoji: r.emoji }));
  mountPartyPanel(document.getElementById('player') as HTMLElement, { adapter: () => ({ ready: true, title: 'Clip de test' }) });
  client.start();
  handle.ready = true;
} catch (err) {
  handle.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
