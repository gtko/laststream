/* Suivi des erreurs de l'interface (Sentry) : navigateur, application Windows (WebView2) et Android (Capacitor).
 * Actif seulement si VITE_SENTRY_DSN est défini au build (`.env.production`), jamais en développement ni en tests.
 * Pas de traces de performance, pas de Session Replay, pas de données personnelles. Chaque événement et fil d'Ariane
 * passe par le filtre de confidentialité de ./scrub. Compte : identifiant seulement, jamais pseudo ni e-mail. */
import { breadcrumbsIntegration, init, type BrowserOptions } from '@sentry/browser';
import { auth, isKidProfile } from '../data/auth';
import { isAndroidApp } from '../data/config';
import { isShellEnvironment } from '../player/shell';
import { scrubBreadcrumb, scrubEvent } from './scrub';

export type SentryEnvironment = 'web' | 'windows' | 'android';

/** Même détection que le reste de l'interface : Capacitor (Android), puis coque WebView2 (Windows), sinon navigateur. */
export function resolveEnvironment(): SentryEnvironment {
  if (isAndroidApp()) return 'android';
  if (isShellEnvironment()) return 'windows';
  return 'web';
}

/** Options du client. Le profil et le compte sont lus à l'envoi, donc toujours à jour. */
export function buildSentryOptions(dsn: string, environment: SentryEnvironment, release?: string): BrowserOptions {
  return {
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    // Aucune donnée personnelle (IP, cookies, en-têtes, paramètres d'URL, variables locales) : c'est le rôle de
    // sendDefaultPii: false, remplacé par dataCollection dans Sentry 11.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    maxBreadcrumbs: 50,
    // Fils d'Ariane : navigation, fetch et xhr seulement. Clics et saisies (dom) et console (intégration « Console »,
    // distincte de Breadcrumbs dans Sentry 11) ne sont jamais enregistrés.
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'Breadcrumbs' && integration.name !== 'Console'),
      breadcrumbsIntegration({ dom: false }),
    ],
    beforeSend(event) {
      event.tags = { ...event.tags, profileKind: isKidProfile() ? 'enfant' : 'principal' };
      if (auth.accountId) event.user = { id: auth.accountId };
      return scrubEvent(event, location.origin);
    },
    beforeBreadcrumb(crumb) {
      return scrubBreadcrumb(crumb, location.origin);
    },
  };
}

const release = (): string | undefined =>
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? `laststream-app@${__APP_VERSION__}` : undefined;

/** Démarre Sentry si un DSN est fourni au build. Sans effet en développement, dans les tests ou sans DSN. */
export function initSentry(): void {
  const dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn || import.meta.env.DEV || import.meta.env.MODE === 'test') return;
  try {
    init(buildSentryOptions(dsn, resolveEnvironment(), release()));
  } catch {
    // La supervision ne doit jamais empêcher l'application de démarrer.
  }
}
