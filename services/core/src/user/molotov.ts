import { randomUUID } from 'node:crypto';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendBody, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { decryptJson, encryptJson } from '../config/codec.js';
import { isMolotovRelayEnabled } from '../config/runtime-env.js';
import { fetchBytes, isRecord, type FetchFn } from '../sources/http.js';
import type { UserBackend, UserRepo } from './repo.js';
import { assertNotLocked, assertUnlocked, sessionOf, type Session } from './session.js';
import type { MolotovAccount } from './store.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Compte « Molotov » (fubo Europe) d'un compte Laststream : une session API, stockée chiffrée, rejouée par le serveur.
 *
 * Le serveur ne fait que deux choses : conserver les jetons (chiffrés au repos) et rejouer les appels de l'app web
 * (`app.molotov.tv`) que le navigateur ne peut pas faire lui-même (l'API renvoie un `Access-Control-Allow-Origin`
 * fixe). Toute URL visée est construite par le serveur : aucune URL fournie par le client n'est suivie, hormis celle
 * de la licence DRM, dont l'hôte et le chemin sont vérifiés.
 */

/** API Molotov (Europe) : seule origine appelée par le relais. */
export const MOLOTOV_API = 'https://api-eu.fubo.tv';

/** Origine de l'app web Molotov (Origin et Referer envoyés à l'API). */
const MOLOTOV_ORIGIN = 'https://app.molotov.tv';

/** Identité « client Molotov » : l'API attend ces en-têtes sur chaque appel. */
export const MOLOTOV_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Electron/42.0.0 Safari/537.36 Molotov/8.0.3';

/**
 * Identifiants de poste : persistants pour la durée de l'isolat (l'API les renseigne après la connexion).
 * Tirés à la première requête, jamais au chargement du module : les Workers interdisent
 * toute génération aléatoire en portée globale (erreur Cloudflare 10021).
 */
let deviceId: string | undefined;
let sessionId: string | undefined;

/** En-têtes `x-*` d'identité client fixes (sans les identifiants de poste, voir `clientHeaders`). */
export const MOLOTOV_HEADERS: Readonly<Record<string, string>> = {
  'x-application-id': 'molotov',
  'x-client-version': '6.17.1-hotfix.3',
  'x-player-version': '7.4.2',
  'x-device-app': 'web',
  'x-device-type': 'desktop',
  'x-device-group': 'desktop',
  'x-device-platform': 'desktop',
  'x-drm-scheme': 'widevine',
  'x-supported-streaming-protocols': 'hls,dash',
  'x-supported-codecs-list': 'avc',
};

/** En-têtes d'identité client complets, identifiants de poste compris (générés au premier appel). */
export function clientHeaders(): Record<string, string> {
  deviceId ??= randomUUID();
  sessionId ??= randomUUID();
  return { ...MOLOTOV_HEADERS, 'x-device-id': deviceId, 'x-ad-id': deviceId, 'x-session-id': sessionId };
}

/** Usage de chiffrement des jetons : lié au compte (une valeur ne se rejoue pas ailleurs). */
const TOKENS_PURPOSE = 'molotov';
/** Usage de chiffrement du profil Molotov (identité du compte, rang), distinct des jetons. */
const PROFILE_PURPOSE = 'molotov-profile';

/** Chemin de la licence DRM (seul chemin autorisé pour un relais binaire). */
const LICENSE_PATH = '/vapi/v1/drm/irdeto-proxy/license';

/** Chemins amont que le relais JSON accepte. Liste stricte : pas d'open proxy. */
const RELAY_PATHS: ReadonlySet<string> = new Set([
  '/papi/v1/page/channels',
  '/papi/v1/main-navigation',
  '/papi/v1/config',
  '/vapi/v1/playback',
  '/vapi/asset/v1',
  '/user',
  '/social',
  '/profile',
  '/users/tier',
  '/rights/v2/location',
  '/v3/location',
]);

/** Nombre maximal de chaînes renvoyées par le catalogue compacté. */
const MAX_CHANNELS = 500;
/** Durée de vie du catalogue compacté en mémoire (par instance). */
const CHANNELS_TTL_MS = 5 * 60_000;
/** Nombre maximal de catalogues gardés en mémoire (les plus anciens sont écartés). */
const MAX_CACHED_CATALOGUES = 64;
/** Validité annoncée du manifeste et de la licence (la signature du manifeste expire au bout d'environ une heure). */
const ASSET_TTL_MS = 55 * 60_000;
/** Plafond de lecture d'une réponse amont (le catalogue « En direct » pèse environ 2 Mo). */
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
/** Délai d'un appel amont ordinaire. */
const UPSTREAM_TIMEOUT_MS = 12_000;
/** Délai de la lecture du catalogue (réponse volumineuse). */
const CATALOG_TIMEOUT_MS = 30_000;

/** Jetons Molotov d'un compte. */
interface MolotovTokens {
  idToken: string;
  refreshToken: string;
}

/** Identité du compte Molotov (aucun jeton). */
interface MolotovProfile {
  userId: string | null;
  profileId: string | null;
  email: string | null;
  tier: string | null;
  channelCount: number;
}

/** Chaîne du catalogue telle que rendue à l'app. */
interface MolotovChannel {
  id: string;
  name: string;
  callSign: string | null;
  logo: string | null;
  group: string | null;
  live: boolean;
  program: string | null;
}

const tokensSchema = z.object({ idToken: z.string().min(1).max(8192), refreshToken: z.string().min(1).max(8192) });

/** Réponse de rafraîchissement partielle : l'API peut ne renvoyer que le nouvel id_token. */
const partialTokensSchema = z.object({
  idToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192).optional(),
});

