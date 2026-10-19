import { getLangPrefs, LANG_VO } from '../data/langPrefs';
import { getBandwidthSetting } from '../data/prefs';
import { fetchStreamsResult, fetchStreamStatus, imdbIdOf, planBandwidth, readStoredBandwidth, sortStreams } from '../data/sources';
import type { DeviceTarget } from '../data/sources';
import type { Lang, Stream } from '../data/stream';
import { fetchDeviceStreams, mergeDeviceStreams } from './deviceFetch';
import { browserCaps, inShell } from '../player/caps';
import { applyVerdicts, playableStreams, toSourceViews, withWebPlayback, type SourceView } from './info';
import { CHECK_TOP_N, debrid } from './debridClient';
import { recommend, type Recommendation } from './rank';

/* Chargement des sources d'un titre et recommandation selon le débit et la langue préférée. */

export interface SourceRequest {
  type: 'movie' | 'tv';
  /** Identifiant TMDB. */
  id: string;
  name: string;
  season?: number | null;
  episode?: number | null;
  /** Clé de titre : `movie:550` / `tv:1399`. */
  key: string;
  imdb?: string;
  /** Identifiant de flux de l'épisode selon la structure canonique (`<imdb>:<saison>:<épisode>`) ; sinon calculé. */
  streamId?: string | null;
}

export interface LoadedSources {
  imdb: string;
  views: SourceView[];
  /** Addons Stremio encore interrogés (réponse partielle de lastAddon). */
  pending: string[];
  /** Message du serveur (ex. « Configure AllDebrid ») quand les torrents sont masqués faute de débrideur. */
  notice?: string;
  /** Avancement du repli « via l'appareil » à la construction de cette liste (voir `pollSources`). */
  deviceVersion?: number;
  /** Part du serveur : nombre de flux reçus et sources encore en attente (le reste vient de l'appareil). */
  serverCount?: number;
  serverPending?: string[];
}

const CACHE_MS = 90_000;
const inflight = new Map<string, { at: number; promise: Promise<LoadedSources> }>();
/** Une liste partielle ne reste en cache que quelques secondes. */
const PARTIAL_CACHE_MS = 8_000;

export const requestKey = (req: Pick<SourceRequest, 'type' | 'id' | 'season' | 'episode'>): string =>
  [req.type, req.id, req.season ?? '', req.episode ?? ''].join(':');

/** Attente maximale du contrôle « cache » avant d'afficher la liste : au-delà, statut « à la demande » (le contrôle continue en arrière-plan). */
export const CACHE_CHECK_WAIT_MS = 5_000;

/**
 * Sources « client » (torrents sans lien) : contrôle du cache sur l'appareil pour les N meilleures, statuts combinés des
 * fournisseurs configurés, filtre « seulement en cache » quand le statut est connu. Ne lève jamais.
 */
export async function annotateClientViews(views: SourceView[], opts: { onlyCached?: boolean; waitMs?: number } = {}): Promise<SourceView[]> {
  const clients = views.filter((v) => v.client);
  if (!clients.length) return views;
  const manager = debrid();
  const hashes = clients.slice(0, CHECK_TOP_N).map((v) => v.stream.infoHash ?? '');
  const work = manager.checkCache(hashes).catch(() => null);
  const verdicts = (await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), opts.waitMs ?? CACHE_CHECK_WAIT_MS))])) ?? (await manager.cachedVerdicts(hashes));
  // Les verdicts déjà connus de toutes les sources (cache local), pas seulement des N vérifiées.
  const all = await manager.cachedVerdicts(clients.map((v) => v.stream.infoHash ?? ''));
  for (const [k, v] of verdicts) all.set(k, v);
  const annotated = applyVerdicts(views, all);
  return opts.onlyCached ? annotated.filter((v) => !v.client || all.get((v.stream.infoHash ?? '').toLowerCase())?.cached !== false) : annotated;
}

/** Repli « via l'appareil » d'une recherche : flux déjà reçus des addons que le serveur n'a pas pu joindre, et ceux encore attendus. */
interface DeviceState {
  at: number;
  streams: Stream[];
  pending: string[];
  /** Augmente à chaque addon terminé : signale à `pollSources` qu'il y a du nouveau. */
  version: number;
}
const deviceStates = new Map<string, DeviceState>();

