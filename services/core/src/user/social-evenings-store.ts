import { randomUUID } from 'node:crypto';
import { nextOccurrences, type SeriesRule } from './evening-recurrence.js';
import type { SqlDb, SqlParam } from './sql.js';

/**
 * Soirées planifiées (LAST-198, lot L1a) : soirées ponctuelles et séries récurrentes entre amis, avec invitations,
 * réponses, rappel T-15 min et fenêtre glissante de quatre occurrences par série. Même base que les autres stores
 * sociaux (SQLite Node ou Durable Object), requêtes paramétrées, identifiants publics seulement (pid).
 *
 * Droits : une soirée n'est visible que de son hôte et de ses invités non retirés. Seul l'hôte modifie, annule ou
 * invite ; un invité répond ou quitte. Un invité doit être un ami accepté : pour tout autre profil (en attente, bloqué
 * dans un sens ou dans l'autre, enfant, inconnu, membre du foyer), la réponse est la même, `not_friend`.
 *
 * L'hôte figure parmi les invités de sa soirée, avec la réponse « yes ». Les méthodes sont synchrones et reçoivent
 * l'instant `now` (ms) : ni horloge ni dépendance Cloudflare ici. `tick` renvoie les rappels à émettre et l'instant du
 * prochain réveil, sans rien émettre lui-même.
 */

const WINDOW_SIZE = 4;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Une soirée commence au plus tôt dans une minute et au plus tard dans 90 jours ; une fin de série au plus tard dans un an. */
const MIN_LEAD_MS = MINUTE_MS;
const MAX_AHEAD_MS = 90 * DAY_MS;
const MAX_UNTIL_AHEAD_MS = 365 * DAY_MS;
const TITLE_MAX = 80;
/** Invités par soirée, hôte non compris. */
const MAX_GUESTS = 19;
/** Soirées ponctuelles à venir et séries actives, par hôte. Les occurrences d'une série ne comptent pas parmi les soirées. */
const MAX_ONE_OFF = 10;
const MAX_SERIES = 5;
/** Rappel à partir de T-15 min ; soirées passées conservées 30 jours ; rappels traités par tick. */
const REMINDER_LEAD_MS = 15 * MINUTE_MS;
const PURGE_AFTER_MS = 30 * DAY_MS;
const TICK_BATCH = 200;
/** Une soirée commencée depuis moins de 2 h est encore « en cours » (fenêtre d'ouverture du salon). */
const LIVE_GRACE_MS = 2 * 60 * MINUTE_MS;
/** Soirées renvoyées au plus par page de liste. */
export const MAX_EVENING_PAGE = 50;

type EveningResponse = 'pending' | 'yes' | 'maybe' | 'no';
type Answer = 'yes' | 'maybe' | 'no';
type EveningStatus = 'scheduled' | 'cancelled';
type SeriesStatus = 'active' | 'stopped';
export type EveningScope = 'occurrence' | 'series';
type EveningListScope = 'upcoming' | 'past' | 'invites';

/** Règle d'une série : fuseau IANA, jour (0 = dimanche), heure locale HH:MM, cadence (1 ou 2 semaines), fin facultative (ms). */
export interface SeriesRuleInput {
  tz: string;
  weekday: number;
  localTime: string;
  interval: 1 | 2;
  untilAt: number | null;
}

export interface EveningCreateInput {
  title: string;
  /** Début de la soirée ; avec `series`, début de la première occurrence, qui doit tomber sur la règle. */
  startsAt: number;
  /** Fuseau IANA de la soirée. Avec `series`, celui de la règle, qui doit être le même. */
  tz: string;
  /** Pids des invités, amis acceptés. L'hôte n'est pas à inclure. */
  guests: readonly string[];
  series?: SeriesRuleInput;
}

/** Modification d'une occurrence (titre, début) ou d'une série (titre, règle). Un champ absent reste inchangé. */
export type EveningChange =
  | { scope: 'occurrence'; title?: string; startsAt?: number }
  | ({ scope: 'series'; title?: string } & Partial<SeriesRuleInput>);

export interface EveningListOptions {
  scope: EveningListScope;
  /** Curseur renvoyé par la page précédente. */
  cursor?: string;
  limit: number;
}

interface EveningGuest {
  pid: string;
  response: EveningResponse;
  respondedAt: number | null;
}

interface EveningSeriesView {
  id: string;
  status: SeriesStatus;
  tz: string;
  weekday: number;
  localTime: string;
  interval: 1 | 2;
  untilAt: number | null;
}

/** Soirée telle que la voit un participant : `role` et `myResponse` sont ceux du profil qui consulte. */
export interface EveningView {
  id: string;
  title: string;
  startsAt: number;
  /** Fuseau IANA de la soirée (celui de sa série pour une occurrence). */
  tz: string;
  status: EveningStatus;
  overridden: boolean;
  hostPid: string;
  role: 'host' | 'guest';
  myResponse: EveningResponse;
  partyId: string | null;
  series: EveningSeriesView | null;
  guests: EveningGuest[];
}

/** Échecs communs. `not_friend` ne dit jamais pourquoi le profil visé n'est pas un ami. */
export type EveningFailure =
  | { result: 'evening_not_found' }
  | { result: 'not_host' }
  | { result: 'not_friend' }
  | { result: 'evening_closed' }
  | { result: 'too_many_evenings' }
  | { result: 'invalid_body' };

