/* Feedback envoyé depuis l'app (LAST-1654) : menu du profil, lecteur, erreurs interceptées.
 *  - Sentry reçoit le maximum de contexte pour résoudre le problème : erreur d'origine (capturée avec une empreinte
 *    stable), état du lecteur, appareil, version, écran. C'est privé : seule l'équipe le lit. Tout le texte passe par le
 *    filtre de confidentialité de ../observability/scrub (aucun lien de source, aucune clé, aucun e-mail).
 *  - Le forum (service en ligne seulement) reçoit un sujet public dans « Remontée de bugs » ou « Idées et demandes » :
 *    titre de l'erreur, message, version et type d'appareil. Un bug de même empreinte rejoint le sujet déjà ouvert.
 * Sans Sentry (développement, build sans DSN) ni forum (auto-hébergé), le feedback n'existe pas : les entrées sont masquées. */
import type { captureException, captureFeedback } from '@sentry/browser';
import { hasCommunity, isKidProfile } from './auth';

export type FeedbackKind = 'bug' | 'idea' | 'other';
export type Value = string | number | boolean;
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

export function forgetError(): void {
  lastError = null;
}

type Provider = () => ContextSection | null;
export const providers = new Map<string, Provider>();

/** Contexte fourni par un module tant qu'il est actif (le lecteur : titre, source, moteur, position…). `null` le retire. */
export function setFeedbackContext(name: string, provider: Provider | null): void {
  if (provider) providers.set(name, provider);
  else providers.delete(name);
}

/** Fonctions Sentry, données par initSentry une fois Sentry démarré. Ce module n'importe pas @sentry/browser : il est
 * partagé avec des écrans chargés à la demande, et l'import découperait Sentry hors du paquet de démarrage. */
export interface SentryApi {
  captureException: typeof captureException;
  captureFeedback: typeof captureFeedback;
}
let sentry: SentryApi | null = null;

export function setFeedbackSentry(api: SentryApi | null): void {
  sentry = api;
}

export const sentryApi = (): SentryApi | null => sentry;

/** Filtre de confidentialité (observability/scrub), donné au démarrage par initSentry même sans DSN. Avant cela, repli
 * prudent : tout lien est retiré. */
let scrub = (text: string): string => text.replace(/\b[a-z][a-z0-9+.-]*:\S+/gi, '[lien]');

export function setFeedbackScrub(fn: (text: string) => string): void {
  scrub = fn;
}

export const scrubFeedback = (text: string): string => scrub(text);

/** Sentry est actif (build avec DSN, hors développement et tests). */
export const sentryActive = (): boolean => sentry !== null;

/** Le bouton feedback a une destination : Sentry ou le forum. Jamais pour un profil enfant. */
export const feedbackAvailable = (): boolean => !isKidProfile() && (sentryActive() || hasCommunity());

/** Publication sur le forum possible (service en ligne). */
export const forumAvailable = (): boolean => hasCommunity();
