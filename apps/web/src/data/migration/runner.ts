/* Moteur d'import : écrit les éléments choisis un par un et tient un journal par profil sur l'appareil. Une coupure réseau
 * (ou un serveur momentanément indisponible) met l'import en pause ; la reprise repart du premier élément non confirmé.
 * Comme chaque écriture est idempotente et que les éléments confirmés sont sautés, une reprise ne crée pas de doublon.
 * Le journal donne aussi le rapport final : réussis, ignorés, échoués, et la raison de chacun. */

import { LastAddonError } from '../errors';
import { UserApiError } from '../userApi';
import { rememberWatchDate, tagAnime } from './profileMarks';
import { NotFound, type Resolver, type VideoLister } from './resolve';
import type { MigrationSink, ResolvedTitle } from './sink';
import {
  LIST_NAME, SOURCE_LABEL,
  type ItemResult, type ItemStatus, type MigrationAction, type MigrationBundle, type MigrationItem, type MigrationList, type MigrationSource,
} from './types';
import { decodeWatched, type Inflate } from './watchedBitfield';

const JOB_PREFIX = 'laststream.migration.job:';
const SAVE_EVERY = 20;

type JobStatus = 'running' | 'paused' | 'done';

export interface MigrationJob {
  v: 1;
  source: MigrationSource;
  profileId: string;
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  /** Raison de la pause, en langage clair. */
  pausedReason?: string;
  items: MigrationItem[];
  /** Résultat par `uid` : statut et raison. Absent : pas encore traité. */
  results: Record<string, { s: ItemStatus; r?: string }>;
  /** Listes créées (ou retrouvées) pour cet import. */
  lists: Partial<Record<MigrationList, string>>;
}

/** Ordre d'écriture : bibliothèque et listes, puis vus, puis progression (« Reprendre » reflète le dernier état). */
const ORDER: Record<MigrationAction, number> = { library: 0, list: 1, watched: 2, progress: 3 };

export function createJob(bundle: Pick<MigrationBundle, 'source' | 'items'>, profileId: string, now = Date.now()): MigrationJob {
  const seen = new Set<string>();
  const items = bundle.items.filter((i) => (seen.has(i.uid) ? false : (seen.add(i.uid), true)));
  items.sort((a, b) => ORDER[a.action] - ORDER[b.action]);
  return { v: 1, source: bundle.source, profileId, startedAt: now, status: 'running', items, results: {}, lists: {} };
}

// ---------- Journal ----------

export function loadJob(profileId: string): MigrationJob | null {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(JOB_PREFIX + profileId) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const j = raw as MigrationJob;
    return j.v === 1 && Array.isArray(j.items) && j.results && typeof j.results === 'object' ? j : null;
  } catch {
    return null;
  }
}

export function saveJob(job: MigrationJob): void {
  try { globalThis.localStorage?.setItem(JOB_PREFIX + job.profileId, JSON.stringify(job)); } catch { /* stockage plein : la reprise repartira du début, sans doublon */ }
}

export function clearJob(profileId: string): void {
  try { globalThis.localStorage?.removeItem(JOB_PREFIX + profileId); } catch { /* rien à faire */ }
}

// ---------- Rapport ----------

export interface MigrationReport {
  source: MigrationSource;
  total: number;
  done: number;
  ok: number;
  skipped: number;
  failed: number;
  /** Comptes par action (réussis seulement). */
  byAction: Record<MigrationAction, number>;
  /** Éléments ignorés ou échoués, avec leur raison, dans l'ordre de traitement. */
  problems: ItemResult[];
}

export function reportOf(job: MigrationJob): MigrationReport {
  const byAction: Record<MigrationAction, number> = { library: 0, list: 0, watched: 0, progress: 0 };
  const problems: ItemResult[] = [];
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const it of job.items) {
    const r = job.results[it.uid];
    if (!r) continue;
    if (r.s === 'ok') { ok += 1; byAction[it.action] += 1; } else {
      if (r.s === 'skipped') skipped += 1; else failed += 1;
      problems.push({ uid: it.uid, status: r.s, action: it.action, title: it.title, ...(r.r ? { reason: r.r } : {}) });
    }
  }
  return { source: job.source, total: job.items.length, done: ok + skipped + failed, ok, skipped, failed, byAction, problems };
}

/** Rapport en texte brut (à copier ou à télécharger). */
export function reportText(rep: MigrationReport, at = Date.now()): string {
  const lines = [
    'Import ' + SOURCE_LABEL[rep.source] + ' vers Laststream, ' + new Date(at).toLocaleString('fr-FR'),
    'Réussis : ' + rep.ok + ' · Ignorés : ' + rep.skipped + ' · Échoués : ' + rep.failed + ' (sur ' + rep.total + ')',
    '',
  ];
  for (const p of rep.problems) lines.push((p.status === 'skipped' ? 'Ignoré' : 'Échec') + ' · ' + p.title + ' · ' + (p.reason || 'raison inconnue'));
  return lines.join('\n');
}

// ---------- Exécution ----------

