import { runtimeEnv } from './platform/index.js';
import { LruCache, hashConfigKey } from './cache/lru.js';
import type { Config } from './config/schema.js';
import { getCinemetaTitle, getRuntimeSeconds, getSeasonEpisodeCounts } from './engine/cinemeta.js';
import { type FormatItem, type PlayableCopy, formatStreams } from './engine/format.js';
import { type CopyRef, type GroupedCandidate, groupCopies } from './engine/group.js';
import { enrichHosterLinks } from './engine/hosters-step.js';
import { filterCandidates, limitPerResolution } from './engine/filter.js';
import { enrichWithProbe } from './engine/probe-step.js';
import type { probeMedia } from './media/probe.js';
import { rankCandidates } from './engine/score.js';
import { getContentMeta } from './engine/tmdb-meta.js';
import { type Candidate, type ContentMeta, type Ranked, infoHashOf, isDirect } from './engine/types.js';
import type { AllDebridClient } from './sources/alldebrid.js';
import type { HostHealth } from './play/hosts.js';
import type { PackStore } from './play/packs.js';
import { parseRawStream } from './parse/index.js';
import { type ReleaseScope, scopeCovers } from './parse/scope.js';
import { type CollectResult, collectStreams, mergeIndexerCopies, type SourceErrorEntry } from './sources/collect.js';
import type { HosterClient } from './sources/hosters.js';
import type { TitleInfo } from './sources/indexers.js';
import { effectiveSources, type LocalProwlarrProvider } from './sources/local-prowlarr.js';
import { PROWLARR_BUDGET_MS, PROWLARR_SOFT_MS } from './sources/prowlarr.js';
import { getTitleVariants, nameMatchesTitles, releaseYearFits, type TitleVariants } from './sources/query-titles.js';
import { resolveInfoHashes } from './torrent/enrich.js';
import { scrubUrl, type TorrentCache } from './torrent/fetch-torrent.js';
import type { ContentRef, RawStream, StremioStream, StreamOrigin } from './types.js';
import type { AnimeMapper } from './anime/mapping.js';

/**
 * Budget de lecture des .torrent d'une réponse rapide (échéance douce), en ms : un .torrent d'indexeur privé met souvent
 * 1 à 3 s. Les lectures abandonnées sont reprises, avec le budget complet, par le recalcul en arrière-plan.
 */
const SOFT_TORRENT_BUDGET_MS = 1_200;
/** Nombre maximal de .torrent lus (flux sans infoHash mais avec downloadUrl), les premiers après fusion. */
const RESOLVE_TOP_N = 12;
/** Nombre maximal d'infoHash interrogés auprès du débrideur pour le statut « cache » (copies des premiers groupes). */
const CACHE_CHECK_LIMIT = 8;
/** Nombre maximal de liens d'hébergeur contrôlés par requête. */
const HOSTER_TOP_N = 8;
const TITLE_TIMEOUT_MS = 3_000;
const META_TIMEOUT_MS = 4_000;
/** Délai maximal du remappage anime (table Fribb déjà en mémoire, sinon l'épisode est traité sans numéro absolu). */
const ANIME_TIMEOUT_MS = 1_500;

/**
 * Budgets des étapes, en millisecondes. Une étape qui dépasse son budget est abandonnée : ses résultats partiels
 * sont gardés, et la requête ne reste pas bloquée (sources : collecte bornée ; torrents : lectures terminées ;
 * cache AllDebrid et hébergeurs : étape ignorée ; sonde : candidats déjà sondés).
 */
export interface StageBudgets {
  sources: number;
  torrents: number;
  cache: number;
  hosters: number;
  probe: number;
}
const STAGE_BUDGET_MS: StageBudgets = { sources: PROWLARR_BUDGET_MS, torrents: 3_000, cache: 2_000, hosters: 2_000, probe: 3_000 };

/** Durée de vie du cache des résultats : 5 minutes, 200 entrées. */
const RESULT_TTL_MS = 5 * 60 * 1_000;
const RESULT_CACHE_MAX = 200;

const EMPTY_COLLECT: CollectResult = { streams: [], errors: [] };
const NO_TITLES: TitleVariants = { titles: [] };
const sharedResultCache = new LruCache<PipelineResult>({ max: RESULT_CACHE_MAX, ttlMs: RESULT_TTL_MS });

/** Client débrideur du pipeline : statut « cache » (checkCached) et résolution des liens cachés (sonde). */
export type PipelineDebrid = Pick<AllDebridClient, 'checkCached' | 'resolve'>;

