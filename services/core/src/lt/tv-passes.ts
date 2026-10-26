/**
 * Reprise du Cron TV (LAST-137) : état de chaque source d'un passage à l'autre, plan de la passe suivante et seuil
 * d'alerte. Module pur (ni R2 ni Sentry) : testé sous Node. Les sources sont celles de tv-build.ts : le catalogue
 * (iptv-org, Free-TV, Pluto, Samsung) et chaque fichier EPG XMLTV (clé « epg:<hôte et chemin> »).
 */

/** Reprise : ne relance que les sources en échec et les sondages restants. */
export const TV_RESUME_CRON = '*/30 * * * *';
/** Échecs d'affilée qui déclenchent l'alerte, une seule fois, au franchissement du seuil. */
const ALERT_AFTER_FAILURES = 2;

/** Sources du catalogue : c'est une jointure, une source en échec relance l'étage catalogue entier. */
const CATALOG_SOURCE_IDS = ['iptv', 'freetv', 'pluto', 'samsung'] as const;

/** Clé d'une source EPG (une URL XMLTV), la même que l'étiquette de `epgStats`. */
export const epgSourceId = (url: string): string => 'epg:' + url.replace(/^https:\/\//, '');

/** Résultat d'une source pendant un passage. `error` : code court, jamais de message brut. */
export interface SourceOutcome {
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** Trace d'un passage, remplie par la construction (même en cas d'échec). */
export interface TvPassTrace {
  sources: Record<string, SourceOutcome>;
  /** Sondes faites pendant le passage (absent si le passage ne sondait pas). */
  probes?: number;
  /** Sondages restants, faute de budget (reprise à la passe suivante). */
  probesPending?: boolean;
}

/** État d'une source après son dernier passage. */
interface SourceState {
  /** Dernier succès (ISO), null si la source n'a jamais réussi. */
  lastSuccessAt: string | null;
  /** Échecs d'affilée (0 après un succès). */
  consecutiveFailures: number;
  /** Durée du dernier passage de la source (ms). */
  durationMs: number;
  /** Code d'erreur du dernier échec, null après un succès. */
  error: string | null;
}

export type SourceStates = Record<string, SourceState>;

/** Ce qu'une passe doit faire. `epg` : URL XMLTV à lire. */
export interface PassPlan {
  kind: 'full' | 'resume';
  catalog: boolean;
  epg: readonly string[];
  probes: boolean;
  health: boolean;
}

/**
 * Source à reprendre : en échec, sans dépasser le seuil d'alerte. Au-delà, la reprise l'abandonne et seule la passe
 * complète de 6 h la retente (sinon une source morte relancerait la reprise toutes les 30 min).
 */
const failing = (state: SourceState | undefined): boolean => {
  const failures = state?.consecutiveFailures ?? 0;
  return failures > 0 && failures <= ALERT_AFTER_FAILURES;
};

/**
 * Plan de la reprise : seules les sources en échec (au plus ALERT_AFTER_FAILURES échecs d'affilée), et les sondages
 * restants. Rien (undefined) si tout est à jour, ou si aucun état n'existe encore (la passe complète de 6 h l'établit).
 * Les contrôles de santé ne tournent jamais en reprise : ils ont leur propre cadence (ttl).
 */
export function planResume(states: SourceStates | undefined, epgUrls: readonly string[], probesPending: boolean): PassPlan | undefined {
  if (states === undefined) return undefined;
  const catalog = CATALOG_SOURCE_IDS.some((id) => failing(states[id]));
  const epg = epgUrls.filter((url) => failing(states[epgSourceId(url)]));
  if (!catalog && epg.length === 0 && !probesPending) return undefined;
  return { kind: 'resume', catalog, epg, probes: probesPending, health: false };
}

/**
 * Vrai pendant les cinq premières minutes d'une passe complète (00:00, 06:00… UTC) : la reprise s'efface alors, pour
 * que la passe complète ne trouve pas le verrou pris par elle.
 */
export function isFullPassWindow(scheduledTimeMs: number): boolean {
  const date = new Date(scheduledTimeMs);
  return date.getUTCHours() % 6 === 0 && date.getUTCMinutes() < 5;
}

/** État après un passage : les sources exécutées sont mises à jour, les autres gardent leur état. */
export function applyOutcomes(previous: SourceStates | undefined, outcomes: Record<string, SourceOutcome>, at: string): SourceStates {
  const next: SourceStates = { ...previous };
  for (const [id, outcome] of Object.entries(outcomes)) {
    const before = previous?.[id];
    next[id] = outcome.ok
      ? { lastSuccessAt: at, consecutiveFailures: 0, durationMs: outcome.durationMs, error: null }
      : {
          lastSuccessAt: before?.lastSuccessAt ?? null,
          consecutiveFailures: (before?.consecutiveFailures ?? 0) + 1,
          durationMs: outcome.durationMs,
          error: outcome.error ?? 'erreur',
        };
  }
  return next;
}

/** Sources qui viennent d'atteindre le seuil d'alerte à ce passage (échec, et échecs d'affilée = seuil). */
export function alertsOf(next: SourceStates, outcomes: Record<string, SourceOutcome>): string[] {
  return Object.entries(outcomes)
    .filter(([id, outcome]) => !outcome.ok && next[id]?.consecutiveFailures === ALERT_AFTER_FAILURES)
    .map(([id]) => id);
}
