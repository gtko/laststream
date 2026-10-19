// Hôte simulé du test e2e de la watch party (scripts/relay-e2e/party.mjs) : un vrai PartyClient sur le vrai salon (lastaddon,
// wrangler dev), un vrai HostRelaySession qui sert les plages du clip par HTTP Range, et des commandes de lecture envoyées au
// salon (play, pause, sync, chat, sous-titres). Expose window.__host pour que le script pilote et lise l'état.
import { PartyClient, type SocketLike } from '../../../src/party/client';
import { HostRelaySession } from '../../../src/relay/session';
import { urlRangeSource } from '../../../src/relay/sources';
import type { PartySubtitleTrack } from '../../../src/party/subtitles';

const params = new URLSearchParams(location.search);
const ws = params.get('ws') ?? '';
const media = params.get('media') ?? '';
const statusEl = document.getElementById('status') as HTMLElement;

/** Position de lecture estimée (secondes), à partir de l'état du salon et de son horloge. */
function position(client: PartyClient | null): number {
  const s = client?.state;
  if (!client || !s) return 0;
  return s.playing ? Math.max(0, s.pos + (client.serverNow() - s.at) / 1000) : s.pos;
}

const handle = {
  ready: false,
  error: null as string | null,
  client: null as PartyClient | null,
  session: null as HostRelaySession | null,
  state: () => handle.client?.state ?? null,
  waiting: () => handle.client?.waiting ?? null,
  chat: () => handle.client?.chat ?? [],
  stats: () => handle.session?.stats() ?? { guests: 0, links: 0, bytesSent: 0, rateBps: 0 },
  status: () => handle.client?.status ?? 'idle',
  play: () => handle.client?.control('play', position(handle.client)) ?? false,
  pause: () => handle.client?.control('pause', position(handle.client)) ?? false,
  sendChat: (text: string) => handle.client?.sendChat(text) ?? false,
  setSubtitles: (tracks: PartySubtitleTrack[]) => handle.session?.setSubtitles(tracks),
};
(window as unknown as { __host: typeof handle }).__host = handle;

// Pas de STUN en loopback : candidats hôte seulement (même réglage que la page de maillage).
const NativePc = window.RTCPeerConnection;
class LoopbackPeerConnection extends NativePc {
  constructor(config?: RTCConfiguration) {
    super({ ...config, iceServers: [] });
  }
}
window.RTCPeerConnection = LoopbackPeerConnection as unknown as typeof RTCPeerConnection;

try {
  const source = urlRangeSource({ url: media, mime: 'video/mp4' });
  const client = new PartyClient({ connect: async () => new WebSocket(ws) as unknown as SocketLike });
  handle.client = client;
  handle.session = new HostRelaySession({ client, source });
  client.start();
  handle.ready = true;
  // Rapport périodique de l'hôte (horloge de référence), comme l'hôte réel pendant la lecture.
  setInterval(() => {
    if (client.state?.playing && client.status === 'open') client.control('sync', position(client));
    const s = handle.stats();
    const w = client.waiting;
    statusEl.textContent = `hôte : salon ${client.status} ; invités ${s.guests}, liaisons ${s.links} ; lecture ${client.state?.playing ? 'en cours' : 'en pause'} ; attente ${w ? w.who.length : 0}`;
  }, 1000);
} catch (err) {
  handle.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  statusEl.textContent = `hôte : erreur ${handle.error}`;
}
