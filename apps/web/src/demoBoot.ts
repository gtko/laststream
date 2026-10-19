/*
 * Amorçage du mode démo : AUCUN import, et premier module évalué par main.js. Il détecte `?demo=1` / `#/demo` puis remplace
 * localStorage et sessionStorage par un stockage en mémoire avant que les autres modules lisent quoi que ce soit (session,
 * réglages, préférences, thème...). Le vrai stockage du navigateur n'est ainsi ni lu ni modifié pendant la démo.
 */
export interface DemoFlags {
  on: boolean;
  /** Pas de bandeau « Démo » (captures). */
  clean: boolean;
  /** Profil factice demandé (`profile=leo|sam|alex`). */
  profile: string;
}

const flag = (params: URLSearchParams, name: string): boolean => params.get(name) === '1';

/** Lit l'activation du mode démo dans l'URL : `?demo=1` ou un hash `#/demo`, avec `clean=1` et `profile=` éventuels. */
export function detectDemo(search: string, hash: string): DemoFlags {
  const q = new URLSearchParams(search);
  const h = /^#\/?demo(?:[?&/](.*))?$/.exec(hash);
  const hq = new URLSearchParams(h?.[1] ?? '');
  const on = flag(q, 'demo') || h !== null;
  return {
    on,
    clean: on && (flag(q, 'clean') || flag(hq, 'clean')),
    profile: (q.get('profile') ?? hq.get('profile') ?? '').toLowerCase(),
  };
}

/** Stockage en mémoire (aucune écriture dans le navigateur). */
export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string): void { this.m.delete(k); }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
}

// Évalué une fois, au chargement : l'état n'est jamais relu depuis un stockage.
export const demoState: { flags: DemoFlags } = {
  flags: typeof location === 'undefined' ? { on: false, clean: false, profile: '' } : detectDemo(location.search, location.hash),
};

const KEYS = ['localStorage', 'sessionStorage'] as const;
let saved: Array<[string, PropertyDescriptor | undefined]> | null = null;

/** Remplace localStorage et sessionStorage de la page par des stockages en mémoire. */
export function substituteStorage(): void {
  if (saved) return;
  saved = KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as [string, PropertyDescriptor | undefined]);
  for (const k of KEYS) {
    try {
      Object.defineProperty(globalThis, k, { value: new MemoryStorage(), configurable: true, writable: true });
    } catch {
      // Propriété non remplaçable : la garde réseau et le repli par rechargement restent en place.
    }
  }
}

/** Rend les vrais stockages (tests, et repli quand la démo ne peut pas démarrer). */
export function restoreStorage(): void {
  if (!saved) return;
  for (const [k, d] of saved) {
    try {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    } catch {
      // Rien à restaurer.
    }
  }
  saved = null;
}

if (demoState.flags.on) substituteStorage();