/** Forme réelle des jetons côté API (le client officiel lit `id_token`/`refresh_token`) ; `refresh_token` peut manquer. */
const snakePartialTokensSchema = z.object({
  id_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192).optional(),
});

const profileSchema = z.object({
  userId: z.string().nullable(),
  profileId: z.string().nullable(),
  email: z.string().nullable(),
  tier: z.string().nullable(),
  channelCount: z.number().int().min(0),
});

const connectSchema = z
  .object({
    idToken: z.string().min(1).max(8192).optional(),
    refreshToken: z.string().min(1).max(8192).optional(),
    /** Jeton Google (flux implicite) : le serveur l'échange contre une session Molotov. */
    googleToken: z.string().min(1).max(8192).optional(),
  })
  .refine((body) => (body.idToken !== undefined && body.refreshToken !== undefined) || body.googleToken !== undefined, {
    message: 'idToken, refreshToken ou googleToken requis',
  });

const signinSchema = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) });

/** Vérification en deux étapes : le jeton de défi et le code reçu par email (jamais journalisés). */
const mfaVerifySchema = z.object({ mfaToken: z.string().min(1).max(4096), code: z.string().min(1).max(32) });

/** Renvoi du code : le jeton de défi en cours (jamais journalisé). */
const mfaResendSchema = z.object({ mfaToken: z.string().min(1).max(4096) });

const playSchema = z.object({ channelId: z.string().trim().min(1).max(128) });

const licenseSchema = z.object({
  licenseUrl: z.string().min(1).max(2048),
  token: z.string().min(1).max(8192),
  challenge: z.string().min(1).max(32768),
});

const heartbeatSchema = z.object({
  channelId: z.string().trim().min(1).max(128),
  assetId: z.string().trim().min(1).max(256).optional(),
  progress: z.number().finite().min(0).max(1e15),
  /** Charge utile du cœur amont (`passback`, `pdt`, `progress`) : `pdt` et `progress` sont remplacés. */
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** Session Molotov en cours : jetons courants, profil connu, et moyen de réécrire la ligne (chiffrée). */
interface MolotovState {
  accountId: string;
  tokens: MolotovTokens;
  profile: MolotovProfile | null;
  /** Réécrit les jetons (chiffrés) en conservant le profil connu. */
  save(tokens: MolotovTokens): Promise<void>;
  /** Réécrit le profil (chiffré) en conservant les jetons courants. */
  saveProfile(profile: MolotovProfile): Promise<void>;
}

/** Réponse amont lue en octets. */
interface UpstreamResult {
  status: number;
  ok: boolean;
  bytes: Uint8Array;
  contentType: string;
}

/** Catalogue compacté, gardé en mémoire le temps de sa validité. */
interface CachedCatalogue {
  channels: MolotovChannel[];
  fetchedAt: number;
}

const catalogues = new Map<string, CachedCatalogue>();

/** JSON décodé, ou null si le corps n'est pas du JSON. */
function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/** Première chaîne non vide parmi les clés données (longueur bornée). */
function pickString(source: unknown, keys: readonly string[]): string | null {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= 512) return value.trim();
  }
  return null;
}

/** Identifiant de l'asset en cours de lecture : payload du cœur, sinon paramètre `id` de l'URL de progression. */
function assetIdOf(heartbeat: unknown, heartbeatUrl: string | null): string | null {
  const fromPayload = pickString(heartbeat, ['assetId', 'asset_id', 'id']);
  if (fromPayload !== null) return fromPayload;
  if (heartbeatUrl === null) return null;
  try {
    const id = new URL(heartbeatUrl).searchParams.get('id');
    return id !== null && id.length > 0 && id.length <= 256 ? id : null;
  } catch {
    return null;
  }
}

/** Usage de chiffrement des jetons d'un compte. */
function tokensPurpose(accountId: string): string {
  return `${TOKENS_PURPOSE}:${accountId}`;
}

/** Usage de chiffrement du profil d'un compte. */
function profilePurpose(accountId: string): string {
  return `${PROFILE_PURPOSE}:${accountId}`;
}

/** En-têtes d'un appel authentifié : identité client, origine de l'app web et jeton de session. */
function molotovHeaders(tokens: MolotovTokens, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...clientHeaders(),
    'User-Agent': MOLOTOV_UA,
    Origin: MOLOTOV_ORIGIN,
    Referer: `${MOLOTOV_ORIGIN}/`,
    Authorization: `Bearer ${tokens.idToken}`,
    ...extra,
  };
}

/** Écrit la session d'un compte : jetons chiffrés, profil chiffré (ou absent). */
async function saveAccount(
  users: UserRepo,
  secret: string,
  accountId: string,
  tokens: MolotovTokens,
  profile: MolotovProfile | null,
): Promise<void> {
  await users.setMolotovAccount(
    accountId,
    encryptJson(tokens, secret, tokensPurpose(accountId)),
    profile === null ? null : encryptJson(profile, secret, profilePurpose(accountId)),
  );
}

/** Relit la session chiffrée d'un compte ; undefined si elle est absente ou illisible. */
function readAccount(
  row: MolotovAccount | null,
  secret: string,
  accountId: string,
): { tokens: MolotovTokens; profile: MolotovProfile | null } | undefined {
  if (row === null) return undefined;
  let tokens: MolotovTokens;
  try {
    const parsed = tokensSchema.safeParse(decryptJson(row.tokens, secret, tokensPurpose(accountId)));
    if (!parsed.success) return undefined;
    tokens = parsed.data;
  } catch {
    return undefined;
  }
  let profile: MolotovProfile | null = null;
  if (row.profile !== null) {
    try {
      const parsed = profileSchema.safeParse(decryptJson(row.profile, secret, profilePurpose(accountId)));
      if (parsed.success) profile = parsed.data;
    } catch {
      profile = null;
    }
  }
  return { tokens, profile };
}

