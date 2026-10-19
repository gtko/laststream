// Sous-titres côté hôte : la liaison envoie les trames SUBS à l'ouverture de son canal (créé « connecting »), puis à chaque
// changement sur les canaux ouverts. Un canal pas encore ouvert ne reçoit rien.
import { describe, expect, it } from 'vitest';
import type { RangeSource } from './host';
import { RelayHost, type RelaySignal, type SignalTransport } from './peer';
import { SubsAssembler, decodeFrame, encodeSubs } from './protocol';
import { encodePartySubtitles, parsePartySubtitles, type PartySubtitleTrack } from '../party/subtitles';

type Listener = (ev: { data?: unknown }) => void;

/** Canal factice qui s'ouvre quand le test le décide (comme un RTCDataChannel côté hôte). */
class OpeningChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  send(data: Uint8Array): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    this.sent.push(data.slice());
  }

  close(): void {
    this.readyState = 'closed';
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  open(): void {
    this.readyState = 'open';
    for (const fn of [...(this.listeners.get('open') ?? [])]) fn({});
  }
}

class FakePc {
  connectionState = 'new';
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  channel: OpeningChannel | null = null;

  createDataChannel(): OpeningChannel {
    this.channel = new OpeningChannel();
    return this.channel;
  }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'OFFER' };
  }

  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.connectionState = 'closed';
  }
}

const tracksOf = (vtt: string): PartySubtitleTrack[] => [{ id: 's1', lang: 'fr', label: 'Français', vtt }];
const VTT_A = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n\n';
const VTT_B = 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nAu revoir\n\n';

/** Messages SUBS reçus sur le canal (réassemblés et validés), dans l'ordre. */
function received(ch: OpeningChannel): Array<PartySubtitleTrack[] | null> {
  const asm = new SubsAssembler();
  const out: Array<PartySubtitleTrack[] | null> = [];
  for (const bytes of ch.sent) {
    const frame = decodeFrame(bytes);
    if (frame?.t !== 'subs') continue;
    const msg = asm.push(frame);
    if (msg) out.push(parsePartySubtitles(msg));
  }
  return out;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe('sous-titres de l’hôte : liaison', () => {
  it('envoi à l’ouverture du canal, puis à chaque changement ; aucun envoi avant l’ouverture', async () => {
    const handlers: Array<(from: string, data: unknown) => void> = [];
    const signaling: SignalTransport = {
      send: (_to: string, _data: RelaySignal) => undefined,
      onMessage: (cb) => {
        handlers.push(cb);
        return () => undefined;
      },
    };
    const pcs: FakePc[] = [];
    const source: RangeSource = { size: async () => 0, read: async () => new Uint8Array(0) };
    const host = new RelayHost(source, signaling, {
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      allow: () => true,
    });
    const hello = (from: string): void => handlers.forEach((cb) => cb(from, { t: 'hello' }));

    host.setSubtitles(encodeSubs(encodePartySubtitles(tracksOf(VTT_A))));
    hello('g1');
    await settle();
    const first = pcs[0].channel!;
    expect(first.sent).toEqual([]);

    first.open();
    expect(received(first)).toEqual([tracksOf(VTT_A)]);

    host.setSubtitles(encodeSubs(encodePartySubtitles(tracksOf(VTT_B))));
    expect(received(first)).toEqual([tracksOf(VTT_A), tracksOf(VTT_B)]);

    host.setSubtitles(encodeSubs(encodePartySubtitles([])));
    expect(received(first)).toEqual([tracksOf(VTT_A), tracksOf(VTT_B), []]);

    hello('g2');
    await settle();
    const second = pcs[1].channel!;
    expect(second.sent).toEqual([]);
    second.open();
    expect(received(second)).toEqual([[]]);

    host.close();
  });

  it('un canal fermé ne reçoit plus rien ; la session se ferme sans erreur', async () => {
    const handlers: Array<(from: string, data: unknown) => void> = [];
    const signaling: SignalTransport = {
      send: () => undefined,
      onMessage: (cb) => {
        handlers.push(cb);
        return () => undefined;
      },
    };
    const pcs: FakePc[] = [];
    const host = new RelayHost({ size: async () => 0, read: async () => new Uint8Array(0) }, signaling, {
      createPc: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
      allow: () => true,
    });
    handlers.forEach((cb) => cb('g1', { t: 'hello' }));
    await settle();
    const ch = pcs[0].channel!;
    ch.open();
    ch.close();
    expect(() => host.setSubtitles(encodeSubs(encodePartySubtitles(tracksOf(VTT_A))))).not.toThrow();
    expect(received(ch)).toEqual([]);
    host.close();
  });
});
