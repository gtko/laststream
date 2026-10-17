import { createHash } from 'node:crypto';
import type { Express, Response } from 'express';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { AllDebridClient, AllDebridError } from '../sources/alldebrid.js';
import { type FailoverReason, type ResolveErrorCode, type ResolvedLink, resolveWithFailover } from '../play/failover.js';
import { type PlayFailureReason, renderFailure } from '../play/errors.js';
import { hostFromUrl } from '../play/hosts.js';
import { defaultPlayState, type PlayState } from '../play/state.js';
import { type PlayCopy, decodeCopiesToken } from '../play/token.js';

const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/i;
const FILE_IDX_PATTERN = /^\d{1,6}$/;
const EPISODE_PART_PATTERN = /^\d{1,4}$/;
const SIZE_PATTERN = /^\d{1,15}$/;
const FILENAME_MAX_LENGTH = 512;
const RETRY_AFTER_SECONDS = 5;

type DebridClient = Pick<AllDebridClient, 'resolve' | 'checkCached' | 'checkApiKey'>;

/**
 * Codes d'erreur de l'API AllDebrid vers les codes du failover (documentation AllDebrid, codes connus).
 * Un code absent de cette table, ou une erreur réseau, vaut `unknown` : la copie suivante est essayée.
 */
const API_CODE_REASONS: ReadonlyMap<string, ResolveErrorCode> = new Map<string, ResolveErrorCode>([
  ['AUTH_BAD_APIKEY', 'invalid_key'],
  ['AUTH_MISSING_APIKEY', 'invalid_key'],
  ['AUTH_USER_BANNED', 'invalid_key'],
  ['MUST_BE_PREMIUM', 'subscription_expired'],
  ['FREE_TRIAL_LIMIT_REACHED', 'quota'],
  ['MAGNET_TOO_MANY', 'quota'],
  ['LINK_HOST_UNAVAILABLE', 'host_unavailable'],
  ['LINK_TEMPORARY_UNAVAILABLE', 'host_unavailable'],
  ['LINK_DOWN', 'dead_link'],
  ['LINK_NOT_SUPPORTED', 'unsupported'],
  ['LINK_HOST_NOT_SUPPORTED', 'unsupported'],
]);

/** Raison affichée pour chaque motif du failover. `not_ready` et `aborted` n'ont pas de page dédiée. */
const RENDERED_REASON: Readonly<Record<FailoverReason, PlayFailureReason>> = {
  not_cached: 'not_cached',
  dead_link: 'dead_link',
  host_unavailable: 'host_unavailable',
  file_not_found: 'file_not_found',
  subscription_expired: 'subscription_expired',
  invalid_key: 'invalid_key',
  quota: 'quota',
  not_ready: 'not_cached',
  unsupported: 'unsupported_format',
  unknown: 'unknown',
  no_copy: 'no_copy',
  timeout: 'timeout',
  aborted: 'unknown',
};

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

/** Erreur portant un code du failover, comme celles qu'attend resolveWithFailover. */
function copyError(code: ResolveErrorCode): Error & { code: ResolveErrorCode } {
  return Object.assign(new Error(code), { code });
}

/** Code du failover pour une erreur levée par le client AllDebrid (ou une erreur inattendue). */
function reasonOfError(err: unknown): ResolveErrorCode {
  if (!(err instanceof AllDebridError)) return 'unknown';
  if (err.code === 'not_ready') return 'not_cached';
  if (err.code === 'no_file') return 'file_not_found';
  if (err.code === 'magnet_failed') return 'dead_link';
  if (err.code === 'rate_limited') return 'quota';
  return API_CODE_REASONS.get(err.code) ?? 'unknown';
}

/** Lit la configuration chiffrée (ou JSON brut si allowPlain). Undefined si elle est illisible. */
function readConfig(deps: AppDeps, encoded: string): Config | undefined {
  try {
    return decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain });
  } catch (err) {
    if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) return undefined;
    throw err;
  }
}

