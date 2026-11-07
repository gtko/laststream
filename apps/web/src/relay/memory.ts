import type { ChannelEvent, ChannelLike } from './protocol';

/* Canal en mémoire qui imite un RTCDataChannel : tampon `bufferedAmount` décompté à la livraison, événement
 * `bufferedamountlow` émis au franchissement du seuil (comme le navigateur), livraison asynchrone dans l'ordre, réception
 * en ArrayBuffer. Sert aux tests de l'hôte et de l'invité ; l'application ne l'utilise jamais. */

type Listener = (ev: { data?: unknown }) => void;

export class MemoryChannel implements ChannelLike {
  readonly label = 'ranges';
  readyState: 'open' | 'closed' = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  /** Plus fort tampon observé côté émission (contrôle de flux). */
  peakBuffered = 0;
  /** Nombre d'événements `bufferedamountlow` émis. */
  lowEvents = 0;
  /** Nombre de messages envoyés. */
  sent = 0;
  peer: MemoryChannel | null = null;
  private readonly listeners = new Map<ChannelEvent, Set<Listener>>();

  constructor(private readonly latencyMs = 0) {}

  send(data: Uint8Array): void {
    const peer = this.peer;
    if (this.readyState !== 'open' || !peer) throw new Error('InvalidStateError');
    const copy = data.slice();
    const n = copy.byteLength;
    this.bufferedAmount += n;
    this.sent += 1;
    this.peakBuffered = Math.max(this.peakBuffered, this.bufferedAmount);
    setTimeout(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= n;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.lowEvents += 1;
        this.emit('bufferedamountlow', {});
      }
      if (peer.readyState === 'open') peer.emit('message', { data: copy.buffer });
    }, this.latencyMs);
  }

  close(): void {
    const other = this.peer;
    this.markClosed();
    other?.markClosed();
  }

  addEventListener(type: ChannelEvent, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: ChannelEvent, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private markClosed(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    setTimeout(() => this.emit('close', {}), 0);
  }

  private emit(type: ChannelEvent, ev: { data?: unknown }): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
}

/** Deux extrémités reliées : ce qu'une extrémité envoie, l'autre le reçoit. */
export function memoryChannelPair(latencyMs = 0): [MemoryChannel, MemoryChannel] {
  const a = new MemoryChannel(latencyMs);
  const b = new MemoryChannel(latencyMs);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
