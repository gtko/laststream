import type { Express } from 'express';
import { type Config, ConfigValidationError, parseConfig } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { serviceProbes, type ServiceField, type ServiceProbe } from '../lt/checks.js';
import { createLtContext, LtError } from '../lt/context.js';
import { AllDebridClient } from '../sources/alldebrid.js';
import { maskSecrets, SourceError, type SourceTestResult } from '../sources/http.js';
import { testTorznab } from '../sources/torznab.js';
import { testUpstream } from '../sources/upstream.js';

export type SourceCheckType = 'upstream' | 'torznab' | 'alldebrid';

/** Résultat du test d'une clé de service (TMDB, MDBList, TVDB, OpenRouter, Fanart.tv). Jamais la clé. */
export interface ServiceCheck {
  name: string;
  type: ServiceField;
  ok: boolean;
  error?: string;
}

/** Résultat du test d'une source. `error` est absent quand la source répond. */
export interface SourceCheck {
  name: string;
  type: SourceCheckType;
  ok: boolean;
  error?: string;
}

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
  const secrets = config.sources.flatMap((source) => (source.type === 'torznab' ? [source.apiKey] : []));
  if (config.debrid !== undefined) secrets.push(config.debrid.apiKey);
  const { openrouterModel: _model, ...keys } = config.services;
  secrets.push(...Object.values(keys).filter((value): value is string => typeof value === 'string'));
  return secrets;
}

/** Sonde d'un service : succès, ou échec avec un message sûr (code d'erreur, jamais clé ni URL). */
async function probeService(probe: ServiceProbe, secrets: readonly string[]): Promise<ServiceCheck> {
  try {
    await probe.probe();
    return { name: probe.name, type: probe.type, ok: true };
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

type Parsed = { config: Config } | { issues: readonly string[] };

/** Valide le corps : les issues ne contiennent que des chemins et messages, jamais les valeurs saisies. */
function parseBody(input: unknown): Parsed {
  try {
    return { config: parseConfig(input) };
  } catch (err) {
    if (err instanceof ConfigValidationError) return { issues: err.issues };
    throw err;
  }
}

/**
 * POST /config/test : configuration JSON non chiffrée. Teste chaque source (upstream, Torznab) et le compte
 * debrid en parallèle. Réponse : `{ sources: [{ name, type, ok, error? }] }`.
 */
export function registerTestRoutes(app: Express, deps: AppDeps): void {
  app.post('/config/test', async (req, res) => {
    const parsed = parseBody(req.body);
    if ('issues' in parsed) {
      res.status(400).json({ error: 'invalid_config', issues: parsed.issues });
      return;
    }
    const { config } = parsed;
    const secrets = secretsOf(config);
    const fetchOpts = { fetch: deps.fetch };

    const sourceChecks = config.sources.map((source) =>
      source.type === 'upstream'
        ? settle(source.name, 'upstream', () => testUpstream(source, fetchOpts), secrets)
        : settle(source.name, 'torznab', () => testTorznab(source, fetchOpts), secrets),
    );
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
