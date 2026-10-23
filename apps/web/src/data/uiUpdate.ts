import { updateSupported } from './appUpdate';

/* Mise à jour de l'interface (Windows/WebView2 et web) : le Worker sert l'UI et publie /version.json ({build}) à chaque déploiement,
 * la bannière propose de recharger quand il diffère du build embarqué (__BUILD_ID__). Logique pure, réseau/horloge/stockage injectés. */

export const SNOOZE_MS = 6 * 60 * 60 * 1000;
const SNOOZE_KEY = 'laststream.uiupdate.snooze';
const FETCH_TIMEOUT_MS = 8000;
const RELOAD_PARAM = '_ls';

/** Build embarqué ; 'dev' en développement et en test (aucune bannière). */
export const currentBuild = (): string => (typeof __BUILD_ID__ === 'string' && __BUILD_ID__ ? __BUILD_ID__ : 'dev');

/** Le mécanisme ne vaut ni pour Android natif (bannière APK) ni pour un build de développement. */
export const uiUpdateActive = (): boolean => !updateSupported() && currentBuild() !== 'dev';

/** Build déployé, ou null sans bruit (réseau, statut, JSON invalide, repli SPA renvoyant index.html). */
export async function fetchDeployedBuild(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`/version.json?t=${Date.now()}`, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const build = body && typeof body === 'object' ? (body as { build?: unknown }).build : undefined;
    return typeof build === 'string' && build ? build : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const hasNewBuild = (current: string, deployed: string | null): boolean =>
  deployed !== null && current !== 'dev' && deployed !== current;

export interface Snooze { build: string; until: number }

export function readSnooze(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Snooze | null {
  try {
    const o = JSON.parse(storage?.getItem(SNOOZE_KEY) ?? 'null') as Partial<Snooze> | null;
    return o && typeof o.build === 'string' && typeof o.until === 'number' ? { build: o.build, until: o.until } : null;
  } catch {
    return null;
  }
}

/** « Plus tard » : masque CE build pendant 6 h ; un build encore plus récent réaffiche tout de suite. */
export function snoozeBuild(build: string, now: number = Date.now(), storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(SNOOZE_KEY, JSON.stringify({ build, until: now + SNOOZE_MS })); } catch { /* réglage perdu : la bannière reviendra */ }
}

export const isSnoozed = (snooze: Snooze | null, deployed: string, now: number): boolean =>
  !!snooze && snooze.build === deployed && snooze.until > now;

export const shouldShowBanner = (current: string, deployed: string | null, notify: boolean, snooze: Snooze | null, now: number): boolean =>
  notify && hasNewBuild(current, deployed) && !isSnoozed(snooze, deployed as string, now);

/** Même adresse (chemin, requête, route #/…) avec un paramètre `_ls` neuf, qui contourne le cache HTTP. */
export function reloadUrl(href: string, now: number = Date.now()): string {
  const u = new URL(href);
  u.searchParams.set(RELOAD_PARAM, String(now));
  return u.toString();
}

/** Au démarrage : retire `_ls` de l'adresse affichée sans toucher au reste ni à l'historique. */
export function stripReloadParam(loc: Pick<Location, 'href'> = location, hist: Pick<History, 'replaceState' | 'state'> = history): void {
  try {
    const u = new URL(loc.href);
    if (!u.searchParams.has(RELOAD_PARAM)) return;
    u.searchParams.delete(RELOAD_PARAM);
    hist.replaceState(hist.state, '', u.pathname + u.search + u.hash);
  } catch { /* adresse inattendue : on laisse telle quelle */ }
}

export interface ApplyDeps {
  caches?: Pick<CacheStorage, 'keys' | 'delete'>;
  serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistrations'>;
  replace?: (url: string) => void;
  href?: string;
  now?: number;
}

/** Vide les caches, désinscrit les service workers (chaque étape tolère l'échec) puis recharge la même page. */
export async function applyUpdate(deps: ApplyDeps = {}): Promise<void> {
  const cs = 'caches' in deps ? deps.caches : globalThis.caches;
  try { if (cs) await Promise.all((await cs.keys()).map((k) => cs.delete(k))); } catch { /* cache indisponible */ }
  const sw = 'serviceWorker' in deps ? deps.serviceWorker : globalThis.navigator?.serviceWorker;
  try {
    if (sw) await Promise.all((await sw.getRegistrations()).map((r) => r.unregister()));
  } catch { /* pas de service worker */ }
  const href = deps.href ?? location.href;
  const target = reloadUrl(href, deps.now);
  if (deps.replace) deps.replace(target); else location.replace(target);
}
