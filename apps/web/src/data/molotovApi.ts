import { appFetchBinary } from './crossFetch';
import { requireBase } from './config';
import { getSession } from './session';
import { call } from './userApi';
import { capacitorHttp, nativeKind, shellHttp, type HttpFn } from '../sources/debrid/http';

/* Client Molotov (TV française) : connexion, catalogue et lecture.
 *
 * Deux voies, choisies à l'exécution (contrat « Molotov », §7) :
 *  - relais serveur (`/user/account/molotov/…`) : le serveur injecte les en-têtes `x-*` et l'origine `app.molotov.tv`,
 *    garde les jetons chiffrés et relaie la licence (binaire). Seul moyen possible sur le web : `api-eu.fubo.tv` ne
 *    renvoie un `Access-Control-Allow-Origin` que pour ses propres origines ;
 *  - appel direct vers `https://api-eu.fubo.tv` depuis l'appareil (CapacitorHttp sous Android, pont de la coque sous
 *    Windows) : aucun relais, les jetons ne quittent jamais l'appareil. Un 401 est rejoué une fois après rafraîchissement.
 */

const MOLOTOV_API_BASE = 'https://api-eu.fubo.tv';
/** Application web Molotov : ouverte dans le navigateur quand la lecture DASH n'est pas possible ici. */
export const MOLOTOV_WEB_URL = 'https://app.molotov.tv';

/** Identité « client Molotov » que l'API exige sur chaque appel (contrat §2). */
const CLIENT_HEADERS: Record<string, string> = {
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
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36 Molotov/8.0.3 Electron/42.0.0',
  origin: 'https://app.molotov.tv',
  referer: 'https://app.molotov.tv/',
};

const DEVICE_ID_KEY = 'ls_molotov_device_id';
const REQUEST_TIMEOUT_MS = 20_000;
const enc = encodeURIComponent;

/** Identifiant d'appareil stable (en-têtes `x-device-id` / `x-ad-id`) : conservé sur l'appareil, jamais transmis au compte. */
function deviceId(): string {
  try {
    let id = globalThis.localStorage?.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = 'ls-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      globalThis.localStorage?.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'ls-device';
  }
}

/** Identifiant de session (en-tête `x-session-id`) : valable le temps de l'ouverture de l'application. */
const sessionId = 'ls-' + Math.random().toString(36).slice(2, 12);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// ---------- Types ----------

export interface MolotovStatus {
  connected: boolean;
  tier?: string | null;
  userId?: string | null;
  profileId?: string | null;
  email?: string | null;
  channelCount?: number;
  /** Date de dernière mise à jour de la session (ms epoch). */
  updatedAt?: number | null;
}

export interface MolotovChannelDto {
  id: string;
  name: string;
  callSign?: string;
  logo?: string;
  group?: string;
  live?: boolean;
  program?: string | null;
}

export interface MolotovCredentials {
  idToken: string;
  refreshToken: string;
  expiresAt?: number | null;
}

export interface MolotovDrm {
  scheme: string | null;
  licenseUrl: string | null;
  licenseToken: string | null;
}

export interface MolotovPlay {
  /** Manifeste DASH (Akamai, `Access-Control-Allow-Origin: *`) : chargeable directement par le lecteur. */
  manifestUrl: string;
  drm: MolotovDrm | null;
  /** URL de progression (cœur de lecture). */
  heartbeatUrl: string | null;
  /** Chaîne jouée (relayé au serveur pour la progression). */
  channelId: string;
  /** Identifiant de l'asset (paramètre `id` du heartbeat), quand l'API l'a donné. */
  assetId?: string | null;
  /** Charge utile du heartbeat amont (`passback`…), à renvoyer telle quelle en direct. */
  heartbeatPayload?: Record<string, unknown> | null;
  /** Expiration estimée de la signature du manifeste (ms epoch). */
  expiresAt?: number | null;
}

