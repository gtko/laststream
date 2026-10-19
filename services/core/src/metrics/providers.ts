/**
 * Compteurs par fournisseur et par jour (UTC) : appels sortants, lectures de cache (mémoire, KV, valeur périmée servie,
 * requête jointe à un appel en vol), fiches R2 (hit, miss) et réponses 304. Module pur (aucune E/S), comme core.ts :
 * l'accumulateur d'instance, le Durable Object `Metrics` et le mode mémoire s'en servent. Conservation : PROVIDER_DAYS
 * jours UTC, jour courant inclus. Aucun identifiant de titre, de compte ni de clé ici : seulement des compteurs.
 */

export const DAY_MS = 24 * 3600_000;
/** Jours conservés (UTC), jour courant inclus. */
export const PROVIDER_DAYS = 30;

/**
 * Fournisseurs suivis. Liste fermée : un nom hors liste n'entre jamais dans le stockage. `rows` : rangées d'accueil
 * communes lues dans R2 (lt/rows.ts), sans appel amont.
 */
export const PROVIDERS = ['tmdb', 'tvdb', 'openrouter', 'cinemeta', 'mdblist', 'fanart', 'rows'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/**
 * Événements : `call` appel sortant ; `l1hit` / `l2hit` lecture servie par la mémoire / le KV ; `stale` valeur périmée
 * servie pendant un rafraîchissement ; `coalesced` requête jointe à un appel déjà en vol ; `r2hit` / `r2miss` fiche lue /
 * absente du R2 ; `304` réponse non modifiée.
 */
export const PROVIDER_EVENTS = ['call', 'l1hit', 'l2hit', 'stale', 'coalesced', 'r2hit', 'r2miss', '304'] as const;
export type ProviderEvent = (typeof PROVIDER_EVENTS)[number];

/** Compteur d'un (jour UTC, fournisseur, événement). `day` : début du jour UTC en ms epoch. */
export interface ProviderRow {
  day: number;
  provider: ProviderName;
  event: ProviderEvent;
  value: number;
}

export const dayOf = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;

/** Premier jour conservé à l'instant `now` (PROVIDER_DAYS jours, jour courant inclus). */
export const providerWindowStart = (now: number): number => dayOf(now) - (PROVIDER_DAYS - 1) * DAY_MS;

export const isProvider = (value: unknown): value is ProviderName => (PROVIDERS as readonly unknown[]).includes(value);
export const isProviderEvent = (value: unknown): value is ProviderEvent => (PROVIDER_EVENTS as readonly unknown[]).includes(value);

const keyOf = (row: Pick<ProviderRow, 'day' | 'provider' | 'event'>): string => `${row.day}|${row.provider}|${row.event}`;

/** Additionne une ligne de compteur à une table (clé : jour, fournisseur, événement). */
export function addProviderRow(table: Map<string, ProviderRow>, row: ProviderRow): void {
  const key = keyOf(row);
  const existing = table.get(key);
  if (existing === undefined) table.set(key, { ...row });
  else existing.value += row.value;
}

export interface ProviderCounts {
  /** Appels sortants vers le fournisseur (échecs compris). */
  calls: number;
  l1Hits: number;
  l2Hits: number;
  /** Valeurs périmées servies pendant un rafraîchissement (stale-while-revalidate). */
  stale: number;
  /** Requêtes jointes à un appel déjà en vol. */
  coalesced: number;
  r2Hits: number;
  r2Misses: number;
  /** Réponses 304 (non modifiée). */
  notModified: number;
  /**
   * Lectures servies sans appel sortant (mémoire, KV, périmé, jointes) / (ces lectures + appels). Un rafraîchissement en
   * arrière-plan compte comme un appel. Null sans lecture.
   */
  hitRate: number | null;
  /** Fiches R2 lues / (lues + absentes). Null sans lecture R2. */
  r2HitRate: number | null;
}

export interface ProviderEntry extends ProviderCounts {
  provider: ProviderName;
}

export interface ProviderDayEntry {
  /** Jour UTC, AAAA-MM-JJ. */
  day: string;
  providers: ProviderEntry[];
}

export interface ProviderReport {
  windowDays: number;
  /** Premier et dernier jour couverts (UTC, inclus). */
  from: string;
  to: string;
  /** Un bloc par jour ayant des compteurs, du plus ancien au plus récent. */
  byDay: ProviderDayEntry[];
  /** Totaux par fournisseur sur la fenêtre. */
  totals: ProviderEntry[];
}

type Tally = Record<ProviderEvent, number>;

const emptyTally = (): Tally => Object.fromEntries(PROVIDER_EVENTS.map((event) => [event, 0])) as Tally;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function countsOf(tally: Tally): ProviderCounts {
  const served = tally.l1hit + tally.l2hit + tally.stale + tally.coalesced;
  const reads = served + tally.call;
  const r2Reads = tally.r2hit + tally.r2miss;
  return {
    calls: tally.call,
    l1Hits: tally.l1hit,
    l2Hits: tally.l2hit,
    stale: tally.stale,
    coalesced: tally.coalesced,
    r2Hits: tally.r2hit,
    r2Misses: tally.r2miss,
    notModified: tally['304'],
    hitRate: reads === 0 ? null : round3(served / reads),
    r2HitRate: r2Reads === 0 ? null : round3(tally.r2hit / r2Reads),
  };
}

const dateOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/**
 * Rapport des compteurs par fournisseur : un bloc par jour et des totaux, sur la fenêtre de PROVIDER_DAYS jours qui
 * finit au jour de `now`. Fonction pure : même résultat en mémoire et dans le Durable Object.
 */
export function buildProviderReport(rows: readonly ProviderRow[], now: number): ProviderReport {
  const from = providerWindowStart(now);
  const to = dayOf(now);
  const perDay = new Map<number, Map<ProviderName, Tally>>();
  const perProvider = new Map<ProviderName, Tally>();
  const tallyIn = (table: Map<ProviderName, Tally>, provider: ProviderName): Tally => {
    let tally = table.get(provider);
    if (tally === undefined) {
      tally = emptyTally();
      table.set(provider, tally);
    }
    return tally;
  };
  for (const row of rows) {
    if (row.day < from || row.day > to || !isProvider(row.provider) || !isProviderEvent(row.event)) continue;
    let day = perDay.get(row.day);
    if (day === undefined) {
      day = new Map();
      perDay.set(row.day, day);
    }
    tallyIn(day, row.provider)[row.event] += row.value;
    tallyIn(perProvider, row.provider)[row.event] += row.value;
  }
  const byName = (a: ProviderEntry, b: ProviderEntry): number => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider);
  const entries = (table: Map<ProviderName, Tally>): ProviderEntry[] =>
    [...table.entries()].map(([provider, tally]) => ({ provider, ...countsOf(tally) })).sort(byName);
  return {
    windowDays: PROVIDER_DAYS,
    from: dateOf(from),
    to: dateOf(to),
    byDay: [...perDay.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([day, table]) => ({ day: dateOf(day), providers: entries(table) })),
    totals: entries(perProvider),
  };
}