/** Requête amont (une seule tentative) vers l'API Molotov. */
async function upstream(
  fetchFn: FetchFn,
  tokens: MolotovTokens,
  options: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<UpstreamResult> {
  const result = await fetchBytes(
    fetchFn,
    options.url,
    {
      method: options.method,
      headers: molotovHeaders(tokens, options.headers ?? {}),
      ...(options.body === undefined ? {} : { body: options.body }),
    },
    options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
    { maxBytes: options.maxBytes ?? MAX_UPSTREAM_BYTES },
  );
  return { status: result.status, ok: result.ok, bytes: result.bytes, contentType: result.headers.get('content-type') ?? 'application/json' };
}

/**
 * Rafraîchit la session : `POST /refresh` avec le jeton de rafraîchissement. Les jetons neufs sont réécrits (chiffrés).
 * undefined si le rafraîchissement échoue : la session est alors perdue.
 */
async function refreshTokens(fetchFn: FetchFn, state: MolotovState): Promise<MolotovTokens | undefined> {
  const result = await upstream(fetchFn, state.tokens, {
    method: 'POST',
    url: `${MOLOTOV_API}/refresh`,
    headers: { Authorization: `Bearer ${state.tokens.refreshToken}` },
  });
  if (!result.ok) return undefined;
  const parsed = partialTokensFromDocument(parseJsonBytes(result.bytes));
  if (parsed === undefined) return undefined;
  // L'API peut ne renvoyer que le nouvel id_token : le refresh_token court est alors conservé.
  const merged: MolotovTokens = {
    idToken: parsed.idToken,
    refreshToken: parsed.refreshToken ?? state.tokens.refreshToken,
  };
  await state.save(merged);
  return merged;
}

/**
 * Appel authentifié à l'API Molotov. Une réponse 401 déclenche un rafraîchissement puis un seul rejeu ; si le
 * rafraîchissement échoue, la session est invalide (401 `invalid_session`).
 */
async function apiCall(
  fetchFn: FetchFn,
  state: MolotovState,
  options: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    query?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs?: number;
    maxBytes?: number;
  },
): Promise<UpstreamResult> {
  const suffix = options.query === undefined || options.query === '' ? '' : `?${options.query}`;
  const url = `${MOLOTOV_API}${options.path}${suffix}`;
  const first = await upstream(fetchFn, state.tokens, {
    method: options.method,
    url,
    headers: options.headers,
    body: options.body,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
  });
  if (first.status !== 401) return first;
  const refreshed = await refreshTokens(fetchFn, state);
  if (refreshed === undefined) throw new UserApiError(401, 'invalid_session');
  return upstream(fetchFn, state.tokens, {
    method: options.method,
    url,
    headers: options.headers,
    body: options.body,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
  });
}

/** Échange du jeton Google contre une session Molotov (`PUT /oauth/google`). */
async function exchangeGoogleToken(fetchFn: FetchFn, googleToken: string): Promise<MolotovTokens> {
  const result = await fetchBytes(
    fetchFn,
    `${MOLOTOV_API}/oauth/google`,
    {
      method: 'PUT',
      headers: {
        ...clientHeaders(),
        'User-Agent': MOLOTOV_UA,
        Origin: MOLOTOV_ORIGIN,
        Referer: `${MOLOTOV_ORIGIN}/`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: googleToken }),
    },
    UPSTREAM_TIMEOUT_MS,
    { maxBytes: 256 * 1024 },
  );
  if (!result.ok) {
    // Un refus amont (client Google inconnu, jeton expiré) est remonté tel quel : un 502 masquerait la cause.
    if (result.status >= 400 && result.status < 500) throw new UserApiError(400, 'google_token_rejected');
    throw new UserApiError(502, 'molotov_unavailable');
  }
  const parsed = tokensSchema.safeParse(parseJsonBytes(result.bytes));
  if (!parsed.success) throw new UserApiError(502, 'molotov_unavailable');
  return parsed.data;
}

/** Résultat d'une connexion : session obtenue, ou défi de vérification en deux étapes. */
type SigninResult = { kind: 'tokens'; tokens: MolotovTokens } | { kind: 'mfa'; mfaToken: string };

/**
 * Jetons d'une réponse amont, sous `payload` ou à plat. L'API renvoie `id_token`/`refresh_token` (forme réelle, lue
 * telle quelle par le client officiel) ; la forme `idToken`/`refreshToken` est acceptée en repli. `refreshToken` peut
 * être absent (rafraîchissement qui ne renvoie que le nouvel id_token).
 */
function partialTokensFromDocument(document: unknown): { idToken: string; refreshToken?: string } | undefined {
  const sources: unknown[] = [];
  if (isRecord(document)) {
    if (isRecord(document.payload)) sources.push(document.payload);
    sources.push(document);
  }
  for (const source of sources) {
    const snake = snakePartialTokensSchema.safeParse(source);
    if (snake.success) return { idToken: snake.data.id_token, refreshToken: snake.data.refresh_token };
    const camel = partialTokensSchema.safeParse(source);
    if (camel.success) return camel.data;
  }
  return undefined;
}

/** Jetons complets d'une réponse amont (les deux présents), sinon undefined. */
function tokensFromDocument(document: unknown): MolotovTokens | undefined {
  const partial = partialTokensFromDocument(document);
  return partial !== undefined && partial.refreshToken !== undefined
    ? { idToken: partial.idToken, refreshToken: partial.refreshToken }
    : undefined;
}