/** Erreur HTTP de l'API Molotov (amont direct ou relais serveur). */
class MolotovError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message || code);
    this.name = 'MolotovError';
  }
}

/** Le transport natif est indisponible ou a échoué : l'appel passe par le relais serveur (ou l'inverse). */
class MolotovTransportError extends Error {
  constructor(readonly reason: unknown) {
    super('molotov_transport');
    this.name = 'MolotovTransportError';
  }
}

// ---------- Transport ----------

let nativeHttp: HttpFn | null | undefined;

/** Pont HTTP de l'appareil (Android : CapacitorHttp ; Windows : IPC de la coque) ; null sur le web. */
function directHttp(): HttpFn | null {
  if (nativeHttp !== undefined) return nativeHttp;
  const kind = nativeKind();
  nativeHttp = kind === 'shell' ? shellHttp() : kind === 'capacitor' ? capacitorHttp() : null;
  return nativeHttp;
}

/** Voie employée pour les appels Molotov : direct depuis l'appareil, ou relais serveur. */
export function molotovWay(): 'direct' | 'relay' {
  return directHttp() ? 'direct' : 'relay';
}

interface UpstreamOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  query?: Record<string, string>;
  /** Jeton Molotov (`Authorization: Bearer`). */
  token?: string | null;
}

interface UpstreamReply {
  status: number;
  json: unknown;
  bytes: Uint8Array;
}

function queryOf(query?: Record<string, string>): string {
  if (!query) return '';
  const s = new URLSearchParams(query).toString();
  return s ? '?' + s : '';
}

/** Découpe une URL amont en chemin et paramètres (pour les appels directs). */
function splitUpstreamUrl(url: string): { path: string; query: Record<string, string> } {
  try {
    const u = new URL(url);
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { query[k] = v; });
    return { path: u.pathname, query };
  } catch {
    return { path: url.startsWith('/') ? url : '/' + url, query: {} };
  }
}

/** Appel direct vers `api-eu.fubo.tv` (en-têtes `x-*` du contrat §2). */
async function directUpstream(path: string, o: UpstreamOptions): Promise<UpstreamReply> {
  const http = directHttp();
  if (!http) throw new MolotovTransportError(new Error('no_native_transport'));
  const headers: Record<string, string> = {
    ...CLIENT_HEADERS,
    'x-device-id': deviceId(),
    'x-ad-id': deviceId(),
    'x-session-id': sessionId,
    accept: 'application/json',
  };
  if (o.token) headers.authorization = 'Bearer ' + o.token;
  let body: string | undefined;
  if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  let res;
  try {
    res = await http({
      url: MOLOTOV_API_BASE + path + queryOf(o.query),
      method: o.method ?? 'GET',
      headers,
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    throw new MolotovTransportError(err);
  }
  const text = new TextDecoder().decode(res.body);
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, bytes: res.body };
}

/**
 * Relais serveur : le serveur injecte `x-*` et l'origine Molotov, puis rend la réponse amont.
 * Le relais ne couvre que les lectures (`GET`) : les écritures passent par les routes dédiées
 * (`PUT /account/molotov` pour l'échange OAuth, `POST /account/molotov/heartbeat` pour la progression).
 */
async function relayUpstream(path: string, o: UpstreamOptions): Promise<UpstreamReply> {
  if ((o.method ?? 'GET') !== 'GET' || o.body !== undefined) {
    throw new MolotovError(501, 'relay_method_unsupported', `Relais indisponible pour ${o.method ?? 'GET'} ${path}`);
  }
  // La query amont est transmise à part : elle ne doit pas être concaténée au chemin (allow-list stricte du serveur).
  const query = o.query === undefined ? '' : '&query=' + enc(queryOf(o.query));
  const json = await call<unknown>('/account/molotov/relay?path=' + enc(path) + query, { headers: profileHeaders() });
  return { status: 200, json, bytes: new TextEncoder().encode(JSON.stringify(json ?? null)) };
}

/** Appel amont : direct quand l'appareil le permet, sinon par le relais serveur (le relais sert aussi de repli). */
async function upstream(path: string, o: UpstreamOptions): Promise<UpstreamReply> {
  if (directHttp()) {
    try {
      return await directUpstream(path, o);
    } catch (err) {
      // Pont natif indisponible ou hôte refusé (allow-list de la coque) : on repasse par le serveur.
      if (!(err instanceof MolotovTransportError)) throw err;
    }
  }
  return relayUpstream(path, o);
}

// ---------- Jeton Molotov ----------

let credentials: MolotovCredentials | null = null;

/** Jeton courant (demandé au serveur s'il n'est pas encore connu). */
async function molotovCredentials(force = false): Promise<MolotovCredentials> {
  if (!force && credentials) return credentials;
  credentials = await getMolotovCredentials();
  return credentials;
}

/** Oublie le jeton en mémoire (déconnexion, changement de compte). */
export function forgetMolotovCredentials(): void {
  credentials = null;
}

function sessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const session = getSession();
  if (session) headers.authorization = 'Bearer ' + session.token;
  const profile = session?.profileId;
  if (profile) headers['x-profile-id'] = profile;
  return headers;
}