export interface PipelineContext {
  /** Base publique du endpoint de lecture (ex. https://addon.example.com). */
  playBaseUrl: string;
  /** Segment de configuration tel que reçu, réutilisé dans les URL de lecture. */
  configToken: string;
  /** Secret de signature des jetons de lecture (deps.secret). Ne jamais journaliser. */
  secret: string;
  /** fetch injecté pour les sources, Cinemeta, TMDB et les sondes (tests). Par défaut : fetch global. */
  fetch?: typeof fetch;
  /** Client debrid : statut « cache » et sonde des liens cachés. Absent : aucune vérification. */
  debrid?: PipelineDebrid;
  /** Hébergeurs AllDebrid (contrôle des liens d'hébergeur). Absent : aucun lien d'hébergeur n'est identifié. */
  hosters?: Pick<HosterClient, 'getHosts' | 'hosterFor' | 'linkInfos'>;
  /** Hébergeurs signalés en panne : leurs liens sont écartés sans contrôle. */
  hostHealth?: Pick<HostHealth, 'isDown'> & { warm?: HostHealth['warm'] };
  /** Cache partagé des .torrent (octets des torrents privés, par guid). Absent : cache du module fetch-torrent. */
  torrentCache?: TorrentCache;
  /** Fichiers des packs déjà vus : apprentissage depuis les .torrent lus, et recherche d'un épisode. */
  packStore?: Pick<PackStore, 'learn' | 'findEpisode'> & { warm?: PackStore['warm'] };
  /** Cache des résultats (LRU, 5 min, 200 entrées). Absent : cache partagé. `false` : désactivé. */
  cache?: LruCache<PipelineResult> | false;
  /** Sonde média injectable (tests). Défaut : sonde réelle, avec le fetch du contexte. */
  probe?: typeof probeMedia;
  /** Durée de chaque étape, en ms (script de vérification live). Absent : aucune mesure, aucun journal. */
  stageTimer?: (stage: string, ms: number) => void;
  /** Budgets des étapes (tests). Défaut : STAGE_BUDGET_MS. */
  budgetsMs?: Partial<StageBudgets>;
  /** Prowlarr local détecté : ajouté aux sources de la configuration (autoProwlarr actif, sauf s'il y figure déjà). */
  localProwlarr?: LocalProwlarrProvider;
  /** Remappage anime (numéro absolu d'un épisode de série). Absent : aucun remappage, comportement inchangé. */
  animeMapper?: Pick<AnimeMapper, 'toAbsolute'>;
  /** Échéance douce des indexeurs Prowlarr, en ms (défaut PROWLARR_SOFT_MS) : au-delà, réponse partielle. */
  softMs?: number;
  /** `full` : attend tous les indexeurs (dans le budget dur) au lieu de répondre à l'échéance douce. */
  wait?: 'soft' | 'full';
  /** Recalcul en arrière-plan : les indexeurs échoués récemment ne sont pas relancés. Usage interne. */
  reuseFailed?: boolean;
}

export interface PipelineResult {
  streams: StremioStream[];
  /** Erreurs isolées des sources : elles ne font jamais échouer la requête. */
  errors: SourceErrorEntry[];
  /** Vrai si des indexeurs lents n'ont pas encore répondu : le résultat complet remplacera celui-ci dans le cache. */
  partial?: boolean;
  /** Noms des indexeurs encore en cours (avec `partial`). */
  pending?: string[];
}

/** Calcul d'un résultat, et sa suite en arrière-plan quand il est partiel. */
interface Computed {
  result: PipelineResult;
  /** Se résout quand les recherches encore actives (indexeurs lents, compléments) sont terminées. */
  settled?: Promise<void>;
}

/** Avancement d'une requête, pour les clients qui rechargent un résultat partiel. */
export interface StreamsStatus {
  pending: string[];
  count: number;
}

/** Candidat groupé, classé ou non : ses copies suivent le candidat à travers les étapes. */
type Grouped = GroupedCandidate;
type Scored = Ranked & { copies: CopyRef[] };