/** Jeton de défi (`payload.token`, 1..4096) ; null si absent ou hors bornes. */
function payloadTokenOf(document: unknown): string | null {
  const payload = isRecord(document) && isRecord(document.payload) ? document.payload : {};
  const token = payload['token'];
  return typeof token === 'string' && token.length >= 1 && token.length <= 4096 ? token : null;
}

/** Défi de vérification en deux étapes (`type: MFA`, insensible à la casse) ; null sinon. */
function mfaChallengeOf(document: unknown): string | null {
  if (!isRecord(document)) return null;
  const type = document['type'];
  if (typeof type !== 'string' || type.toUpperCase() !== 'MFA') return null;
  return payloadTokenOf(document);
}

/**
 * Connexion par email et mot de passe (`PUT /v2/signin`) : même identité client que les autres appels, sans `Authorization`
 * (aucune session encore). Un refus amont (identifiants incorrects) devient `401 invalid_credentials` ; une demande de
 * vérification en deux étapes (`type: MFA`) devient `kind: 'mfa'` avec le jeton de défi ; panne, 5xx ou réponse sans
 * jeton : `502 molotov_unavailable`.
 */
async function signinMolotov(fetchFn: FetchFn, email: string, password: string): Promise<SigninResult> {
  let status: number;
  let ok: boolean;
  let bytes: Uint8Array;
  try {
    const result = await fetchBytes(
      fetchFn,
      `${MOLOTOV_API}/v2/signin`,
      {
        method: 'PUT',
        headers: {
          ...clientHeaders(),
          'User-Agent': MOLOTOV_UA,
          Origin: MOLOTOV_ORIGIN,
          Referer: `${MOLOTOV_ORIGIN}/`,
          'content-type': 'application/json',
        },
        // `/v2/signin` identifie le compte par `username` (le client officiel y envoie l'email) : avec `email` seul,
        // l'API répond 401 comme pour un mot de passe faux.
        body: JSON.stringify({ username: email, password }),
      },
      UPSTREAM_TIMEOUT_MS,
      { maxBytes: 256 * 1024 },
    );
    status = result.status;
    ok = result.ok;
    bytes = result.bytes;
  } catch {
    throw new UserApiError(502, 'molotov_unavailable');
  }
  if (status === 429) throw new UserApiError(429, 'rate_limited');
  if (status >= 400 && status < 500) throw new UserApiError(401, 'invalid_credentials');
  if (!ok) throw new UserApiError(502, 'molotov_unavailable');
  const document = parseJsonBytes(bytes);
  const mfaToken = mfaChallengeOf(document);
  if (mfaToken !== null) return { kind: 'mfa', mfaToken };
  const tokens = tokensFromDocument(document);
  if (tokens === undefined) throw new UserApiError(502, 'molotov_unavailable');
  return { kind: 'tokens', tokens };
}

/**
 * Requête de vérification en deux étapes (`PUT <path>`) : le jeton de défi voyage dans `X-Mfa-Token`, toujours sans
 * `Authorization`. Ni le jeton ni le code ne sont journalisés.
 */
async function mfaUpstream(fetchFn: FetchFn, path: string, mfaToken: string, body: string): Promise<UpstreamResult> {
  try {
    const result = await fetchBytes(
      fetchFn,
      `${MOLOTOV_API}${path}`,
      {
        method: 'PUT',
        headers: {
          ...clientHeaders(),
          'User-Agent': MOLOTOV_UA,
          Origin: MOLOTOV_ORIGIN,
          Referer: `${MOLOTOV_ORIGIN}/`,
          'content-type': 'application/json',
          'X-Mfa-Token': mfaToken,
        },
        body,
      },
      UPSTREAM_TIMEOUT_MS,
      { maxBytes: 256 * 1024 },
    );
    return {
      status: result.status,
      ok: result.ok,
      bytes: result.bytes,
      contentType: result.headers.get('content-type') ?? 'application/json',
    };
  } catch {
    throw new UserApiError(502, 'molotov_unavailable');
  }
}

/** Refus d'un appel de vérification : 4xx devient `401 invalid_code` (ou `429 rate_limited` sur `CHILL_PLZ`), le reste `502`. */
function mfaFailure(result: UpstreamResult): UserApiError {
  if (result.status >= 400 && result.status < 500) {
    const document = parseJsonBytes(result.bytes);
    const code = isRecord(document) ? document['code'] ?? document['error'] : undefined;
    if (code === 'CHILL_PLZ') return new UserApiError(429, 'rate_limited');
    return new UserApiError(401, 'invalid_code');
  }
  return new UserApiError(502, 'molotov_unavailable');
}

/** Vérification du code (`PUT /mfa/verify`) : les jetons obtenus sont chiffrés au repos par la route appelante. */
async function verifyMolotovMfa(fetchFn: FetchFn, mfaToken: string, code: string): Promise<MolotovTokens> {
  const result = await mfaUpstream(fetchFn, '/mfa/verify', mfaToken, JSON.stringify({ code }));
  if (!result.ok) throw mfaFailure(result);
  const tokens = tokensFromDocument(parseJsonBytes(result.bytes));
  if (tokens === undefined) throw new UserApiError(502, 'molotov_unavailable');
  return tokens;
}

/** Renvoi du code (`PUT /mfa/email/resend`) : le jeton de défi peut changer, sinon l'ancien reste valable. */
async function resendMolotovMfa(fetchFn: FetchFn, mfaToken: string): Promise<string> {
  const result = await mfaUpstream(fetchFn, '/mfa/email/resend', mfaToken, '');
  if (!result.ok) throw mfaFailure(result);
  return payloadTokenOf(parseJsonBytes(result.bytes)) ?? mfaToken;
}

