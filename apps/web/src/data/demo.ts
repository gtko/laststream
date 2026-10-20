import { demoState, detectDemo, MemoryStorage, restoreStorage, type DemoFlags } from '../demoBoot';
import { auth } from './auth';
import { encodeConfig } from './configApi';
import { PUBLIC_BASE, useMemorySettings } from './config';
import { getServedOrigin } from './serverMode';
import { LocalUserStore, PROFILES_KEY, PROFILE_CURRENT_KEY, setUserStore, type Profile } from './userStore';

/*
 * Mode démo vitrine : navigation du catalogue en lecture seule, sans compte, pour les captures d'écran marketing.
 *  - activé par l'URL seulement (`?demo=1` ou `#/demo`, `clean=1` masque le bandeau) ; jamais enregistré : un rechargement
 *    sans ces paramètres retrouve la connexion normale ;
 *  - localStorage et sessionStorage sont remplacés par un stockage en mémoire dès le premier module (voir demoBoot.ts) :
 *    ni la session ni les préférences d'un vrai utilisateur ne sont lues ou modifiées ;
 *  - garde réseau en liste blanche : vers le serveur, seulement les GET du catalogue public (/lt/tmdb, meta, top10, tv/channels...)
 *    et les fichiers statiques de l'app ; flux, sources, comptes, profils, invitations, parties et écritures sont refusés ;
 *  - lecture désactivée (voir `DEMO_BLOCKED_MSG`).
 */

export { detectDemo };
export type { DemoFlags };

export const isDemo = (): boolean => demoState.flags.on;
/** Tests uniquement. */
export function setDemoFlags(next: DemoFlags): void {
  demoState.flags = next;
}

export const DEMO_BLOCKED_MSG = 'Démo : la lecture est désactivée.';

export const DEMO_PROFILES: Profile[] = [
  { id: 'demo-alex', name: 'Alex', avatarColor: '#ff5a36', isMainProfile: true },
  { id: 'demo-sam', name: 'Sam', avatarColor: '#7b5bf5', isMainProfile: false },
  { id: 'demo-leo', name: 'Léo', avatarColor: '#19c3a6', isKid: true, kidMaxAge: 10, isMainProfile: false },
];

/** Routes lt publiques du catalogue (les seules données autorisées vers le serveur). */
const LT_READ = /^\/[^/]+\/lt\/(?:tmdb\/[^/]+(?:\/[^/]+)*|top10\/[^/]+|mdblist\/[^/]+\/[^/]+|tvdb\/series\/[^/]+|series\/[^/]+\/episodes|meta\/[^/]+\/[^/]+|health|tv\/(?:channels|facets|epg))$/;
/** Fichiers statiques de l'application (build) : racine, ou dossiers publics connus. */
const STATIC = /^\/(?:(?:assets|app|badges|icons)\/[^/][^?#]*|[\w.-]+\.(?:js|mjs|css|png|svg|ico|webp|jpe?g|woff2?|json|webmanifest|map|html|txt|wasm)|)$/;
/** Serveur de développement Vite (modules, HMR) : seulement avec `dev`. */
const DEV_STATIC = /^\/(?:src|@vite|@fs|@id|@react-refresh|node_modules|__vite_ping)(?:\/|$)/;
/** Chemins aux détours classiques (double barre, point-point, séparateurs encodés) : refusés vers le serveur. */
const SNEAKY = /\/\/|\.\.|%2e|%2f|%5c|\\/i;

const rawPath = (s: string): string => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(s);
  return m ? m[1] : s.split(/[?#]/)[0];
};

/**
 * Une requête peut-elle partir en mode démo ? Vers le serveur Laststream ou la page elle-même : liste blanche (GET d'une route
 * de catalogue, ou fichier statique de l'app), après normalisation par `URL` ; tout détour de chemin est refusé.
 * Ailleurs (images, polices, bandes-annonces) : GET seulement.
 */
export function demoAllows(url: string, method: string, bases: readonly string[], dev = false): boolean {
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return false;
  if (/^[/\\]{2}/.test(url)) return false; // adresse relative au protocole : jamais
  let u: URL;
  try {
    u = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href);
  } catch {
    return false;
  }
  const serverish = bases.includes(u.origin) || (typeof location !== 'undefined' && u.origin === location.origin);
  if (!serverish) return true;
  if (SNEAKY.test(rawPath(url)) || SNEAKY.test(u.pathname)) return false;
  if (LT_READ.test(u.pathname)) return true;
  return STATIC.test(u.pathname) || (dev && DEV_STATIC.test(u.pathname));
}

type G = Record<string, any>;
let uninstall: (() => void) | null = null;

/** Rend fetch, XHR, sendBeacon et WebSocket d'origine (tests). */
export function removeGuard(): void {
  uninstall?.();
  uninstall = null;
}

function installGuard(bases: readonly string[], dev: boolean): void {
  if (uninstall) return;
  const g = globalThis as unknown as G;
  const realFetch = g.fetch;
  const xhrProto = g.XMLHttpRequest?.prototype;
  const realOpen = xhrProto?.open;
  const nav = g.navigator;
  const realBeacon = nav?.sendBeacon;
  const realWs = g.WebSocket;
  const ok = (url: string, method: string): boolean => demoAllows(url, method, bases, dev);
  if (realFetch) {
    g.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      const url = req ? req.url : String(input);
      if (!ok(url, init?.method ?? req?.method ?? 'GET')) return Promise.reject(new TypeError('Démo : requête bloquée'));
      return realFetch.call(globalThis, input, init);
    };
  }
  if (xhrProto) {
    xhrProto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      if (!ok(String(url), method)) throw new TypeError('Démo : requête bloquée');
      return realOpen.call(this, method, url, ...rest);
    };
  }
  try { if (nav) nav.sendBeacon = () => false; } catch { /* propriété en lecture seule */ }
  g.WebSocket = class { constructor() { throw new TypeError('Démo : connexion bloquée'); } };
  uninstall = () => {
    if (realFetch) g.fetch = realFetch;
    if (xhrProto) xhrProto.open = realOpen;
    try { if (nav) nav.sendBeacon = realBeacon; } catch { /* rien */ }
    g.WebSocket = realWs;
  };
}

function paintBanner(): void {
  document.body.dataset.demo = '1';
  if (demoState.flags.clean || document.getElementById('demo-banner')) return;
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
 * profils factices en mémoire, garde réseau. Renvoie faux si le serveur ne répond pas : les vrais stockages sont alors
 * rendus et l'appelant recharge la page sans mode démo (connexion normale).
 */
export async function startDemo(): Promise<boolean> {
  const base = getServedOrigin() ?? PUBLIC_BASE;
  const dev = !!(import.meta as any).env?.DEV;
  const local = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  let config: string;
  try {
    config = await encodeConfig({}, undefined, dev && local ? `${location.origin}/_edge` : base);
  } catch {
    restoreStorage();
    return false;
  }
  useMemorySettings({ base, config, mode: 'public', custom: '' });
  const mem = new MemoryStorage();
  const wanted = DEMO_PROFILES.find((p) => p.id === 'demo-' + demoState.flags.profile.replace(/^demo-/, '')) ?? DEMO_PROFILES[0];
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
  installGuard([base, location.origin], dev && local);
  // `#/demo` n'est pas une route de l'application : le hash est vidé (`?demo=1` reste dans l'URL).
  if (/^#\/?demo/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  if (document.body) paintBanner(); else document.addEventListener('DOMContentLoaded', paintBanner, { once: true });
  return true;
}