/** Lance (une seule fois par recherche) l'interrogation, depuis l'appareil, des addons listés par le serveur. */
function startDeviceFetch(key: string, targets: readonly DeviceTarget[], now = Date.now()): DeviceState | null {
  const known = deviceStates.get(key);
  if (known && now - known.at < CACHE_MS) return known;
  if (!targets.length) return null;
  const state: DeviceState = { at: now, streams: [], pending: targets.map((t) => t.addonId), version: 0 };
  deviceStates.set(key, state);
  void fetchDeviceStreams(targets, {
    onAddon: (target, streams) => {
      state.streams = mergeDeviceStreams(state.streams, streams);
      const i = state.pending.indexOf(target.addonId);
      if (i >= 0) state.pending.splice(i, 1);
      state.version += 1;
    },
  });
  return state;
}

async function fetchSources(req: SourceRequest): Promise<LoadedSources> {
  const imdb = req.imdb ?? (await imdbIdOf(req.type, req.id));
  if (!imdb) throw new Error('no-imdb');
  // Les torrents sans lien ne sont demandés au serveur que si l'appareil a un débrideur (option avancée).
  const clientOk = debrid().hasAny();
  const res = await fetchStreamsResult(req.type, imdb, req.season, req.episode, { torrents: clientOk, streamId: req.streamId });
  const device = startDeviceFetch(requestKey(req), res.deviceFetch ?? []);
  // Sources lisibles seulement : lien HTTP(S) des addons, jamais un infoHash à lire en pair-à-pair sans débrideur.
  const all = device ? mergeDeviceStreams(res.streams, device.streams) : res.streams;
  const streams = sortStreams(playableStreams(all, clientOk));
  let views = withWebPlayback(toSourceViews(streams), inShell() ? null : browserCaps());
  if (clientOk) views = await annotateClientViews(views, { onlyCached: res.onlyCached });
  return {
    imdb, views,
    pending: [...res.pending, ...(device?.pending ?? [])],
    notice: res.notice,
    ...(device ? { deviceVersion: device.version, serverCount: res.streams.length, serverPending: res.pending } : {}),
  };
}

/**
 * Récupère les streams de lastAddon pour la demande, triés par score, en fiches détaillées. Le résultat (ou la recherche en
 * cours) est gardé 90 s : la préchargée au focus de « Lecture » sert à l'ouverture du lecteur.
 */
export function loadSources(req: SourceRequest, now = Date.now()): Promise<LoadedSources> {
  const key = requestKey(req);
  const hit = inflight.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.promise;
  const promise = fetchSources(req);
  inflight.set(key, { at: now, promise });
  promise.then((r) => {
    // Liste partielle : on la garde peu de temps, la suite arrive par `refreshSources`.
    if (r.pending.length && inflight.get(key)?.promise === promise) inflight.set(key, { at: now - (CACHE_MS - PARTIAL_CACHE_MS), promise });
  }).catch(() => { if (inflight.get(key)?.promise === promise) inflight.delete(key); });
  return promise;
}

/** Lance la recherche en arrière-plan (focus maintenu 1 s sur « Lecture », jamais au survol : voir ui/sources-ui.js). Ne rejette jamais. */
export function prefetchSources(req: SourceRequest): void {
  loadSources(req).catch(() => undefined);
}

export function clearSourceCache(): void { inflight.clear(); deviceStates.clear(); }

/** Recharge la liste sans passer par le cache (et la met en cache pour les appels suivants). */
export async function refreshSources(req: SourceRequest): Promise<LoadedSources> {
  const promise = fetchSources(req);
  inflight.set(requestKey(req), { at: Date.now(), promise });
  return promise;
}

/** La recherche a-t-elle avancé depuis la dernière liste ? (nombre de sources ou sources encore en attente) */
export function statusChanged(known: { count: number; pending: readonly string[] }, status: { count: number; pending: readonly string[] }): boolean {
  return status.count !== known.count || status.pending.length !== known.pending.length;
}

