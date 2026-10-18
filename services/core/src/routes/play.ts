import { createHash } from 'node:crypto';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { App, Ctx } from '../http/app-env.js';
import { originalUrl, queryParams, sendBody, sendEmpty, sendJson } from '../http/respond.js';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps, DebridClient } from '../deps.js';
import { AllDebridClient, AllDebridError } from '../sources/alldebrid.js';
import { HosterClient } from '../sources/hosters.js';
import {
  type FailoverReason,
  type ResolveErrorCode,
  type ResolvedLink,
  isResolveErrorCode,
  resolveWithFailover,
} from '../play/failover.js';
import { type PlayFailureReason, renderFailure } from '../play/errors.js';
import { hostFromUrl } from '../play/hosts.js';
import { issuedUrls } from '../play/issued.js';
import { defaultPlayState, type PlayState } from '../play/state.js';
import { type PlayCopy, decodeCopiesToken } from '../play/token.js';
import type { TorrentCache } from '../torrent/fetch-torrent.js';

const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/i;
const FILE_IDX_PATTERN = /^\d{1,6}$/;
const EPISODE_PART_PATTERN = /^\d{1,4}$/;
const SIZE_PATTERN = /^\d{1,15}$/;
const FILENAME_MAX_LENGTH = 512;
const RETRY_AFTER_SECONDS = 5;

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
  no_copy: 'no_copy',
  unknown: 'unknown',
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

/** Code du failover pour une erreur du HosterClient : il rend déjà des codes du failover, sans URL ni clé. */
function reasonOfHosterError(err: unknown): ResolveErrorCode {
  if (!(err instanceof AllDebridError)) return 'unknown';
  return isResolveErrorCode(err.code) ? err.code : 'unknown';
}

/**
 * Octets d'un .torrent privé, relus par guid. Undefined si le guid est absent, si le cache ne le connaît plus
 * (expiré, évincé), si l'entrée n'a pas d'octets, ou si son hash ne correspond pas à celui de la copie.
 */