/** Réponse d'échec : page HTML ou JSON selon Accept, sans clé ni URL. Le statut vient de la table des raisons. */
function sendFailure(res: Response, reason: FailoverReason, accept: string | undefined): void {
  const failure = renderFailure(RENDERED_REASON[reason], { accept });
  res.status(failure.status);
  res.setHeader('Content-Type', failure.contentType);
  res.send(failure.body);
}

/**
 * Lecture d'un stream. Deux formes :
 * - GET /:config/play/:infoHash{/:fileIdx} (legacy, ?s=&e=&filename=&size= en query) ;
 * - GET /:config/play/c/:token : jeton signé de copies ordonnées, essayées une à une (failover, budget play.budgetMs).
 * Succès : 302 vers le lien. Erreurs : pages ou JSON génériques, sans clé ni configuration ni URL.
 */
export function registerPlayRoutes(app: Express, deps: AppDeps, state: PlayState = defaultPlayState): void {
  // Clients mis en cache par empreinte de clé API : la clé brute n'est jamais une clé de Map.
  const clients = new Map<string, DebridClient>();

  const clientFor = (apiKey: string): DebridClient => {
    const cacheKey = createHash('sha256').update(apiKey, 'utf8').digest('hex');
    let client = clients.get(cacheKey);
    if (client === undefined) {
      client = deps.alldebridFactory
        ? deps.alldebridFactory(apiKey)
        : new AllDebridClient(apiKey, {
            fetch: deps.fetch,
            onFiles: (infoHash, files) => {
              state.packStore.learn(infoHash, files);
            },
          });
      clients.set(cacheKey, client);
    }
    return client;
  };

  // Déclarée avant la route legacy : /:config/play/c/:token ne doit pas être lue comme un hash.
  app.get('/:config/play/c/:token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const accept = req.get('accept');

    const decoded = decodeCopiesToken(req.params.token, deps.secret);
    if (decoded === null) {
      res.status(400).json({ error: 'invalid_token', message: 'Lien de lecture invalide.' });
      return;
    }

    const config = readConfig(deps, req.params.config);
    if (config === undefined) {
      res.status(400).json({ error: 'invalid_config' });
      return;
    }

    const debrid = config.debrid;
    // Sans debrid, les copies torrent sont inutilisables ; les copies directes restent valables.
    const copies = decoded.copies.filter((copy) => copy.url !== undefined || debrid !== undefined);

    const resolveCopy = async (copy: PlayCopy): Promise<ResolvedLink> => {
      if (copy.url !== undefined) {
        if (hostFromUrl(copy.url) === undefined) throw copyError('unknown');
        return { url: copy.url, filename: copy.filename, size: copy.size };
      }
      if (debrid === undefined || copy.infoHash === undefined) throw copyError('unknown');
      const client = clientFor(debrid.apiKey);
      try {
        const link = await client.resolve(copy.infoHash, copy.fileIdx, {
          season: decoded.season,
          episode: decoded.episode,
          filename: copy.filename,
          size: copy.size,
        });
        return { url: link.url, filename: link.filename, size: link.size };
      } catch (err) {
        // Le failover ne reconnaît que ses propres codes : les codes AllDebrid sont traduits ici.
        throw copyError(reasonOfError(err));
      }
    };

    const result = await resolveWithFailover({
      copies,
      resolve: resolveCopy,
      budgetMs: config.play.budgetMs,
      isHostDown: (host) => state.hostHealth.isDown(host),
      markHostDown: (host) => {
        state.hostHealth.markDown(host);
      },
    });

    if (!result.ok) {
      sendFailure(res, result.reason, accept);
      return;
    }
    const location = hostFromUrl(result.link.url) === undefined ? undefined : new URL(result.link.url).href;
    if (location === undefined) {
      sendFailure(res, 'unknown', accept);
      return;
    }
    res.setHeader('Location', location);
    res.status(302).end();
  });

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

    const config = readConfig(deps, encoded);
    if (config === undefined) {
      res.status(400).json({ error: 'invalid_config' });
      return;
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
        // Contrat historique : 503 avec Retry-After pour que le lecteur réessaie.
        res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
        sendFailure(res, 'host_unavailable', req.get('accept'));
        return;
      }
      sendFailure(res, reasonOfError(err), req.get('accept'));
    }
  });
}
