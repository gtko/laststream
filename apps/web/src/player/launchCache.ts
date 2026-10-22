import type { Stream } from '../data/stream';
import type { SourceView } from '../sources/info';
import { webCompatOf, type WebCompatContext } from '../sources/webCompat';

/* Relance d'un épisode déjà lancé (ODY-206) : la source qui a démarré est mémorisée sur cet appareil, la relance la reprend sans
 * refaire la recherche. On garde la source (identité du flux), jamais un lien débridé : le lien est résolu sur l'appareil à
 * chaque lancement (et réutilisé 1 h par le débrideur). Aucun appel serveur, aucun débrideur appelé d'ici. */

const KEY = 'laststream.player.launch.v1';
/** Durée de vie d'une source mémorisée : au-delà, les liens des addons ont pu changer ou expirer. */
export const LAUNCH_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 30;

export interface LaunchEntry {
  at: number;
  /** Identité de la source (voir `sourceKey`) : sert à ne retirer l'entrée que si c'est bien cette source qui échoue. */
  source: string;
  stream: Stream;
  imdb: string;
  /** Langue de source préférée au moment du lancement : si elle change, la source mémorisée n'est plus la bonne. */
  lang: string;
}

type Store = Record<string, LaunchEntry>;

const isEntry = (v: unknown): v is LaunchEntry => {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.at === 'number' && typeof e.source === 'string' && typeof e.imdb === 'string' && typeof e.lang === 'string'
    && !!e.stream && typeof e.stream === 'object';
};

function read(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Store = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) if (isEntry(e)) out[k] = e;
    return out;
  } catch {
    return {};
  }
}

function write(all: Store): void {
  try {
    const keys = Object.keys(all);
    // On ne garde que les plus récentes.
    const keep = keys.sort((a, b) => all[b].at - all[a].at).slice(0, MAX_ENTRIES);
    const out: Store = {};
    for (const k of keep) out[k] = all[k];
    globalThis.localStorage?.setItem(KEY, JSON.stringify(out));
  } catch { /* stockage indisponible ou plein : la relance refera la recherche */ }
}

/** Mémorise la source qui vient de démarrer pour cet épisode (`episode` : clé `type:id:saison:épisode`). */
export function rememberLaunch(episode: string, entry: Omit<LaunchEntry, 'at'>, now = Date.now()): void {
  const all = read();
  all[episode] = { ...entry, at: now };
  write(all);
}

/** Source mémorisée pour cet épisode si elle a moins de 6 h et correspond à la langue préférée actuelle ; sinon null (et l'entrée périmée est retirée). */
export function recallLaunch(episode: string, lang: string, now = Date.now()): LaunchEntry | null {
  const all = read();
  const e = all[episode];
  if (!e) return null;
  if (now - e.at >= LAUNCH_TTL_MS || e.at > now + 60_000 || e.lang !== lang) {
    delete all[episode];
    write(all);
    return null;
  }
  return e;
}

/** Retire l'entrée de cet épisode ; avec `source`, seulement si c'est cette source (une autre, plus récente, reste). */
export function forgetLaunch(episode: string, source?: string): void {
  const all = read();
  const e = all[episode];
  if (!e || (source !== undefined && e.source !== source)) return;
  delete all[episode];
  write(all);
}

export function clearLaunchCache(): void {
  try { globalThis.localStorage?.removeItem(KEY); } catch { /* stockage indisponible */ }
}

/** Index de la fiche reconstruite depuis la mémoire tant qu'elle n'est pas dans la liste chargée : ne peut entrer en collision avec aucune source. */
export const MEMORY_INDEX = -1;

/**
 * La liste complète est arrivée : la source mémorisée `mine` est remplacée par sa fiche de la liste (même identité, `keyOf`), avec
 * ses indices déjà essayés remappés ; absente de la liste, elle reste telle quelle (index `MEMORY_INDEX`, hors liste).
 */
export function reconcileLaunch<V extends { index: number }>(mine: V, loaded: readonly V[], keyOf: (v: V) => string, tried: ReadonlySet<number>): { view: V; tried: Set<number> } {
  const key = keyOf(mine);
  const view = loaded.find((v) => keyOf(v) === key) ?? mine;
  return { view, tried: new Set([...tried].map((i) => (i === mine.index ? view.index : i))) };
}

export interface LaunchCheck {
  compat: WebCompatContext;
  /** Un débrideur est configuré sur l'appareil (les sources sans lien en ont besoin). */
  hasDebrid: boolean;
  /** Sources mémorisées comme lentes ou en échec pour cet épisode (voir `badSources`). */
  bad: ReadonlySet<string>;
  keyOf: (v: SourceView) => string;
}

/**
 * La source mémorisée peut-elle être relancée telle quelle ? Non si elle n'est plus lisible, si elle a besoin d'un débrideur qui n'est
 * plus configuré, si elle a été marquée lente ou en échec depuis, ou si elle ne passerait plus dans ce navigateur (ODY-189) :
 * la relance fait alors la recherche complète.
 */
export function launchUsable(view: SourceView, c: LaunchCheck): boolean {
  if (!view.playable) return false;
  if (view.client && !c.hasDebrid) return false;
  if (c.bad.has(c.keyOf(view))) return false;
  return webCompatOf(view, c.compat).level === 'ok';
}
