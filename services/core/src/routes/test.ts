import type { Express } from 'express';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError, parseConfig } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { serviceProbes, type ServiceField, type ServiceProbe } from '../lt/checks.js';
import { createLtContext, LtError } from '../lt/context.js';
import { AllDebridClient } from '../sources/alldebrid.js';
import { defaultIndexerHealth, type HealthStatus } from '../sources/indexer-health.js';
import { discoverJackettIndexers } from '../sources/jackett.js';
import type { IndexerInfo } from '../sources/indexers.js';
import { isRecord, maskSecrets, SourceError, type SourceTestResult } from '../sources/http.js';
import { discoverProwlarrIndexers } from '../sources/prowlarr.js';
import { testTorznab } from '../sources/torznab.js';
import { testUpstream } from '../sources/upstream.js';

export type SourceCheckType = 'upstream' | 'torznab' | 'alldebrid' | 'prowlarr' | 'jackett';

/** Statut d'un indexeur (Prowlarr, Jackett) : issu de la santé en mémoire, jamais de clé ni d'URL. */
export interface IndexerCheck {
  id: string;
  name: string;
  status: HealthStatus | 'unknown';
}

/**
 * Résultat du test d'une clé de service (TMDB, MDBList, TVDB, OpenRouter, Fanart.tv). Jamais la clé. `note` est une
 * information non sensible (ex. version d'API TheTVDB retenue), absente le plus souvent.
 */
export interface ServiceCheck {
  name: string;
  type: ServiceField;
  ok: boolean;
  error?: string;
  note?: string;
}

/** Résultat du test d'une source. `error` est absent quand la source répond. `indexers` : Prowlarr et Jackett. */
export interface SourceCheck {
  name: string;
  type: SourceCheckType;
  ok: boolean;
  error?: string;
  indexers?: IndexerCheck[];
}

type SourceConfig = Config['sources'][number];

const ALLDEBRID_NAME = 'AllDebrid';
const UNEXPECTED_ERROR = 'erreur inattendue';

/**
 * Retire de `message` les secrets fournis (et leurs formes URL-encodée et base64), remplacés par ***.
 * Secrets de moins de 6 caractères : jamais masqués, mais le message générique remplace celui qui les contient.
 */
export function scrubSecrets(message: string, secrets: readonly string[]): string {
  return maskSecrets(message, secrets);
}

/** Clés API présentes dans la configuration : elles ne doivent jamais sortir dans une réponse. */
function secretsOf(config: Config): string[] {
  const secrets = config.sources.flatMap((source) =>
    source.type === 'upstream' ? [] : [source.apiKey],
  );
  if (config.debrid !== undefined) secrets.push(config.debrid.apiKey);
  const { openrouterModel: _model, ...keys } = config.services;
  secrets.push(...Object.values(keys).filter((value): value is string => typeof value === 'string'));
  return secrets;
}

/** Sonde d'un service : succès, ou échec avec un message sûr (code d'erreur, jamais clé ni URL). */
async function probeService(probe: ServiceProbe, secrets: readonly string[]): Promise<ServiceCheck> {
  try {
    const note = await probe.probe();
    const check: ServiceCheck = { name: probe.name, type: probe.type, ok: true };
    if (note !== undefined) check.note = note;
    return check;
  } catch (err) {
    const message = err instanceof LtError || err instanceof SourceError ? err.message : UNEXPECTED_ERROR;
    return { name: probe.name, type: probe.type, ok: false, error: scrubSecrets(message, secrets) };
  }
}

/** Exécute un test de source sans jamais lever : toute exception devient un échec générique. */
async function settle(
  name: string,
  type: SourceCheckType,
  run: () => Promise<SourceTestResult>,
  secrets: readonly string[],
): Promise<SourceCheck> {
  let result: SourceTestResult;
  try {
    result = await run();
  } catch {
    result = { ok: false, error: UNEXPECTED_ERROR };
  }
  const check: SourceCheck = { name, type, ok: result.ok };
  if (!result.ok) check.error = scrubSecrets(result.error ?? UNEXPECTED_ERROR, secrets);
  return check;
}

/** Statut courant d'un indexeur d'après la santé en mémoire ; « unknown » s'il n'a jamais été interrogé. */
function indexerStatus(source: string, indexerId: number | string): HealthStatus | 'unknown' {
  return defaultIndexerHealth.get(source, indexerId)?.status ?? 'unknown';
}