/**
 * Extraction du catalogue : parcours défensif du document PAPI. Les objets porteurs d'un identifiant de chaîne et
 * d'un nom deviennent des chaînes ; tout le reste est ignoré. La forme exacte du document n'étant pas figée, le
 * parcours accepte les variantes usuelles des noms de champs.
 */
const CHANNEL_ID_KEYS = ['channel_id', 'channelId'] as const;
const CHANNEL_NAME_KEYS = ['name', 'displayName', 'title'] as const;
const CHANNEL_LOGO_KEYS = ['logoOnDarkUrl', 'logo', 'logo_url', 'logoUrl'] as const;
const CHANNEL_GROUP_KEYS = ['group', 'groupName', 'category'] as const;
const CHANNEL_CALLSIGN_KEYS = ['callSign', 'callsign', 'call_sign'] as const;
const CHANNEL_PROGRAM_KEYS = ['program', 'nowPlaying', 'currentProgram', 'liveProgram'] as const;
const CHANNEL_PROGRAM_TITLE_KEYS = ['title', 'name', 'programTitle'] as const;

/** Nombre maximal d'objets visités dans le document (garde-fou contre un document inattendu). */
const MAX_VISITED_NODES = 400_000;

function channelOf(id: string, name: string, node: Record<string, unknown>): MolotovChannel {
  const program = CHANNEL_PROGRAM_KEYS.map((key) => node[key]).find((value) => isRecord(value));
  const live = typeof node.live === 'boolean' ? node.live : typeof node.isLive === 'boolean' ? node.isLive : true;
  return {
    id,
    name,
    callSign: pickString(node, CHANNEL_CALLSIGN_KEYS),
    logo: pickString(node, CHANNEL_LOGO_KEYS),
    group: pickString(node, CHANNEL_GROUP_KEYS),
    live,
    program: program === undefined ? pickString(node, CHANNEL_PROGRAM_TITLE_KEYS) : pickString(program, CHANNEL_PROGRAM_TITLE_KEYS),
  };
}

/** Parcours du document : renvoie les chaînes retenues et le nombre d'objets porteurs d'un identifiant de chaîne. */
function extractChannels(document: unknown): { channels: MolotovChannel[]; rawChannelCount: number } {
  const found = new Map<string, MolotovChannel>();
  const stack: unknown[] = [document];
  let visited = 0;
  let rawChannelCount = 0;
  while (stack.length > 0 && visited < MAX_VISITED_NODES) {
    const node = stack.pop();
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!isRecord(node)) continue;
    const id = pickString(node, CHANNEL_ID_KEYS);
    if (id !== null) {
      rawChannelCount += 1;
      const name = pickString(node, CHANNEL_NAME_KEYS);
      if (name !== null && !found.has(id)) found.set(id, channelOf(id, name, node));
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }
  const channels = [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, MAX_CHANNELS);
  return { channels, rawChannelCount };
}

/** Profil lu dans les réponses « profil » et « rang » de l'API (formes non figées : lecture défensive). */
function profileFrom(profileDoc: unknown, tierDoc: unknown): MolotovProfile {
  const nested = isRecord(profileDoc) && isRecord(profileDoc.profile) ? profileDoc.profile : profileDoc;
  const tier =
    typeof tierDoc === 'string'
      ? tierDoc
      : pickString(tierDoc, ['tier', 'name', 'label']) ?? (isRecord(tierDoc) ? pickString(tierDoc.data, ['tier', 'name']) : null);
  return {
    userId: pickString(nested, ['userId', 'user_id', 'id']),
    profileId: pickString(nested, ['profileId', 'profile_id']),
    email: pickString(nested, ['email', 'emailAddress', 'email_address']),
    tier,
    channelCount: 0,
  };
}

/** Profil du compte Molotov : lecture facultative, jamais bloquante pour la connexion. */
async function fetchProfile(fetchFn: FetchFn, state: MolotovState): Promise<MolotovProfile | null> {
  try {
    const profile = await apiCall(fetchFn, state, { method: 'GET', path: '/profile' });
    if (!profile.ok) return null;
    const tier = await apiCall(fetchFn, state, { method: 'GET', path: '/users/tier' });
    return profileFrom(parseJsonBytes(profile.bytes), tier.ok ? parseJsonBytes(tier.bytes) : null);
  } catch {
    return null;
  }
}

/** Date d'expiration d'un jeton (claim `exp` du JWT), en ms, ou null si le jeton n'est pas un JWT lisible. */
function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) return null;
    const exp = payload.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Décodage base64 (ou base64url) strict ; null si la valeur n'est pas du base64. */
function decodeBase64(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.length === 0) return null;
  return new Uint8Array(bytes);
}

/** URL de licence : hôte et chemin imposés par l'API, sinon refus. */
function licenseTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserApiError(400, 'invalid_body', ['licenseUrl:url_invalide']);
  }
  if (url.protocol !== 'https:' || url.host !== 'api-eu.fubo.tv' || url.pathname !== LICENSE_PATH) {
    throw new UserApiError(400, 'invalid_body', ['licenseUrl:cible_non_autorisee']);
  }
  return url.href;
}

/** Requête relayée : paramètres validés, jamais d'URL absolue. */
function relayQuery(raw: unknown): string {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') throw new UserApiError(400, 'invalid_body', ['query:chaine_attendue']);
  if (raw.length === 0) return '';
  if (raw.length > 2048) throw new UserApiError(400, 'invalid_body', ['query:trop_longue']);
  const out = new URLSearchParams();
  for (const [name, value] of new URLSearchParams(raw)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new UserApiError(400, 'invalid_body', ['query:nom_invalide']);
    if (value.length > 512) throw new UserApiError(400, 'invalid_body', ['query:valeur_trop_longue']);
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('//')) {
      throw new UserApiError(400, 'invalid_body', ['query:valeur_absolue_refusee']);
    }
    out.append(name, value);
  }
  return out.toString();
}