function profileHeaders(): Record<string, string> {
  const profile = getSession()?.profileId;
  return profile ? { 'x-profile-id': profile } : {};
}

/**
 * Rafraîchit les jetons Molotov : direct (`POST /refresh` sur l'API) si possible, sinon le serveur les rend à jour.
 * Les nouveaux jetons sont renvoyés au serveur pour qu'il les garde chiffrés.
 */
async function refreshMolotovTokens(): Promise<MolotovCredentials> {
  const current = await molotovCredentials();
  if (directHttp()) {
    try {
      const reply = await directUpstream('/refresh', { method: 'POST', body: { refreshToken: current.refreshToken }, token: current.idToken });
      const json = reply.json as { idToken?: string; refreshToken?: string } | null;
      if (reply.status < 400 && json && json.idToken && json.refreshToken) {
        const fresh: MolotovCredentials = { idToken: json.idToken, refreshToken: json.refreshToken, expiresAt: current.expiresAt ?? null };
        await connectMolotov({ idToken: fresh.idToken, refreshToken: fresh.refreshToken });
        credentials = fresh;
        return fresh;
      }
    } catch {
      // Repli : le serveur sait peut-être rafraîchir de son côté.
    }
  }
  const fresh = await getMolotovCredentials();
  credentials = fresh;
  return fresh;
}

/**
 * Appel authentifié : rejoue une fois après rafraîchissement si l'API répond 401 (jeton expiré).
 * Hors appel direct, c'est le serveur qui porte le jeton : rien à demander au client.
 */
async function upstreamAuthed(path: string, o: UpstreamOptions = {}): Promise<UpstreamReply> {
  if (!directHttp()) return upstream(path, o);
  const creds = await molotovCredentials();
  let reply = await upstream(path, { ...o, token: creds.idToken });
  if (reply.status === 401) {
    const fresh = await refreshMolotovTokens();
    reply = await upstream(path, { ...o, token: fresh.idToken });
  }
  return reply;
}

function fail(reply: UpstreamReply, what: string): never {
  const json = reply.json as { error?: string; message?: string } | null;
  throw new MolotovError(reply.status, json?.error || 'http_' + reply.status, json?.message || what);
}

// ---------- Routes serveur (contrat §8) ----------

/** État de la connexion Molotov du compte. */
export const getMolotovStatus = () => call<MolotovStatus>('/account/molotov', { headers: profileHeaders() });

/** Enregistre les jetons Molotov (après rafraîchissement) : ils sont chiffrés au repos par le serveur. */
export const connectMolotov = (tokens: { idToken: string; refreshToken: string }) =>
  call<{ ok: boolean }>('/account/molotov', { method: 'PUT', body: tokens, headers: profileHeaders() });

