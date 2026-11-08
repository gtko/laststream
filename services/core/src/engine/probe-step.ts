/**
 * Étape de sonde du moteur : lit l'audio réel des meilleurs candidats éligibles, puis enrichit leurs langues et
 * pistes vérifiées. Le cache de sondes est injectable (défaut : cache partagé de 30 jours).
 *
 * Le serveur ne contacte jamais un lien d'addon : un lien de résolution débridé, appelé depuis l'IP du serveur, serait
 * débridé chez le tiers. Le réseau n'est sollicité que pour les hôtes de la liste blanche `probeHosts` (vide par défaut,
 * câblée par la variable PROBE_HOSTS). Éligibilité, par candidat, dans l'ordre du classement :
 * 1. Candidat direct AVEC infoHash (torrent résolu par un débrideur) : jamais d'appel réseau. Si le cache contient déjà
 *    sa sonde (clé probeCacheKey(infoHash, fileIdx)), elle est appliquée ; sinon le candidat reste inchangé. Aucun code
 *    n'écrit actuellement ces clés : le cache pourra être alimenté plus tard par une sonde côté client.
 * 2. Candidat direct SANS infoHash : sondé seulement si toutes ces conditions sont vraies :
 *    - c'est une URL http(s) ;
 *    - assertNotDebrid ne lève pas (hôte de débridage écarté et signalé) ;
 *    - son hôte (URL.hostname, en minuscules, correspondance exacte) figure dans probeHosts ;
 *    - le dernier segment du chemin, décodé, se termine par .mkv, .mp4, .m4v, .webm, .avi, .mov, .ts ou .m2ts
 *      (insensible à la casse) ;
 *    - aucun segment du chemin ni aucune valeur de la query n'est opaque : 32 caractères ou plus, dans l'alphabet
 *      base64 / base64url (configuration, clé, jeton) ;
 *    - l'URL ne correspond pas à isDebridResolverUrl ;
 *    - son hôte n'est pas mémorisé (voir ci-dessous).
 * 3. Sinon : pas de plan. Le candidat est rendu tel quel et ne compte pas dans topN.
 *
 * Une sonde dont une redirection quitte l'hôte est arrêtée avant tout appel au nouvel hôte ; cet hôte d'origine est
 * mémorisé 24 h (isolat), et ses liens ne sont plus sondés (candidat rendu tel quel, hors topN).
 *
 * Règles :
 * - topN : nombre de sondes réseau (règle 2) à lancer. topN <= 0 ne fait rien, cache compris. Les candidats de la
 *   règle 1 ne consomment pas topN. Les candidats de même clé de cache partagent une seule sonde.
 * - Concurrence : au plus PROBE_CONCURRENCY sondes à la fois. Budget : à l'échéance de budgetMs, les candidats déjà
 *   sondés sont gardés, les autres restent inchangés, et la fonction rend la main (les sondes en cours se terminent
 *   en arrière-plan sans effet sur le résultat).
 * - Échec, délai ou exception : candidat inchangé. La fonction ne lève jamais.
 * - Ni l'URL directe, ni le lien débridé, ni la clé de cache ne sont inclus dans le résultat ni dans les erreurs,
 *   et rien n'est journalisé. Un lien direct sans infoHash a pour clé le sha256 de son URL.
 */

import { createHash } from 'node:crypto';
import { assertNotDebrid, DebridEgressBlockedError, isDebridResolverUrl } from '../egress/debrid-guard.js';
import type { FetchFn } from '../sources/http.js';
import { type MediaProbe, probeMedia } from '../media/probe.js';
import { ProbeCache, peekProbeWithCache, probeCacheKey, probeWithCache } from '../media/probe-cache.js';
import type { AudioTrack } from '../media/tracks.js';
import type { Lang } from '../types.js';
import { type Ranked, type VerifiedAudio, fileIdxOf, infoHashOf, isDirect } from './types.js';