/** Chemin relayé : doit appartenir à la liste stricte des chemins amont autorisés. */
function relayPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new UserApiError(400, 'invalid_body', ['path:chaine_attendue']);
  if (!RELAY_PATHS.has(raw)) throw new UserApiError(400, 'unsupported_path');
  return raw;
}

/**
 * Profil principal du compte : la gestion du compte Molotov est réservée au profil principal (comme la configuration
 * du compte). Une session verrouillée sur un profil invité est refusée.
 */
async function principalSession(users: UserRepo, c: Ctx, deps: AppDeps, backend: UserBackend): Promise<Session> {
  const session = await sessionOf(users, c);
  assertNotLocked(session);
  const mainId = await backend.admin().mainProfileId(session.account.id);
  const actorId = c.req.header('x-profile-id');
  if (mainId === null || actorId === undefined || actorId !== mainId) throw new UserApiError(403, 'main_profile_required');
  const actor = await users.findProfile(session.account.id, actorId);
  if (actor === undefined) throw new UserApiError(403, 'main_profile_required');
  assertUnlocked(c, session, actor, deps.secret);
  return session;
}

/** Session Molotov du compte, prête à appeler l'API ; 401 `invalid_session` si elle est absente ou illisible. */
async function molotovState(users: UserRepo, secret: string, accountId: string): Promise<MolotovState> {
  const row = await users.getMolotovAccount(accountId);
  const account = readAccount(row, secret, accountId);
  if (account === undefined) throw new UserApiError(401, 'invalid_session');
  const state: MolotovState = {
    accountId,
    tokens: account.tokens,
    profile: account.profile,
    save: async (tokens) => {
      state.tokens = tokens;
      await saveAccount(users, secret, accountId, tokens, state.profile);
    },
    saveProfile: async (profile) => {
      state.profile = profile;
      await saveAccount(users, secret, accountId, state.tokens, profile);
    },
  };
  return state;
}

/** Catalogue compacté, servi depuis le cache mémoire tant qu'il est valide. */
function cachedCatalogue(accountId: string): CachedCatalogue | undefined {
  const entry = catalogues.get(accountId);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.fetchedAt >= CHANNELS_TTL_MS) {
    catalogues.delete(accountId);
    return undefined;
  }
  return entry;
}

