/* File d'attente des emojis flottants du lecteur (LAST-1614) : au plus `maxVisible` à l'écran, un nouveau toutes les
 * `gapMs`, jamais plus de `maxPending` en attente (les plus anciens sont abandonnés : une rafale de 50 ne bloque rien). */

export interface FxItem { emoji: string; name: string }
export interface QueueOptions {
  maxVisible?: number;
  maxPending?: number;
  /** Délai minimal entre deux apparitions (ms). */
  gapMs?: number;
  /** Durée de vie d'un emoji à l'écran (ms) ; doit suivre l'animation CSS. */
  lifeMs?: number;
}

export interface ReactionQueue {
  push(item: FxItem): void;
  clear(): void;
}

export function createReactionQueue(show: (item: FxItem) => void, opts: QueueOptions = {}): ReactionQueue {
  const maxVisible = opts.maxVisible ?? 4;
  const maxPending = opts.maxPending ?? 20;
  const gapMs = opts.gapMs ?? 260;
  const lifeMs = opts.lifeMs ?? 4200;
  let pending: FxItem[] = [];
  let visible = 0;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  const lifeTimers = new Set<ReturnType<typeof setTimeout>>();

  function pump(): void {
    if (gapTimer !== null || visible >= maxVisible) return;
    const item = pending.shift();
    if (!item) return;
    visible += 1;
    show(item);
    const life = setTimeout(() => { lifeTimers.delete(life); visible -= 1; pump(); }, lifeMs);
    lifeTimers.add(life);
    gapTimer = setTimeout(() => { gapTimer = null; pump(); }, gapMs);
  }

  return {
    push(item) {
      pending.push(item);
      if (pending.length > maxPending) pending = pending.slice(-maxPending);
      pump();
    },
    clear() {
      pending = [];
      visible = 0;
      if (gapTimer !== null) { clearTimeout(gapTimer); gapTimer = null; }
      lifeTimers.forEach((t) => clearTimeout(t));
      lifeTimers.clear();
    },
  };
}
