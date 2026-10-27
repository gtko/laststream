import type { CreateEveningBody } from './socialV3Api';
import { UserApiError } from './userApi';

/* Formulaire de soirée planifiée (LAST-199, lot B) : plafonds du serveur (docs/social.md, « Soirées planifiées »), validation,
 * corps de création et textes d'erreur. Pur : aucune lecture du DOM ni du réseau, l'instant courant est un paramètre. */

/** Titre : 1 à 80 caractères (points de code) une fois les espaces retirés. */
export const TITLE_MAX = 80;
/** Invités au plus (l'hôte exclu). */
export const MAX_GUESTS = 19;
/** Début : au plus tôt dans 1 minute, au plus tard dans 90 jours. */
const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 90 * 86_400_000;

type Repeat = 'once' | 'weekly' | 'biweekly';

export interface EveningFormInput {
  title: string;
  /** `AAAA-MM-JJ` (champ date), heure locale du navigateur. */
  date: string;
  /** `HH:MM`. */
  time: string;
  guests: readonly string[];
  repeat: Repeat;
  /** `AAAA-MM-JJ` : dernier jour de la série (facultatif, ignoré pour une soirée ponctuelle). */
  until: string;
}

export interface FormProblem {
  field: 'title' | 'when' | 'guests' | 'until';
  text: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Instant (ms) de `date` + `time` à l'heure locale ; `NaN` si l'une des deux est absente, mal formée ou n'existe pas (30 février). */
export function parseLocal(date: string, time = '00:00'): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return NaN;
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  const at = new Date(y, mo - 1, da, h, mi);
  return at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === da && at.getHours() === h && at.getMinutes() === mi ? at.getTime() : NaN;
}

export const toDateInput = (ms: number): string => {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
export const toTimeInput = (ms: number): string => {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
};

/** Créneau proposé : 21 h ce soir, ou demain si 20 h sont passées. */
export function defaultStart(now: number): { date: string; time: string } {
  const d = new Date(now);
  d.setHours(21, 0, 0, 0);
  if (now > d.getTime() - 3_600_000) d.setDate(d.getDate() + 1);
  return { date: toDateInput(d.getTime()), time: '21:00' };
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Fin d'une série : le dernier jour choisi, jusqu'à minuit ; `undefined` si le champ est vide ou invalide. */
function untilOf(input: EveningFormInput): number | undefined {
  if (input.repeat === 'once' || !input.until) return undefined;
  const at = parseLocal(input.until, '23:59');
  return Number.isNaN(at) ? undefined : at + 59_999;
}

/**
 * Problèmes du formulaire, vides s'il est valide. `when: false` : l'horaire n'a pas changé (modification d'une soirée), il n'est
 * pas revérifié contre la fenêtre du serveur.
 */
export function validateEvening(input: EveningFormInput, now: number, o: { when?: boolean } = {}): FormProblem[] {
  const out: FormProblem[] = [];
  const title = input.title.trim();
  const len = [...title].length;
  if (!len) out.push({ field: 'title', text: 'Donne un titre à ta soirée.' });
  else if (len > TITLE_MAX) out.push({ field: 'title', text: 'Le titre fait ' + len + ' caractères : ' + TITLE_MAX + ' au maximum.' });
  const at = parseLocal(input.date, input.time);
  if (o.when !== false) {
    if (Number.isNaN(at)) out.push({ field: 'when', text: 'Choisis une date et une heure.' });
    else if (at < now + MIN_LEAD_MS) out.push({ field: 'when', text: 'La soirée doit commencer dans au moins une minute.' });
    else if (at > now + MAX_LEAD_MS) out.push({ field: 'when', text: 'La soirée doit avoir lieu dans les 90 prochains jours.' });
  }
  if (new Set(input.guests).size > MAX_GUESTS) out.push({ field: 'guests', text: MAX_GUESTS + ' invités au maximum.' });
  if (input.repeat !== 'once' && input.until) {
    const until = untilOf(input);
    if (until === undefined) out.push({ field: 'until', text: 'La date de fin n’est pas valide.' });
    else if (!Number.isNaN(at) && until < at) out.push({ field: 'until', text: 'La fin de la série doit tomber après la première soirée.' });
  }
  return out;
}

/** Corps de `POST /evenings` ; à n'appeler que sur un formulaire valide. */
export function buildCreateBody(input: EveningFormInput, tz: string): CreateEveningBody {
  const until = untilOf(input);
  const body: CreateEveningBody = { title: input.title.trim(), startsAt: parseLocal(input.date, input.time), tz, guests: [...new Set(input.guests)] };
  if (input.repeat !== 'once') body.recurrence = { freq: 'weekly', interval: input.repeat === 'biweekly' ? 2 : 1, ...(until === undefined ? {} : { until }) };
  return body;
}

const ERRORS: Record<string, string> = {
  not_friend: 'Un des invités n’est pas (ou plus) dans tes amis.',
  too_many_evenings: 'Tu as déjà 10 soirées à venir (ou 5 séries) : annule-en une avant d’en planifier une autre.',
  invalid_body: 'Le serveur a refusé ces informations : vérifie le titre, la date et les invités.',
  evening_closed: 'Cette soirée est annulée ou a déjà commencé.',
  evening_not_found: 'Cette soirée n’existe plus.',
  not_host: 'Seul l’hôte peut faire cela.',
  kid_profile: 'Les soirées ne sont pas disponibles sur un profil enfant.',
  rate_limited: 'Trop de demandes : réessaie dans un instant.',
  network: 'Serveur injoignable : vérifie ta connexion.',
};
const FALLBACK = 'Cette action est impossible pour le moment.';

/** Texte humain d'une erreur du serveur des soirées ; un code inconnu donne le texte générique. */
export function eveningErrorText(err: unknown): string {
  return err instanceof UserApiError && ERRORS[err.code] ? ERRORS[err.code] : FALLBACK;
}
