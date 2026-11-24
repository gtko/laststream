/* Feedback envoyé depuis l'app (LAST-1654) : menu du profil, lecteur, erreurs interceptées.
 *  - Sentry reçoit le maximum de contexte pour résoudre le problème : erreur d'origine (capturée avec une empreinte
 *    stable), état du lecteur, appareil, version, écran. C'est privé : seule l'équipe le lit. Tout le texte passe par le
 *    filtre de confidentialité de ../observability/scrub (aucun lien de source, aucune clé, aucun e-mail).
 *  - Le forum (service en ligne seulement) reçoit un sujet public dans « Remontée de bugs » ou « Idées et demandes » :
 *    titre de l'erreur, message, version et type d'appareil. Un bug de même empreinte rejoint le sujet déjà ouvert.
 * Sans Sentry (développement, build sans DSN) ni forum (auto-hébergé), le feedback n'existe pas : les entrées sont masquées. */
import { captureException, captureFeedback, getClient } from '@sentry/browser';
import { scrubText } from '../observability/scrub';
import { resolveEnvironment } from '../observability/sentry';
import { hasCommunity, isKidProfile } from './auth';
import { sendForumFeedback } from './forumApi';

type FeedbackKind = 'bug' | 'idea' | 'other';
type Value = string | number | boolean;
export type ContextSection = Record<string, Value>;

/** Erreur interceptée (try/catch) que l'utilisateur peut signaler. */
export interface FeedbackError {
  /** Écran ou module : `player`, `fiche`, `social`… */
  where: string;
  /** Empreinte stable : regroupe les mêmes erreurs dans Sentry et dans un même sujet du forum. */
  code: string;
  /** Titre court affiché (« Lecture impossible »). */
  title: string;
  /** Détail affiché à l'utilisateur. */
  message: string;
  at: number;
  /** Erreur d'origine, pour sa pile d'appels dans Sentry. */
  error?: unknown;
  /** Contexte propre à l'erreur (statut HTTP, source tentée…), jamais d'URL. */
  extra?: ContextSection;
}

const MAX_TEXT = 300;

/** Morceau d'empreinte : minuscules sans accents, mots séparés par des tirets, 40 caractères au plus. */
export function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Empreinte d'une erreur : `où:titre`, plus le statut HTTP s'il apparaît dans le message (`http-503`). Les détails
 * variables (noms, durées, compteurs) ne comptent pas : deux membres qui voient la même erreur ont la même empreinte.
 */
export function errorCode(where: string, title: string, message = ''): string {
  const http = /\bHTTP\s*(\d{3})\b/i.exec(message) ?? /\b(\d{3})\b(?=\s*\))/.exec(message);
  return [slug(where) || 'app', slug(title) || 'erreur', http ? 'http-' + http[1] : ''].filter(Boolean).join(':').slice(0, 80);
}

let lastError: FeedbackError | null = null;

/** Note une erreur interceptée : elle devient l'erreur jointe par défaut au prochain signalement. */
export function noteError(e: Omit<FeedbackError, 'at' | 'code'> & { code?: string }): FeedbackError {
  const noted: FeedbackError = { ...e, code: e.code ?? errorCode(e.where, e.title, e.message), at: Date.now() };
  lastError = noted;
  return noted;
}

/** Dernière erreur interceptée, si elle date de moins de 10 minutes. */
export function recentError(now = Date.now()): FeedbackError | null {
  return lastError && now - lastError.at < 10 * 60_000 ? lastError : null;
}

function forgetError(): void {
  lastError = null;
}

type Provider = () => ContextSection | null;
const providers = new Map<string, Provider>();

/** Contexte fourni par un module tant qu'il est actif (le lecteur : titre, source, moteur, position…). `null` le retire. */
export function setFeedbackContext(name: string, provider: Provider | null): void {
  if (provider) providers.set(name, provider);
  else providers.delete(name);
}

/** Sentry est actif (build avec DSN, hors développement et tests). */
export const sentryActive = (): boolean => getClient() !== undefined;

/** Le bouton feedback a une destination : Sentry ou le forum. Jamais pour un profil enfant. */
export const feedbackAvailable = (): boolean => !isKidProfile() && (sentryActive() || hasCommunity());

/** Publication sur le forum possible (service en ligne). */
export const forumAvailable = (): boolean => hasCommunity();

type Platform = 'web' | 'windows' | 'macos' | 'linux' | 'android' | 'tv';

/** Type d'appareil, dit en clair sur le forum. */
export function platformOf(env = resolveEnvironment(), ua = navigator.userAgent): Platform {
  if (/Web0S|webOS|SmartTV|Tizen|AFT[A-Z]|BRAVIA|Android TV/i.test(ua)) return 'tv';
  if (env === 'android') return 'android';
  if (env === 'windows') {
    if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
    if (/Linux|X11/.test(ua) && !/Android/.test(ua)) return 'linux';
    return 'windows';
  }
  return 'web';
}