export type EveningCreateOutcome = EveningFailure | { result: 'ok'; evening: EveningView };
export type EveningGetOutcome = { result: 'evening_not_found' } | { result: 'ok'; evening: EveningView };
export type EveningListOutcome = { result: 'invalid_body' } | { result: 'ok'; items: EveningView[]; nextCursor: string | null };
/** `evening` vaut `null` quand une modification de série a remplacé l'occurrence visée par la nouvelle règle. */
export type EveningUpdateOutcome = EveningFailure | { result: 'ok'; evening: EveningView | null; removed?: RemovedEvening[] };

/** Occurrence supprimée par une modification de série : `pids` = hôte et invités qui n'avaient pas dit non (à prévenir). */
interface RemovedEvening {
  eveningId: string;
  hostPid: string;
  pids: string[];
}
export type EveningOutcome = EveningFailure | { result: 'ok' };

interface EveningReminder {
  type: 'reminder';
  eveningId: string;
  title: string;
  startsAt: number;
  tz: string;
  hostPid: string;
}

interface EveningEffect {
  /** Destinataires : invités qui n'ont pas répondu « non », hôte compris. */
  pids: string[];
  event: EveningReminder;
}

export interface TickOutcome {
  effects: EveningEffect[];
  /** Instant (ms) du prochain tick utile, ou `null` s'il n'y a rien à attendre. */
  nextWake: number | null;
}

/** Ligne d'une soirée, avec les colonnes de sa série (`s_*`, nulles pour une soirée ponctuelle). */
interface EveningRow {
  id: string;
  series_id: string | null;
  host_pid: string;
  title: string;
  tz: string;
  starts_at: number;
  status: string;
  overridden: number;
  party_id: string | null;
  reminded_at: number | null;
  s_status: string | null;
  s_tz: string | null;
  s_weekday: number | null;
  s_local_time: string | null;
  s_interval: number | null;
  s_until_at: number | null;
}

/** Ligne brute d'une série. `anchor_at` : première occurrence, qui fixe la parité des semaines. */
interface SeriesRow {
  id: string;
  host_pid: string;
  title: string;
  tz: string;
  weekday: number;
  local_time: string;
  interval: number;
  until_at: number | null;
  status: string;
  anchor_at: number;
}

interface GuestRow {
  pid: string;
  response: string;
  responded_at: number | null;
}

interface DueRow {
  id: string;
  title: string;
  starts_at: number;
  tz: string;
  host_pid: string;
}

/** Invité retiré d'une soirée future par `detach`. */
export interface DetachedGuest {
  eveningId: string;
  hostPid: string;
  guestPid: string;
}

const EVENING_SELECT = `SELECT e.id, e.series_id, e.host_pid, e.title, e.tz, e.starts_at, e.status, e.overridden, e.party_id, e.reminded_at,
  s.status AS s_status, s.tz AS s_tz, s.weekday AS s_weekday, s.local_time AS s_local_time, s.interval AS s_interval, s.until_at AS s_until_at
  FROM evenings e LEFT JOIN evening_series s ON s.id = e.series_id`;

const SERIES_SELECT = 'SELECT id, host_pid, title, tz, weekday, local_time, interval, until_at, status, anchor_at FROM evening_series';

const INVALID = { result: 'invalid_body' } as const;

/** Titre sans espaces en bordure, de 1 à 80 caractères (points de code). */
function normalizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const title = raw.trim();
  const length = Array.from(title).length;
  return length >= 1 && length <= TITLE_MAX ? title : undefined;
}

function isValidStart(startsAt: number, now: number): boolean {
  return Number.isSafeInteger(startsAt) && startsAt >= now + MIN_LEAD_MS && startsAt <= now + MAX_AHEAD_MS;
}

/** Fuseau IANA de 1 à 64 caractères, reconnu par Intl. */
function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isValidRule(rule: SeriesRuleInput, now: number): boolean {
  if (!isValidTimezone(rule.tz)) return false;
  if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) return false;
  if (typeof rule.localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.localTime)) return false;
  if (rule.interval !== 1 && rule.interval !== 2) return false;
  if (rule.untilAt !== null && !(Number.isSafeInteger(rule.untilAt) && rule.untilAt > now && rule.untilAt <= now + MAX_UNTIL_AHEAD_MS)) return false;
  return true;
}

/**
 * Invités dédoublonnés ; `undefined` si la liste est trop longue, n'est pas une liste de chaînes, ou contient l'hôte. Un pid mal
 * formé n'est pas refusé ici : ce n'est pas un ami, donc `not_friend`, comme un pid inconnu.
 */
function normalizeGuests(input: unknown, hostPid: string): string[] | undefined {
  if (!Array.isArray(input) || input.length > MAX_GUESTS) return undefined;
  const pids = [...new Set<unknown>(input)];
  if (!pids.every((pid): pid is string => typeof pid === 'string' && pid !== hostPid)) return undefined;
  return pids;
}

function isAnswer(value: unknown): value is Answer {
  return value === 'yes' || value === 'maybe' || value === 'no';
}

