import type { App, Ctx } from '../http/app-env.js';
import { sendJson } from '../http/respond.js';
import { isPublicMode } from '../config/runtime-env.js';
import { IndexerSourceSchema } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { defaultIndexerHealth, type HealthStatus, type IndexerHealth } from '../sources/indexer-health.js';
import { describeFailure, type IndexerInfo } from '../sources/indexers.js';
import { discoverJackettIndexers } from '../sources/jackett.js';
import { checkOutboundUrl, resolveHost, SourceError } from '../sources/http.js';
import { discoverProwlarrIndexers } from '../sources/prowlarr.js';

/** Taille maximale du corps JSON de POST /config/indexers, en octets. */
export const INDEXERS_BODY_MAX_BYTES = 16 * 1024;

/** Santé d'un indexeur dans la réponse : statut courant, et détails quand ils existent. */
export interface IndexerHealthView {
  status: HealthStatus | 'unknown';
  avgLatencyMs?: number;
  lastErrorCode?: string;
}

function healthOf(health: IndexerHealth, source: string, indexerId: number | string): IndexerHealthView {
  const snap = health.get(source, indexerId);
  if (snap === undefined) return { status: 'unknown' };
  const view: IndexerHealthView = { status: snap.status };
  if (snap.avgLatencyMs !== undefined) view.avgLatencyMs = snap.avgLatencyMs;
  if (snap.lastErrorCode !== undefined) view.lastErrorCode = snap.lastErrorCode;
  return view;
}

function describeIssue(issue: { path: readonly PropertyKey[]; message: string }): string {
  return `${issue.path.map(String).join('.') || '(racine)'}: ${issue.message}`;
}

function exceedsBodyLimit(c: Ctx): boolean {
  return new TextEncoder().encode(JSON.stringify(c.get('body') ?? null)).length > INDEXERS_BODY_MAX_BYTES;
}

/**
 * POST /config/indexers : liste les indexeurs d'une source Prowlarr ou Jackett (corps = la source, JSON non chiffré).
 * Réponse : `{ indexers: [{ id, name, protocol, privacy, enabled, health }] }`. Aucune clé ni URL n'est renvoyée.
 * Erreurs : 400 invalid_config (chemins et messages seulement), 413 si le corps dépasse la limite, 502 si la
 * découverte échoue. Non enregistrée par défaut dans l'application (wiring côté appelant).
 */
export function registerIndexerRoutes(app: App, deps: AppDeps, health: IndexerHealth = defaultIndexerHealth): void {
  app.post('/config/indexers', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (exceedsBodyLimit(c)) return sendJson(c, { error: 'payload_too_large' }, 413);
    const parsed = IndexerSourceSchema.safeParse(c.get('body'));
    if (!parsed.success) {
      return sendJson(c, { error: 'invalid_config', issues: parsed.error.issues.map(describeIssue) }, 400);
    }
    const source = parsed.data;

    // Garde SSRF existante : schéma http(s) et, en mode public, adresses non publiques refusées (IP littérales ici,
    // noms résolus et contrôlés à la connexion par l'agent épinglé de fetchBytes).
    try {
      await checkOutboundUrl(source.baseUrl, isPublicMode(), resolveHost, true);
    } catch (err) {
      const reason = err instanceof SourceError ? err.message : 'URL refusée';
      return sendJson(c, { error: 'invalid_config', issues: [`baseUrl: ${reason}`] }, 400);
    }

    try {
      const fetchOpts = { fetch: deps.fetch };
      const indexers: IndexerInfo[] =
        source.type === 'prowlarr'
          ? await discoverProwlarrIndexers(source, fetchOpts)
          : await discoverJackettIndexers(source, fetchOpts);
      return sendJson(c, {
        indexers: indexers.map((indexer) => ({
          id: indexer.id,
          name: indexer.name,
          protocol: indexer.protocol,
          privacy: indexer.privacy,
          enabled: indexer.enabled,
          health: healthOf(health, source.name, indexer.id),
        })),
      });
    } catch (err) {
      return sendJson(c, { error: 'indexers_unavailable', message: describeFailure(err, source.apiKey) }, 502);
    }
  });
}