/** Coupure réseau ou serveur momentanément indisponible : l'import se met en pause au lieu d'échouer. */
export function isTransient(err: unknown): boolean {
  if (err instanceof UserApiError) return err.status === 0 || err.status === 429 || err.status >= 500;
  if (err instanceof LastAddonError) return err.kind === 'network' || (err.status ?? 0) >= 500 || err.status === 429;
  if (err instanceof TypeError || (err instanceof Error && err.name === 'AbortError')) return true;
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Raison d'un échec définitif, en langage clair. */
function reasonOf(err: unknown): string {
  if (err instanceof NotFound) return err.message;
  if (err instanceof UserApiError) {
    if (err.status === 403) return 'Refusé par le serveur : ce profil ne peut pas modifier ces données';
    if (err.status === 404) return 'Fonction absente du serveur Laststream';
    if (err.status === 400 || err.status === 422) return 'Refusé par le serveur : donnée invalide';
    return 'Refusé par le serveur (' + err.code + ')';
  }
  if (err instanceof LastAddonError) return 'Recherche TMDB impossible : ' + err.message;
  return err instanceof Error && err.message ? err.message : 'Erreur inconnue';
}

export interface RunDeps {
  sink: MigrationSink;
  resolve: Resolver;
  videos: VideoLister;
  inflate?: Inflate;
  /** Appelé après chaque élément. */
  onProgress?: (job: MigrationJob) => void;
  /** Arrêt demandé (navigation, déconnexion) : l'import se met en pause. */
  signal?: AbortSignal;
}

/** Écrit un élément ; renvoie le résultat définitif, ou lève une erreur transitoire. */
async function applyItem(job: MigrationJob, it: MigrationItem, deps: RunDeps): Promise<{ s: ItemStatus; r?: string }> {
  if (it.skipReason) return { s: 'skipped', r: it.skipReason };
  let t: ResolvedTitle;
  try {
    t = await deps.resolve(it);
  } catch (err) {
    if (err instanceof NotFound) return { s: 'failed', r: err.message };
    throw err;
  }
  const key = t.type + ':' + t.id;
  if (it.anime) tagAnime([key]);
  switch (it.action) {
    case 'library':
      await deps.sink.library(t, it.at ?? 0);
      return { s: 'ok' };
    case 'list': {
      const list = it.list ?? 'watchlist';
      if (!deps.sink.hasLists) {
        // Sans listes (sans compte, ou serveur ancien) : le titre rejoint la bibliothèque, rien n'est perdu.
        await deps.sink.library(t, it.at ?? 0);
        return { s: 'ok', r: 'Ajouté à la bibliothèque (listes indisponibles sur ce profil)' };
      }
      const name = LIST_NAME[list] + ' · ' + SOURCE_LABEL[job.source].replace(/ \(fichier\)$/, '');
      const id = await deps.sink.ensureList(list, name, job.lists[list]);
      job.lists[list] = id;
      const already = await deps.sink.listItem(id, t);
      return already ? { s: 'skipped', r: 'Déjà dans la liste « ' + name + ' »' } : { s: 'ok' };
    }
    case 'watched': {
      if (t.type === 'movie') {
        await deps.sink.watched(t, null);
        rememberWatchDate(key, it.at ?? 0);
        return { s: 'ok' };
      }
      let episodes = it.episodes ?? [];
      if (!episodes.length && it.stremioWatched) {
        const imdb = t.imdb ?? it.ref.imdb;
        if (!imdb) return { s: 'failed', r: 'Épisodes vus illisibles : identifiant IMDb manquant' };
        try {
          episodes = await decodeWatched(it.stremioWatched, await deps.videos(imdb), deps.inflate);
        } catch (err) {
          if (err instanceof NotFound) return { s: 'failed', r: err.message };
          if (isTransient(err)) throw err;
          return { s: 'failed', r: 'Épisodes vus illisibles dans les données Stremio' };
        }
      }
      if (!episodes.length) return { s: 'skipped', r: 'Aucun épisode vu à reprendre' };
      await deps.sink.watched(t, episodes);
      rememberWatchDate(key, it.at ?? 0);
      return { s: 'ok' };
    }
    case 'progress': {
      const pos = it.positionSec ?? 0;
      const dur = it.durationSec ?? 0;
      if (pos <= 0 || dur <= 0) return { s: 'skipped', r: 'Position de lecture absente' };
      await deps.sink.progress(t, it.season !== undefined ? { season: it.season, episode: it.episode } : {}, pos, dur);
      return { s: 'ok' };
    }
  }
}

/**
 * Exécute (ou reprend) un import. Renvoie le journal à jour : `done`, ou `paused` avec la raison si le réseau ou le serveur a
 * manqué. Le journal est enregistré régulièrement et à chaque changement d'état.
 */
export async function runJob(job: MigrationJob, deps: RunDeps): Promise<MigrationJob> {
  job.status = 'running';
  delete job.pausedReason;
  saveJob(job);
  let sinceSave = 0;
  for (const it of job.items) {
    if (job.results[it.uid]) continue;
    if (deps.signal?.aborted) {
      job.status = 'paused';
      job.pausedReason = 'Import interrompu : il reprendra là où il s’est arrêté.';
      saveJob(job);
      return job;
    }
    try {
      job.results[it.uid] = await applyItem(job, it, deps);
    } catch (err) {
      if (isTransient(err)) {
        job.status = 'paused';
        job.pausedReason = 'Connexion perdue : l’import reprendra là où il s’est arrêté, sans doublon.';
        saveJob(job);
        deps.onProgress?.(job);
        return job;
      }
      job.results[it.uid] = { s: 'failed', r: reasonOf(err) };
    }
    deps.onProgress?.(job);
    if (++sinceSave >= SAVE_EVERY) { saveJob(job); sinceSave = 0; }
  }
  job.status = 'done';
  job.finishedAt = Date.now();
  saveJob(job);
  return job;
}
