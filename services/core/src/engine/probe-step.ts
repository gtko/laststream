/**
 * Étape de sonde du moteur : lit l'audio réel des meilleurs candidats éligibles, puis enrichit leurs langues et
 * pistes vérifiées. Le cache de sondes est injectable (défaut : cache partagé de 30 jours).
 *
 * Éligibilité, dans l'ordre du classement : seuls les liens directs http(s) sont sondés tels quels. Le serveur n'appelle
 * jamais AllDebrid : les candidats sans lien direct ne sont pas sondés.
 *
 * Règles :
 * - topN : nombre de candidats éligibles à sonder. topN <= 0 ne fait rien. Les candidats de même clé de cache
 *   partagent une seule sonde.
 * - Concurrence : au plus PROBE_CONCURRENCY sondes à la fois. Budget : à l'échéance de budgetMs, les candidats déjà
 *   sondés sont gardés, les autres restent inchangés, et la fonction rend la main (les sondes en cours se terminent
 *   en arrière-plan sans effet sur le résultat).
 * - Échec, délai ou exception : candidat inchangé. La fonction ne lève jamais.
 * - Ni l'URL directe, ni le lien débridé, ni la clé de cache ne sont inclus dans le résultat ni dans les erreurs,
 *   et rien n'est journalisé. Un lien direct sans infoHash a pour clé le sha256 de son URL.
 */

import { createHash } from 'node:crypto';
import type { FetchFn } from '../sources/http.js';
import { type MediaProbe, probeMedia } from '../media/probe.js';
import { type ProbeCache, probeCacheKey, probeWithCache } from '../media/probe-cache.js';
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

/** Options de l'étape. Seul `topN` est obligatoire. */
export interface EnrichWithProbeOptions {
  /** Nombre de candidats éligibles à sonder. 0 désactive l'étape. */
  topN: number;
  /** Sonde injectable (tests). Défaut : probeMedia. */
  probe?: typeof probeMedia;
  /** Cache des sondes. Défaut : cache partagé. */
  cache?: ProbeCache<MediaProbe>;
  /** fetch injecté pour les requêtes de sonde (tests). */
  fetch?: FetchFn;
  /** Budget global de l'étape, en millisecondes. Défaut : 4000. */
  budgetMs?: number;
}

/** Ce qu'il faut pour sonder un candidat : clé de cache, et lien à sonder (obtenu seulement si la sonde manque). */
interface Plan {
  key: string;
  link: () => Promise<string>;
}

/** Candidats partageant une même clé : une seule sonde, dont le résultat est appliqué à chacun. */
interface Job {
  plan: Plan;
  /** Indices dans le classement d'entrée. */
  members: number[];
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isLang(value: string): value is Lang {
  return LANGS.has(value);
}

/** Plan de sonde d'un candidat, ou undefined s'il n'est pas éligible (seul un lien direct l'est). */
function planOf(c: Ranked): Plan | undefined {
  const hash = infoHashOf(c);
  const fileIdx = fileIdxOf(c);
  if (isDirect(c)) {
    const url = c.raw.url ?? '';
    if (!isHttpUrl(url)) return undefined;
    return { key: hash === undefined ? sha256(url) : probeCacheKey(hash, fileIdx), link: async () => url };
  }
  return undefined;
}

/** Groupes des candidats éligibles, dans l'ordre du classement, limités à topN candidats. */
function planJobs(ranked: readonly Ranked[], opts: EnrichWithProbeOptions): Job[] {
  const jobs = new Map<string, Job>();
  let picked = 0;
  for (let index = 0; index < ranked.length && picked < opts.topN; index += 1) {
    const plan = planOf(ranked[index]);
    if (plan === undefined) continue;
    picked += 1;
    const job = jobs.get(plan.key) ?? { plan, members: [] };
    job.members.push(index);
    jobs.set(plan.key, job);
  }
  return [...jobs.values()];
}

/**
 * Sonde du groupe. Le lien n'est demandé que si la clé est absente du cache (probeWithCache ne lance `fn` que dans
 * ce cas, et partage les appels concurrents d'une même clé).
 */
function probeJob(job: Job, opts: EnrichWithProbeOptions): Promise<MediaProbe | null> {
  const probe = opts.probe ?? probeMedia;
  return probeWithCache(
    job.plan.key,
    async () => {
      const url = await job.plan.link();
      return probe(url, { fetch: opts.fetch });
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
 * Enrichit les topN premiers candidats éligibles (cachés chez le débrideur avec infoHash, ou liens directs http(s))
 * avec les langues et pistes audio réellement lues. Renvoie un nouveau tableau dans le même ordre ; les candidats
 * non sondés, en échec ou hors budget sont renvoyés tels quels. Ne lève jamais.
 */
export async function enrichWithProbe(ranked: Ranked[], opts: EnrichWithProbeOptions): Promise<Ranked[]> {
  if (!(opts.topN > 0)) return ranked;
  const jobs = planJobs(ranked, opts);
  if (jobs.length === 0) return ranked;

  const enriched = new Map<number, Ranked>();
  const work = runLimited(jobs, PROBE_CONCURRENCY, async (job) => {
    try {
      const probed = await probeJob(job, opts);
      if (probed === null) return;
      for (const index of job.members) enriched.set(index, enrich(ranked[index], probed));
    } catch {
      // Échec isolé : les candidats de ce groupe restent inchangés.
    }
  }).catch(() => undefined);

  await withinBudget(work, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  return ranked.map((c, index) => enriched.get(index) ?? c);
}
