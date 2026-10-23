import { getLangPrefs, LANG_VO, type LangPrefs } from '../data/langPrefs';
import { NoImdbError, resolveImdbId } from '../data/imdbResolve';
import { getBandwidthSetting } from '../data/prefs';
import { fetchStreamsResult, fetchStreamStatus, planBandwidth, readStoredBandwidth, sortStreams } from '../data/sources';
import type { DeviceTarget } from '../data/sources';
import type { Lang, Stream } from '../data/stream';
import { deviceAddonName, fetchDeviceStreams, mergeDeviceStreams } from './deviceFetch';
import { browserCaps, inShell } from '../player/caps';
import { serverLikelyUp } from '../player/server';
import { rangeDenied } from './hostRange';
import { webCompatOf, type WebCompatContext } from './webCompat';
import { applyVerdicts, playableStreams, toSourceViews, withWebPlayback, type SourceView } from './info';
import { CHECK_TOP_N, debrid } from './debridClient';
import { recommend, type Recommendation } from './rank';
import { currentCapHeight } from './resolutionCap';

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
  /** Film pas encore disponible en numérique : aucune source proposée (`views` vide), message à la place. */
  notYetDigital?: boolean;
  digitalDate?: string;
  /** Part du serveur : nombre de flux reçus et sources encore en attente (le reste vient de l'appareil). */
  serverCount?: number;
  serverPending?: string[];
}

const CACHE_MS = 90_000;
const inflight = new Map<string, { at: number; promise: Promise<LoadedSources> }>();
/** Une liste partielle ne reste en cache que quelques secondes. */
const PARTIAL_CACHE_MS = 8_000;
/** Une liste vide (aucune source, rien en attente) ne reste en cache que 60 s : un addon peut répondre vide avant la sortie. */
const EMPTY_CACHE_MS = 60_000;

/**
 * Raccourcit la durée de vie du résultat selon son contenu : partielle 8 s, vide 60 s, complète 90 s (inchangée).
 * Une liste vide où l'appareil a été interrogé n'est pas gardée du tout : la prochaine recherche réinterroge l'appareil.
 */
function shortenCache(key: string, promise: Promise<LoadedSources>, now: number): void {
  promise.then((r) => {
    if (inflight.get(key)?.promise !== promise) return;
    if (r.pending.length === 0 && r.views.length === 0 && r.deviceVersion !== undefined) {
      inflight.delete(key);
      return;
    }
    const ttl = r.pending.length ? PARTIAL_CACHE_MS : r.views.length === 0 ? EMPTY_CACHE_MS : undefined;
    if (ttl !== undefined) inflight.set(key, { at: now - (CACHE_MS - ttl), promise });
  }).catch(() => { if (inflight.get(key)?.promise === promise) inflight.delete(key); });
}

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

/**
 * Lance (une seule fois par recherche) l'interrogation, depuis l'appareil, des addons listés par le serveur. Un appareil
 * terminé sans aucun flux (addon lent, hors délai) n'est pas repris tel quel : `retry` (recherche demandée par l'utilisateur)
 * le réinterroge ; le rafraîchissement automatique (`pollSources`) le garde pour ne pas boucler.
 */
function startDeviceFetch(key: string, targets: readonly DeviceTarget[], now = Date.now(), retry = false): DeviceState | null {
  const known = deviceStates.get(key);
  const finishedEmpty = known !== undefined && known.pending.length === 0 && known.streams.length === 0;
  if (known && now - known.at < CACHE_MS && !(retry && finishedEmpty)) return known;
  if (!targets.length) return null;
  const state: DeviceState = { at: now, streams: [], pending: targets.map(deviceAddonName), version: 0 };
  deviceStates.set(key, state);
  void fetchDeviceStreams(targets, {
    onAddon: (target, streams) => {
      state.streams = mergeDeviceStreams(state.streams, streams);
      const i = state.pending.indexOf(deviceAddonName(target));
      if (i >= 0) state.pending.splice(i, 1);
      state.version += 1;
    },
  });
  return state;
}

/** Fiche d'une source déjà connue (relance d'un épisode, ODY-206) : mêmes capacités web que dans `fetchSources`, sans contrôle du cache débrideur. */
export function viewFromStream(stream: Stream): SourceView {
  return withWebPlayback(toSourceViews([stream]), inShell() ? null : browserCaps(), { appAudio: !inShell() && !serverLikelyUp() })[0];
}