/** Exécute `work` ; en cas d'erreur, renvoie `fallback`. Chaque étape est isolée : jamais d'exception. */
async function settle<T>(work: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

/**
 * Garde les copies d'un groupe à travers les étapes : rang, sonde et filtre renvoient des copies d'objets
 * (le champ `copies` ajouté par groupCopies est conservé, mais les types TypeScript de ces étapes ne le voient pas).
 */
function withCopies<T extends Candidate>(items: T[]): (T & { copies: CopyRef[] })[] {
  return items.map((item) => {
    const copies = 'copies' in item && Array.isArray(item.copies) ? (item.copies as CopyRef[]) : [];
    return { ...item, copies };
  });
}

/** Raison pour laquelle une release est écartée : titre, année, ou portée (épisode), ou undefined si elle est gardée. */
type Rejection = 'titre' | 'annee' | 'portee';

/**
 * Motif d'écart d'une release de série (saison et épisode demandés), commun à toutes les origines (addons, indexeurs,
 * Prowlarr) : titre (correspondance stricte, voir nameMatchesTitles), année (pas antérieure à la première diffusion moins
 * un an), puis portée : épisode exact, pack de la saison, ou intégrale qui la couvre. Une release sans aucun texte, ou un
 * lien direct, n'est pas écartée : rien à vérifier. Une release au nom sans portée reconnue est écartée (« Titre S04E05 »
 * ne passe pas pour S04E04). Films : inchangé ici (année à ±1 an dans filterByYear).
 */
function rejectionOf(candidate: Candidate, ref: ContentRef, titles: TitleVariants, absolute?: number): Rejection | undefined {
  const { season, episode } = ref;
  if (ref.type !== 'series' || season === undefined || episode === undefined) return undefined;
  const { raw } = candidate;
  if (raw.url !== undefined) return undefined;
  const hasText = [raw.filename, raw.title, raw.name, raw.description].some((text) => text !== undefined && text.trim() !== '');
  if (!hasText) return undefined;
  // Le nom de la release doit commencer par un titre de la série : un pack « S03 » d'une autre série n'est pas le bon.
  const release = raw.filename ?? raw.title;
  if (release !== undefined) {
    if (!nameMatchesTitles(release, [...titles.titles, ...(titles.aliases ?? [])])) return 'titre';
    if (!releaseYearFits(release, titles, ref.type)) return 'annee';
  }
  const scope = candidate.parsed.scope ?? {};
  // Numéro absolu (anime) sans remappage connu (remappeur absent ou en délai) : la release n'est pas écartée, faute
  // de moyen de la vérifier. Avec un remappage, la correspondance est exigée.
  const absoluteOnly = scope.absolute !== undefined && scope.episode === undefined && scope.pack === undefined;
  if (absoluteOnly && absolute === undefined) return undefined;
  return scopeCovers(scope, season, episode, absolute) ? undefined : 'portee';
}

/** Compteurs par étape (débogage), journalisés si LASTADDON_DEBUG=1 : jamais de contenu, seulement des nombres. */
function debugStage(ref: ContentRef, stage: string, details: Record<string, number | string>): void {
  if (runtimeEnv().get('LASTADDON_DEBUG') !== '1') return;
  console.debug(`[pipeline ${ref.id}] ${stage} ${JSON.stringify(details)}`);
}

/** Épisodes supposés d'une saison dont le nombre est inconnu (Cinemeta absent ou sans cette saison). */
const DEFAULT_SEASON_EPISODES = 10;
/** Épisodes supposés d'une intégrale sans bornes de saisons, quand le nombre de saisons est inconnu. */
const DEFAULT_COMPLETE_EPISODES = 50;

/** Nombre d'épisodes couverts par un pack : sa saison, ou les saisons de l'intégrale (Cinemeta, sinon valeurs par défaut). */
export function packEpisodeCount(scope: ReleaseScope, counts: ReadonlyMap<number, number>): number {
  if (scope.pack === 'season') {
    return (scope.season === undefined ? undefined : counts.get(scope.season)) ?? DEFAULT_SEASON_EPISODES;
  }
  const seasons: number[] = [];
  if (scope.seasons !== undefined) {
    for (let season = scope.seasons.from; season <= scope.seasons.to && seasons.length < 60; season += 1) seasons.push(season);
  } else {
    seasons.push(...[...counts.keys()].filter((season) => season > 0));
  }
  if (seasons.length === 0) return DEFAULT_COMPLETE_EPISODES;
  return seasons.reduce((sum, season) => sum + (counts.get(season) ?? DEFAULT_SEASON_EPISODES), 0);
}

/**
 * Pack (saison ou intégrale) d'une série : sa taille est celle de tout le pack, pas de l'épisode demandé. Elle est
 * remplacée par une estimation par épisode (taille du pack / nombre d'épisodes), pour que les filtres de taille et de
 * débit, le classement et l'affichage jugent l'épisode ; la taille du pack est gardée dans `packSizeBytes`. Le fichier
 * exact est choisi à la lecture. Sans taille, sans pack ou hors série : inchangé.
 */
function withEpisodeSize(candidate: Candidate, ref: ContentRef, counts: ReadonlyMap<number, number>): Candidate {
  const { scope } = candidate.parsed;
  const size = candidate.parsed.sizeBytes ?? candidate.raw.sizeBytes;
  if (ref.type !== 'series' || scope?.pack === undefined || size === undefined || !(size > 0)) return candidate;
  const episodes = Math.max(1, packEpisodeCount(scope, counts));
  return { ...candidate, parsed: { ...candidate.parsed, sizeBytes: Math.floor(size / episodes), packSizeBytes: size } };
}

/** Numéro absolu d'un épisode de série (remappage anime), borné à ANIME_TIMEOUT_MS. Undefined sans remappage. */
function absoluteOf(ref: ContentRef, mapper: PipelineContext['animeMapper']): Promise<number | undefined> {
  const { season, episode } = ref;
  if (mapper === undefined || ref.type !== 'series' || season === undefined || episode === undefined) {
    return Promise.resolve(undefined);
  }
  return within(
    settle(() => mapper.toAbsolute(ref.imdbId, season, episode), undefined),
    ANIME_TIMEOUT_MS,
    undefined,
  );
}

/** Titres TMDB, complétés du titre Cinemeta (repli) s'il n'est pas déjà présent. Sans repli : inchangés. */
function withTitleFallback(variants: TitleVariants, fallback: TitleInfo | undefined): TitleVariants {
  if (fallback === undefined) return variants;
  const known = variants.titles.some((title) => title.toLowerCase() === fallback.title.toLowerCase());
  const titles = known ? variants.titles : [...variants.titles, fallback.title];
  const year = variants.year ?? fallback.year;
  return year === undefined ? { ...variants, titles } : { ...variants, titles, year };
}

/** Configuration de la première passe : aucune exigence qui dépend de la sonde ou du cache (appliquées après). */
function firstPassConfig(config: Config): Config {
  return {
    ...config,
    onlyCached: false,
    audio: { ...config.audio, verifiedLanguagesOnly: false },
    filters: { ...config.filters, directVerifiedOnly: false },
  };
}

/** Interroge le débrideur. Une erreur ou un lot inconnu vaut « non caché » : jamais d'exception. */
async function checkCachedSafely(
  debrid: PipelineDebrid,
  hashes: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  try {
    return await debrid.checkCached([...hashes]);
  } catch {
    return new Map<string, boolean>();
  }
}

/** infoHash des premières copies des groupes classés, dans l'ordre du classement (sans doublon, au plus `limit`). */
function cacheCheckHashes(ranked: readonly Scored[], limit: number): string[] {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    for (const hash of [infoHashOf(item), ...item.copies.map((copy) => copy.infoHash)]) {
      if (hashes.length >= limit) return hashes;
      const key = hash?.toLowerCase();
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      hashes.push(key);
    }
  }
  return hashes;
}

