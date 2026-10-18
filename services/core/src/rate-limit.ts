/** Nombre maximal d'entrées gardées avant purge des fenêtres expirées. */
const RATE_TABLE_PRUNE_SIZE = 10_000;

/** Compteur à fenêtre fixe par clé (en mémoire, par processus). Renvoie allowed = false une fois la limite atteinte. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (key: string): { allowed: boolean; retryAfterSec: number } => {
    const current = now();
    if (windows.size > RATE_TABLE_PRUNE_SIZE) {
      for (const [existing, window] of windows) {
        if (window.resetAt <= current) windows.delete(existing);
      }
    }
    let window = windows.get(key);
    if (window === undefined || window.resetAt <= current) {
      window = { count: 0, resetAt: current + windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((window.resetAt - current) / 1000));
    return { allowed: window.count <= limit, retryAfterSec };
  };
}
