import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { AllDebridClient, AllDebridError } from '../sources/alldebrid.js';

const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/i;
const FILE_IDX_PATTERN = /^\d{1,6}$/;
const EPISODE_PART_PATTERN = /^\d{1,4}$/;
const SIZE_PATTERN = /^\d{1,15}$/;
const FILENAME_MAX_LENGTH = 512;
const RETRY_AFTER_SECONDS = 5;

type DebridClient = Pick<AllDebridClient, 'resolve' | 'checkCached' | 'checkApiKey'>;

function episodePart(value: unknown): number | undefined {
  return typeof value === 'string' && EPISODE_PART_PATTERN.test(value) ? Number(value) : undefined;
}

/** Nom de fichier attendu (query ?filename=) ; ignoré s'il est vide ou trop long. */
function queryFilename(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= FILENAME_MAX_LENGTH ? value : undefined;
}

/** Taille attendue en octets (query ?size=) ; ignorée si elle n'est pas un entier décimal. */
function querySize(value: unknown): number | undefined {
  return typeof value === 'string' && SIZE_PATTERN.test(value) ? Number(value) : undefined;
}

/**
 * Lecture d'un stream (GET /:config/play/:infoHash/:fileIdx?, query optionnelle ?s=&e= pour une série).
 * Succès : 302 vers le lien AllDebrid. Erreurs : réponses génériques, sans clé ni configuration.
 */
export function registerPlayRoutes(app: Express, deps: AppDeps): void {
  // Clients mis en cache par empreinte de clé API : la clé brute n'est jamais une clé de Map.
  const clients = new Map<string, DebridClient>();

  const clientFor = (apiKey: string): DebridClient => {
    const cacheKey = createHash('sha256').update(apiKey, 'utf8').digest('hex');
    let client = clients.get(cacheKey);
    if (client === undefined) {
      client = deps.alldebridFactory
        ? deps.alldebridFactory(apiKey)
        : new AllDebridClient(apiKey, { fetch: deps.fetch });
      clients.set(cacheKey, client);
    }
    return client;
  };

  app.get('/:config/play/:infoHash{/:fileIdx}', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const encoded: string = req.params.config;
    const infoHash: string = req.params.infoHash;
    const rawFileIdx: string | undefined = req.params.fileIdx;

    if (!INFO_HASH_PATTERN.test(infoHash)) {
      res.status(400).json({ error: 'invalid_hash' });
      return;
    }
    if (rawFileIdx !== undefined && !FILE_IDX_PATTERN.test(rawFileIdx)) {
      res.status(400).json({ error: 'invalid_file_idx' });
      return;
    }

    let config: Config;
    try {
      config = decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain });
    } catch (err) {
      if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) {
        res.status(400).json({ error: 'invalid_config' });
        return;
      }
      throw err;
    }

    if (config.debrid === undefined) {
      res.status(404).json({ error: 'no_debrid' });
      return;
    }
    const client = clientFor(config.debrid.apiKey);

    try {
      const link = await client.resolve(
        infoHash,
        rawFileIdx === undefined ? undefined : Number(rawFileIdx),
        {
          season: episodePart(req.query.s),
          episode: episodePart(req.query.e),
          filename: queryFilename(req.query.filename),
          size: querySize(req.query.size),
        },
      );
      res.setHeader('Location', new URL(link.url).href);
      res.status(302).end();
    } catch (err) {
      if (err instanceof AllDebridError && err.code === 'not_ready') {
        res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
        res.status(503).json({ error: 'not_ready' });
        return;
      }
      res.status(502).json({ error: 'debrid_error' });
    }
  });
}