/** Connexion par email et mot de passe : le serveur échange les identifiants contre une session Molotov. */
export const signinMolotov = (body: { email: string; password: string }) =>
  call<MolotovStatus>('/account/molotov/signin', { method: 'POST', body, headers: profileHeaders() });

/** Déconnexion : le serveur oublie les jetons. */
export const disconnectMolotov = () => call<{ ok: boolean }>('/account/molotov', { method: 'DELETE', headers: profileHeaders() });

/** Jeton courant pour les appels directs depuis l'appareil. */
export const getMolotovCredentials = () => call<MolotovCredentials>('/account/molotov/credentials', { headers: profileHeaders() });

/** Catalogue compact des chaînes (serveur). */
const getMolotovChannelList = () => call<{ channels?: MolotovChannelDto[]; fetchedAt?: number }>('/account/molotov/channels', { headers: profileHeaders() });

/** Lecture : manifeste DASH, licence (URL + jeton) et heartbeat. */
const getMolotovPlayRelay = (channelId: string) =>
  call<MolotovPlay>('/account/molotov/play', { method: 'POST', body: { channelId }, headers: profileHeaders() });

/** Progression : le serveur relaie le heartbeat amont. */
const postMolotovHeartbeatRelay = (body: { channelId: string; assetId?: string; progress: number; payload?: Record<string, unknown> }) =>
  call<{ ok: boolean }>('/account/molotov/heartbeat', { method: 'POST', body, headers: profileHeaders() });

/**
 * Licence Widevine : le serveur relaie le corps binaire tel quel (contrat §8).
 * `challenge` est en base64 (comme dans le contrat) ; la réponse est la licence brute.
 *
 * Le relais sert sur toutes les plateformes, pas seulement le web : le pont natif Android (CapacitorHttp) n'écrit un
 * corps binaire que sous forme de texte, la challenge Widevine ne passerait pas intacte. La réponse, elle, doit être
 * lue en octets bruts (jamais en texte) sous peine de licence corrompue.
 */
export async function postMolotovLicense(req: { licenseUrl: string; token: string; challenge: string }): Promise<ArrayBuffer> {
  return appFetchBinary(requireBase() + '/user/account/molotov/license', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/octet-stream', ...sessionHeaders() },
    body: JSON.stringify({ licenseUrl: req.licenseUrl, token: req.token, challenge: req.challenge }),
  });
}

// ---------- Catalogue ----------

/** Mémo du catalogue (le catalogue amont fait plusieurs mégaoctets). */
const CHANNELS_TTL_MS = 5 * 60 * 1000;
let channelCache: { at: number; channels: MolotovChannelDto[] } | null = null;

/** Extrait les chaînes d'une réponse de catalogue quel que soit son arborescence (rubriques, listes, items). */
function extractChannels(raw: unknown): MolotovChannelDto[] {
  const out = new Map<string, MolotovChannelDto>();
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    const o = node as Record<string, unknown>;
    const id = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : '';
    const name = str(o.name) || str(o.title) || str(o.label) || str(o.channelName) || '';
    if (id && name && !out.has(id)) {
      out.set(id, {
        id,
        name,
        callSign: str(o.callSign) || str(o.call_sign) || str(o.canonicalName) || undefined,
        logo: str(o.logo) || str(o.logoUrl) || str(o.image) || undefined,
        group: str(o.group) || str(o.category) || str(o.rubric) || str(o.groupName) || undefined,
        live: o.live === undefined ? undefined : !!o.live,
      });
    }
    Object.values(o).forEach((v) => walk(v, depth + 1));
  };
  walk(raw, 0);
  return Array.from(out.values()).slice(0, 500);
}

