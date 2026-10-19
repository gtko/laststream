import { auth } from './auth';
import { encodeConfig } from './configApi';
import { PUBLIC_BASE, useMemorySettings } from './config';
import { getServedOrigin } from './serverMode';
import { LocalUserStore, PROFILES_KEY, PROFILE_CURRENT_KEY, setUserStore, type Profile } from './userStore';

/*
 * Mode démo vitrine : navigation du catalogue en lecture seule, sans compte, pour les captures d'écran marketing.
 *  - activé par l'URL seulement (`?demo=1` ou `#/demo`, `clean=1` masque le bandeau) ; jamais enregistré : un rechargement
 *    sans ces paramètres retrouve la connexion normale ;
 *  - réglages et données (profils factices Alex, Sam, Léo) en mémoire, aucune écriture dans le stockage du compte ;
 *  - garde réseau : seules les routes publiques du catalogue (GET /lt/tmdb, meta, top10, tv/channels...) partent vers le
 *    serveur ; flux, sources, comptes, profils, invitations, parties et écritures sont refusés ;
 *  - lecture désactivée (voir `demoBlocked`).
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

// Évalué une fois, au chargement : l'état n'est jamais relu depuis un stockage.
let flags: DemoFlags = typeof location === 'undefined' ? { on: false, clean: false, profile: '' } : detectDemo(location.search, location.hash);

export const isDemo = (): boolean => flags.on;
export const isDemoClean = (): boolean => flags.clean;
/** Tests uniquement. */
export function setDemoFlags(next: DemoFlags): void {
  flags = next;
}

export const DEMO_BLOCKED_MSG = 'Démo : la lecture est désactivée.';

export const DEMO_PROFILES: Profile[] = [
  { id: 'demo-alex', name: 'Alex', avatarColor: '#ff5a36', isMainProfile: true },
  { id: 'demo-sam', name: 'Sam', avatarColor: '#7b5bf5', isMainProfile: false },
  { id: 'demo-leo', name: 'Léo', avatarColor: '#19c3a6', isKid: true, kidMaxAge: 10, isMainProfile: false },
];

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

/** Routes lt publiques du catalogue (les seules autorisées vers le serveur). */
const LT_READ = /^\/[^/]+\/lt\/(?:tmdb\/.+|top10\/[^/]+|mdblist\/[^/]+\/[^/]+|tvdb\/series\/[^/]+|series\/[^/]+\/episodes|meta\/[^/]+\/[^/]+|health|tv\/(?:channels|facets|epg))$/;

/** Routes du serveur qui ne sont jamais ouvertes en démo (hors celles de LT_READ). */
const RESERVED = /^\/(?:[^/]+\/)?(?:lt|stream|catalog|manifest\.json|user|party|admin|config|health)(?:\/|$)/;

/**
 * Une requête peut-elle partir en mode démo ? Vers le serveur Laststream : GET d'une route de catalogue seulement
 * (jamais flux, TV HLS, sources, /user, /party, /admin, /config, ni POST). Ailleurs (images, polices, bandes-annonces) : GET.
 */
export function demoAllows(url: string, method: string, bases: readonly string[]): boolean {
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return false;
  let u: URL;
  try {
    u = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href);
  } catch {
    return false;
  }
  const serverish = bases.includes(u.origin) || (typeof location !== 'undefined' && u.origin === location.origin);
  if (!serverish) return true;
  if (LT_READ.test(u.pathname)) return true;
  // Serveur ou page elle-même : ressources statiques de l'app seulement, jamais une route de données.
  return !RESERVED.test(u.pathname);
}

function installGuard(bases: readonly string[]): void {
  const g = globalThis as unknown as Record<string, any>;
  const realFetch = g.fetch?.bind(globalThis) as typeof fetch | undefined;
  if (realFetch) {
    g.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      const url = req ? req.url : String(input);
      const method = init?.method ?? req?.method ?? 'GET';
      if (!demoAllows(url, method, bases)) return Promise.reject(new TypeError('Démo : requête bloquée'));
      return realFetch(input as RequestInfo, init);
    };
  }
  const Xhr = g.XMLHttpRequest?.prototype;
  if (Xhr) {
    const open = Xhr.open;
    Xhr.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      if (!demoAllows(String(url), method, bases)) throw new TypeError('Démo : requête bloquée');
      return open.call(this, method, url, ...rest);
    };
  }
  try { if (g.navigator) g.navigator.sendBeacon = () => false; } catch { /* propriété en lecture seule */ }
  g.WebSocket = class { constructor() { throw new TypeError('Démo : connexion bloquée'); } };
}

function paintBanner(): void {
  document.body.dataset.demo = '1';
  if (flags.clean || document.getElementById('demo-banner')) return;
  const el = document.createElement('div');
  el.id = 'demo-banner';
  el.textContent = 'Démo';
  el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;padding:3px 10px;border-radius:999px;' +
    'font:600 11px/1.6 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#fff;' +
    'background:rgba(0,0,0,.55);pointer-events:none';
  document.body.appendChild(el);
}

/**
 * Installe le mode démo (avant la connexion). Config publique générée à la volée (POST /config/encode, sans compte),
 * profils factices en mémoire, garde réseau. Renvoie faux si le serveur ne répond pas (l'app retombe alors sur la connexion).
 */
export async function startDemo(): Promise<boolean> {
  const base = getServedOrigin() ?? PUBLIC_BASE;
  const dev = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && (import.meta as any).env?.DEV;
  let config: string;
  try {
    config = await encodeConfig({}, undefined, dev ? `${location.origin}/_edge` : base);
  } catch {
    return false;
  }
  useMemorySettings({ base, config, mode: 'public', custom: '' });
  const mem = new MemoryStorage();
  const wanted = DEMO_PROFILES.find((p) => p.id === 'demo-' + flags.profile.replace(/^demo-/, '')) ?? DEMO_PROFILES[0];
  mem.setItem(PROFILES_KEY, JSON.stringify(DEMO_PROFILES));
  mem.setItem(PROFILE_CURRENT_KEY, wanted.id);
  setUserStore(new LocalUserStore(mem));
  // Statut 'local' : aucune fonction de compte (amis, parties, invitations, synchronisation serveur) n'est proposée.
  auth.status = 'local';
  auth.username = '';
  auth.accountId = '';
  auth.isOwner = false;
  auth.profiles = DEMO_PROFILES;
  auth.profile = wanted;
  installGuard([base, `${location.origin}`]);
  // `#/demo` n'est pas une route de l'application : le hash est vidé (`?demo=1` reste dans l'URL).
  if (/^#\/?demo/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  if (document.body) paintBanner(); else document.addEventListener('DOMContentLoaded', paintBanner, { once: true });
  return true;
}
