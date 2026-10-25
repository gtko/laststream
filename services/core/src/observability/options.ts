/**
 * Options du SDK Sentry du Worker (`withSentry`). Module sans effet de bord, testé sous Node : même collecte de données
 * que l'application (aucune donnée personnelle), aucun en-tête de trace vers les appels sortants, filtres de
 * confidentialité de ./scrub.
 */
import type { CloudflareOptions } from '@sentry/cloudflare';
import { beforeBreadcrumbFilter, beforeSendFilter, beforeSendTransactionFilter } from './scrub.js';

/** Valeur tag `platform` : le Worker s'exécute sur Cloudflare Workers. */
export const WORKER_PLATFORM = 'cloudflare-workers';

export function workerSentryOptions(dsn: string | undefined, release: string): CloudflareOptions {
  return {
    dsn,
    environment: 'production',
    release,
    // Tags posés sur tous les événements (erreurs, traces) : version et plateforme d'exécution du Worker.
    initialScope: { tags: { release, platform: WORKER_PLATFORM } },
    tracesSampleRate: 0.05,
    // Ni compte, ni cookies, ni en-têtes, ni paramètres d'URL, ni variables locales (comme l'application).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    // Aucun en-tête de trace transmis aux appels sortants (TMDB, addons, débrideurs).
    tracePropagationTargets: [],
    beforeSend: beforeSendFilter,
    beforeSendTransaction: beforeSendTransactionFilter,
    beforeBreadcrumb: beforeBreadcrumbFilter,
  };
}
