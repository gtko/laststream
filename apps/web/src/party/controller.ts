import type { PartyClient } from './client';
import { driftAction, expectedPosition } from './sync';

/* Synchronise le lecteur local avec le salon, quel que soit le moteur (HTML5/HLS, mpv, libVLC natif) : seule l'interface
 * minimale `PlayerLike` est utilisée. L'hôte pilote (ses actions locales sont envoyées), les autres suivent avec correction
 * de dérive d'après l'horloge serveur. Appelé toutes les ~100 ms par le lecteur (`tick`). */

export interface PlayerLike {
  /** Un média est chargé et la position est mesurable. */
  ready(): boolean;
  time(): number;
  duration(): number;
  paused(): boolean;
  buffering(): boolean;
  rate(): number;
  play(): void;
  pause(): void;
  seek(to: number): void;
  setRate(rate: number): void;
  /** La vitesse de lecture est réglable (libVLC : par prudence, non). */
  canRate: boolean;
}

export const HOST_SYNC_EVERY_MS = 5000;
/** Écart de position, par rapport à ce que la lecture normale produirait, qui compte comme un saut de l'hôte. */
export const HOST_SEEK_JUMP_SEC = 1.5;
/** Pause laissée à un saut ou une action reçue avant de re-mesurer la dérive. */
export const SETTLE_MS = 1500;
const FOLLOW_EVERY_MS = 500;

export class PartyController {
  private last: { paused: boolean; time: number; at: number } | null = null;
  private lastSyncSent = 0;
  private settleUntil = 0;
  private lastFollow = 0;
  private correcting = false;
  /** Dernières commandes appliquées au lecteur local (inspection par les tests). */
  readonly applied: string[] = [];

  constructor(private readonly client: PartyClient, private readonly now: () => number = () => Date.now()) {}

  /** Oublie l'état mesuré (nouveau média, reconnexion) : la prochaine mesure repart de zéro. */
  reset(): void {
    this.last = null;
    this.settleUntil = 0;
    this.correcting = false;
  }

  tick(player: PlayerLike | null): void {
    if (!player || !player.ready() || !this.client.state || this.client.status === 'closed') return;
    if (this.client.isHost) this.hostTick(player);
    else this.followTick(player);
  }

  // ---- Hôte : les actions locales deviennent des commandes ----
  private hostTick(p: PlayerLike): void {
    const now = this.now();
    const time = p.time();
    const paused = p.paused();
    const st = this.client.state!;
    if (!this.last) {
      // Première mesure : aligne le salon sur le lecteur de l'hôte s'il diffère.
      this.last = { paused, time, at: now };
      if (st.playing === paused || Math.abs(expectedPosition(st, this.client.serverNow()) - time) > 1) {
        this.client.control(paused ? 'pause' : 'play', time);
        this.lastSyncSent = now;
      }
      return;
    }
    const prev = this.last;
    if (p.buffering() && !paused) { this.last = { paused, time, at: now }; return; }
    const expected = prev.paused ? prev.time : prev.time + ((now - prev.at) / 1000) * Math.max(0.25, p.rate());
    if (paused !== prev.paused) {
      this.client.control(paused ? 'pause' : 'play', time);
      this.lastSyncSent = now;
    } else if (Math.abs(time - expected) > HOST_SEEK_JUMP_SEC) {
      this.client.control('seek', time);
      this.lastSyncSent = now;
    } else if (!paused && now - this.lastSyncSent >= HOST_SYNC_EVERY_MS) {
      this.client.control('sync', time);
      this.lastSyncSent = now;
    }
    this.last = { paused, time, at: now };
  }

  // ---- Invité : le lecteur suit l'état du salon ----
  private followTick(p: PlayerLike): void {
    const now = this.now();
    if (now < this.settleUntil || now - this.lastFollow < FOLLOW_EVERY_MS) return;
    this.lastFollow = now;
    const st = this.client.state!;
    const expected = expectedPosition(st, this.client.serverNow());
    const dur = p.duration();
    const target = dur > 0 ? Math.min(expected, Math.max(0, dur - 0.5)) : expected;
    if (!st.playing) {
      if (!p.paused()) this.run(p, 'pause', () => p.pause());
      if (Math.abs(p.time() - target) >= 0.5) this.seek(p, target);
      if (this.correcting) this.restoreRate(p);
      return;
    }
    if (p.paused()) this.run(p, 'play', () => p.play());
    if (p.buffering()) return; // la position n'est pas fiable pendant le chargement
    const action = driftAction(p.time(), target, true, { canRate: p.canRate, correcting: this.correcting });
    if (action.kind === 'none') {
      if (this.correcting) this.restoreRate(p);
    } else if (action.kind === 'rate') {
      if (Math.abs(p.rate() - action.rate) > 0.001) this.run(p, 'rate:' + action.rate, () => p.setRate(action.rate));
      this.correcting = true;
    } else {
      this.seek(p, action.to);
      if (this.correcting) this.restoreRate(p);
    }
  }

  private seek(p: PlayerLike, to: number): void {
    this.run(p, 'seek:' + to.toFixed(1), () => p.seek(to));
    this.settleUntil = this.now() + SETTLE_MS;
  }

  private restoreRate(p: PlayerLike): void {
    this.correcting = false;
    if (Math.abs(p.rate() - 1) > 0.001) this.run(p, 'rate:1', () => p.setRate(1));
  }

  private run(_p: PlayerLike, label: string, fn: () => void): void {
    this.applied.push(label);
    if (this.applied.length > 50) this.applied.shift();
    try { fn(); } catch { /* le moteur peut ne pas être prêt : retenté au tour suivant */ }
  }
}
