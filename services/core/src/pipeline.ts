import { LruCache, hashConfigKey } from './cache/lru.js';
import type { Config } from './config/schema.js';
import { getRuntimeSeconds } from './engine/cinemeta.js';
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
import { type CollectResult, collectStreams, mergeIndexerCopies, type SourceErrorEntry } from './sources/collect.js';
import type { HosterClient } from './sources/hosters.js';
import { effectiveSources, type LocalProwlarrProvider } from './sources/local-prowlarr.js';
import { getTitleVariants, type TitleVariants } from './sources/query-titles.js';
import { resolveInfoHashes } from './torrent/enrich.js';
import { scrubUrl, type TorrentCache } from './torrent/fetch-torrent.js';
import type { ContentRef, RawStream, StremioStream } from './types.js';

/** Nombre maximal de .torrent lus (flux sans infoHash mais avec downloadUrl), les premiers après fusion. */
const RESOLVE_TOP_N = 12;
/** Nombre maximal d'infoHash interrogés auprès du débrideur pour le statut « cache » (copies des premiers groupes). */
const CACHE_CHECK_LIMIT = 8;
/** Nombre maximal de liens d'hébergeur contrôlés par requête. */
const HOSTER_TOP_N = 8;
const TITLE_TIMEOUT_MS = 3_000;
const META_TIMEOUT_MS = 4_000;

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
const STAGE_BUDGET_MS: StageBudgets = { sources: 8_000, torrents: 3_000, cache: 2_000, hosters: 2_000, probe: 3_000 };

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
  hostHealth?: Pick<HostHealth, 'isDown'>;
  /** Cache partagé des .torrent (octets des torrents privés, par guid). Absent : cache du module fetch-torrent. */
  torrentCache?: TorrentCache;
  /** Fichiers des packs déjà vus : apprentissage depuis les .torrent lus, et recherche d'un épisode. */
  packStore?: Pick<PackStore, 'learn' | 'findEpisode'>;
  /** Cache des résultats (LRU, 5 min, 200 entrées). Absent : cache partagé. `false` : désactivé. */
  cache?: LruCache<PipelineResult> | false;
  /** Sonde média injectable (tests). Défaut : sonde réelle, avec le fetch du contexte. */
  probe?: typeof probeMedia;
  /** Durée de chaque étape, en ms (script de vérification live). Absent : aucune mesure, aucun journal. */
  stageTimer?: (stage: string, ms: number) => void;
  /** Budgets des étapes (tests). Défaut : STAGE_BUDGET_MS. */
  budgetsMs?: Partial<StageBudgets>;
  /** Prowlarr local détecté : interrogé seulement si la configuration n'a aucune source (et autoProwlarr actif). */
  localProwlarr?: LocalProwlarrProvider;
}

export interface PipelineResult {
  streams: StremioStream[];
  /** Erreurs isolées des sources : elles ne font jamais échouer la requête. */
  errors: SourceErrorEntry[];
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
  guid?: string;
  privateTorrent: boolean;
}