export const POLL_EVERY_MS = 2_000;
export const POLL_MAX_MS = 20_000;

/**
 * Une interrogation de l'état : renvoie la nouvelle liste si la recherche a avancé, la liste actuelle sans `pending` si elle est
 * terminée ou si la route n'existe pas (ancien lastAddon), ou la liste actuelle inchangée.
 */
export async function pollSources(req: SourceRequest, current: LoadedSources): Promise<LoadedSources> {
  if (!current.pending.length) return current;
  const refresh = async (): Promise<LoadedSources> => {
    try {
      return await refreshSources({ ...req, imdb: current.imdb });
    } catch {
      return current;
    }
  };
  // Des addons joints depuis l'appareil ont répondu depuis la dernière liste : on la recompose sans interroger le serveur.
  const device = deviceStates.get(requestKey(req));
  if (device && device.version !== (current.deviceVersion ?? 0)) return refresh();
  const serverPending = current.serverPending ?? current.pending;
  // Le serveur n'a plus rien en attente : seul le repli de l'appareil peut encore faire avancer la liste.
  if (!serverPending.length) return current;
  const status = await fetchStreamStatus(req.type, current.imdb, req.season, req.episode, { torrents: debrid().hasAny(), streamId: req.streamId });
  if (!status) return device?.pending.length ? current : { ...current, pending: [] };
  if (statusChanged({ count: current.serverCount ?? current.views.length, pending: serverPending }, status)) return refresh();
  return current;
}

/**
 * Surveille une recherche partielle : toutes les 2 s (20 s au plus) tant que des sources sont en attente, rappelle `onUpdate`
 * avec la liste complétée et le nombre de sources ajoutées. Renvoie la fonction d'arrêt.
 */
export function watchSources(req: SourceRequest, start: LoadedSources, onUpdate: (next: LoadedSources, added: number) => void, opts: { every?: number; maxMs?: number } = {}): () => void {
  let stopped = false;
  let current = start;
  const t0 = Date.now();
  const every = opts.every ?? POLL_EVERY_MS;
  const maxMs = opts.maxMs ?? POLL_MAX_MS;
  const step = async (): Promise<void> => {
    if (stopped || !current.pending.length || Date.now() - t0 >= maxMs) return;
    const next = await pollSources(req, current);
    if (stopped) return;
    if (next !== current) {
      const added = next.views.length - current.views.length;
      current = next;
      onUpdate(next, Math.max(0, added));
    }
    setTimeout(() => { void step(); }, every);
  };
  setTimeout(() => { void step(); }, every);
  return () => { stopped = true; };
}

const SUPPORTED: readonly Lang[] = ['fr', 'en', 'es', 'de', 'it'];

/**
 * Langue audio visée pour le classement des sources : la langue apprise en mode apprentissage, sinon la langue audio
 * principale des réglages « Audio et sous-titres » (reprend l'ancienne langue des bandes-annonces tant que rien n'est choisi).
 * Une langue que les sources n'annoncent pas (japonais…) ou « version originale » vise les sources en VO.
 */
export function preferredLang(): Lang {
  const lp = getLangPrefs();
  const want = lp.learn && lp.learnLang !== lp.audio ? lp.learnLang : lp.audio;
  if (want === LANG_VO) return 'original';
  return SUPPORTED.includes(want as Lang) ? (want as Lang) : 'original';
}

/** Mode apprentissage : les sources en VO ou multi-audio ne sont pas pénalisées (elles portent l'audio de la langue apprise). */
function alsoAccepted(): readonly Lang[] {
  return getLangPrefs().learn ? ['original', 'multi'] : [];
}

export function recommendFor(views: readonly SourceView[], bwKbps: number | null): Recommendation | null {
  return recommend(views, bwKbps, preferredLang(), { preferDirect: !inShell(), alsoAccept: alsoAccepted() });
}

/** Débit connu sans mesurer (réglage fixe ou mesure récente), sinon null. */
export function knownBandwidthKbps(): number | null {
  const plan = planBandwidth(getBandwidthSetting(), readStoredBandwidth(), Date.now());
  return plan.kind === 'measure' ? null : plan.kbps;
}
