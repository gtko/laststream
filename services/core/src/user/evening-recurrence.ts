/**
 * Calcul pur des occurrences d'une série hebdomadaire de soirées dans un fuseau horaire. Seul `Intl.DateTimeFormat`
 * fournit le fuseau : aucune dépendance à Cloudflare ni à Node.
 *
 * Une occurrence est un jour civil combiné à une heure murale (`localTime`) dans `tz`. Son instant UTC est recalculé
 * pour chaque jour, ce qui conserve l'heure murale à travers les changements d'heure.
 */

/** Règle d'une série hebdomadaire. */
export interface SeriesRule {
  /** Fuseau IANA, par exemple `Europe/Paris`. */
  tz: string;
  /** Jour de la semaine : 0 = dimanche, …, 6 = samedi. */
  weekday: number;
  /** Heure murale locale au format `HH:MM` sur 24 h. */
  localTime: string;
  /** Pas en semaines : 1 = chaque semaine, 2 = une semaine sur deux. */
  interval: 1 | 2;
  /** Dernier instant admis (ms UTC, inclus), ou `null` pour une série sans fin. */
  untilAt: number | null;
  /** Ms UTC de la première occurrence : l'ancre fixe la phase des semaines et rien n'est produit avant elle. */
  anchorStartsAt: number;
}

interface HeureMurale {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const MS_PAR_SECONDE = 1_000;
const MS_PAR_MINUTE = 60_000;
const MS_PAR_JOUR = 86_400_000;
const FORMAT_HEURE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Formateurs par fuseau. Seuls les fuseaux valides entrent dans le cache : la construction lève pour les autres. */
const formateurs = new Map<string, Intl.DateTimeFormat>();

function formateurPour(tz: string): Intl.DateTimeFormat {
  let formateur = formateurs.get(tz);
  if (!formateur) {
    formateur = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formateurs.set(tz, formateur);
  }
  return formateur;
}

/** Vrai si `tz` est un fuseau IANA reconnu par le moteur JavaScript (ex. `Europe/Paris`, `UTC`). */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    formateurPour(tz);
    return true;
  } catch {
    return false;
  }
}

function verifierFuseau(tz: string): void {
  if (!isValidTimeZone(tz)) throw new RangeError(`Fuseau horaire invalide : ${tz}`);
}

/** Heure murale (date et heure locales) de l'instant `utcMs` dans `tz`. */
function heureMurale(tz: string, utcMs: number): HeureMurale {
  const parts = formateurPour(tz).formatToParts(new Date(utcMs));
  const lire = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: lire('year'),
    month: lire('month'),
    day: lire('day'),
    hour: lire('hour'),
    minute: lire('minute'),
    second: lire('second'),
  };
}

/** Décalage en ms entre l'heure murale de `tz` et UTC à l'instant `utcMs` (positif à l'est de Greenwich). */
function decalageA(tz: string, utcMs: number): number {
  const h = heureMurale(tz, utcMs);
  const murealCommeUtc = Date.UTC(h.year, h.month - 1, h.day, h.hour, h.minute, h.second);
  return murealCommeUtc - Math.floor(utcMs / MS_PAR_SECONDE) * MS_PAR_SECONDE;
}

/**
 * Numéro du jour civil `y-m-d` (jours écoulés depuis le 1er janvier 1970, sans fuseau). Lève si la date n'existe pas
 * (ex. 30 février).
 */
function numeroJour(y: number, m: number, d: number): number {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new RangeError(`Date invalide : ${y}-${m}-${d}`);
  }
  const ms = Date.UTC(y, m - 1, d);
  const reelle = new Date(ms);
  if (reelle.getUTCFullYear() !== y || reelle.getUTCMonth() !== m - 1 || reelle.getUTCDate() !== d) {
    throw new RangeError(`Date invalide : ${y}-${m}-${d}`);
  }
  return ms / MS_PAR_JOUR;
}

