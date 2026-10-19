// Page hôte du test de maillage : vrai salon (lastaddon, wrangler dev), vraie source HTTP (clip H.264 d'un serveur de test),
// HostRelaySession avec maillage. Expose window.__host.
import { PartyClient, type SocketLike } from '../../../src/party/client';
import { HostRelaySession } from '../../../src/relay/session';
import { urlRangeSource } from '../../../src/relay/sources';

const params = new URLSearchParams(location.search);
const ws = params.get('ws') ?? '';
const media = params.get('media') ?? '';
const statusEl = document.getElementById('status') as HTMLElement;

const handle = {
  ready: false,
  error: null as string | null,
  client: null as PartyClient | null,
  session: null as HostRelaySession | null,
  state: () => handle.client?.state ?? null,
  stats: () => handle.session?.stats() ?? { guests: 0, links: 0, bytesSent: 0, rateBps: 0 },
  status: () => handle.client?.status ?? 'idle',
  /** Octets reçus et envoyés sur les DataChannel de la page, par libellé. */
  channels: () => channelBytes,
};
(window as unknown as { __host: typeof handle }).__host = handle;

const channelBytes: Record<string, { sent: number; received: number }> = {};
const Native = window.RTCPeerConnection;
class Traced extends Native {
  constructor(config?: RTCConfiguration) {
    super({ ...config, iceServers: [] });
    this.addEventListener('datachannel', (ev: RTCDataChannelEvent) => count(ev.channel));
  }
  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
    const ch = super.createDataChannel(label, init);
    count(ch);
    return ch;
  }
}
function count(ch: RTCDataChannel): void {
  const row = (channelBytes[ch.label] ??= { sent: 0, received: 0 });
  const send = ch.send.bind(ch) as (d: ArrayBuffer | ArrayBufferView) => void;
  ch.send = ((d: ArrayBuffer | ArrayBufferView) => {
    row.sent += d.byteLength;
    send(d);
  }) as typeof ch.send;
  ch.addEventListener('message', (m: MessageEvent) => {
    if (m.data instanceof ArrayBuffer) row.received += m.data.byteLength;
  });
}
window.RTCPeerConnection = Traced as unknown as typeof RTCPeerConnection;

try {
  const source = urlRangeSource({ url: media, mime: 'video/mp4' });
  const client = new PartyClient({ connect: async () => new WebSocket(ws) as unknown as SocketLike });
  handle.client = client;
  handle.session = new HostRelaySession({ client, source });
  client.start();
  handle.ready = true;
  setInterval(() => {
    const s = handle.stats();
    statusEl.textContent = `hôte : salon ${client.status} ; invités ${s.guests}, liaisons ${s.links}, envoyés ${s.bytesSent} o`;
  }, 500);
} catch (err) {
  handle.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  statusEl.textContent = `hôte : erreur ${handle.error}`;
}