/**
 * Marque « cached » chaque copie connue du débrideur, range les copies cachées d'abord, et fait du candidat caché
 * le représentant quand la copie cachée est un torrent différent du représentant (le lien joué est alors le bon).
 */
function withCachedCopies(group: Grouped, cached: ReadonlyMap<string, boolean>): Grouped {
  let checked = false;
  const copies = group.copies.map((copy) => {
    const flag = copy.infoHash === undefined ? undefined : cached.get(copy.infoHash.toLowerCase());
    if (flag === undefined) return copy;
    checked = true;
    return { ...copy, cached: flag };
  });
  const ordered = [...copies].sort((a, b) => Number(b.cached === true) - Number(a.cached === true));
  const next: Grouped = { ...group, copies: ordered };
  if (checked) next.cached = ordered.some((copy) => copy.cached === true);
  return promoteCachedCopy(next);
}

/** Représentant d'un torrent : son infoHash et ses champs de fichier suivent la copie cachée de tête. */
function promoteCachedCopy(group: Grouped): Grouped {
  const lead = group.copies[0];
  if (lead?.cached !== true || lead.infoHash === undefined || isDirect(group)) return group;
  if (infoHashOf(group)?.toLowerCase() === lead.infoHash.toLowerCase()) return group;
  const raw: RawStream = { ...group.raw, infoHash: lead.infoHash, fileIdx: lead.fileIdx };
  if (lead.filename !== undefined) raw.filename = lead.filename;
  const parsed = {
    ...group.parsed,
    infoHash: lead.infoHash,
    fileIdx: lead.fileIdx,
    sizeBytes: lead.size ?? group.parsed.sizeBytes,
  };
  return { ...group, raw, parsed };
}

/** Vérification « cache » AllDebrid sur les groupes classés. Sans débrideur : groupes inchangés. */
async function markCached(groups: Grouped[], config: Config, debrid: PipelineDebrid): Promise<Grouped[]> {
  const hashes = cacheCheckHashes(rankWithCopies(groups, config), CACHE_CHECK_LIMIT);
  if (hashes.length === 0) return groups;
  const cached = await checkCachedSafely(debrid, hashes);
  return groups.map((group) => withCachedCopies(group, cached));
}

function rankWithCopies(items: Candidate[], config: Config): Scored[] {
  return withCopies(rankCandidates(items, config));
}

/** Clés de rapprochement des sources : infoHash (en minuscules) et URL directe. */
const hashKey = (hash: string): string => `hash:${hash.toLowerCase()}`;
const urlKey = (url: string): string => `url:${url}`;

/** Indexeurs et informations de torrent par source (infoHash ou URL), pour les copies d'un groupe. */
interface SourceInfo {
  indexers: string[];
  origins: StreamOrigin[];
  guid?: string;
  privateTorrent: boolean;
}

/** Provenances d'un flux : l'addon amont, ou chacun des indexeurs (du Prowlarr local ou d'une source explicite). */
function originsOf(raw: RawStream): StreamOrigin[] {
  if (raw.origin !== undefined) {
    return [{ kind: 'addon', name: raw.origin.name, ...(raw.origin.logo === undefined ? {} : { logo: raw.origin.logo }) }];
  }
  const kind = raw.viaLocalProwlarr === true ? 'prowlarr-local' : 'indexer';
  return (raw.indexers ?? []).map((name) => ({ kind, name }));
}

/** Ajoute des provenances sans doublon (même type et même nom). */
function addOrigins(into: StreamOrigin[], more: readonly StreamOrigin[]): void {
  for (const origin of more) {
    if (!into.some((known) => known.kind === origin.kind && known.name === origin.name)) into.push(origin);
  }
}

