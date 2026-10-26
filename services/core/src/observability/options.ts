/**
 * Options du SDK Sentry du Worker (`withSentry`). Module sans effet de bord, testé sous Node : même collecte de données
 * que l'application (aucune donnée personnelle), aucun en-tête de trace vers les appels sortants, filtres de
 * confidentialité de ./scrub.
 */
import type { CloudflareOptions } from '@sentry/cloudflare';
import { beforeBreadcrumbFilter, beforeSendFilter, beforeSendTransactionFilter } from './scrub.js';

/** Valeur tag `platform` : le Worker s'exécute sur Cloudflare Workers. */
const WORKER_PLATFORM = 'cloudflare-workers';

export function workerSentryOptions(dsn: string | undefined, release: string): CloudflareOptions {
  return {
    dsn,
    environment: 'production',
    release,
    // Tag posé sur tous les événements (erreurs, traces) : plateforme d'exécution du Worker. La version est déjà portée
    // par `release` (option ci-dessus, recopiée par le SDK sur chaque événement) : pas de tag en double.
    initialScope: { tags: { platform: WORKER_PLATFORM } },
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
