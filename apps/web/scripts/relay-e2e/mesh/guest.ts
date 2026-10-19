// Page invité du test de maillage : rejoint le vrai salon avec un jeton d'invitation, lit le clip par le relais de l'hôte et
// par les autres invités (DataChannel « mesh »), le décode via GuestPlayer sur un canvas. Compte les octets par DataChannel,
// vus au niveau du navigateur (indépendamment des compteurs de l'application).
import { GuestPlayer } from '../../../src/relay/player/index.ts';
import { GuestRelaySession } from '../../../src/relay/session';
import type { PlayerCallbacks } from '../../../src/relay/player/types';
import type { SocketLike } from '../../../src/party/client';

const params = new URLSearchParams(location.search);
const ws = params.get('ws') ?? '';
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;

const channelBytes: Record<string, { received: number; sent: number }> = {};
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
  const row = (channelBytes[ch.label] ??= { received: 0, sent: 0 });
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

function sample() {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2D indisponible');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += 16) {
    if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 30) lit++;
    colors.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0));
  }
  return { lit: lit / (data.length / 16), colors: colors.size, width: canvas.width, height: canvas.height };
}

let player: GuestPlayer | null = null;
const session = new GuestRelaySession({
  connect: async () => new WebSocket(ws) as unknown as SocketLike,
  createPlayer: (callbacks: PlayerCallbacks) => {
    player = new GuestPlayer(callbacks);
    return player;
  },
  canvas,
  peer: { iceServers: [] },
});

(window as unknown as { __guest: unknown }).__guest = {
  ready: true,
  view: () => session.tick(),
  stats: () => player?.getStats() ?? null,
  sample,
  channels: () => channelBytes,
  play: () => session.play(),
  pause: () => session.pause(),
  /** Diagnostic : identité, participants, état du maillage. */
  debug: () => {
    const x = session as unknown as { client?: { you?: unknown; participants?: unknown }; mesh?: { stats(): unknown; id: string | null } | null };
    return { you: x.client?.you, participants: x.client?.participants, mesh: x.mesh ? { id: x.mesh.id, stats: x.mesh.stats() } : null };
  },
};

session.start();
setInterval(() => {
  const v = session.tick();
  statusEl.textContent = `invité : ${v.phase}${v.message ? ` (${v.message})` : ''} ; hôte ${v.bytesReceived} o, pairs ${v.bytesFromPeers} o (${v.meshPeers} liés), servis ${v.bytesServed} o ; position ${v.position.toFixed(1)} s / ${v.duration.toFixed(1)} s ; ${v.playing ? 'lecture' : 'pause'}`;
}, 250);
