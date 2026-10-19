/* Compteur de débit (octets par seconde sur une fenêtre glissante) pour les statistiques d'envoi (hôte) et de réception
 * (invité). Les callbacks `onStats` sont limités à une émission par seconde, sauf émission forcée (fin de requête). */

export const STATS_EVERY_MS = 1000;

export class RateMeter {
  private readonly samples: { at: number; bytes: number }[] = [];
  private sum = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs = 5000,
  ) {}

  add(bytes: number): void {
    const at = this.now();
    this.samples.push({ at, bytes });
    this.sum += bytes;
    this.prune(at);
  }

  /** Débit moyen sur la fenêtre, en octets par seconde. */
  rate(): number {
    const at = this.now();
    this.prune(at);
    const first = this.samples[0];
    if (!first) return 0;
    const span = Math.max(1000, Math.min(this.windowMs, at - first.at));
    return Math.round((this.sum * 1000) / span);
  }

  private prune(at: number): void {
    while (this.samples.length > 0 && at - this.samples[0]!.at > this.windowMs) {
      const old = this.samples.shift();
      if (old) this.sum -= old.bytes;
    }
  }
}
