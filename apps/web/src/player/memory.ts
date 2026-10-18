/* Choix de pistes mémorisés par titre (série entière ou film) : langue audio, sous-titres. */

export interface TitleMemory {
  /** Code de langue audio (fr, en…). */
  audio?: string;
  /** `off` ou code de langue des sous-titres. */
  sub?: string;
}

export const MEMORY_KEY = 'laststream.player.memory';
const MAX_ENTRIES = 300;

function readAll(): Record<string, TitleMemory> {
  try {
    const raw = globalThis.localStorage?.getItem(MEMORY_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, TitleMemory>) : {};
  } catch {
    return {};
  }
}

export function getMemory(titleKey: string): TitleMemory {
  const m = readAll()[titleKey];
  return m && typeof m === 'object' ? m : {};
}

export function remember(titleKey: string, patch: TitleMemory): void {
  const all = readAll();
  // Le plus récent en dernier ; on garde les 300 derniers titres.
  const merged = { ...(all[titleKey] ?? {}), ...patch };
  delete all[titleKey];
  all[titleKey] = merged;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k];
  try { globalThis.localStorage?.setItem(MEMORY_KEY, JSON.stringify(all)); } catch { /* quota */ }
}