/** Sondes simultanées au plus. */
const PROBE_CONCURRENCY = 3;
/** Budget global de l'étape par défaut, en millisecondes. */
const DEFAULT_BUDGET_MS = 4000;
/** Valeurs acceptées dans parsed.languages (type Lang). */
const LANGS: ReadonlySet<string> = new Set<Lang>(['fr', 'en', 'es', 'de', 'it', 'multi', 'original']);
/** Disposition des canaux, sous la même forme que le parseur ('5.1', '7.1', '2.0'). */
const CHANNEL_LAYOUTS: ReadonlyMap<number, string> = new Map([
  [1, '1.0'],
  [2, '2.0'],
  [6, '5.1'],
  [8, '7.1'],
]);
/** Extension vidéo exigée pour sonder un lien direct sans infoHash (insensible à la casse). */
const MEDIA_EXTENSION = /\.(?:mkv|mp4|m4v|webm|avi|mov|ts|m2ts)$/i;
/** Longueur à partir de laquelle un segment ou une valeur de query est opaque (configuration, clé, jeton). */
const OPAQUE_MIN_LENGTH = 32;
/** Alphabet d'une valeur opaque : base64 et base64url. */
const OPAQUE_ALPHABET = /^[A-Za-z0-9+/=_-]+$/;
/** Liste blanche vide : aucune sonde réseau d'un lien direct sans infoHash. Défaut de l'étape. */
const NO_PROBE_HOSTS: ReadonlySet<string> = new Set<string>();

/** Durée pendant laquelle un hôte qui a redirigé une sonde vers un autre hôte n'est plus sondé : 24 heures. */
const RESOLVER_HOST_TTL_MS = 24 * 60 * 60 * 1000;
/** Nombre maximal d'hôtes mémorisés par isolat. */
const RESOLVER_HOST_MAX = 500;

/** Hôtes d'origine à ne plus sonder : clé = nom d'hôte, valeur = true. */
export type ResolverHostMemo = ProbeCache<true>;

/** Nouvelle mémoire des hôtes résolveurs (24 h, 500 hôtes). L'horloge est injectable (tests). */
export function newResolverHostMemo(now?: () => number): ResolverHostMemo {
  return new ProbeCache<true>({ ttlMs: RESOLVER_HOST_TTL_MS, maxEntries: RESOLVER_HOST_MAX, now });
}

/** Mémoire partagée de l'isolat, utilisée par défaut. */
const sharedResolverHosts = newResolverHostMemo();

/** Options de l'étape. Seul `topN` est obligatoire. */
export interface EnrichWithProbeOptions {
  /** Nombre de sondes réseau à lancer. 0 désactive l'étape. */
  topN: number;
  /** Sonde injectable (tests). Défaut : probeMedia. */
  probe?: typeof probeMedia;
  /** Cache des sondes. Défaut : cache partagé. */
  cache?: ProbeCache<MediaProbe>;
  /** fetch injecté pour les requêtes de sonde (tests). */
  fetch?: FetchFn;
  /** Budget global de l'étape, en millisecondes. Défaut : 4000. */
  budgetMs?: number;
  /** Hôtes à ne plus sonder après une redirection vers un autre hôte. Défaut : mémoire partagée de l'isolat. */
  resolverHosts?: ResolverHostMemo;
  /**
   * Liste blanche : hôtes (URL.hostname, en minuscules, correspondance exacte, sans sous-domaine implicite) dont les liens
   * directs sans infoHash peuvent être sondés. Défaut : ensemble vide, donc aucune sonde réseau. Câblée par PROBE_HOSTS.
   */
  probeHosts?: ReadonlySet<string>;
}

/**
 * Ce qu'il faut pour traiter un groupe de candidats. `cacheOnly` : lecture du cache seul, sans aucun appel réseau (il
 * n'y a pas de `link`). Sinon : sonde du lien `link`, demandé seulement si la clé est absente du cache.
 */
type Plan = { key: string; cacheOnly: true } | { key: string; cacheOnly: false; link: () => Promise<string> };

/** Candidats partageant une même clé : une seule sonde, dont le résultat est appliqué à chacun. */
interface Job {
  plan: Plan;
  /** Indices dans le classement d'entrée. */
  members: number[];
}