async function fetchSources(req: SourceRequest, retry: boolean): Promise<LoadedSources> {
  let imdb = req.imdb;
  if (!imdb) {
    const found = await resolveImdbId(req.type, req.id);
    // Étape en erreur (réseau, 5xx) : absence non établie, le sélecteur affiche l'erreur de chargement générique.
    if (!found.imdb && found.failed) throw new Error('imdb-lookup-failed');
    if (!found.imdb) throw new NoImdbError(found.tried);
    imdb = found.imdb;
  }
  // Les torrents sans lien ne sont demandés au serveur que si l'appareil a un débrideur (option avancée).
  const clientOk = debrid().hasAny();
  const res = await fetchStreamsResult(req.type, imdb, req.season, req.episode, { torrents: clientOk, streamId: req.streamId });
  // Film pas encore sorti en numérique : aucune source (les releases restantes ne sont pas fiables), pas d'appel à l'appareil.
  const yet = res.notYetDigital === true;
  const device = yet ? undefined : startDeviceFetch(requestKey(req), res.deviceFetch ?? [], Date.now(), retry);
  // Sources lisibles seulement : lien HTTP(S) des addons, jamais un infoHash à lire en pair-à-pair sans débrideur.
  const all = device ? mergeDeviceStreams(res.streams, device.streams) : res.streams;
  const streams = yet ? [] : sortStreams(playableStreams(all, clientOk));
  // Web sans serveur de streaming : le son AC-3 / E-AC-3 est décodé par l'app (moteur audio de repli), le DTS ne l'est pas.
  let views = withWebPlayback(toSourceViews(streams), inShell() ? null : browserCaps(), { appAudio: !inShell() && !serverLikelyUp() });
  if (clientOk) views = await annotateClientViews(views, { onlyCached: res.onlyCached });
  return {
    imdb, views,
    pending: [...res.pending, ...(device?.pending ?? [])],
    notice: res.notice,
    ...(yet ? { notYetDigital: true, ...(res.digitalDate !== undefined ? { digitalDate: res.digitalDate } : {}) } : {}),
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
  const promise = fetchSources(req, true);
  inflight.set(key, { at: now, promise });
  shortenCache(key, promise, now);
  return promise;
}

/** Lance la recherche en arrière-plan (focus maintenu 1 s sur « Lecture », jamais au survol : voir ui/sources-ui.js). Ne rejette jamais. */
export function prefetchSources(req: SourceRequest): void {
  loadSources(req).catch(() => undefined);
}

export function clearSourceCache(): void { inflight.clear(); deviceStates.clear(); }

/** Recharge la liste sans passer par le cache (et la met en cache pour les appels suivants). */
export async function refreshSources(req: SourceRequest): Promise<LoadedSources> {
  const now = Date.now();
  const promise = fetchSources(req, false);
  inflight.set(requestKey(req), { at: now, promise });
  shortenCache(requestKey(req), promise, now);
  return promise;
}

/** La recherche a-t-elle avancé depuis la dernière liste ? (nombre de sources ou sources encore en attente) */
export function statusChanged(known: { count: number; pending: readonly string[] }, status: { count: number; pending: readonly string[] }): boolean {
  return status.count !== known.count || status.pending.length !== known.pending.length;
}

export const POLL_EVERY_MS = 2_000;
export const POLL_MAX_MS = 20_000;
/** Fenêtre de grâce après la première source lisible (lien HTTP) : le reste de la recherche n'est pas attendu. */
export const LAUNCH_GRACE_MS = 2_500;
/** Délai global, depuis le début de l'attente, au-delà duquel on lance dès qu'une source lisible existe. */
export const LAUNCH_MAX_MS = 8_000;

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

/** Attend `work` au plus tard à `at` (epoch ms) : null si le délai est écoulé d'abord. */
function until<T>(work: Promise<T>, at: number): Promise<T | null> {
  return Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, at - Date.now())))]);
}

export interface LaunchOptions {
  request: SourceRequest;
  /** Début de l'attente (epoch ms) : le délai global court depuis là. Par défaut : maintenant. */
  since?: number;
  /** Une source lisible sans attendre existe-t-elle déjà (lien HTTP(S), pas un torrent) ? */
  readable: (views: readonly SourceView[]) => boolean;
  /** Recommandation parmi les sources reçues. */
  recommend: (views: readonly SourceView[]) => Recommendation | null;
  /** La recommandation satisfait les préférences : on lance sans attendre. */
  good: (rec: Recommendation | null) => boolean;
  /** Vrai pour interrompre l'attente (session fermée, « Choisir moi-même »). */
  stop?: () => boolean;
  /** Liste complétée pendant l'attente. */
  onUpdate?: (next: LoadedSources) => void;
  /** Avant chaque pause : l'écran de chargement affiche l'état courant. */
  onWait?: (cur: LoadedSources, rec: Recommendation | null) => void;
}

export interface LaunchChoice {
  loaded: LoadedSources;
  rec: Recommendation | null;
}

/**
 * Attente avant lancement. Une recommandation qui satisfait les préférences part tout de suite. Sinon, dès qu'une source lisible
 * est là, on attend la fenêtre de grâce (2,5 s), sans dépasser 8 s depuis `since` ; sans source lisible, on attend le délai
 * existant (20 s). La recherche qui reste n'est pas attendue : `loaded` renferme ce qui est reçu à cet instant.
 */
