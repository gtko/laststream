import { auth, isKidProfile, isServerMode } from './auth';
import { UserApiError } from './userApi';
import { getEvening, listEvenings, respondToEvening, type Evening, type EveningEvent, type EveningScope } from './socialV3Api';

/* Soirées planifiées (LAST-199) : une liste par portée (à venir, passées, invitations), chargée page par page, tenue à jour par les
 * trames `evening_*` du canal temps réel (une soirée touchée est relue, jamais de polling). Une génération est capturée avant chaque
 * appel : un changement de profil ou une déconnexion (`resetEvenings`) rend toute réponse en vol caduque. Aucun appel hors compte
 * connecté, ni sur un profil enfant. Le cache sert aussi l'accueil (eveningsHome.ts) : `maxAge` évite de relire à chaque affichage. */

export interface ScopeState {
  items: Evening[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: boolean;
  /** Instant (ms) de la dernière lecture de la première page ; 0 : à relire. */
  at: number;
}

const SCOPES: readonly EveningScope[] = ['upcoming', 'past', 'invites'];
const PAGE = 20;
/** Les invitations se lisent en une page (maximum du serveur). */
const INVITES_PAGE = 50;
/** Durée pendant laquelle une liste déjà lue n'est pas relue (cache de l'accueil et des changements d'onglet). */
export const EVENINGS_MAX_AGE_MS = 30_000;

const fresh = (): ScopeState => ({ items: [], nextCursor: null, loaded: false, loading: false, error: false, at: 0 });
const freshAll = (): Record<EveningScope, ScopeState> => ({ upcoming: fresh(), past: fresh(), invites: fresh() });

let lists = freshAll();
let gen = 0;
const flights = new Map<EveningScope, Promise<void>>();
const stamps: Record<EveningScope, number> = { upcoming: 0, past: 0, invites: 0 };
const subs = new Set<() => void>();

const emit = (): void => {
  subs.forEach((fn) => {
    try { fn(); } catch { /* un écouteur ne casse pas le magasin */ }
  });
};

/** Vrai si les soirées existent pour le profil actif : compte connecté, profil adulte. */
export const eveningsAvailable = (): boolean => isServerMode() && !isKidProfile() && !!auth.profile;

export const getEveningList = (scope: EveningScope): ScopeState => lists[scope];

export function subscribeEvenings(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** Vide tout (déconnexion, changement de profil) : les réponses en vol sont ignorées. */
export function resetEvenings(): void {
  gen++;
  flights.clear();
  lists = freshAll();
  emit();
}

/**
 * Lit une portée. Sans `more`, relit la première page (sauf si elle est récente : `maxAge`, ou `force`) ; avec `more`, ajoute la
 * page suivante. Un appel identique en vol est partagé. Une invalidation pendant la lecture (trame reçue) relance une lecture.
 */
export function loadEvenings(scope: EveningScope, o: { more?: boolean; force?: boolean; maxAge?: number } = {}): Promise<void> {
  if (!eveningsAvailable()) return Promise.resolve();
  const cur = lists[scope];
  if (o.more) {
    if (!cur.nextCursor || cur.loading) return flights.get(scope) ?? Promise.resolve();
  } else {
    const inflight = flights.get(scope);
    if (inflight) return inflight;
    if (!o.force && cur.loaded && !cur.error && Date.now() - cur.at < (o.maxAge ?? EVENINGS_MAX_AGE_MS)) return Promise.resolve();
  }
  const g = gen;
  const stamp = stamps[scope];
  const cursor = o.more ? cur.nextCursor ?? undefined : undefined;
  lists[scope] = { ...cur, loading: true, error: false };
  emit();
  const run = (async () => {
    try {
      const page = await listEvenings(scope, { cursor, limit: scope === 'invites' ? INVITES_PAGE : PAGE });
      if (g !== gen) return;
      if (!Array.isArray(page?.items)) throw new Error('page');
      const prev = lists[scope];
      const seen = new Set(prev.items.map((e) => e.id));
      const items = o.more ? [...prev.items, ...page.items.filter((e) => !seen.has(e.id))] : page.items;
      lists[scope] = { items, nextCursor: page.nextCursor ?? null, loaded: true, loading: false, error: false, at: o.more ? prev.at : Date.now() };
    } catch {
      if (g !== gen) return;
      lists[scope] = { ...lists[scope], loading: false, error: true };
    }
    flights.delete(scope);
    emit();
    if (stamps[scope] !== stamp && !o.more) void loadEvenings(scope, { force: true });
  })();
  if (!o.more) flights.set(scope, run);
  return run;
}

/** Marque les portées déjà lues comme périmées et relit la première page de chacune (invitation reçue, soirée inconnue de la liste). */
export function reloadEvenings(): void {
  for (const scope of SCOPES) {
    stamps[scope]++;
    if (lists[scope].loaded) {
      lists[scope] = { ...lists[scope], at: 0 };
      void loadEvenings(scope, { force: true });
    }
  }
}

const has = (id: string): boolean => SCOPES.some((s) => lists[s].items.some((e) => e.id === id));

function removeEvening(id: string): void {
  for (const scope of SCOPES) lists[scope] = { ...lists[scope], items: lists[scope].items.filter((e) => e.id !== id) };
  emit();
}

/** Remplace la soirée là où elle figure ; elle quitte « invitations » dès que j'y ai répondu ou qu'elle est annulée. */
function applyEvening(e: Evening): void {
  for (const scope of SCOPES) {
    const l = lists[scope];
    if (!l.items.some((x) => x.id === e.id)) continue;
    const gone = scope === 'invites' && (e.myResponse !== 'pending' || e.status === 'cancelled');
    lists[scope] = { ...l, items: gone ? l.items.filter((x) => x.id !== e.id) : l.items.map((x) => (x.id === e.id ? e : x)) };
  }
  emit();
}

/** Relit une soirée et la met à jour dans les listes ; 404 : elle n'existe plus pour ce profil. */
export async function refreshEvening(id: string): Promise<void> {
  if (!eveningsAvailable()) return;
  const g = gen;
  try {
    const e = await getEvening(id);
    if (g !== gen) return;
    if (has(id)) applyEvening(e);
    else reloadEvenings();
  } catch (err) {
    if (g !== gen) return;
    if (err instanceof UserApiError && err.status === 404) removeEvening(id);
  }
}

/**
 * Trame `evening_*` : une invitation relit les listes, une mise à jour, une réponse ou l'ouverture du salon relit la soirée,
 * un rappel redessine seulement (la fenêtre « Ouvrir le salon » s'ouvre à T-15 min). Sans liste lue, rien à tenir à jour.
 */
export function handleEveningEvent(ev: EveningEvent): void {
  if (!eveningsAvailable() || !SCOPES.some((s) => lists[s].loaded)) return;
  switch (ev.type) {
    case 'evening_invite':
      reloadEvenings();
      return;
    case 'evening_reminder':
      emit();
      return;
    case 'evening_update':
    case 'evening_response':
    case 'evening_open':
      void refreshEvening(ev.eveningId);
      return;
    default:
      // trame d'un type inconnu : ignorée
  }
}

/** Ma réponse à une soirée, puis relecture de la soirée ; rend vrai si le serveur l'a acceptée. */
export async function answerEvening(id: string, response: 'yes' | 'maybe' | 'no'): Promise<boolean> {
  if (!eveningsAvailable()) return false;
  const g = gen;
  try {
    await respondToEvening(id, response);
  } catch {
    return false;
  }
  if (g === gen) await refreshEvening(id);
  return true;
}

/** Remplace une soirée déjà connue par sa version rendue par le serveur (ouverture du salon). */
export function putEvening(e: Evening): void {
  if (has(e.id)) applyEvening(e);
}

/** La soirée `id` telle que les listes la tiennent (première portée où elle figure), ou `undefined`. */
export function findEvening(id: string): Evening | undefined {
  for (const scope of SCOPES) {
    const e = lists[scope].items.find((x) => x.id === id);
    if (e) return e;
  }
  return undefined;
}

/**
 * Exécute une écriture (création, modification, annulation…) puis relit ce qu'elle a touché : la soirée `id`, ou toutes les listes
 * lues si `id` manque (série, création). Rend faux si le profil a changé pendant l'appel : l'appelant n'écrit alors plus rien.
 * Une erreur est relancée à l'appelant ; avec `id`, la soirée est relue quand même (une modification peut être partielle).
 */
export async function commitEvening(run: () => Promise<unknown>, id?: string): Promise<boolean> {
  if (!eveningsAvailable()) return false;
  const g = gen;
  try {
    await run();
  } catch (err) {
    if (id && g === gen) void refreshEvening(id);
    throw err;
  }
  if (g !== gen) return false;
  if (id) await refreshEvening(id);
  else reloadEvenings();
  return g === gen;
}