/** URL parsée si elle est http(s), sinon undefined. */
function httpUrlOf(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Segment ou valeur décodé, ou undefined si son encodage est invalide. */
function decodedOf(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Valeur opaque : longue et dans l'alphabet base64 / base64url. */
function isOpaque(value: string): boolean {
  return value.length >= OPAQUE_MIN_LENGTH && OPAQUE_ALPHABET.test(value);
}

/**
 * Vrai si l'URL ressemble à un fichier vidéo nu : le dernier segment décodé porte une extension vidéo, et ni segment ni
 * valeur de query n'est opaque (testés bruts et décodés). Un encodage invalide est refusé.
 */
function isMediaFileUrl(url: URL): boolean {
  const segments = url.pathname.split('/');
  const last = decodedOf(segments.at(-1) ?? '');
  if (last === undefined || !MEDIA_EXTENSION.test(last)) return false;
  for (const segment of segments) {
    const decoded = decodedOf(segment);
    if (decoded === undefined || isOpaque(segment) || isOpaque(decoded)) return false;
  }
  for (const part of url.search.slice(1).split('&')) {
    // Valeur après le premier '='. Sans '=', la partie entière est la valeur.
    const value = part.slice(part.indexOf('=') + 1);
    const decoded = decodedOf(value);
    if (decoded === undefined || isOpaque(value) || isOpaque(decoded)) return false;
  }
  return true;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isLang(value: string): value is Lang {
  return LANGS.has(value);
}

/**
 * Règle 1 : candidat direct avec infoHash. Lecture du cache seul, jamais d'appel réseau. Aucun code n'écrit actuellement
 * ces clés (probeCacheKey) : la règle reste en place pour une sonde côté client, à venir.
 */
function cachePlanOf(c: Ranked): Plan | undefined {
  const hash = infoHashOf(c);
  if (!isDirect(c) || hash === undefined) return undefined;
  return { key: probeCacheKey(hash, fileIdxOf(c)), cacheOnly: true };
}

/** Règle 2 : sonde réseau d'un candidat direct sans infoHash, ou undefined si le candidat n'est pas éligible. */
function probePlanOf(c: Ranked, resolverHosts: ResolverHostMemo, probeHosts: ReadonlySet<string>): Plan | undefined {
  if (!isDirect(c) || infoHashOf(c) !== undefined) return undefined;
  const url = c.raw.url ?? '';
  const parsed = httpUrlOf(url);
  if (parsed === undefined) return undefined;
  // Garde de sortie : un lien vers un hôte de débridage est écarté et signalé.
  try {
    assertNotDebrid(url, 'probe');
  } catch (error) {
    if (error instanceof DebridEgressBlockedError) return undefined;
    throw error;
  }
  // Liste blanche (PROBE_HOSTS) : seul un hôte explicitement autorisé est sondé. Correspondance exacte, sans sous-domaine.
  if (!probeHosts.has(parsed.hostname)) return undefined;
  if (!isMediaFileUrl(parsed)) return undefined;
  // Pas de sonde d'un lien de résolution de débrideur (StremThru, ElfHosted, /resolve/<débrideur>/…) : il serait débridé
  // chez le tiers avec l'IP du serveur. Le candidat reste proposé, sans vérification audio.
  if (isDebridResolverUrl(url)) return undefined;
  // Hôte qui a déjà redirigé une sonde vers un autre hôte : ses liens ne sont plus sondés.
  if (resolverHosts.get(parsed.hostname) !== undefined) return undefined;
  return { key: sha256(url), cacheOnly: false, link: async () => url };
}

function addMember(jobs: Map<string, Job>, plan: Plan, index: number): void {
  const job = jobs.get(plan.key) ?? { plan, members: [] };
  job.members.push(index);
  jobs.set(plan.key, job);
}

/**
 * Groupes à traiter. Les candidats de la règle 1 sont tous retenus, sans compter dans topN ; les sondes réseau de la
 * règle 2 sont limitées aux topN premières, dans l'ordre du classement.
 */
function planJobs(ranked: readonly Ranked[], opts: EnrichWithProbeOptions, resolverHosts: ResolverHostMemo): Job[] {
  const cached = new Map<string, Job>();
  const probes = new Map<string, Job>();
  let picked = 0;
  for (let index = 0; index < ranked.length; index += 1) {
    const cachePlan = cachePlanOf(ranked[index]);
    if (cachePlan !== undefined) {
      addMember(cached, cachePlan, index);
      continue;
    }
    if (picked >= opts.topN) continue;
    const plan = probePlanOf(ranked[index], resolverHosts, opts.probeHosts ?? NO_PROBE_HOSTS);
    if (plan === undefined) continue;
    picked += 1;
    addMember(probes, plan, index);
  }
  // Le cache seul passe en premier : il ne lance aucune sonde, donc ni la concurrence ni le budget ne le retardent.
  return [...cached.values(), ...probes.values()];
}

/**
 * Résultat du groupe. Pour le cache seul, lecture sans appel réseau. Sinon, sonde du lien, demandé seulement si la clé
 * est absente du cache (probeWithCache ne lance `fn` que dans ce cas, et partage les appels concurrents d'une même clé).
 */
function probeJob(job: Job, opts: EnrichWithProbeOptions, resolverHosts: ResolverHostMemo): Promise<MediaProbe | null> {
  const { plan } = job;
  if (plan.cacheOnly === true) return Promise.resolve(peekProbeWithCache(plan.key, opts.cache) ?? null);
  const probe = opts.probe ?? probeMedia;
  return probeWithCache(
    plan.key,
    async () => {
      const url = await plan.link();
      return probe(url, {
        fetch: opts.fetch,
        onCrossHostRedirect: (host) => resolverHosts.set(host, true),
      });
    },
    opts.cache,
  );
}

/** Langues ISO 639-1 vérifiées (pistes sans langue exclues) ; 'multi' s'ajoute dès deux langues. */
function verifiedLanguagesOf(audio: readonly AudioTrack[]): string[] {
  const langs = [...new Set(audio.map((track) => track.lang).filter((lang) => /^[a-z]{2}$/.test(lang)))];
  return langs.length >= 2 ? [...langs, 'multi'] : langs;
}

function channelLayout(channels: number | undefined): string {
  if (channels === undefined) return '';
  return CHANNEL_LAYOUTS.get(channels) ?? String(channels);
}

function verifiedAudioOf(audio: readonly AudioTrack[]): VerifiedAudio[] {
  return audio.map((track) => ({
    lang: track.lang,
    codec: track.codec,
    channels: channelLayout(track.channels),
    atmos: track.atmos === true,
  }));
}

/** Langues annoncées, complétées par les langues vérifiées absentes. Les annoncées sont toujours conservées. */
function languagesWith(announced: readonly Lang[], verified: readonly string[]): Lang[] {
  const languages = [...announced];
  for (const lang of verified) {
    if (isLang(lang) && !languages.includes(lang)) languages.push(lang);
  }
  return languages;
}

/** Candidat enrichi par une sonde réussie. Les langues ajoutées restent identifiables via verifiedLanguages. */
function enrich(c: Ranked, probed: MediaProbe): Ranked {
  const verifiedLanguages = verifiedLanguagesOf(probed.audio);
  const next: Ranked = {
    ...c,
    parsed: { ...c.parsed, languages: languagesWith(c.parsed.languages, verifiedLanguages) },
    verifiedLanguages,
    verifiedAudio: verifiedAudioOf(probed.audio),
  };
  if (isDirect(c)) next.directVerified = true;
  return next;
}

/** Exécute `task` sur chaque élément, avec au plus `limit` tâches en parallèle. */
async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/** Attend `work` au plus `budgetMs` millisecondes, puis rend la main sans annuler `work`. */
async function withinBudget(work: Promise<unknown>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enrichit les candidats dont la sonde est en cache (infoHash, règle 1) et les topN premiers liens directs sondables
 * (règle 2) avec les langues et pistes audio réellement lues. Renvoie un nouveau tableau dans le même ordre ; les
 * candidats non sondés, en échec ou hors budget sont renvoyés tels quels. Ne lève jamais.
 */
export async function enrichWithProbe(ranked: Ranked[], opts: EnrichWithProbeOptions): Promise<Ranked[]> {
  if (!(opts.topN > 0)) return ranked;
  const resolverHosts = opts.resolverHosts ?? sharedResolverHosts;
  const jobs = planJobs(ranked, opts, resolverHosts);
  if (jobs.length === 0) return ranked;

  const enriched = new Map<number, Ranked>();
  const work = runLimited(jobs, PROBE_CONCURRENCY, async (job) => {
    try {
      const probed = await probeJob(job, opts, resolverHosts);
      if (probed === null) return;
      for (const index of job.members) enriched.set(index, enrich(ranked[index], probed));
    } catch {
      // Échec isolé : les candidats de ce groupe restent inchangés.
    }
  }).catch(() => undefined);

  await withinBudget(work, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  return ranked.map((c, index) => enriched.get(index) ?? c);
}