/** Date civile `{ y, m, d }` (m de 1 à 12) correspondant à un numéro de jour. */
function dateDuNumero(numero: number): { y: number; m: number; d: number } {
  const date = new Date(numero * MS_PAR_JOUR);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** Jour de la semaine (0 = dimanche) d'un numéro de jour. */
function jourDeSemaine(numero: number): number {
  return new Date(numero * MS_PAR_JOUR).getUTCDay();
}

/**
 * Instant UTC (ms) de l'heure murale `hh:mm` du jour `y-m-d` dans `tz`. `m` va de 1 à 12.
 * - Heure ambiguë (retour à l'heure d'hiver) : la première occurrence, c'est-à-dire l'instant le plus ancien, est renvoyée.
 * - Heure absente (passage à l'heure d'été) : on garde le décalage d'avant la transition, donc l'heure est repoussée
 *   de la durée du trou. Par exemple 02:30 le 28/03/2027 à Paris donne 03:30 CEST.
 */
export function zonedToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number): number {
  verifierFuseau(tz);
  const jour = numeroJour(y, m, d);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) {
    throw new RangeError(`Heure invalide : ${hh}:${mm}`);
  }
  // Heure murale traitée comme si elle était UTC : point de départ du calcul du décalage réel.
  const murale = jour * MS_PAR_JOUR + (hh * 60 + mm) * MS_PAR_MINUTE;
  // Les transitions sont espacées de plusieurs mois : un jour de marge de part et d'autre suffit pour trouver
  // le décalage avant et après une éventuelle transition.
  const avant = decalageA(tz, murale - MS_PAR_JOUR);
  const apres = decalageA(tz, murale + MS_PAR_JOUR);
  const candidats: number[] = [];
  for (const decalage of new Set([avant, apres])) {
    const instant = murale - decalage;
    if (decalageA(tz, instant) === decalage) candidats.push(instant);
  }
  if (candidats.length > 0) return Math.min(...candidats);
  // Heure absente : aucun décalage ne la réalise, on applique le décalage d'avant la transition.
  return murale - avant;
}

/**
 * Jusqu'à `n` instants UTC (ms) strictement postérieurs à `from`, triés, où la série tombe.
 *
 * Une occurrence tombe sur `weekday` dans la semaine (lundi à dimanche) de l'ancre, puis toutes les `interval` semaines.
 * Aucune occurrence n'est renvoyée avant `anchorStartsAt`, ni après `untilAt` (inclus). Lève une `RangeError` si la
 * règle ou les paramètres sont invalides.
 */
export function nextOccurrences(rule: SeriesRule, from: number, n: number): number[] {
  verifierFuseau(rule.tz);
  if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
    throw new RangeError(`Jour de semaine invalide : ${rule.weekday}`);
  }
  const heure = FORMAT_HEURE.exec(rule.localTime);
  if (heure === null) throw new RangeError(`Heure locale invalide : ${rule.localTime}`);
  if (rule.interval !== 1 && rule.interval !== 2) throw new RangeError(`Intervalle invalide : ${rule.interval}`);
  if (!Number.isFinite(from) || !Number.isFinite(rule.anchorStartsAt)) throw new RangeError('Instant invalide');
  if (rule.untilAt !== null && !Number.isFinite(rule.untilAt)) {
    throw new RangeError(`Fin de série invalide : ${rule.untilAt}`);
  }
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`Nombre d'occurrences invalide : ${n}`);
  if (n === 0) return [];

  const hh = Number(heure[1]);
  const mm = Number(heure[2]);
  const ancre = heureMurale(rule.tz, rule.anchorStartsAt);
  const jourAncre = numeroJour(ancre.year, ancre.month, ancre.day);
  // Lundi de la semaine de l'ancre. Le jour demandé tombe `decalage` jours après ce lundi (lundi = 0).
  const lundiAncre = jourAncre - ((jourDeSemaine(jourAncre) + 6) % 7);
  const decalage = (rule.weekday + 6) % 7;
  const pas = 7 * rule.interval;

  const depart = heureMurale(rule.tz, from);
  const jourDepart = numeroJour(depart.year, depart.month, depart.day);
  // Premier indice parcouru : une période avant le jour de `from`, sans parcourir la série depuis son début.
  let k = Math.max(0, Math.floor((jourDepart - (lundiAncre + decalage)) / pas) - 1);
  const occurrences: number[] = [];
  while (occurrences.length < n) {
    const { y, m, d } = dateDuNumero(lundiAncre + decalage + pas * k);
    k += 1;
    const instant = zonedToUtc(rule.tz, y, m, d, hh, mm);
    if (rule.untilAt !== null && instant > rule.untilAt) break;
    if (instant > from && instant >= rule.anchorStartsAt) occurrences.push(instant);
  }
  return occurrences;
}