/** Découverte des indexeurs d'une source Prowlarr ou Jackett : succès avec statuts, ou échec sûr. */
async function settleIndexers(
  name: string,
  type: 'prowlarr' | 'jackett',
  discover: () => Promise<IndexerInfo[]>,
  secrets: readonly string[],
): Promise<SourceCheck> {
  let indexers: IndexerInfo[];
  try {
    indexers = await discover();
  } catch (err) {
    const message = err instanceof SourceError ? err.message : UNEXPECTED_ERROR;
    return { name, type, ok: false, error: scrubSecrets(message, secrets) };
  }
  const statuses = indexers.map((indexer) => ({
    id: String(indexer.id),
    name: indexer.name,
    status: indexerStatus(name, indexer.id),
  }));
  return { name, type, ok: true, indexers: statuses };
}

/** Teste une source selon son type. Ne lève jamais. */
function checkSource(source: SourceConfig, fetchOpts: { fetch?: typeof fetch }, secrets: readonly string[]): Promise<SourceCheck> {
  switch (source.type) {
    case 'upstream':
      return settle(source.name, 'upstream', () => testUpstream(source, fetchOpts), secrets);
    case 'torznab':
      return settle(source.name, 'torznab', () => testTorznab(source, fetchOpts), secrets);
    case 'prowlarr':
      return settleIndexers(source.name, 'prowlarr', () => discoverProwlarrIndexers(source, fetchOpts), secrets);
    case 'jackett':
      return settleIndexers(source.name, 'jackett', () => discoverJackettIndexers(source, fetchOpts), secrets);
  }
}

type Parsed = { config: Config } | { issues: readonly string[] };

/**
 * Configuration du corps. Accepte l'objet de configuration brut (configurateur), `{ config: objet }`, ou
 * `{ config: chaîne }` : chaîne chiffrée, ou JSON brut en base64url si LASTADDON_ALLOW_PLAIN=1 (règle des routes).
 * Sans cette distinction, `{ config: {...} }` était lu comme une configuration vide.
 */
function configOfBody(input: unknown, deps: AppDeps): Config {
  if (!isRecord(input) || !('config' in input)) return parseConfig(input);
  const { config } = input;
  if (typeof config === 'string') return decodeConfig(config, deps.secret, { allowPlain: deps.allowPlain });
  if (isRecord(config)) return parseConfig(config);
  throw new ConfigValidationError(['config: chaîne encodée ou objet attendu']);
}

/** Valide le corps : les issues ne contiennent que des chemins et messages, jamais les valeurs saisies. */
function parseBody(input: unknown, deps: AppDeps): Parsed {
  try {
    return { config: configOfBody(input, deps) };
  } catch (err) {
    if (err instanceof ConfigValidationError) return { issues: err.issues };
    if (err instanceof ConfigDecodeError) return { issues: [`config: ${err.message}`] };
    throw err;
  }
}

/**
 * POST /config/test : configuration JSON non chiffrée. Teste chaque source (upstream, Torznab) et le compte
 * debrid en parallèle. Réponse : `{ sources: [{ name, type, ok, error? }] }`.
 */
export function registerTestRoutes(app: Express, deps: AppDeps): void {
  app.post('/config/test', async (req, res) => {
    const parsed = parseBody(req.body, deps);
    if ('issues' in parsed) {
      res.status(400).json({ error: 'invalid_config', issues: parsed.issues });
      return;
    }
    const { config } = parsed;
    const secrets = secretsOf(config);
    const fetchOpts = { fetch: deps.fetch };

    const sourceChecks = config.sources.map((source) => checkSource(source, fetchOpts, secrets));
    const apiKey = config.debrid?.apiKey;
    const debridCheck =
      apiKey === undefined
        ? []
        : [
            settle(
              ALLDEBRID_NAME,
              'alldebrid',
              async () => {
                const client = deps.alldebridFactory
                  ? deps.alldebridFactory(apiKey)
                  : new AllDebridClient(apiKey, fetchOpts);
                const check = await client.checkApiKey();
                return check.ok ? { ok: true } : { ok: false, error: check.error ?? UNEXPECTED_ERROR };
              },
              secrets,
            ),
          ];

    const sources = await Promise.all([...sourceChecks, ...debridCheck]);
    const ltContext = createLtContext(deps);
    const services = await Promise.all(serviceProbes(ltContext, config).map((probe) => probeService(probe, secrets)));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sources, services });
  });
}