function indexSources(candidates: Candidate[]): Map<string, SourceInfo> {
  const index = new Map<string, SourceInfo>();
  for (const candidate of candidates) {
    const hash = infoHashOf(candidate);
    const keys = [hash === undefined ? undefined : hashKey(hash), isDirect(candidate) ? urlKey(candidate.raw.url ?? '') : undefined];
    for (const key of keys) {
      if (key === undefined) continue;
      const info = index.get(key) ?? { indexers: [], origins: [], privateTorrent: false };
      info.indexers.push(...(candidate.raw.indexers ?? []));
      addOrigins(info.origins, originsOf(candidate.raw));
      if (info.guid === undefined && candidate.raw.guid !== undefined) info.guid = candidate.raw.guid;
      if (candidate.raw.privateTorrent === true) info.privateTorrent = true;
      index.set(key, info);
    }
  }
  return index;
}

/**
 * Copie jouable : hash (guid seulement pour un torrent privé), ou lien d'hébergeur débridé. Garde-fou : un torrent
 * privé n'est jamais envoyé en magnet public. Sans guid exploitable, la copie est écartée (undefined).
 */
function playableCopyOf(
  copy: CopyRef,
  sources: Map<string, SourceInfo>,
  hosters: PipelineContext['hosters'],
): PlayableCopy | undefined {
  const out: PlayableCopy = {};
  if (copy.infoHash !== undefined) {
    const info = sources.get(hashKey(copy.infoHash));
    // Le guid sert de clé de cache serveur : jamais un lien contenant un secret.
    const guid = info?.guid !== undefined && scrubUrl(info.guid) === info.guid ? info.guid : undefined;
    if (info?.privateTorrent === true) {
      if (guid === undefined) return undefined;
      out.guid = guid;
      out.privateTorrent = true;
    }
    out.infoHash = copy.infoHash;
    if (copy.fileIdx !== undefined) out.fileIdx = copy.fileIdx;
    if (copy.filename !== undefined) out.filename = copy.filename;
    if (copy.size !== undefined) out.size = copy.size;
  } else if (copy.url !== undefined) {
    const hoster = hosters?.hosterFor(copy.url)?.name;
    if (hoster !== undefined) {
      out.url = copy.url;
      out.hoster = hoster;
    }
  }
  if (copy.cached !== undefined) out.cached = copy.cached;
  return out;
}

/** Vrai si le candidat (ou son infoHash) désigne un torrent privé. */
function isPrivateItem(item: Scored, sources: Map<string, SourceInfo>): boolean {
  if (item.raw.privateTorrent === true) return true;
  const hash = infoHashOf(item);
  return hash !== undefined && sources.get(hashKey(hash))?.privateTorrent === true;
}

/**
 * Groupe classé → élément de formatage : copies jouables (cachées d'abord), indexeurs de toutes les copies.
 * Undefined si un torrent privé n'a aucune copie jouable : il n'est alors pas livré du tout.
 */
function toFormatItem(
  item: Scored,
  sources: Map<string, SourceInfo>,
  hosters: PipelineContext['hosters'],
): FormatItem | undefined {
  const copies = item.copies.flatMap((copy) => {
    const playable = playableCopyOf(copy, sources, hosters);
    return playable === undefined ? [] : [playable];
  });
  if (copies.length === 0 && isPrivateItem(item, sources)) return undefined;
  const cachedFirst = [...copies].sort((a, b) => Number(b.cached === true) - Number(a.cached === true));
  const indexers = new Set<string>(item.raw.indexers ?? []);
  const origins: StreamOrigin[] = [];
  addOrigins(origins, originsOf(item.raw));
  for (const copy of item.copies) {
    const key = copy.infoHash !== undefined ? hashKey(copy.infoHash) : copy.url !== undefined ? urlKey(copy.url) : undefined;
    for (const name of key === undefined ? [] : (sources.get(key)?.indexers ?? [])) indexers.add(name);
    addOrigins(origins, key === undefined ? [] : (sources.get(key)?.origins ?? []));
  }
  return { ...item, copies: cachedFirst, indexers: [...indexers], origins };
}

/** Pack learning : le fichier d'un épisode connu du magasin (torrent déjà lu) remplace celui de la copie. */
function applyLearnedFiles(items: Scored[], ref: ContentRef, store: PipelineContext['packStore']): Scored[] {
  const { season, episode } = ref;
  if (store === undefined || ref.type !== 'series' || season === undefined || episode === undefined) return items;
  const basename = (name: string): string => name.split(/[\\/]/).pop() ?? name;
  return items.map((item) => {
    const copies = item.copies.map((copy) => {
      const file = copy.infoHash === undefined ? undefined : store.findEpisode(copy.infoHash, season, episode);
      if (file === undefined) return copy;
      return { ...copy, fileIdx: file.idx, filename: basename(file.name), size: file.size };
    });
    const hash = infoHashOf(item);
    const file = hash === undefined ? undefined : store.findEpisode(hash, season, episode);
    if (file === undefined) return { ...item, copies };
    return {
      ...item,
      copies,
      raw: { ...item.raw, fileIdx: file.idx, filename: basename(file.name), sizeBytes: file.size },
      parsed: { ...item.parsed, fileIdx: file.idx, sizeBytes: file.size },
    };
  });
}

/** Retire le repli de langue posé par une passe précédente : filterCandidates le recalcule. */
function withoutLanguageFallback(item: Scored): Scored {
  return { ...item, languageFallback: undefined };
}