function storeCatalogue(accountId: string, channels: MolotovChannel[], fetchedAt: number): void {
  if (catalogues.size >= MAX_CACHED_CATALOGUES) {
    const oldest = [...catalogues.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
    if (oldest !== undefined) catalogues.delete(oldest[0]);
  }
  catalogues.set(accountId, { channels, fetchedAt });
}

/** État de la connexion (jamais les jetons) : même corps pour `GET /account/molotov` et `POST /account/molotov/signin`. */
function statusBody(
  account: { profile: MolotovProfile | null } | undefined,
  updatedAt: number | null,
): {
  connected: boolean;
  tier: string | null;
  userId: string | null;
  profileId: string | null;
  email: string | null;
  channelCount: number;
  updatedAt: number | null;
} {
  if (account === undefined) {
    return { connected: false, tier: null, userId: null, profileId: null, email: null, channelCount: 0, updatedAt: null };
  }
  const profile = account.profile;
  return {
    connected: true,
    tier: profile?.tier ?? null,
    userId: profile?.userId ?? null,
    profileId: profile?.profileId ?? null,
    email: profile?.email ?? null,
    channelCount: profile?.channelCount ?? 0,
    updatedAt,
  };
}

/**
 * Routes du compte Molotov (montées sous /user). Toutes exigent une session valide et le profil principal, sauf le
 * relais JSON qui exige seulement la session (l'app web appelle le relais depuis une page non gérée). Les réponses
 * portant sur le compte ne sont jamais mises en cache (`no-store`).
 */
export function registerMolotovRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = (): UserRepo => backend.users();
  const fetchFn = (): FetchFn => deps.fetch ?? fetch;

  /** Refuse les appels qui font appel à l'API Molotov depuis le serveur quand le relais est désactivé. */
  const assertRelayEnabled = (): void => {
    if (!isMolotovRelayEnabled()) throw new UserApiError(403, 'relay_disabled');
  };

  /** GET /user/account/molotov : état de la connexion (jamais les jetons). */
  router.get('/account/molotov', async (c) => {
    const session = await principalSession(users(), c, deps, backend);
    const row = await users().getMolotovAccount(session.account.id);
    const account = readAccount(row, deps.secret, session.account.id);
    c.header('Cache-Control', 'no-store');
    return sendJson(c, statusBody(account, row?.updatedAt ?? null));
  });

  /**
   * PUT /user/account/molotov : connexion. `{ idToken, refreshToken }` (session déjà obtenue) ou `{ googleToken }`
   * (échange fait par le serveur, l'appel direct étant bloqué par CORS). Les jetons sont chiffrés au repos.
   */
  router.put('/account/molotov', async (c) => {
    const session = await principalSession(users(), c, deps, backend);
    const body = parseWith(connectSchema, c.get('body'));
    let tokens: MolotovTokens;
    if (body.googleToken !== undefined) {
      tokens = await exchangeGoogleToken(fetchFn(), body.googleToken);
    } else if (body.idToken !== undefined && body.refreshToken !== undefined) {
      tokens = { idToken: body.idToken, refreshToken: body.refreshToken };
    } else {
      throw new UserApiError(400, 'invalid_body', ['tokens:requis']);
    }
    await saveAccount(users(), deps.secret, session.account.id, tokens, null);
    const state = await molotovState(users(), deps.secret, session.account.id);
    const profile = await fetchProfile(fetchFn(), state);
    if (profile !== null) await state.saveProfile(profile);
    c.header('Cache-Control', 'no-store');
    return sendJson(c, { ok: true });
  });

  /**
   * POST /user/account/molotov/signin : connexion par email et mot de passe (aucun client id Google). Le serveur échange
   * les identifiants contre une session Molotov (`PUT /v2/signin`), la stocke chiffrée et répond avec le même état que
   * `GET /account/molotov`. Si l'API exige une vérification en deux étapes, la route répond `mfa_required` avec le jeton
   * de défi : aucune ligne de compte n'est créée tant que le code n'est pas vérifié. Ni le mot de passe, ni les jetons,
   * ni le code ne sont journalisés ni renvoyés.
   */
  router.post('/account/molotov/signin', async (c) => {
    const session = await principalSession(users(), c, deps, backend);
    const body = parseWith(signinSchema, c.get('body'));
    const result = await signinMolotov(fetchFn(), body.email, body.password);
    c.header('Cache-Control', 'no-store');
    if (result.kind === 'mfa') return sendJson(c, { status: 'mfa_required', mfaToken: result.mfaToken });
    await saveAccount(users(), deps.secret, session.account.id, result.tokens, null);
    const state = await molotovState(users(), deps.secret, session.account.id);
    const profile = await fetchProfile(fetchFn(), state);
    if (profile !== null) await state.saveProfile(profile);
    const row = await users().getMolotovAccount(session.account.id);
    return sendJson(c, statusBody({ profile: state.profile }, row?.updatedAt ?? null));
  });

  /**
   * POST /user/account/molotov/signin/verify : vérification du code reçu par email (`PUT /mfa/verify`, le jeton de défi
   * voyage dans `X-Mfa-Token`). Réussie, elle enregistre la session chiffrée et répond comme une connexion réussie ;
   * refus amont : `401 invalid_code`, ou `429 rate_limited` quand l'API répond `CHILL_PLZ` (trop d'essais).
   */
  router.post('/account/molotov/signin/verify', async (c) => {
    const session = await principalSession(users(), c, deps, backend);
    const body = parseWith(mfaVerifySchema, c.get('body'));
    const tokens = await verifyMolotovMfa(fetchFn(), body.mfaToken, body.code);
    await saveAccount(users(), deps.secret, session.account.id, tokens, null);
    const state = await molotovState(users(), deps.secret, session.account.id);
    const profile = await fetchProfile(fetchFn(), state);
    if (profile !== null) await state.saveProfile(profile);
    const row = await users().getMolotovAccount(session.account.id);
    c.header('Cache-Control', 'no-store');
    return sendJson(c, statusBody({ profile: state.profile }, row?.updatedAt ?? null));
  });

  /**
   * POST /user/account/molotov/signin/resend : renvoi du code par email (`PUT /mfa/email/resend`). L'API peut changer
   * le jeton de défi : la route renvoie toujours celui à utiliser ensuite.
   */
  router.post('/account/molotov/signin/resend', async (c) => {
    await principalSession(users(), c, deps, backend);
    const body = parseWith(mfaResendSchema, c.get('body'));
    const mfaToken = await resendMolotovMfa(fetchFn(), body.mfaToken);
    c.header('Cache-Control', 'no-store');
    return sendJson(c, { mfaToken });
  });

  /** DELETE /user/account/molotov : déconnexion (la ligne disparaît, vérifié après écriture). */
  router.delete('/account/molotov', async (c) => {
    const session = await principalSession(users(), c, deps, backend);
    await users().deleteMolotovAccount(session.account.id);
    if ((await users().getMolotovAccount(session.account.id)) !== null) throw new UserApiError(500, 'molotov_delete_failed');
    c.header('Cache-Control', 'no-store');
    return sendJson(c, { ok: true });
  });

  /**
   * GET /user/account/molotov/credentials : jetons en clair, pour l'appel direct depuis l'appareil (Android, desktop).
   *
   * Choix de sécurité assumé : la route rend les jetons de session Molotov au seul profil principal du compte
   * connecté, en clair, sur un canal chiffré par le TLS du worker (`Cache-Control: no-store`). Sans cela, l'appareil
   * ne pourrait pas appeler `api-eu.fubo.tv` lui-même (CORS) ; le risque est donc accepté et borné : la réponse n'est
   * pas journalisée, n'est jamais mise en cache, et ne quitte ni le compte ni son profil principal.
   */
  router.get('/account/molotov/credentials', async (c) => {
    const session = await principalSession(users(), c, deps, backend);
    const state = await molotovState(users(), deps.secret, session.account.id);
    c.header('Cache-Control', 'no-store');
    return sendJson(c, {
      idToken: state.tokens.idToken,
      refreshToken: state.tokens.refreshToken,
      expiresAt: jwtExpiry(state.tokens.idToken),
    });
  });

  /** GET /user/account/molotov/channels : catalogue « En direct » compacté (identifiant, nom, logo, programme). */
  router.get('/account/molotov/channels', async (c) => {
    assertRelayEnabled();
    const session = await principalSession(users(), c, deps, backend);
    const cached = cachedCatalogue(session.account.id);
    if (cached !== undefined) {
      c.header('Cache-Control', 'no-store');
      return sendJson(c, { channels: cached.channels, fetchedAt: cached.fetchedAt, rawChannelCount: cached.channels.length });
    }
    const state = await molotovState(users(), deps.secret, session.account.id);
    const result = await apiCall(fetchFn(), state, {
      method: 'GET',
      path: '/papi/v1/page/live-tv',
      timeoutMs: CATALOG_TIMEOUT_MS,
    });
    if (!result.ok) throw new UserApiError(502, 'molotov_unavailable');
    const extracted = extractChannels(parseJsonBytes(result.bytes));
    if (extracted.channels.length === 0) console.warn('[molotov] catalogue sans chaîne exploitable');
    const fetchedAt = Date.now();
    storeCatalogue(session.account.id, extracted.channels, fetchedAt);
    await state.saveProfile({ ...(state.profile ?? profileFrom(null, null)), channelCount: extracted.channels.length });
    c.header('Cache-Control', 'no-store');
    return sendJson(c, { channels: extracted.channels, fetchedAt, rawChannelCount: extracted.rawChannelCount });
  });

  /** POST /user/account/molotov/play : manifeste, DRM et battement de cœur d'une chaîne. */
  router.post('/account/molotov/play', async (c) => {
    assertRelayEnabled();
    const session = await principalSession(users(), c, deps, backend);
    const body = parseWith(playSchema, c.get('body'));
    const state = await molotovState(users(), deps.secret, session.account.id);
    const result = await apiCall(fetchFn(), state, {
      method: 'GET',
      path: '/vapi/asset/v1',
      query: new URLSearchParams({ channelId: body.channelId, type: 'live' }).toString(),
    });
    if (!result.ok) throw new UserApiError(502, 'molotov_unavailable');
    const document = parseJsonBytes(result.bytes);
    if (!isRecord(document)) throw new UserApiError(502, 'molotov_unavailable');
    const stream = isRecord(document.stream) ? document.stream : undefined;
    const manifestUrl = pickString(stream, ['url']);
    if (manifestUrl === null) throw new UserApiError(502, 'molotov_unavailable');
    const drm = isRecord(document.drm) ? document.drm : undefined;
    const heartbeat = isRecord(document.heartbeat) ? document.heartbeat : undefined;
    const heartbeatUrl = heartbeat === undefined ? null : pickString(heartbeat, ['url']);
    c.header('Cache-Control', 'no-store');
    return sendJson(c, {
      channelId: body.channelId,
      manifestUrl,
      drm: {
        scheme: drm === undefined ? null : pickString(drm, ['scheme']),
        licenseUrl: drm === undefined ? null : pickString(drm, ['licenseUrl', 'license_url']),
        licenseToken: drm === undefined ? null : pickString(drm, ['token']),
      },
      heartbeatUrl,
      heartbeatPayload: heartbeat === undefined || heartbeat.payload === undefined ? null : heartbeat.payload,
      assetId: assetIdOf(heartbeat, heartbeatUrl),
      expiresAt: Date.now() + ASSET_TTL_MS,
    });
  });

  /**
   * POST /user/account/molotov/license : relais binaire de la licence DRM. Le corps (challenge) est relayé tel quel,
   * octet pour octet : aucune conversion de format. Le corps n'est jamais journalisé.
   */
  router.post('/account/molotov/license', async (c) => {
    assertRelayEnabled();
    const session = await principalSession(users(), c, deps, backend);
    const body = parseWith(licenseSchema, c.get('body'));
    const target = licenseTarget(body.licenseUrl);
    const challenge = decodeBase64(body.challenge);
    if (challenge === null) throw new UserApiError(400, 'invalid_body', ['challenge:base64_attendu']);
    const state = await molotovState(users(), deps.secret, session.account.id);
    const result = await upstream(fetchFn(), state.tokens, {
      method: 'POST',
      url: target,
      headers: { Authorization: `Bearer ${body.token}`, 'content-type': 'application/octet-stream' },
      body: challenge,
    });
    if (!result.ok) throw new UserApiError(502, 'molotov_unavailable');
    c.header('Cache-Control', 'no-store');
    return sendBody(c, result.bytes, result.status as ContentfulStatusCode, 'application/octet-stream');
  });

  /** POST /user/account/molotov/heartbeat : progression de lecture relayée vers l'API. */
  router.post('/account/molotov/heartbeat', async (c) => {
    assertRelayEnabled();
    const session = await principalSession(users(), c, deps, backend);
    const body = parseWith(heartbeatSchema, c.get('body'));
    const state = await molotovState(users(), deps.secret, session.account.id);
    const heartbeatQuery = new URLSearchParams({ channelId: body.channelId, type: 'live' });
    if (body.assetId !== undefined) heartbeatQuery.set('id', body.assetId);
    const result = await apiCall(fetchFn(), state, {
      method: 'POST',
      path: '/vapi/heartbeat/v2',
      query: heartbeatQuery.toString(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(body.payload ?? {}), pdt: Date.now(), progress: body.progress }),
    });
    if (!result.ok) throw new UserApiError(502, 'molotov_unavailable');
    c.header('Cache-Control', 'no-store');
    return sendJson(c, { ok: true });
  });

  /**
   * GET /user/account/molotov/relay : relais JSON vers l'API Molotov (usage web). Chemins et paramètres validés
   * (liste stricte, aucune URL absolue) ; le jeton de session reste côté serveur.
   */
  router.get('/account/molotov/relay', async (c) => {
    assertRelayEnabled();
    const usersRepo = users();
    // Le relais porte les jetons du compte : profil principal exigé, comme sur les autres routes Molotov.
    const session = await principalSession(usersRepo, c, deps, backend);
    const params = queryParams(c);
    const path = relayPath(params.path);
    const query = relayQuery(params.query);
    const state = await molotovState(usersRepo, deps.secret, session.account.id);
    const result = await apiCall(fetchFn(), state, { method: 'GET', path, query });
    c.header('Cache-Control', 'no-store');
    return sendBody(c, result.bytes, result.status as ContentfulStatusCode, result.contentType);
  });
}