function privateTorrentBytes(cache: TorrentCache, guid: string | undefined, infoHash: string): Buffer | undefined {
  if (guid === undefined) return undefined;
  const cached = cache.get(guid);
  if (cached?.kind !== 'torrent' || !cached.private || cached.bytes === undefined) return undefined;
  return cached.infoHash.toLowerCase() === infoHash.toLowerCase() ? cached.bytes : undefined;
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
function sendFailure(c: Ctx, reason: PlayFailureReason, accept: string | undefined): Response {
  const failure = renderFailure(reason, { accept });
  return sendBody(c, failure.body, failure.status as ContentfulStatusCode, failure.contentType);
}

/**
 * Lecture d'un stream. Deux formes :
 * - GET /:config/play/:infoHash{/:fileIdx} (legacy, ?s=&e=&filename=&size= en query) ;
 * - GET /:config/play/c/:token : jeton signé de copies ordonnées, essayées une à une (failover, budget play.budgetMs).
 *   Avant toute résolution : sortie future (not_released) et limite d'âge (age_limit) sont contrôlées.
 *   Une copie `kind: 'hoster'` est débridée via AllDebrid ; une copie `privateTorrent` envoie ses octets (cache par guid).
 * Succès : 302 vers le lien. Erreurs : pages ou JSON génériques, sans clé ni configuration ni URL.
 */
export function registerPlayRoutes(app: App, deps: AppDeps, state: PlayState = defaultPlayState): void {
  // Clients mis en cache par empreinte de clé API : la clé brute n'est jamais une clé de Map.
  const clients = new Map<string, DebridClient>();
  // Un HosterClient par client AllDebrid : son catalogue d'hébergeurs est gardé 12 h.
  const hosterClients = new WeakMap<DebridClient, HosterClient>();

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

  const hosterFor = (client: DebridClient): HosterClient => {
    let hoster = hosterClients.get(client);
    if (hoster === undefined) {
      hoster = new HosterClient(client);
      hosterClients.set(client, hoster);
    }
    return hoster;
  };

  // Déclarée avant la route legacy : /:config/play/c/:token ne doit pas être lue comme un hash.
  app.get('/:config/play/c/:token', async (c) => {
    c.header('Cache-Control', 'no-store');
    const accept = c.req.header('accept');

    const decoded = decodeCopiesToken(c.req.param('token'), deps.secret);
    if (decoded === null) {
      return sendJson(c, { error: 'invalid_token', message: 'Lien de lecture invalide.' }, 400);
    }

    const config = readConfig(deps, c.req.param('config'));
    if (config === undefined) {
      return sendJson(c, { error: 'invalid_config' }, 400);
    }

    // Contrôles avant toute résolution : un contenu non sorti ou hors limite d'âge ne consomme aucun appel au debrid.
    if (decoded.releasedAt !== undefined && Date.parse(decoded.releasedAt) > Date.now()) {
      return sendFailure(c, 'not_released', accept);
    }
    const ageLimit = config.filters.ageLimit;
    if (typeof ageLimit === 'number' && decoded.ageFr !== undefined && decoded.ageFr > ageLimit) {
      return sendFailure(c, 'age_limit', accept);
    }

    const debrid = config.debrid;
    // Sans debrid, les copies torrent et les liens d'hébergeur sont inutilisables ; les liens directs restent valables.
    const copies = decoded.copies.filter(
      (copy) => debrid !== undefined || (copy.url !== undefined && copy.kind !== 'hoster'),
    );

    const resolveCopy = async (copy: PlayCopy, signal: AbortSignal): Promise<ResolvedLink> => {
      if (copy.kind === 'hoster') {
        if (debrid === undefined || copy.url === undefined) throw copyError('unknown');
        try {
          const link = await hosterFor(clientFor(debrid.apiKey)).unlock(copy.url, { signal });
          return { url: link.url, filename: link.filename, size: link.size };
        } catch (err) {
          throw copyError(reasonOfHosterError(err));
        }
      }
      if (copy.url !== undefined) {
        if (hostFromUrl(copy.url) === undefined) throw copyError('unknown');
        return { url: copy.url, filename: copy.filename, size: copy.size };
      }
      const { infoHash } = copy;
      if (debrid === undefined || infoHash === undefined) throw copyError('unknown');
      const client = clientFor(debrid.apiKey);
      let bytes: Buffer | undefined;
      if (copy.privateTorrent === true) {
        bytes = privateTorrentBytes(state.torrentCache, copy.guid, infoHash);
        // Octets absents du cache : cette copie n'a pas de source, la suivante est essayée.
        if (bytes === undefined) throw copyError('no_copy');
      }
      const options = { season: decoded.season, episode: decoded.episode, filename: copy.filename, size: copy.size };
      try {
        const link =
          bytes === undefined
            ? await client.resolve(infoHash, copy.fileIdx, options)
            : await client.resolveTorrentFile(bytes, infoHash, copy.fileIdx, options);
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
      return sendFailure(c, RENDERED_REASON[result.reason], accept);
    }
    const location = hostFromUrl(result.link.url) === undefined ? undefined : new URL(result.link.url).href;
    if (location === undefined) {
      return sendFailure(c, 'unknown', accept);
    }
    issuedUrls.noteResolved(originalUrl(c), location);
    c.header('Location', location);
    return sendEmpty(c, 302);
  });

  app.get('/:config/play/:infoHash/:fileIdx?', async (c) => {
    c.header('Cache-Control', 'no-store');
    const encoded: string = c.req.param('config');
    const infoHash: string = c.req.param('infoHash');
    const rawFileIdx: string | undefined = c.req.param('fileIdx');

    if (!INFO_HASH_PATTERN.test(infoHash)) {
      return sendJson(c, { error: 'invalid_hash' }, 400);
    }
    if (rawFileIdx !== undefined && !FILE_IDX_PATTERN.test(rawFileIdx)) {
      return sendJson(c, { error: 'invalid_file_idx' }, 400);
    }

    const config = readConfig(deps, encoded);
    if (config === undefined) {
      return sendJson(c, { error: 'invalid_config' }, 400);
    }

    if (config.debrid === undefined) {
      return sendJson(c, { error: 'no_debrid' }, 404);
    }
    const client = clientFor(config.debrid.apiKey);
    const query = queryParams(c);

    try {
      const link = await client.resolve(
        infoHash,
        rawFileIdx === undefined ? undefined : Number(rawFileIdx),
        {
          season: episodePart(query.s),
          episode: episodePart(query.e),
          filename: queryFilename(query.filename),
          size: querySize(query.size),
        },
      );
      issuedUrls.noteResolved(originalUrl(c), new URL(link.url).href);
      c.header('Location', new URL(link.url).href);
      return sendEmpty(c, 302);
    } catch (err) {
      if (err instanceof AllDebridError && err.code === 'not_ready') {
        // Contrat historique : 503 avec Retry-After pour que le lecteur réessaie.
        c.header('Retry-After', String(RETRY_AFTER_SECONDS));
        return sendFailure(c, 'host_unavailable', c.req.header('accept'));
      }
      return sendFailure(c, RENDERED_REASON[reasonOfError(err)], c.req.header('accept'));
    }
  });
}