export async function awaitLaunchable(start: LoadedSources, opts: LaunchOptions): Promise<LaunchChoice> {
  const t0 = opts.since ?? Date.now();
  let cur = start;
  let rec = opts.recommend(cur.views);
  let readableAt = 0;
  while (!opts.stop?.() && cur.pending.length && !opts.good(rec)) {
    const now = Date.now();
    if (!readableAt && opts.readable(cur.views)) readableAt = now;
    const deadline = readableAt ? Math.min(readableAt + LAUNCH_GRACE_MS, t0 + LAUNCH_MAX_MS) : t0 + POLL_MAX_MS;
    if (now >= deadline) break;
    opts.onWait?.(cur, rec);
    await new Promise((r) => setTimeout(r, Math.min(POLL_EVERY_MS, deadline - now)));
    if (opts.stop?.()) break;
    const next = await until(pollSources(opts.request, cur).catch(() => cur), deadline);
    if (next && next !== cur) {
      cur = next;
      rec = opts.recommend(cur.views);
      opts.onUpdate?.(cur);
    }
  }
  return { loaded: cur, rec };
}

const SUPPORTED: readonly Lang[] = ['fr', 'en', 'es', 'de', 'it'];

/**
 * Langue visée par le classement des sources, selon les préférences de langue :
 * - langue (apprise ou principale) que les sources annoncent (fr, en, es, de, it) : elle-même ;
 * - « version originale » : `original` ;
 * - langue apprise que les sources n'annoncent pas (japonais, coréen…) : `original` si le titre est dans cette langue
 *   (`originalLang`, code à deux lettres), sinon `multi` (les sources multi-audio portent la langue apprise) ;
 * - langue principale non gérée hors apprentissage : `original`.
 */
export function sourceLangFor(lp: LangPrefs, originalLang?: string): Lang {
  const learning = lp.learn && lp.learnLang !== lp.audio;
  const want = learning ? lp.learnLang : lp.audio;
  if (want === LANG_VO) return 'original';
  if (SUPPORTED.includes(want as Lang)) return want as Lang;
  if (!learning) return 'original';
  return originalLang?.trim().toLowerCase() === want ? 'original' : 'multi';
}

/**
 * Langues audio à viser sur les pistes (codes de langue, jamais le libellé de classement des sources `original` / `multi`) :
 * le choix mémorisé pour le titre d'abord, puis, en mode apprentissage, la langue apprise (`ja`, `ko`…) ; hors apprentissage,
 * la langue du classement des sources, comme avant.
 */
export function audioLangsFor(lp: LangPrefs, remembered?: string, originalLang?: string): string[] {
  const learning = lp.learn && lp.learnLang !== lp.audio;
  return [remembered, learning ? lp.learnLang : sourceLangFor(lp, originalLang)].filter((l): l is string => !!l);
}

/** Mode apprentissage : les sources en VO ou multi-audio ne sont pas pénalisées (elles portent l'audio de la langue apprise). */
function alsoAccepted(lp: LangPrefs): readonly Lang[] {
  return lp.learn ? ['original', 'multi'] : [];
}

/** Contexte de la règle de compatibilité web : navigateur seul, serveur de streaming présent ou non, hôtes refusés. */
export function webCompatContext(): WebCompatContext {
  return { web: !inShell(), serverUp: serverLikelyUp(), rangeDenied };
}

/** `originalLang` : langue d'origine du titre (code à deux lettres) quand elle est connue ; sinon omise. `maxHeight` : plafond de résolution (ODY-236), par défaut celui de l'appareil. `lp` : réglages de langue effectifs du titre (animes : voir `resolveLangPrefs`), les réglages généraux à défaut. */
export function recommendFor(views: readonly SourceView[], bwKbps: number | null, originalLang?: string, maxHeight?: number | null, lp: LangPrefs = getLangPrefs()): Recommendation | null {
  // Hôte déjà refusé (CORS) par la sonde du moteur audio : son son ne peut plus être décodé par l'app.
  const checked = views.map((v) => (v.appAudio === 'app' && rangeDenied(v.stream?.url) ? { ...v, appAudio: 'unsupported' as const } : v));
  // Navigateur sans Dolby natif : le son AC-3 / E-AC-3 est décodé par l'app, une source AAC / Opus de résolution proche le vaut mieux.
  const web = !inShell();
  // Dans le navigateur, seules les sources dont la vidéo et le son passent sont choisies d'office (ODY-189) ; sinon aucune.
  const ctx = webCompatContext();
  const eligible = web ? checked.filter((v) => webCompatOf(v, ctx).level === 'ok') : checked;
  return recommend(eligible, bwKbps, sourceLangFor(lp, originalLang), { preferDirect: web, preferAac: web && browserCaps().dolbyNative !== true, alsoAccept: alsoAccepted(lp), maxHeight: maxHeight === undefined ? currentCapHeight() : maxHeight });
}

/** Débit connu sans mesurer (réglage fixe ou mesure récente), sinon null. */
export function knownBandwidthKbps(): number | null {
  const plan = planBandwidth(getBandwidthSetting(), readStoredBandwidth(), Date.now());
  return plan.kind === 'measure' ? null : plan.kbps;
}
