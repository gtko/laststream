/* Envoi du feedback (LAST-1654) : contexte joint, Sentry, forum. Chargé seulement à l'ouverture de la fenêtre, pour
 * garder le démarrage léger ; les petites fonctions toujours utiles (noteError, disponibilité…) restent dans ./feedback. */
import { isShellEnvironment } from '../player/shell';
import { isAndroidApp } from './config';
import { hasCommunity, isKidProfile } from './auth';
import { type ContextSection, type FeedbackError, type FeedbackKind, type Value, forgetError, forumAvailable, providers, scrubFeedback as scrubText, sentryApi, slug } from './feedback';
import { sendForumFeedback } from './forumApi';

const MAX_TEXT = 300;

type Platform = 'web' | 'windows' | 'macos' | 'linux' | 'android' | 'tv';

/** Type d'appareil, dit en clair sur le forum. */
/** Même détection que resolveEnvironment (observability/sentry), sans importer ce module du démarrage. */
const environment = (): string => (isAndroidApp() ? 'android' : isShellEnvironment() ? 'windows' : 'web');

export function platformOf(env = environment(), ua = navigator.userAgent): Platform {
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
  const sentry = sentryApi();
  if (sentry) {
    const contexts: Record<string, Record<string, unknown>> = collectContext();
    if (err) contexts.erreur = cleanSection({ Titre: err.title, Message: err.message, Empreinte: err.code, Où: err.where, ...(err.extra || {}) });
    const tags: Record<string, string> = { feedback: input.kind, feedbackFrom: err ? err.where : 'app' };
    if (input.reason) tags.feedbackReason = slug(input.reason);
    if (err) tags.errorCode = err.code;
    let associatedEventId: string | undefined;
    if (err) {
      // L'erreur d'origine devient un événement Sentry à empreinte stable : les retours des membres s'y rattachent.
      const original = err.error instanceof Error ? err.error : new Error(err.title + ' : ' + scrubText(err.message));
      associatedEventId = sentry.captureException(original, { tags, contexts, fingerprint: ['feedback', err.code], level: 'error' });
    }
    eventId = sentry.captureFeedback(
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