/**
 * Catalogue des chaînes : le serveur renvoie la forme compacte (le catalogue amont fait plusieurs mégaoctets).
 * Le direct n'est utilisé qu'en repli (serveur en mode « relais désactivé ») : le catalogue complet est volumineux
 * et l'app n'a pas à le parcourir.
 * Mémoïsé cinq minutes.
 */
export async function getMolotovChannels(force = false): Promise<MolotovChannelDto[]> {
  if (!force && channelCache && Date.now() - channelCache.at < CHANNELS_TTL_MS) return channelCache.channels;
  let list: MolotovChannelDto[] = [];
  try {
    const res = await getMolotovChannelList();
    list = Array.isArray(res.channels) ? res.channels : [];
  } catch (err) {
    if (err instanceof MolotovError && err.status === 403) {
      // Relais désactivé côté serveur : le catalogue est récupéré directement depuis l'appareil.
      if (directHttp()) {
        const reply = await upstreamAuthed('/papi/v1/page/live-tv');
        if (reply.status < 400) list = extractChannels(reply.json);
      }
    } else {
      throw err;
    }
  }
  channelCache = { at: Date.now(), channels: list };
  return list;
}

// ---------- Lecture ----------

/** Réponse de `/vapi/asset/v1` (champs à plat) ramenée à la forme commune. */
function playFromAsset(raw: unknown, channelId: string): MolotovPlay {
  const o = (raw ?? {}) as Record<string, unknown>;
  const stream = (o.stream ?? {}) as Record<string, unknown>;
  const drm = (o.drm ?? {}) as Record<string, unknown>;
  const heartbeat = (o.heartbeat ?? {}) as Record<string, unknown>;
  const manifestUrl = str(stream.url);
  if (!manifestUrl) throw new MolotovError(502, 'no_manifest', 'Flux direct indisponible.');
  const heartbeatUrl = str(heartbeat.url);
  let assetId = '';
  try { assetId = new URL(heartbeatUrl).searchParams.get('id') ?? ''; } catch { assetId = ''; }
  const payload = (heartbeat.payload ?? null) as Record<string, unknown> | null;
  return {
    manifestUrl,
    drm: str(drm.licenseUrl) ? { scheme: str(drm.scheme) || 'widevine', licenseUrl: str(drm.licenseUrl), licenseToken: str(drm.token) } : null,
    heartbeatUrl,
    channelId,
    assetId: assetId || undefined,
    heartbeatPayload: payload ?? undefined,
    expiresAt: null,
  };
}

/** Prépare la lecture d'une chaîne : manifeste, licence et heartbeat. */
export async function getMolotovPlay(channelId: string): Promise<MolotovPlay> {
  if (directHttp()) {
    const reply = await upstreamAuthed('/vapi/asset/v1', { query: { channelId, type: 'live' } });
    if (reply.status < 400) return playFromAsset(reply.json, channelId);
    fail(reply, 'Lecture direct indisponible.');
  }
  return getMolotovPlayRelay(channelId);
}

// ---------- Licence et heartbeat ----------

/** Base64 d'un tableau d'octets (challenge EME). */
export function base64Of(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Progression de lecture : direct depuis l'appareil, sinon relayée par le serveur. */
export async function postMolotovHeartbeat(play: MolotovPlay, progressMs: number): Promise<void> {
  const progress = Math.round(progressMs);
  const upstreamPayload = (play.heartbeatPayload ?? {}) as Record<string, unknown>;
  const payload = { ...upstreamPayload, pdt: Date.now(), progress };
  if (directHttp() && play.heartbeatUrl) {
    const { path, query } = splitUpstreamUrl(play.heartbeatUrl);
    const reply = await upstreamAuthed(path, { method: 'POST', body: payload, query });
    if (reply.status < 400) return;
  }
  await postMolotovHeartbeatRelay({
    channelId: play.channelId,
    assetId: play.assetId ?? undefined,
    progress,
    payload: upstreamPayload,
  });
}