/** Curseur `<début en ms>:<identifiant>` ; `undefined` s'il est mal formé. */
function parseCursor(raw: string): { startsAt: number; id: string } | undefined {
  const match = /^(\d{1,15}):([\w-]{1,64})$/.exec(raw);
  if (match === null) return undefined;
  return { startsAt: Number(match[1]), id: match[2] ?? '' };
}

/** Une soirée est ouverte (on peut la modifier, y répondre, la quitter) tant qu'elle est prévue et pas commencée. */
function isOpen(row: EveningRow, now: number): boolean {
  return row.status === 'scheduled' && row.starts_at > now;
}

function ruleOf(series: SeriesRow): SeriesRule {
  return {
    tz: series.tz,
    weekday: series.weekday,
    localTime: series.local_time,
    interval: series.interval === 2 ? 2 : 1,
    untilAt: series.until_at,
    anchorStartsAt: series.anchor_at,
  };
}

function pairOf(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

/**
 * Supprime les lignes de soirées d'un profil : séries et soirées qu'il héberge (invités en cascade), ses invitations et
 * ses séries suivies. Sans transaction propre : l'appelant (purge sociale, `purgeProfile`) la fournit.
 */
export function purgeEveningRows(db: SqlDb, pid: string): void {
  db.prepare('DELETE FROM evening_series WHERE host_pid = ?').run(pid);
  db.prepare('DELETE FROM evenings WHERE host_pid = ?').run(pid);
  db.prepare('DELETE FROM evening_guests WHERE pid = ?').run(pid);
  db.prepare('DELETE FROM evening_series_guests WHERE pid = ?').run(pid);
}

export class EveningStore {
  constructor(private readonly db: SqlDb) {}

  /** Crée une soirée ponctuelle, ou une série dont la première occurrence est `startsAt`. */
  create(hostPid: string, input: EveningCreateInput, now: number): EveningCreateOutcome {
    return this.db.transaction((): EveningCreateOutcome => {
      if (!this.isAdult(hostPid)) return { result: 'not_host' };
      const title = normalizeTitle(input.title);
      if (title === undefined || !isValidStart(input.startsAt, now) || !isValidTimezone(input.tz)) return INVALID;
      const guests = normalizeGuests(input.guests, hostPid);
      if (guests === undefined) return INVALID;
      const rule = input.series;
      if (rule !== undefined) {
        if (!isValidRule(rule, now) || rule.tz !== input.tz) return INVALID;
        // Le début doit être une occurrence de la règle, sinon la série et sa première soirée divergeraient.
        const first = nextOccurrences({ ...rule, anchorStartsAt: input.startsAt }, input.startsAt - 1, 1)[0];
        if (first !== input.startsAt) return INVALID;
      }
      for (const pid of guests) {
        if (!this.canInvite(hostPid, pid)) return { result: 'not_friend' };
      }

      if (rule === undefined) {
        if (this.countOneOff(hostPid, now) >= MAX_ONE_OFF) return { result: 'too_many_evenings' };
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO evenings (id, series_id, host_pid, title, tz, starts_at, status, overridden, party_id, reminded_at, slot_at, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, 'scheduled', 0, NULL, NULL, NULL, ?, ?)",
          )
          .run(id, hostPid, title, input.tz, input.startsAt, now, now);
        this.insertGuests(id, hostPid, guests, now);
        return { result: 'ok', evening: this.mustView(id, hostPid) };
      }

      if (this.countActiveSeries(hostPid) >= MAX_SERIES) return { result: 'too_many_evenings' };
      const seriesId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO evening_series (id, host_pid, title, tz, weekday, local_time, interval, until_at, status, anchor_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
        )
        .run(seriesId, hostPid, title, rule.tz, rule.weekday, rule.localTime, rule.interval, rule.untilAt, input.startsAt, now);
      for (const pid of guests) {
        this.db.prepare('INSERT INTO evening_series_guests (series_id, pid, left_at) VALUES (?, ?, NULL)').run(seriesId, pid);
      }
      const series = this.seriesOf(seriesId);
      if (series === undefined) throw new Error('série introuvable après écriture');
      this.materialize(series, now);
      const first = this.db.prepare('SELECT id FROM evenings WHERE series_id = ? AND starts_at = ?').get(seriesId, input.startsAt) as unknown as
        | { id: string }
        | undefined;
      if (first === undefined) throw new Error('première occurrence absente après écriture');
      return { result: 'ok', evening: this.mustView(first.id, hostPid) };
    });
  }

  /** Une soirée visible par `viewer` (hôte ou invité non retiré). */
  get(viewer: string, id: string): EveningGetOutcome {
    const row = this.participantRow(id, viewer);
    if (row === undefined) return { result: 'evening_not_found' };
    return { result: 'ok', evening: this.viewOf(row, viewer) };
  }

  /**
   * Soirées de `viewer` : `upcoming` (à venir, annulées comprises), `past` (commencées), `invites` (à venir, hôte exclu,
   * sans réponse). Tri par date, curseur keyset, `limit` entre 1 et 50.
   */
  list(viewer: string, options: EveningListOptions, now: number): EveningListOutcome {
    const { scope, limit } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENING_PAGE) return INVALID;
    const cursor = options.cursor === undefined ? undefined : parseCursor(options.cursor);
    if (options.cursor !== undefined && cursor === undefined) return INVALID;

    const clauses = [
      '(e.host_pid = ? OR (EXISTS (SELECT 1 FROM evening_guests g WHERE g.evening_id = e.id AND g.pid = ?) AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_pid = ? AND b.blocked_pid = e.host_pid) OR (b.blocker_pid = e.host_pid AND b.blocked_pid = ?))))',
    ];
    const params: SqlParam[] = [viewer, viewer, viewer, viewer];
    if (scope === 'past') {
      clauses.push('e.starts_at < ?');
    } else {
      clauses.push('e.starts_at >= ?');
    }
    params.push(now);
    if (scope === 'invites') {
      clauses.push(
        "e.status = 'scheduled' AND e.host_pid <> ? AND EXISTS (SELECT 1 FROM evening_guests g WHERE g.evening_id = e.id AND g.pid = ? AND g.response = 'pending')",
      );
      params.push(viewer, viewer);
    }
    const dir = scope === 'past' ? 'DESC' : 'ASC';
    if (cursor !== undefined) {
      clauses.push(scope === 'past' ? '(e.starts_at, e.id) < (?, ?)' : '(e.starts_at, e.id) > (?, ?)');
      params.push(cursor.startsAt, cursor.id);
    }
    params.push(limit + 1);
    const rows = this.db
      .prepare(`${EVENING_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY e.starts_at ${dir}, e.id ${dir} LIMIT ?`)
      .all(...params) as unknown as EveningRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last !== undefined ? `${last.starts_at}:${last.id}` : null;
    return { result: 'ok', items: page.map((row) => this.viewOf(row, viewer)), nextCursor };
  }

  /**
   * Modifie une occurrence (`overridden` passe à 1 dans une série) ou une série (titre, règle). Une occurrence dont le
   * début change repasse en attente pour tous les invités. Une série met à jour ses occurrences futures non modifiées :
   * celles qui ne tombent plus sur la règle sont retirées, les nouvelles générées.
   */
  update(viewer: string, id: string, change: EveningChange, now: number): EveningUpdateOutcome {
    return this.db.transaction((): EveningUpdateOutcome => {
      const row = this.participantRow(id, viewer);
      if (row === undefined) return { result: 'evening_not_found' };
      if (row.host_pid !== viewer) return { result: 'not_host' };
      if (change.scope === 'occurrence') return this.updateOccurrence(row, viewer, change, now);
      return this.updateSeries(row, viewer, change, now);
    });
  }

  /** Annule une soirée (`occurrence`) ; `series` arrête la série, comme `stop`. */
  cancel(viewer: string, id: string, scope: EveningScope, now: number): EveningOutcome {
    if (scope === 'series') return this.stop(viewer, id, now);
    return this.db.transaction((): EveningOutcome => {
      const row = this.participantRow(id, viewer);
      if (row === undefined) return { result: 'evening_not_found' };
      if (row.host_pid !== viewer) return { result: 'not_host' };
      if (!isOpen(row, now)) return { result: 'evening_closed' };
      this.db.prepare("UPDATE evenings SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, id);
      return { result: 'ok' };
    });
  }

  /** Arrête la série de la soirée : statut `stopped`, fin à `now`, occurrences futures annulées. */
  stop(viewer: string, id: string, now: number): EveningOutcome {
    return this.db.transaction((): EveningOutcome => {
      const row = this.participantRow(id, viewer);
      if (row === undefined) return { result: 'evening_not_found' };
      if (row.host_pid !== viewer) return { result: 'not_host' };
      if (row.series_id === null) return INVALID;
      const series = this.seriesOf(row.series_id);
      if (series === undefined) return { result: 'evening_not_found' };
      if (series.status !== 'active') return { result: 'evening_closed' };
      this.db.prepare("UPDATE evening_series SET status = 'stopped', until_at = ? WHERE id = ?").run(now, series.id);
      this.db
        .prepare("UPDATE evenings SET status = 'cancelled', updated_at = ? WHERE series_id = ? AND status = 'scheduled' AND starts_at > ?")
        .run(now, series.id, now);
      return { result: 'ok' };
    });
  }

  /** Invite des amis à une soirée (hôte seulement). Un invité déjà présent garde sa réponse. */
  addGuests(viewer: string, id: string, pids: readonly string[], now: number): EveningOutcome {
    return this.db.transaction((): EveningOutcome => {
      const row = this.participantRow(id, viewer);
      if (row === undefined) return { result: 'evening_not_found' };
      if (row.host_pid !== viewer) return { result: 'not_host' };
      if (!isOpen(row, now)) return { result: 'evening_closed' };
      const guests = normalizeGuests(pids, viewer);
      if (guests === undefined || guests.length === 0) return INVALID;
      for (const pid of guests) {
        if (!this.canInvite(viewer, pid)) return { result: 'not_friend' };
      }
      const present = (this.db.prepare('SELECT COUNT(*) AS n FROM evening_guests WHERE evening_id = ?').get(id) as unknown as { n: number }).n;
      const fresh = guests.filter((pid) => !this.isGuestRow(id, pid)).length;
      if (present + fresh > MAX_GUESTS + 1) return INVALID;
      for (const pid of guests) {
        this.db
          .prepare("INSERT OR IGNORE INTO evening_guests (evening_id, pid, response, responded_at) VALUES (?, ?, 'pending', NULL)")
          .run(id, pid);
      }
      return { result: 'ok' };
    });
  }

  /** Retire un invité d'une soirée (hôte seulement). L'hôte ne se retire pas. */
  removeGuest(viewer: string, id: string, pid: string, now: number): EveningOutcome {
    return this.db.transaction((): EveningOutcome => {
      const row = this.participantRow(id, viewer);
      if (row === undefined) return { result: 'evening_not_found' };
      if (row.host_pid !== viewer) return { result: 'not_host' };
      if (!isOpen(row, now)) return { result: 'evening_closed' };
      if (pid === viewer) return INVALID;
      this.db.prepare('DELETE FROM evening_guests WHERE evening_id = ? AND pid = ?').run(id, pid);
      return { result: 'ok' };
    });
  }

  /** Réponse d'un invité : oui, peut-être, non. L'hôte ne répond pas à sa propre soirée. */
  respond(viewer: string, id: string, answer: Answer, now: number): EveningOutcome {
    if (!isAnswer(answer)) return INVALID;
    return this.db.transaction((): EveningOutcome => {
      const row = this.participantRow(id, viewer);
      if (row === undefined) return { result: 'evening_not_found' };
      if (row.host_pid === viewer) return { result: 'not_host' };
      if (!isOpen(row, now)) return { result: 'evening_closed' };
      this.db.prepare('UPDATE evening_guests SET response = ?, responded_at = ? WHERE evening_id = ? AND pid = ?').run(answer, now, id, viewer);
      return { result: 'ok' };
    });
  }

  /**
   * Quitte une soirée (`occurrence` : réponse « non », la soirée reste visible) ou une série (plus d'occurrences futures
   * pour ce profil, et plus de génération pour lui).
   */
  leave(viewer: string, id: string, scope: EveningScope, now: number): EveningOutcome {
    return this.db.transaction((): EveningOutcome => {
      const row = this.participantRow(id, viewer);
      if (row === undefined) return { result: 'evening_not_found' };
      if (row.host_pid === viewer) return { result: 'not_host' };
      if (scope === 'occurrence') {
        if (!isOpen(row, now)) return { result: 'evening_closed' };
        this.db.prepare("UPDATE evening_guests SET response = 'no', responded_at = ? WHERE evening_id = ? AND pid = ?").run(now, id, viewer);
        return { result: 'ok' };
      }
      if (row.series_id === null) return INVALID;
      const series = this.seriesOf(row.series_id);
      if (series === undefined) return { result: 'evening_not_found' };
      if (series.status !== 'active') return { result: 'evening_closed' };
      this.db
        .prepare(
          'INSERT INTO evening_series_guests (series_id, pid, left_at) VALUES (?, ?, ?) ON CONFLICT (series_id, pid) DO UPDATE SET left_at = excluded.left_at',
        )
        .run(series.id, viewer, now);
      this.db
        .prepare('DELETE FROM evening_guests WHERE pid = ? AND evening_id IN (SELECT id FROM evenings WHERE series_id = ? AND starts_at > ?)')
        .run(viewer, series.id, now);
      return { result: 'ok' };
    });
  }

  /** Rattache une soirée à un salon de watch party. Le premier rattachement gagne ; renvoie le salon effectif. */
  attachParty(id: string, partyId: string): string | undefined {
    this.db.prepare('UPDATE evenings SET party_id = ? WHERE id = ? AND party_id IS NULL').run(partyId, id);
    const row = this.db.prepare('SELECT party_id FROM evenings WHERE id = ?').get(id) as unknown as { party_id: string | null } | undefined;
    return row?.party_id ?? undefined;
  }

  /**
   * Après un blocage ou la fin d'une amitié : chacun des deux profils est retiré des soirées de l'autre (futures, en cours ou passées non purgées), séries
   * comprises (la série ne le génère plus). Renvoie les invitations retirées, pour prévenir les profils concernés.
   */
  detach(a: string, b: string, now: number): DetachedGuest[] {
    return this.db.transaction((): DetachedGuest[] => {
      const removed: DetachedGuest[] = [];
      for (const [guest, host] of [
        [a, b],
        [b, a],
      ] as const) {
        const rows = this.db
          .prepare(
            'SELECT g.evening_id AS id, e.starts_at AS starts_at FROM evening_guests g JOIN evenings e ON e.id = g.evening_id WHERE g.pid = ? AND e.host_pid = ? ORDER BY e.starts_at, e.id',
          )
          .all(guest, host) as unknown as { id: string; starts_at: number }[];
        // Soirées futures, en cours ou passées non purgées : un invité bloqué ne garde ni le profil de l'hôte ni le salon (un salon
        // privé se rejoint avec son seul identifiant). Seules les soirées futures ou en cours donnent lieu à une trame.
        for (const row of rows) {
          this.db.prepare('DELETE FROM evening_guests WHERE evening_id = ? AND pid = ?').run(row.id, guest);
          if (row.starts_at > now - LIVE_GRACE_MS) removed.push({ eveningId: row.id, hostPid: host, guestPid: guest });
        }
        this.db.prepare('DELETE FROM evening_series_guests WHERE pid = ? AND series_id IN (SELECT id FROM evening_series WHERE host_pid = ?)').run(guest, host);
      }
      return removed;
    });
  }

  /**
   * Passe le temps : complète la fenêtre des séries actives, purge les soirées passées depuis plus de 30 jours, puis
   * réserve les rappels T-15 min. Un rappel est marqué (`reminded_at`) dans la même transaction que sa lecture : un second
   * tick n'en renvoie pas. Les soirées annulées n'en ont pas. Au plus 200 rappels par tick.
   */
  tick(now: number): TickOutcome {
    return this.db.transaction((): TickOutcome => {
      this.db.prepare("UPDATE evening_series SET status = 'stopped' WHERE status = 'active' AND until_at IS NOT NULL AND until_at <= ?").run(now);
      const active = this.db.prepare(`${SERIES_SELECT} WHERE status = 'active'`).all() as unknown as SeriesRow[];
      for (const series of active) this.materialize(series, now);

      this.db.prepare('DELETE FROM evenings WHERE starts_at < ?').run(now - PURGE_AFTER_MS);

      const due = this.db
        .prepare(
          "SELECT id, title, starts_at, tz, host_pid FROM evenings WHERE status = 'scheduled' AND reminded_at IS NULL AND starts_at > ? AND starts_at <= ? ORDER BY starts_at, id LIMIT ?",
        )
        .all(now, now + REMINDER_LEAD_MS, TICK_BATCH) as unknown as DueRow[];
      const effects: EveningEffect[] = [];
      for (const row of due) {
        const claimed = Number(this.db.prepare('UPDATE evenings SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL').run(now, row.id).changes);
        if (claimed !== 1) continue;
        const guests = this.db
          .prepare("SELECT pid FROM evening_guests WHERE evening_id = ? AND response <> 'no' ORDER BY pid")
          .all(row.id) as unknown as { pid: string }[];
        effects.push({
          pids: guests.map((guest) => guest.pid),
          event: { type: 'reminder', eveningId: row.id, title: row.title, startsAt: row.starts_at, tz: row.tz, hostPid: row.host_pid },
        });
      }

      return { effects, nextWake: this.nextWake(now, due.length === TICK_BATCH) };
    });
  }

  /** Efface les soirées d'un profil (hôte) et ses invitations et séries (invité), lors de la purge au passage en profil enfant. */
  purgeProfile(pid: string): void {
    this.db.transaction((): void => {
      purgeEveningRows(this.db, pid);
    });
  }

  /**
   * Instant (ms) du prochain réveil utile, sans rien modifier : rappel le plus proche ou début de la prochaine soirée.
   * `null` : rien à attendre. Sert à (re)poser l'alarme du Durable Object après une écriture.
   */
  wakeAt(now: number): number | null {
    return this.nextWake(now, false);
  }

  // Modifications

  private updateOccurrence(
    row: EveningRow,
    viewer: string,
    change: { title?: string; startsAt?: number },
    now: number,
  ): EveningUpdateOutcome {
    if (!isOpen(row, now)) return { result: 'evening_closed' };
    const title = change.title === undefined ? row.title : normalizeTitle(change.title);
    if (title === undefined) return INVALID;
    const startsAt = change.startsAt ?? row.starts_at;
    if (change.startsAt !== undefined && !isValidStart(startsAt, now)) return INVALID;
    const moved = startsAt !== row.starts_at;
    if (moved && row.series_id !== null && this.occupied(row.series_id, startsAt, row.id)) return INVALID;
    const overridden = row.series_id === null ? row.overridden : 1;
    this.db
      .prepare('UPDATE evenings SET title = ?, starts_at = ?, overridden = ?, reminded_at = ?, updated_at = ? WHERE id = ?')
      .run(title, startsAt, overridden, moved ? null : row.reminded_at, now, row.id);
    if (moved) {
      this.db.prepare("UPDATE evening_guests SET response = 'pending', responded_at = NULL WHERE evening_id = ? AND pid <> ?").run(row.id, viewer);
    }
    return { result: 'ok', evening: this.mustView(row.id, viewer) };
  }

  private updateSeries(
    row: EveningRow,
    viewer: string,
    change: { title?: string } & Partial<SeriesRuleInput>,
    now: number,
  ): EveningUpdateOutcome {
    if (row.series_id === null) return INVALID;
    const series = this.seriesOf(row.series_id);
    if (series === undefined) return { result: 'evening_not_found' };
    if (series.status !== 'active') return { result: 'evening_closed' };
    const title = change.title === undefined ? series.title : normalizeTitle(change.title);
    if (title === undefined) return INVALID;
    const rule: SeriesRuleInput = {
      tz: change.tz ?? series.tz,
      weekday: change.weekday ?? series.weekday,
      localTime: change.localTime ?? series.local_time,
      interval: change.interval ?? (series.interval === 2 ? 2 : 1),
      untilAt: change.untilAt !== undefined ? change.untilAt : series.until_at,
    };
    if (!isValidRule(rule, now)) return INVALID;

    const updated: SeriesRow = {
      ...series,
      title,
      tz: rule.tz,
      weekday: rule.weekday,
      local_time: rule.localTime,
      interval: rule.interval,
      until_at: rule.untilAt,
    };
    this.db
      .prepare('UPDATE evening_series SET title = ?, tz = ?, weekday = ?, local_time = ?, interval = ?, until_at = ? WHERE id = ?')
      .run(title, rule.tz, rule.weekday, rule.localTime, rule.interval, rule.untilAt, series.id);
    // Occurrences futures non modifiées à la main : celles qui ne tombent plus sur la règle partent, les autres suivent le titre.
    const keep = nextOccurrences(ruleOf(updated), now, WINDOW_SIZE);
    const futureUnlocked = "series_id = ? AND overridden = 0 AND status = 'scheduled' AND starts_at > ?";
    // Seules partent les occurrences sans salon ouvert dont le créneau d'origine (slot_at) n'est plus sur la règle.
    const droppable = `${futureUnlocked} AND party_id IS NULL${keep.length === 0 ? '' : ` AND slot_at NOT IN (${keep.map(() => '?').join(', ')})`}`;
    const dropped = this.db.prepare(`SELECT id, host_pid FROM evenings WHERE ${droppable}`).all(series.id, now, ...keep) as unknown as {
      id: string;
      host_pid: string;
    }[];
    const removed: RemovedEvening[] = dropped.map((gone) => ({
      eveningId: gone.id,
      hostPid: gone.host_pid,
      pids: (
        this.db.prepare("SELECT pid FROM evening_guests WHERE evening_id = ? AND response <> 'no' ORDER BY pid").all(gone.id) as unknown as { pid: string }[]
      ).map((guest) => guest.pid),
    }));
    this.db.prepare(`DELETE FROM evenings WHERE ${droppable}`).run(series.id, now, ...keep);
    this.db.prepare(`UPDATE evenings SET title = ?, tz = ?, updated_at = ? WHERE ${futureUnlocked}`).run(title, rule.tz, now, series.id, now);
    this.materialize(updated, now);

    const kept = this.participantRow(row.id, viewer);
    return { result: 'ok', evening: kept === undefined ? null : this.viewOf(kept, viewer), removed };
  }

  // Génération des occurrences

  /**
   * Matérialise les occurrences à venir d'une série (quatre au plus) qui n'existent pas encore. Les invités de la série,
   * non partis, sont posés en attente sur chaque occurrence nouvelle.
   */
  private materialize(series: SeriesRow, now: number): void {
    const starts = nextOccurrences(ruleOf(series), now, WINDOW_SIZE);
    const guests = (
      this.db.prepare('SELECT pid FROM evening_series_guests WHERE series_id = ? AND left_at IS NULL ORDER BY pid').all(series.id) as unknown as {
        pid: string;
      }[]
    ).map((guest) => guest.pid);
    for (const startsAt of starts) {
      // Une occurrence déplacée à l'heure de ce créneau l'occupe déjà : pas de doublon à la même heure.
      if (this.startTaken(series.id, startsAt)) continue;
      const id = randomUUID();
      const inserted = Number(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO evenings (id, series_id, host_pid, title, tz, starts_at, status, overridden, party_id, reminded_at, slot_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, NULL, NULL, ?, ?, ?)",
          )
          .run(id, series.id, series.host_pid, series.title, series.tz, startsAt, startsAt, now, now).changes,
      );
      if (inserted === 1) this.insertGuests(id, series.host_pid, guests, now);
    }
  }

  /** Prochain réveil : rappel le plus proche, ou début de la prochaine soirée (pour reremplir la fenêtre d'une série). */
  private nextWake(now: number, batchFull: boolean): number | null {
    if (batchFull) return now;
    const wakes: number[] = [];
    const reminder = this.db
      .prepare("SELECT MIN(starts_at) AS t FROM evenings WHERE status = 'scheduled' AND reminded_at IS NULL AND starts_at > ?")
      .get(now) as unknown as { t: number | null };
    if (reminder.t !== null) wakes.push(Math.max(now, reminder.t - REMINDER_LEAD_MS));
    // Début de la prochaine soirée prévue, ou de la prochaine occurrence, même annulée, d'une série active : son passage fait
    // glisser la fenêtre, donc doit réveiller la génération.
    const start = this.db
      .prepare(
        "SELECT MIN(starts_at) AS t FROM evenings WHERE starts_at > ? AND (status = 'scheduled' OR series_id IN (SELECT id FROM evening_series WHERE status = 'active'))",
      )
      .get(now) as unknown as {
      t: number | null;
    };
    if (start.t !== null) wakes.push(start.t);
    return wakes.length === 0 ? null : Math.min(...wakes);
  }

  // Lectures et droits

  private participantRow(id: string, viewer: string): EveningRow | undefined {
    const row = this.rowOf(id);
    if (row === undefined) return undefined;
    if (row.host_pid === viewer) return row;
    // Garde en profondeur : un hôte bloqué avec le consultant (dans un sens ou l'autre) est invisible, même si une ligne subsiste.
    return this.isGuestRow(id, viewer) && !this.isBlockedEither(viewer, row.host_pid) ? row : undefined;
  }

  private isBlockedEither(a: string, b: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS x FROM blocks WHERE (blocker_pid = ? AND blocked_pid = ?) OR (blocker_pid = ? AND blocked_pid = ?) LIMIT 1')
        .get(a, b, b, a) !== undefined
    );
  }

  private rowOf(id: string): EveningRow | undefined {
    return this.db.prepare(`${EVENING_SELECT} WHERE e.id = ?`).get(id) as unknown as EveningRow | undefined;
  }

  private seriesOf(id: string): SeriesRow | undefined {
    return this.db.prepare(`${SERIES_SELECT} WHERE id = ?`).get(id) as unknown as SeriesRow | undefined;
  }

  private mustView(id: string, viewer: string): EveningView {
    const row = this.rowOf(id);
    if (row === undefined) throw new Error('soirée introuvable après écriture');
    return this.viewOf(row, viewer);
  }

  /**
   * Vue d'un participant : ses invités, sauf ceux bloqués avec lui dans un sens ou dans l'autre (lui-même reste). Un blocage
   * avec l'hôte retire déjà l'invité (`detach`) : l'hôte voit donc tous les invités restants.
   */
  private viewOf(row: EveningRow, viewer: string): EveningView {
    const guests = (
      this.db
        .prepare(
          `SELECT g.pid, g.response, g.responded_at FROM evening_guests g
           WHERE g.evening_id = ? AND (g.pid = ? OR NOT EXISTS (
             SELECT 1 FROM blocks b WHERE (b.blocker_pid = ? AND b.blocked_pid = g.pid) OR (b.blocker_pid = g.pid AND b.blocked_pid = ?)))
           ORDER BY g.pid`,
        )
        .all(row.id, viewer, viewer, viewer) as unknown as GuestRow[]
    ).map((guest) => ({ pid: guest.pid, response: guest.response as EveningResponse, respondedAt: guest.responded_at }));
    const mine = guests.find((guest) => guest.pid === viewer);
    const series: EveningSeriesView | null =
      row.series_id === null || row.s_status === null
        ? null
        : {
            id: row.series_id,
            status: row.s_status === 'active' ? 'active' : 'stopped',
            tz: row.s_tz ?? '',
            weekday: row.s_weekday ?? 0,
            localTime: row.s_local_time ?? '00:00',
            interval: row.s_interval === 2 ? 2 : 1,
            untilAt: row.s_until_at,
          };
    return {
      id: row.id,
      title: row.title,
      startsAt: row.starts_at,
      tz: row.tz,
      status: row.status === 'cancelled' ? 'cancelled' : 'scheduled',
      overridden: row.overridden === 1,
      hostPid: row.host_pid,
      role: row.host_pid === viewer ? 'host' : 'guest',
      myResponse: mine?.response ?? 'pending',
      partyId: row.party_id,
      series,
      guests,
    };
  }

  private insertGuests(eveningId: string, hostPid: string, guests: readonly string[], now: number): void {
    this.db.prepare("INSERT INTO evening_guests (evening_id, pid, response, responded_at) VALUES (?, ?, 'yes', ?)").run(eveningId, hostPid, now);
    for (const pid of guests) {
      if (pid === hostPid) continue;
      this.db.prepare("INSERT INTO evening_guests (evening_id, pid, response, responded_at) VALUES (?, ?, 'pending', NULL)").run(eveningId, pid);
    }
  }

  private isGuestRow(eveningId: string, pid: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM evening_guests WHERE evening_id = ? AND pid = ?').get(eveningId, pid) !== undefined;
  }

  private startTaken(seriesId: string, startsAt: number): boolean {
    return this.db.prepare('SELECT 1 AS x FROM evenings WHERE series_id = ? AND starts_at = ?').get(seriesId, startsAt) !== undefined;
  }

  private occupied(seriesId: string, startsAt: number, exceptId: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM evenings WHERE series_id = ? AND starts_at = ? AND id <> ?').get(seriesId, startsAt, exceptId) !== undefined;
  }

  private countOneOff(hostPid: string, now: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM evenings WHERE host_pid = ? AND series_id IS NULL AND status = 'scheduled' AND starts_at > ?")
        .get(hostPid, now) as unknown as { n: number }
    ).n;
  }

  private countActiveSeries(hostPid: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM evening_series WHERE host_pid = ? AND status = 'active'").get(hostPid) as unknown as { n: number }).n;
  }

  /** Profil adulte (non enfant) : seul un tel profil peut héberger. */
  private isAdult(pid: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM profiles WHERE pid = ? AND is_kid = 0').get(pid) !== undefined;
  }

  /**
   * Profil invitable : un autre profil adulte du même compte (foyer, y compris les profils rattachés par invitation foyer), ou un
   * ami accepté d'un autre compte, adulte, sans blocage dans un sens ni dans l'autre. Même règle « ami » que SocialV2Store (qui
   * reste privée) ; le foyer n'est pas une amitié mais peut être invité.
   */
  private canInvite(viewer: string, target: string): boolean {
    if (viewer === target) return false;
    const targetRow = this.db.prepare('SELECT account_id FROM profiles WHERE pid = ? AND is_kid = 0').get(target) as unknown as
      | { account_id: string }
      | undefined;
    if (targetRow === undefined) return false;
    const viewerRow = this.db.prepare('SELECT account_id FROM profiles WHERE pid = ?').get(viewer) as unknown as { account_id: string } | undefined;
    if (viewerRow === undefined) return false;
    if (viewerRow.account_id === targetRow.account_id) return true;
    const blocked = this.db
      .prepare('SELECT 1 AS x FROM blocks WHERE (blocker_pid = ? AND blocked_pid = ?) OR (blocker_pid = ? AND blocked_pid = ?) LIMIT 1')
      .get(viewer, target, target, viewer);
    if (blocked !== undefined) return false;
    const { low, high } = pairOf(viewer, target);
    return (
      this.db.prepare("SELECT 1 AS x FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'accepted'").get(low, high) !== undefined
    );
  }

}
