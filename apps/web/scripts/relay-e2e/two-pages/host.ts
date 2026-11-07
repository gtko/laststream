// Page hôte du test à deux pages. Un PartyClient sur le faux salon (fake-party-relay.mjs) et un HostRelaySession qui sert les
// plages du média à l'invité. La source est la vraie `urlRangeSource` (HEAD + Range), avec un transport en mémoire : l'URL
// factice ne sort jamais de cette page. Expose window.__host pour que two-pages.mjs pilote et lise l'état.
import { PartyClient, type SocketLike } from '../../../src/party/client';
import { HostRelaySession } from '../../../src/relay/session';
import { urlRangeSource } from '../../../src/relay/sources';
import type { HttpFn, HttpRequest, HttpResponse } from '../../../src/sources/debrid/http';

/** URL factice du média (domaine réservé `.invalid`) : seule la source de l'hôte la connaît. */
const FAKE_MEDIA_URL = 'https://relay-e2e.invalid/lien-factice/film.mp4';

const params = new URLSearchParams(location.search);
const relayUrl = params.get('relay') ?? '';
const roomId = params.get('room') ?? 'ROOM';
const media = params.get('media') ?? 'two-pages-h264.mp4';
const mime = media.endsWith('.webm') ? 'video/webm' : 'video/mp4';
const statusEl = document.getElementById('status') as HTMLElement;

/** Transport HTTP en mémoire : HEAD et `Range: bytes=a-b` sur le fichier déjà chargé. */
function memoryHttp(bytes: Uint8Array): HttpFn {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const base = { 'content-length': String(bytes.byteLength), 'accept-ranges': 'bytes' };
    if (req.method === 'HEAD') return { status: 200, headers: base, body: new Uint8Array(0) };
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers?.Range ?? '');
    if (!m) return { status: 200, headers: base, body: bytes };
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]) + 1, bytes.byteLength);
    return {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end - 1}/${bytes.byteLength}`, 'content-length': String(end - start) },
      body: bytes.slice(start, end),
    };
  };
}

const handle = {
  ready: false,
  error: null as string | null,
  client: null as PartyClient | null,
  session: null as HostRelaySession | null,
  /** URL factice lue par la source de l'hôte (le test vérifie que les marqueurs la couvrent). */
  sourceUrl: FAKE_MEDIA_URL,
  /** État de lecture du salon, tel que l'hôte le voit. */
  state: () => handle.client?.state ?? null,
  stats: () => handle.session?.stats() ?? { guests: 0, links: 0, bytesSent: 0, rateBps: 0 },
  status: () => handle.client?.status ?? 'idle',
};
(window as unknown as { __host: typeof handle }).__host = handle;

async function main(): Promise<void> {
  const bytes = new Uint8Array(await (await fetch(`/${media}`)).arrayBuffer());
  const source = urlRangeSource({ url: FAKE_MEDIA_URL, http: memoryHttp(bytes), mime });
  const client = new PartyClient({
    connect: async () => new WebSocket(`${relayUrl}/party/${encodeURIComponent(roomId)}/ws?role=host&name=hote`) as unknown as SocketLike,
  });
  handle.client = client;
  // Pas de STUN en loopback : candidats hôte seulement.
  handle.session = new HostRelaySession({
    client,
    source,
    createPc: (config) => new RTCPeerConnection({ ...config, iceServers: [] }),
  });
  client.start();
  handle.ready = true;
  setInterval(() => {
    const s = handle.stats();
    statusEl.textContent = `hôte : salon ${client.status} ; invités ${s.guests}, liaisons ${s.links}, envoyés ${s.bytesSent} o ; lecture ${client.state?.playing ? 'en cours' : 'en pause'}`;
  }, 500);
}

main().catch((err: unknown) => {
  handle.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  statusEl.textContent = `hôte : erreur ${handle.error}`;
});