const appVersion = (): string => (typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev');

const clean = (v: Value): Value => (typeof v === 'string' ? scrubText(v).slice(0, MAX_TEXT) : v);
function cleanSection(s: ContextSection): ContextSection {
  const out: ContextSection = {};
  for (const [k, v] of Object.entries(s)) if (v !== '' && v !== undefined && v !== null) out[k] = clean(v);
  return out;
}

/** Écran courant : la route, sans paramètres ni jeton. */
const screenOf = (): string => (location.hash || '#/').replace(/[?&].*$/, '').replace(/^#\/(reset|join|foyer)\/.*$/, '#/$1/…');

/** Contexte joint à un feedback, par section : application, appareil, modules actifs (lecteur…). */
export function collectContext(): Record<string, ContextSection> {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number } };
  const ctx: Record<string, ContextSection> = {
    application: cleanSection({
      Version: appVersion(),
      Plateforme: platformOf(),
      Serveur: hasCommunity() ? 'service en ligne' : 'auto-hébergé',
      Écran: screenOf(),
      Profil: isKidProfile() ? 'enfant' : 'principal',
    }),
    appareil: cleanSection({
      Navigateur: navigator.userAgent,
      Langue: navigator.language,
      Fenêtre: innerWidth + '×' + innerHeight + ' @' + (devicePixelRatio || 1) + 'x',
      'En ligne': navigator.onLine,
      Réseau: nav.connection ? [nav.connection.effectiveType, nav.connection.downlink ? nav.connection.downlink + ' Mb/s' : ''].filter(Boolean).join(' · ') : '',
    }),
  };
  for (const [name, provider] of providers) {
    try {
      const s = provider();
      if (s) ctx[name] = cleanSection(s);
    } catch {
      // Un module qui ne sait pas se décrire ne bloque pas le feedback.
    }
  }
  return ctx;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  /** Motif choisi en un geste (lecteur) : « Sous-titres décalés »… */
  reason?: string;
  error?: FeedbackError | null;
  /** Publier aussi sur le forum (bug ou idée, service en ligne). */
  forum: boolean;
}

export interface FeedbackResult {
  sentry: boolean;
  forum: { topicId: string; grouped: boolean; reporters: number } | null;
  /** Code d'erreur du forum s'il a refusé (limite de débit, exclusion…) ; Sentry a reçu le feedback. */
  forumError?: string;
}

const KIND_LABEL: Record<FeedbackKind, string> = { bug: 'Bug', idea: 'Idée', other: 'Autre' };

/** Texte du feedback : motif en tête, puis le message. */
function composeMessage(input: Pick<FeedbackInput, 'reason' | 'message'>): string {
  return [input.reason ? input.reason + '.' : '', input.message.trim()].filter(Boolean).join(' ');
}

/** Envoie le feedback : Sentry (détail privé), puis le forum si demandé. Rejette seulement si aucun des deux n'a abouti. */
export async function sendFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const message = scrubText(composeMessage(input)).slice(0, 4000);
  const err = input.error || null;
  const result: FeedbackResult = { sentry: false, forum: null };
  let eventId: string | undefined;
  if (sentryActive()) {
    const contexts: Record<string, Record<string, unknown>> = collectContext();
    if (err) contexts.erreur = cleanSection({ Titre: err.title, Message: err.message, Empreinte: err.code, Où: err.where, ...(err.extra || {}) });
    const tags: Record<string, string> = { feedback: input.kind, feedbackFrom: err ? err.where : 'app' };
    if (input.reason) tags.feedbackReason = slug(input.reason);
    if (err) tags.errorCode = err.code;
    let associatedEventId: string | undefined;
    if (err) {
      // L'erreur d'origine devient un événement Sentry à empreinte stable : les retours des membres s'y rattachent.
      const original = err.error instanceof Error ? err.error : new Error(err.title + ' : ' + scrubText(err.message));
      associatedEventId = captureException(original, { tags, contexts, fingerprint: ['feedback', err.code], level: 'error' });
    }
    eventId = captureFeedback(
      { message: message || '(sans message)', source: 'laststream-app', associatedEventId, tags: { ...tags, kind: KIND_LABEL[input.kind] } },
      { captureContext: { tags, contexts } },
    );
    result.sentry = true;
  }
  const toForum = input.forum && forumAvailable() && input.kind !== 'other';
  if (toForum) {
    try {
      const res = await sendForumFeedback({
        kind: input.kind === 'idea' ? 'idea' : 'bug',
        code: err && input.kind === 'bug' ? err.code : undefined,
        title: err && input.kind === 'bug' ? err.title + (/\bhttp-(\d{3})$/.exec(err.code) ? ' · HTTP ' + /\bhttp-(\d{3})$/.exec(err.code)?.[1] : '') : undefined,
        message,
        version: /^[0-9A-Za-z.+-]{1,32}$/.test(appVersion()) ? appVersion() : undefined,
        platform: platformOf(),
        sentryEventId: eventId && /^[0-9a-f]{32}$/.test(eventId) ? eventId : undefined,
      });
      result.forum = { topicId: res.topic.id, grouped: res.grouped, reporters: res.reporters };
    } catch (e) {
      result.forumError = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'network';
      if (!result.sentry) throw e;
    }
  }
  if (!result.sentry && !result.forum) throw new Error('feedback_unavailable');
  if (err) forgetError();
  return result;
}

/** Lignes lisibles du contexte joint, pour la fenêtre (« Voir ce qui est joint »). */
export function contextRows(ctx: Record<string, ContextSection>, err: FeedbackError | null): [string, string][] {
  const rows: [string, string][] = [];
  if (err) rows.push(['Erreur', err.title + ' · ' + err.code]);
  for (const section of Object.values(ctx)) for (const [k, v] of Object.entries(section)) rows.push([k, String(v)]);
  return rows;
}