function indexSources(candidates: Candidate[]): Map<string, SourceInfo> {
  const index = new Map<string, SourceInfo>();
  for (const candidate of candidates) {
    const hash = infoHashOf(candidate);
    const keys = [hash === undefined ? undefined : hashKey(hash), isDirect(candidate) ? urlKey(candidate.raw.url ?? '') : undefined];
    for (const key of keys) {
      if (key === undefined) continue;
      const info = index.get(key) ?? { indexers: [], privateTorrent: false };
      info.indexers.push(...(candidate.raw.indexers ?? []));
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
  for (const copy of item.copies) {
    const key = copy.infoHash !== undefined ? hashKey(copy.infoHash) : copy.url !== undefined ? urlKey(copy.url) : undefined;
    for (const name of key === undefined ? [] : (sources.get(key)?.indexers ?? [])) indexers.add(name);
  }
  return { ...item, copies: cachedFirst, indexers: [...indexers] };
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
 * Sources interrogées : celles de la configuration, ou le Prowlarr local détecté quand elle n'en a aucune. Le
 * fournisseur n'est appelé que dans ce cas ; son échec n'empêche jamais la requête (sources vides).
 */
async function sourcesOf(config: Config, ctx: PipelineContext): Promise<Config['sources']> {
  if (config.sources.length > 0 || !config.autoProwlarr || ctx.localProwlarr === undefined) return config.sources;
  const provider = ctx.localProwlarr;
  const local = await settle(() => provider(), null);
  return effectiveSources(config, local);
}

/**
 * Agrège les streams de toutes les sources (pipeline v2) : métadonnées et titres, collecte, lecture des .torrent,
 * parsing, filtre, groupement des copies, statut « cache », liens d'hébergeur, classement, sonde audio, second
 * filtre, apprentissage des packs, formatage Stremio. Chaque étape est isolée : son échec la désactive, sans exception.
 * Les résultats sans erreur de source sont gardés en cache (LRU, 5 min) quand ctx.cache n'est pas `false`.
 */
export async function getStreams(config: Config, ref: ContentRef, ctx: PipelineContext): Promise<PipelineResult> {
  const effective: Config = { ...config, sources: await sourcesOf(config, ctx) };
  const cache = ctx.cache === false ? undefined : (ctx.cache ?? sharedResultCache);
  const key = cache === undefined ? undefined : resultCacheKey(effective, ref, ctx);
  if (cache !== undefined && key !== undefined) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  const result = await computeStreams(effective, ref, ctx);
  if (cache !== undefined && key !== undefined && result.errors.length === 0) cache.set(key, result);
  return result;
}

/** Chronomètre d'étapes : chaque `lap` signale le temps écoulé depuis le lap précédent (sans effet sans stageTimer). */
function stageClock(timer: PipelineContext['stageTimer']): (stage: string) => void {
  let last = Date.now();
  return (stage) => {
    const now = Date.now();
    timer?.(stage, now - last);
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

async function computeStreams(config: Config, ref: ContentRef, ctx: PipelineContext): Promise<PipelineResult> {
  const fetchFn = ctx.fetch;
  const tmdbToken = config.services.tmdbToken;
  const budget: StageBudgets = { ...STAGE_BUDGET_MS, ...ctx.budgetsMs };
  const lap = stageClock(ctx.stageTimer);
  const hosters = config.debrid !== undefined ? ctx.hosters : undefined;
  // Catalogue d'hébergeurs (gardé 12 h, requête partagée) : demandé dès le départ, en parallèle des sources.
  const hostsCatalog = hosters === undefined ? undefined : settle(() => hosters.getHosts(), undefined);

  // a) titres d'abord (la recherche en dépend) ; collecte ensuite, pendant que la fiche et la durée se chargent.
  const titles = await settle(
    () => getTitleVariants(ref, { tmdbToken, fetch: fetchFn, timeoutMs: TITLE_TIMEOUT_MS }),
    NO_TITLES,
  );
  lap('a.titres');
  const collecting = settle(
    () => collectStreams(config, ref, { fetch: fetchFn, titles, budgetMs: budget.sources }),
    EMPTY_COLLECT,
  );
  const metaLoading = Promise.all([
    settle(() => getRuntimeSeconds(ref, { fetch: fetchFn }), undefined),
    settle(() => getContentMeta(ref, { tmdbToken, fetch: fetchFn, timeoutMs: META_TIMEOUT_MS }), {} as ContentMeta),
  ]);
  const collected = await collecting;
  lap('b.sources');
  const [runtime, contentMeta] = await metaLoading;
  const meta: ContentMeta = { ...contentMeta };
  if (meta.runtimeSeconds === undefined && runtime !== undefined) meta.runtimeSeconds = runtime;

  // b) lecture des .torrent sans infoHash (budget propre) ; fusion des copies d'indexeurs par infoHash ensuite.
  const read = await settle(
    () =>
      resolveInfoHashes(collected.streams, {
        fetch: fetchFn,
        topN: RESOLVE_TOP_N,
        cache: ctx.torrentCache,
        budgetMs: budget.torrents,
      }),
    collected.streams,
  );
  lap('c.torrents');
  const streams = mergeIndexerCopies(read);
  if (ctx.packStore !== undefined) {
    for (const raw of streams) {
      if (raw.infoHash !== undefined && raw.packFiles !== undefined && raw.packFiles.length > 0) {
        ctx.packStore.learn(raw.infoHash, raw.packFiles);
      }
    }
  }

  // c) parsing, premier filtre, groupement des copies.
  const candidates: Candidate[] = streams.map((raw) => ({ raw, parsed: parseRawStream(raw) }));
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

  // d) pack learning, puis formatage (un torrent privé sans copie jouable n'est pas livré).
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
  return { streams: formatted, errors: collected.errors };
}