/** Clé de cache : hash de la configuration et de l'identifiant (sans config en clair). */
function resultCacheKey(config: Config, ref: ContentRef, ctx: PipelineContext): string {
  const id = [ref.type, ref.id, ref.season ?? '', ref.episode ?? '', ctx.playBaseUrl, ctx.configToken, ctx.secret].join('|');
  return hashConfigKey(config, id);
}

/**
 * Sources interrogées : celles de la configuration, plus le Prowlarr local détecté (voir effectiveSources). Le
 * fournisseur est appelé à chaque requête (détection mise en cache) ; son échec n'empêche jamais la requête.
 */
async function sourcesOf(config: Config, ctx: PipelineContext): Promise<Config['sources']> {
  if (!config.autoProwlarr || !config.localProwlarr.enabled || ctx.localProwlarr === undefined) return config.sources;
  const provider = ctx.localProwlarr;
  const local = await settle(() => provider(), null);
  return effectiveSources(config, local);
}

/** Calculs en cours par clé de cache : deux requêtes identiques simultanées ne lancent qu'un calcul. */
const inflight = new Map<string, Promise<PipelineResult>>();
/** Recalculs complets en arrière-plan (après un résultat partiel), par clé de cache. */
const refreshing = new Map<string, Promise<PipelineResult>>();

/**
 * Quand les indexeurs lents ont répondu, recalcule le résultat complet (leurs réponses sont en mémoire : le recalcul ne
 * refait aucune requête) et remplace l'entrée partielle du cache (stale-while-revalidate).
 */
function refreshInBackground(
  key: string,
  cache: LruCache<PipelineResult>,
  config: Config,
  ref: ContentRef,
  ctx: PipelineContext,
  settled: Promise<void>,
  partial: PipelineResult,
): void {
  const work = (async (): Promise<PipelineResult> => {
    await settled;
    const { result } = await computeStreams(config, ref, { ...ctx, wait: 'full', reuseFailed: true });
    if (result.errors.length === 0) cache.set(key, result);
    else cache.delete(key);
    return result;
  })().catch(() => {
    cache.delete(key);
    return partial;
  });
  refreshing.set(key, work);
  void work.finally(() => {
    if (refreshing.get(key) === work) refreshing.delete(key);
  });
}

/**
 * Agrège les streams de toutes les sources (pipeline v2) : métadonnées et titres, collecte, lecture des .torrent,
 * parsing, filtre, groupement des copies, statut « cache », liens d'hébergeur, classement, sonde audio, second
 * filtre, apprentissage des packs, formatage Stremio. Chaque étape est isolée : son échec la désactive, sans exception.
 * Les résultats sans erreur de source sont gardés en cache (LRU, 5 min) quand ctx.cache n'est pas `false`.
 * Indexeurs lents : à l'échéance douce (ctx.softMs), le résultat est partiel (`partial`, `pending`) ; il est gardé en
 * cache, puis remplacé par le résultat complet quand les indexeurs lents ont répondu. `ctx.wait = 'full'` attend ce
 * résultat complet.
 */
export async function getStreams(config: Config, ref: ContentRef, ctx: PipelineContext): Promise<PipelineResult> {
  const effective: Config = { ...config, sources: await sourcesOf(config, ctx) };
  const cache = ctx.cache === false ? undefined : (ctx.cache ?? sharedResultCache);
  const key = cache === undefined ? undefined : resultCacheKey(effective, ref, ctx);
  if (cache === undefined || key === undefined) return (await computeStreams(effective, ref, ctx)).result;

  const waitFull = async (result: PipelineResult): Promise<PipelineResult> =>
    result.partial === true && ctx.wait === 'full' ? ((await refreshing.get(key)) ?? result) : result;
  const hit = cache.get(key);
  if (hit !== undefined) return waitFull(hit);
  const running = inflight.get(key);
  if (running !== undefined) return waitFull(await running);

  const work = (async (): Promise<PipelineResult> => {
    const { result, settled } = await computeStreams(effective, ref, ctx);
    // Recherches encore actives (indexeurs lents, compléments) : le résultat est gardé, puis remplacé par le complet.
    if (settled !== undefined && (result.partial === true || result.errors.length === 0)) {
      cache.set(key, result);
      refreshInBackground(key, cache, effective, ref, ctx, settled, result);
    } else if (result.errors.length === 0) {
      cache.set(key, result);
    }
    return result;
  })();
  inflight.set(key, work);
  try {
    return await waitFull(await work);
  } finally {
    if (inflight.get(key) === work) inflight.delete(key);
  }
}

/** Avancement d'une requête : indexeurs encore en cours et nombre de flux disponibles (léger : aucune recherche lancée). */
export async function getStreamsStatus(config: Config, ref: ContentRef, ctx: PipelineContext): Promise<StreamsStatus> {
  const effective: Config = { ...config, sources: await sourcesOf(config, ctx) };
  const cache = ctx.cache === false ? undefined : (ctx.cache ?? sharedResultCache);
  if (cache === undefined) return { pending: [], count: 0 };
  const key = resultCacheKey(effective, ref, ctx);
  const hit = cache.get(key);
  if (hit !== undefined) return { pending: hit.partial === true ? (hit.pending ?? []) : [], count: hit.streams.length };
  return { pending: inflight.has(key) ? ['search'] : [], count: 0 };
}

