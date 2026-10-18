import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, request } from 'undici';
import { isNonPublicAddress } from '../../sources/ip.js';
import { SourceError, UnsafeTargetError } from '../../sources/http.js';
import type { HostLookup, HttpClient, RawResponse, StreamRequestOptions } from '../types.js';

/** Résolution DNS réelle d'un hôte : toutes les adresses renvoyées. */
export async function resolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Lookup épinglé pour la connexion (connect.lookup de l'agent). L'hôte est résolu une seule fois, au moment de la
 * connexion ; si une seule adresse n'est pas publique, la connexion échoue (UnsafeTargetError) ; sinon seules les
 * adresses vérifiées sont renvoyées. Le contrôle et la connexion portent donc sur la même réponse DNS : un
 * rebinding entre les deux est impossible, et chaque saut de redirection est revérifié.
 */
export function pinnedLookup(resolve: HostLookup = resolveHost): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((address) => isNonPublicAddress(address))) {
          callback(new UnsafeTargetError(), '', 4);
          return;
        }
        const records: LookupAddress[] = addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
        const [first] = records;
        if (options.all === true || first === undefined) {
          callback(null, records);
          return;
        }
        callback(null, first.address, first.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new SourceError('hôte non résolu'), '', 4),
    );
  };
}

/** Agent undici dont la résolution DNS est épinglée à la connexion (voir pinnedLookup). */
export function createPinnedAgent(resolve: HostLookup = resolveHost): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(resolve) } });
}

let pinned: Agent | undefined;
let plain: Agent | undefined;

async function streamRequest(url: URL, options: StreamRequestOptions): Promise<RawResponse> {
  const dispatcher = options.allowLocal ? (plain ??= new Agent()) : (pinned ??= createPinnedAgent());
  const upstream = await request(url, {
    method: options.method,
    headers: { ...options.headers },
    dispatcher,
    headersTimeout: options.headersTimeoutMs,
    bodyTimeout: options.bodyTimeoutMs,
  });
  return {
    statusCode: upstream.statusCode,
    headers: upstream.headers,
    body: upstream.body,
    dump: () => upstream.body.dump(),
  };
}

/** Client HTTP Node : fetch global (undici), DNS épinglé par agent undici, relais en flux par undici.request. */
export const nodeHttpClient: HttpClient = {
  fetch: (...args) => globalThis.fetch(...args),
  resolveHost,
  pinnedDispatcher: (lookupHost) => createPinnedAgent(lookupHost),
  stream: streamRequest,
};
