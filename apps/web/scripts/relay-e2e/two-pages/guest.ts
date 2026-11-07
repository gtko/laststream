// Page invité du test à deux pages. Rejoint le faux salon, ouvre la liaison WebRTC avec l'hôte (DataChannel « ranges »), lit les
// plages par ce canal et les décode via GuestPlayer (WebCodecs) sur le canvas. Les boutons passent par GuestRelaySession
// (même chemin que l'interface : la pause ou le saut partent vers le salon).
// Instrumentation : chaque message reçu sur le DataChannel est compté, et on vérifie qu'aucun ne contient l'URL factice.
import { GuestPlayer, type PlayerStats } from '../../../src/relay/player/index.ts';
import { GuestRelaySession } from '../../../src/relay/session';
import type { PlayerCallbacks } from '../../../src/relay/player/types';
import type { SocketLike } from '../../../src/party/client';

const params = new URLSearchParams(location.search);
const relayUrl = params.get('relay') ?? '';
const roomId = params.get('room') ?? 'ROOM';
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLElement;

/** Fragments qui ne doivent jamais atteindre l'invité (URL factice de l'hôte). */
const MARKERS = ['relay-e2e.invalid', 'lien-factice'].map((m) => new TextEncoder().encode(m));

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    if (hay[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const containsMarker = (bytes: Uint8Array): boolean => MARKERS.some((needle) => indexOf(bytes, needle) >= 0);

/** Messages du DataChannel reçus par la page (instrumentation du RTCPeerConnection de l'application). */
const dc = { label: null as string | null, channel: null as RTCDataChannel | null, messages: 0, bytes: 0, leaks: 0 };
const NativePeerConnection = window.RTCPeerConnection;
class TracedPeerConnection extends NativePeerConnection {
  constructor(config?: RTCConfiguration) {
    super(config);
    this.addEventListener('datachannel', (ev: RTCDataChannelEvent) => {
      dc.label = ev.channel.label;
      dc.channel = ev.channel;
      ev.channel.addEventListener('message', (m: MessageEvent) => {
        dc.messages += 1;
        if (m.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(m.data);
          dc.bytes += bytes.byteLength;
          if (containsMarker(bytes)) dc.leaks += 1;
        }
      });
    });
  }
}
window.RTCPeerConnection = TracedPeerConnection as unknown as typeof RTCPeerConnection;

/** Empreinte des pixels du canvas : taux de pixels allumés, nombre de couleurs, hachage. */
function sample() {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2D indisponible');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  let hash = 0;
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r + g + b > 30) lit++;
    const packed = (r << 16) | (g << 8) | b;
    colors.add(packed);
    hash = (Math.imul(hash, 31) + packed) >>> 0;
  }
  return { lit: lit / (data.length / 4), colors: colors.size, hash, width: canvas.width, height: canvas.height };
}

let player: GuestPlayer | null = null;
const session = new GuestRelaySession({
  connect: async () => new WebSocket(`${relayUrl}/party/${encodeURIComponent(roomId)}/ws?role=guest&name=invite`) as unknown as SocketLike,
  createPlayer: (callbacks: PlayerCallbacks) => {
    player = new GuestPlayer(callbacks);
    return player;
  },
  canvas,
  // Pas de STUN en loopback : candidats hôte seulement.
  peer: { iceServers: [] },
});

(window as unknown as { __guest: unknown }).__guest = {
  ready: true,
  /** Vue de la session (phase, octets reçus, position) ; `tick` recale aussi le lecteur comme l'interface. */
  view: () => session.tick(),
  stats: (): PlayerStats | null => player?.getStats() ?? null,
  sample,
  dc: () => ({ label: dc.label, channelState: dc.channel?.readyState ?? null, messages: dc.messages, bytes: dc.bytes, leaks: dc.leaks }),
};

document.getElementById('play')?.addEventListener('click', () => session.play());
document.getElementById('pause')?.addEventListener('click', () => session.pause());
document.getElementById('seek')?.addEventListener('click', () => session.seekBy(5));

session.start();
setInterval(() => {
  const v = session.tick();
  statusEl.textContent = `invité : ${v.phase}${v.message ? ` (${v.message})` : ''} ; reçu ${v.bytesReceived} o via DataChannel ; position ${v.position.toFixed(2)} s / ${v.duration.toFixed(2)} s ; ${v.playing ? 'lecture' : 'pause'}`;
}, 250);