/** Chronomètre d'étapes : chaque `lap` signale le temps écoulé depuis le lap précédent (sans effet sans stageTimer). */
function stageClock(timer: PipelineContext['stageTimer']): (stage: string) => void {
  let last = Date.now();
  return (stage) => {
    const now = Date.now();
    timer?.(stage, now - last);
    if (runtimeEnv().get('LASTADDON_DEBUG') === '1') console.debug(`[pipeline] étape ${stage} ${now - last} ms`);
    last = now;
  };
}

/** Résout `work` au plus tard après `ms` millisecondes ; à l'échéance, `fallback`. `work` n'est pas annulée. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

async function computeStreams(config: Config, ref: ContentRef, ctx: PipelineContext): Promise<Computed> {
  const fetchFn = ctx.fetch;
  const tmdbToken = config.services.tmdbToken;
  const budget: StageBudgets = { ...STAGE_BUDGET_MS, ...ctx.budgetsMs };
  const lap = stageClock(ctx.stageTimer);
  const hosters = config.debrid !== undefined ? ctx.hosters : undefined;
  // Catalogue d'hébergeurs (gardé 12 h, requête partagée) : demandé dès le départ, en parallèle des sources.
  const hostsCatalog = hosters === undefined ? undefined : settle(() => hosters.getHosts(), undefined);

  // a) titres d'abord (la recherche en dépend) : TMDB et, en parallèle, Cinemeta en repli (sans jeton ou panne TMDB).
  // La collecte suit, pendant que la fiche et la durée se chargent (la fiche Cinemeta est déjà en cache).
  const [tmdbTitles, cinemetaTitle, absolute] = await Promise.all([
    settle(() => getTitleVariants(ref, { tmdbToken, fetch: fetchFn, timeoutMs: TITLE_TIMEOUT_MS }), NO_TITLES),
    settle(() => getCinemetaTitle(ref, { fetch: fetchFn, timeoutMs: TITLE_TIMEOUT_MS }), undefined),
    absoluteOf(ref, ctx.animeMapper),
  ]);
  const titles = withTitleFallback(tmdbTitles, cinemetaTitle);
  lap('a.titres');
  const collecting = settle(
    () =>
      collectStreams(config, ref, {
        fetch: fetchFn,
        titles,
        budgetMs: budget.sources,
        absolute,
        softMs: ctx.wait === 'full' ? undefined : (ctx.softMs ?? PROWLARR_SOFT_MS),
        reuseFailed: ctx.reuseFailed,
      }),
    EMPTY_COLLECT,
  );
  const metaLoading = Promise.all([
    settle(() => getRuntimeSeconds(ref, { fetch: fetchFn }), undefined),
    settle(() => getContentMeta(ref, { tmdbToken, fetch: fetchFn, timeoutMs: META_TIMEOUT_MS }), {} as ContentMeta),
    settle(() => getSeasonEpisodeCounts(ref, { fetch: fetchFn }), new Map<number, number>()),
  ]);
  const collected = await collecting;
  lap('b.sources');
  const [runtime, contentMeta, seasonCounts] = await metaLoading;
  const meta: ContentMeta = { ...contentMeta };
  if (meta.runtimeSeconds === undefined && runtime !== undefined) meta.runtimeSeconds = runtime;

  // b) lecture des .torrent sans infoHash (budget propre) ; fusion des copies d'indexeurs par infoHash ensuite.
  const read = await settle(
    () =>
      resolveInfoHashes(collected.streams, {
        fetch: fetchFn,
        topN: RESOLVE_TOP_N,
        cache: ctx.torrentCache,
        budgetMs: ctx.wait === 'full' ? budget.torrents : Math.min(budget.torrents, SOFT_TORRENT_BUDGET_MS),
      }),
    collected.streams,
  );
  // Lectures abandonnées à l'échéance courte : le recalcul en arrière-plan (budget complet) les reprend.
  const unresolved = ctx.wait === 'full' ? 0 : read.filter((raw) => raw.infoHash === undefined && raw.downloadUrl !== undefined).length;
  lap('c.torrents');
  const streams = mergeIndexerCopies(read);
  if (ctx.packStore !== undefined) {
    for (const raw of streams) {
      if (raw.infoHash !== undefined && raw.packFiles !== undefined && raw.packFiles.length > 0) {
        ctx.packStore.learn(raw.infoHash, raw.packFiles);
      }
    }
  }

  // c) parsing, filtre par épisode (série), premier filtre, groupement des copies.
  const parsedAll: Candidate[] = streams.map((raw) => withEpisodeSize({ raw, parsed: parseRawStream(raw) }, ref, seasonCounts));
  const rejections = parsedAll.map((candidate) => rejectionOf(candidate, ref, titles, absolute));
  const candidates: Candidate[] = parsedAll.filter((_candidate, index) => rejections[index] === undefined);
  debugStage(ref, 'c.parse', {
    collected: collected.streams.length,
    withHash: read.length,
    parsed: parsedAll.length,
    rejetTitre: rejections.filter((r) => r === 'titre').length,
    rejetAnnee: rejections.filter((r) => r === 'annee').length,
    rejetPortee: rejections.filter((r) => r === 'portee').length,
    gardes: candidates.length,
    titres: titles.titles.join(' | '),
  });
  if (runtimeEnv().get('LASTADDON_DEBUG_NAMES') === '1') {
    parsedAll.forEach((candidate, index) => {
      console.debug(`[pipeline ${ref.id}] ${rejections[index] ?? 'garde'} ${JSON.stringify(candidate.parsed.scope ?? {})} ${candidate.raw.title ?? ''} ${candidate.raw.sizeBytes ?? ''}`);
    });
  }
  const sources = indexSources(candidates);
  let pool = candidates;
  if (hosters !== undefined && !config.filters.includeHosterLinks) {
    // Liens d'hébergeur exclus : identifiés par le catalogue AllDebrid, retirés avant le groupement.
    if (hostsCatalog !== undefined) await within(hostsCatalog, budget.hosters, undefined);
    pool = candidates.filter((c) => c.raw.url === undefined || hosters.hosterFor(c.raw.url) === undefined);
  }
  const firstPass = await settle(() => filterCandidates(pool, firstPassConfig(config), meta), []);
  let groups: Grouped[] = await settle(() => groupCopies(firstPass), []);
  lap('d.filtre1');
  debugStage(ref, 'd.filtre1', { entree: pool.length, apresFiltres: firstPass.length, apresGroupement: groups.length });

  // Statut « cache » AllDebrid, par copie (budget propre : à l'échéance, groupes inchangés).
  const debrid = ctx.debrid;
  if (config.debrid !== undefined && debrid !== undefined && groups.length > 0) {
    const before = groups;
    groups = await within(settle(() => markCached(before, config, debrid), before), budget.cache, before);
  }
  lap('e.cache');

  // Liens d'hébergeur : contrôle des liens vivants, nom d'hébergeur, liens morts écartés (budget propre).
  if (hosters !== undefined && config.filters.includeHosterLinks) {
    const checked = await settle(
      () =>
        enrichHosterLinks(groups, {
          client: hosters,
          hostHealth: ctx.hostHealth,
          topN: HOSTER_TOP_N,
          budgetMs: budget.hosters,
        }),
      groups,
    );
    groups = withCopies(checked);
  }
  lap('f.hebergeurs');

  // Classement, limite par résolution, sonde audio des meilleurs (budget propre), second filtre, second classement.
  const ranked = limitPerResolution(rankWithCopies(groups, config), config);
  const probed = withCopies(
    await settle(
      () =>
        enrichWithProbe(ranked, {
          debrid: ctx.debrid,
          topN: config.audio.probeTopN,
          season: ref.season,
          episode: ref.episode,
          fetch: fetchFn,
          probe: ctx.probe,
          budgetMs: budget.probe,
        }),
      ranked,
    ),
  );
  lap('g.sonde');
  const unflagged = probed.map(withoutLanguageFallback);
  const verified = withCopies(await settle(() => filterCandidates(unflagged, config, meta), unflagged));
  const finalRanked = limitPerResolution(rankWithCopies(verified, config), config);
  lap('h.filtre2');
  debugStage(ref, 'h.final', { sonde: probed.length, apresFiltre2: verified.length, final: finalRanked.length });

  // d) pack learning, puis formatage (un torrent privé sans copie jouable n'est pas livré).
  // Fichiers de packs appris par d'autres instances (cache partagé) avant la recherche d'épisode, synchrone.
  await ctx.packStore?.warm?.(finalRanked.flatMap((item) => [...item.copies.flatMap((copy) => (copy.infoHash === undefined ? [] : [copy.infoHash])), ...(infoHashOf(item) === undefined ? [] : [infoHashOf(item) as string])]));
  const learned = applyLearnedFiles(finalRanked, ref, ctx.packStore);
  const items = learned.flatMap((item) => {
    const formatItem = toFormatItem(item, sources, hosters);
    return formatItem === undefined ? [] : [formatItem];
  });
  const formatted = formatStreams(items, {
    playBaseUrl: ctx.playBaseUrl,
    configToken: ctx.configToken,
    secret: ctx.secret,
    template: config.display.template,
    runtimeSeconds: meta.runtimeSeconds,
    certificationFr: typeof meta.certificationFr === 'number' ? meta.certificationFr : undefined,
    releaseDate: meta.releaseDate,
    maxResults: config.maxResults,
    hasDebrid: config.debrid !== undefined,
    season: ref.season,
    episode: ref.episode,
  });
  lap('i.format');
  const result: PipelineResult = { streams: formatted, errors: collected.errors };
  const pending = collected.pending ?? [];
  if (pending.length > 0) {
    result.partial = true;
    result.pending = pending;
    for (const stream of result.streams) stream.laststream = { ...stream.laststream, partial: true };
  }
  debugStage(ref, 'i.format', { streams: formatted.length, pending: pending.join(',') });
  const settled = collected.settled ?? (unresolved > 0 ? Promise.resolve() : undefined);
  return { result, settled };
}
