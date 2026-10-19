import { createHash } from 'node:crypto';
import { LruCache } from '../cache/lru.js';
import { hostOf, metrics, type UpstreamOutcome } from '../metrics/index.js';
import type { ContentRef, RawStream } from '../types.js';
import {
  SourceError,
  fetchText,
  isRecord,
  resolveOptions,
  sourceFailure,
  type HttpOptions,
  type SourceTestResult,
} from './http.js';

/** Source amont : un autre addon Stremio, identifié par son URL de base ou celle de son manifest. */
export interface UpstreamSource {
  name: string;
  url: string;
}

/**
 * Métadonnées publiques du manifest d'un addon amont, renvoyées par POST /config/test. Jamais l'URL source ni son
 * jeton : les textes et le logo sont épurés de ces secrets.
 */
export interface UpstreamManifestInfo {
  name?: string;
  logo?: string;
  version?: string;
  description?: string;
  types: string[];
  hasStream: boolean;
}

/** Résultat du test d'un addon amont. `manifest` n'est présent qu'en cas de succès. */
export interface UpstreamTestResult extends SourceTestResult {
  manifest?: UpstreamManifestInfo;
}

/** Durée de vie du manifest en cache : une heure. Seuls les succès sont gardés. */
export const MANIFEST_CACHE_MS = 60 * 60 * 1000;
const manifestCache = new LruCache<UpstreamManifestInfo>({ max: 64, ttlMs: MANIFEST_CACHE_MS, now: () => Date.now() });

/** Cache négatif court : un manifest qui échoue n'est pas redemandé à chaque requête /stream. */
export const MANIFEST_FAILURE_CACHE_MS = 60 * 1000;
interface ManifestFailure {
  message: string;
  blocked: boolean;
}
const manifestFailures = new LruCache<ManifestFailure>({ max: 64, ttlMs: MANIFEST_FAILURE_CACHE_MS, now: () => Date.now() });

/** Longueur maximale d'un texte du manifest, et nombre maximal de types. */
const MAX_MANIFEST_TEXT = 300;
const MAX_MANIFEST_TYPES = 20;
const MAX_LOGO_LENGTH = 2048;
/** Segment de chemin assez long pour être un jeton : seuls ceux-là sont masqués dans les textes du manifest. */
const MIN_SECRET_SEGMENT = 8;

/**
 * Chemin de base d'un addon amont, sans /manifest.json, sans slashes finaux ni doublés (le jeton intégré reste intact).
 */
function addonPath(url: URL): string {
  return url.pathname
    .replace(/\/+$/, '')
    .replace(/\/manifest\.json$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

function parseSourceUrl(sourceUrl: string): URL {
  try {
    return new URL(sourceUrl);
  } catch {
    throw new SourceError('URL source invalide');
  }
}

/**
 * Identifiant dans le chemin : encodé, sauf les `:` des identifiants de série (tt1234567:1:2), comme le fait Stremio.
 */
function encodeStreamId(id: string): string {
  return encodeURIComponent(id).replace(/%3A/gi, ':');
}

/** URL GET `{base}/stream/{type}/{id}.json` ; la query string de la source est conservée. */
export function upstreamStreamUrl(sourceUrl: string, ref: ContentRef): string {
  const url = parseSourceUrl(sourceUrl);
  url.pathname = `${addonPath(url)}/stream/${ref.type}/${encodeStreamId(ref.id)}.json`;
  url.hash = '';
  return url.toString();
}

function manifestUrl(sourceUrl: string): string {
  const url = parseSourceUrl(sourceUrl);
  url.pathname = `${addonPath(url)}/manifest.json`;
  url.hash = '';
  return url.toString();
}

/** Corps « error code: 1042 » (erreurs Cloudflare 10xx, ex. Worker vers Worker) : jamais la réponse d'un addon. */
const CLOUDFLARE_ERROR_BODY = /^s*error code:s*10dd/i;

function isJsonRecord(text: string): boolean {
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * Une réponse HTTP en échec vient-elle d'un blocage d'IP de serveur ou d'une panne passagère ? 401, 403, 429, 451, 5xx : oui.
 * 404 : oui, sauf si le corps est un JSON d'addon (ex. `{streams:[]}` = « rien pour ce titre », cas normal). Un corps
 * « error code: 10xx » ou une page de vérification est toujours un blocage, quel que soit le statut.
 */
export function isBlockingResponse(status: number, text: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status === 451 || status >= 500) return true;
  if (CLOUDFLARE_ERROR_BODY.test(text) || looksLikeChallenge(text)) return true;
  if (status === 404) return !isJsonRecord(text);
  return false;
}

/** Page HTML de vérification Cloudflare (ou équivalent) au lieu du JSON de l'addon. */
export function looksLikeChallenge(text: string): boolean {
  const head = text.slice(0, 4096);
  return /^\s*</.test(head) && /just a moment|cf-chl|cf-browser-verification|attention required|challenge-platform|cloudflare/i.test(head);
}

/** JSON du corps. `blocked` : un corps non JSON sur la route /stream vient d'une barrière (page HTML, « error code: 10xx »). */
function parseJson(text: string, blocked = false): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('réponse JSON invalide', blocked);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Convertit un stream Stremio brut en RawStream. Les titres et langues ne sont pas parsés ici. */
function toRawStream(raw: Record<string, unknown>, sourceName: string): RawStream {
  const hints = isRecord(raw.behaviorHints) ? raw.behaviorHints : undefined;
  const stream: RawStream = { sourceName, sourceKind: 'upstream' };

  const name = optionalString(raw.name);
  if (name !== undefined) stream.name = name;
  const title = optionalString(raw.title);
  if (title !== undefined) stream.title = title;
  const description = optionalString(raw.description);
  if (description !== undefined) stream.description = description;
  const url = optionalString(raw.url);
  if (url !== undefined) stream.url = url;

  const infoHash = optionalString(raw.infoHash);
  if (infoHash !== undefined) stream.infoHash = infoHash.toLowerCase();
  if (typeof raw.fileIdx === 'number' && Number.isInteger(raw.fileIdx)) stream.fileIdx = raw.fileIdx;

  const filename = optionalString(hints?.filename);
  if (filename !== undefined) stream.filename = filename;
  const sizeBytes = optionalNonNegativeNumber(hints?.videoSize);
  if (sizeBytes !== undefined) stream.sizeBytes = sizeBytes;
  if (hints) stream.behaviorHints = hints;

  if (Array.isArray(raw.sources)) {
    const sources = raw.sources.filter((s): s is string => typeof s === 'string');
    if (sources.length > 0) stream.sources = sources;
  }
  return stream;
}

/**
 * Charge le manifest d'un addon en arrière-plan (cache 1 h) pour que ses flux portent son nom et son logo. Échec ignoré.
 */
export function warmUpstreamManifest(source: UpstreamSource, opts: HttpOptions = {}): void {
  const key = manifestCacheKey(source.url);
  if (manifestCache.get(key) === undefined && manifestFailures.get(key) === undefined) void loadManifest(source, opts).catch(() => undefined);
}

/** Provenance d'un flux de l'addon : nom et logo du manifest s'il est en cache, sinon le nom de la source. */
function originOf(source: UpstreamSource, _opts: HttpOptions): { name: string; logo?: string } {
  const cached = manifestCache.get(manifestCacheKey(source.url));
  const origin: { name: string; logo?: string } = { name: cached?.name ?? source.name };
  if (cached?.logo !== undefined) origin.logo = cached.logo;
  return origin;
}

/** Nom d'un addon amont pour l'appareil : celui de son manifest s'il est déjà en cache, sinon le nom de la source (« Addon amont » par défaut). */
export function upstreamDisplayName(source: UpstreamSource): string {
  return manifestCache.get(manifestCacheKey(source.url))?.name || source.name;
}

/**
 * Interroge un addon Stremio amont pour un contenu et renvoie ses streams.
 * Lève une SourceError sûre (sans URL ni clé) en cas d'erreur HTTP, de JSON invalide ou de délai dépassé.
 */
export async function fetchUpstream(
  source: UpstreamSource,
  ref: ContentRef,
  opts: HttpOptions = {},
): Promise<RawStream[]> {
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  const started = Date.now();
  // Santé de l'addon (par nom d'hôte seul, jamais le chemin qui porte le jeton).
  const host = hostOf(source.url);
  const measure = (outcome: UpstreamOutcome): void => {
    if (host !== undefined) metrics().upstream(host, outcome, Date.now() - started);
  };
  try {
    const res = await fetchText(
      fetchFn,
      upstreamStreamUrl(source.url, ref),
      { headers: { Accept: 'application/json' } },
      timeoutMs,
    );
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`, isBlockingResponse(res.status, res.text));
    if (looksLikeChallenge(res.text)) throw new SourceError('page de vérification reçue', true);
    const body = parseJson(res.text, true);
    if (!isRecord(body) || !Array.isArray(body.streams)) {
      throw new SourceError('réponse inattendue (champ streams absent)');
    }
    const origin = originOf(source, opts);
    const streams = body.streams.filter(isRecord).map((raw) => ({ ...toRawStream(raw, source.name), origin }));
    measure('ok');
    return streams;
  } catch (err) {
    measure(err instanceof SourceError && err.message.startsWith('délai dépassé') ? 'timeout' : 'fail');
    throw sourceFailure(source.name, err);
  }
}

/** Clé de cache : empreinte du chemin du manifest (le jeton n'est jamais gardé en clair). */
function manifestCacheKey(sourceUrl: string): string {
  return createHash('sha256').update(manifestUrl(sourceUrl)).digest('hex');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Segments de chemin de l'addon qui sont des jetons probables (à masquer dans les textes du manifest). */
function secretSegments(sourceUrl: string): string[] {
  const segments = addonPath(parseSourceUrl(sourceUrl)).split('/').filter((segment) => segment.length >= MIN_SECRET_SEGMENT);
  return segments.flatMap((segment) => {
    const decoded = safeDecode(segment);
    return decoded === segment ? [segment] : [segment, decoded];
  });
}

/** Texte du manifest épuré : secrets masqués, longueur bornée. Absent si vide ou non textuel. */
function manifestText(value: unknown, secrets: readonly string[]): string | undefined {
  const text = optionalString(value)?.trim();
  if (text === undefined || text === '') return undefined;
  const clean = secrets.reduce((acc, secret) => acc.split(secret).join('***'), text);
  return clean.slice(0, MAX_MANIFEST_TEXT);
}

/** Logo du manifest : seulement une URL http(s) qui ne contient aucun secret de l'addon. */
function manifestLogo(value: unknown, secrets: readonly string[]): string | undefined {
  const logo = optionalString(value)?.trim();
  if (logo === undefined || logo === '' || logo.length > MAX_LOGO_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(logo);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (secrets.some((secret) => logo.includes(secret))) return undefined;
  return logo;
}

/** Métadonnées publiques d'un manifest valide. Le champ `resources` donne `hasStream` (ressource « stream »). */
function manifestInfo(manifest: Record<string, unknown>, sourceUrl: string): UpstreamManifestInfo {
  const secrets = secretSegments(sourceUrl);
  const info: UpstreamManifestInfo = { types: [], hasStream: false };
  const name = manifestText(manifest.name, secrets);
  if (name !== undefined) info.name = name;
  const version = manifestText(manifest.version, secrets);
  if (version !== undefined) info.version = version;
  const description = manifestText(manifest.description, secrets);
  if (description !== undefined) info.description = description;
  const logo = manifestLogo(manifest.logo, secrets);
  if (logo !== undefined) info.logo = logo;
  if (Array.isArray(manifest.types)) {
    info.types = manifest.types
      .filter((type): type is string => typeof type === 'string' && type.trim() !== '')
      .slice(0, MAX_MANIFEST_TYPES)
      .map((type) => type.trim().slice(0, 50));
  }
  if (Array.isArray(manifest.resources)) {
    info.hasStream = manifest.resources.some(
      (resource) => resource === 'stream' || (isRecord(resource) && resource.name === 'stream'),
    );
  }
  return info;
}

/** Charge le manifest d'un addon (cache 1 h). Lève une SourceError brute ; l'appelant la préfixe par le nom. */
async function loadManifest(source: UpstreamSource, opts: HttpOptions, fresh = false): Promise<UpstreamManifestInfo> {
  const key = manifestCacheKey(source.url);
  const cached = manifestCache.get(key);
  if (cached !== undefined) return cached;
  const failed = fresh ? undefined : manifestFailures.get(key);
  if (failed !== undefined) throw new SourceError(failed.message, failed.blocked);
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  try {
    const res = await fetchText(fetchFn, manifestUrl(source.url), { headers: { Accept: 'application/json' } }, timeoutMs);
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`, isBlockingResponse(res.status, res.text));
    const manifest = parseJson(res.text, true);
    if (!isRecord(manifest) || !(typeof manifest.id === 'string' || Array.isArray(manifest.resources))) {
      throw new SourceError('manifest invalide (id ou resources absent)');
    }
    const info = manifestInfo(manifest, source.url);
    manifestCache.set(key, info);
    manifestFailures.delete(key);
    return info;
  } catch (err) {
    if (err instanceof SourceError) manifestFailures.set(key, { message: err.message, blocked: err.blocked });
    throw err;
  }
}

/**
 * Vérifie qu'un addon amont répond et expose un manifest (champ id ou resources). En cas de succès, renvoie aussi
 * ses métadonnées publiques (`manifest`). Échec : statut seulement, sans URL ni jeton. Ne lève jamais.
 */
export async function testUpstream(source: UpstreamSource, opts: HttpOptions = {}): Promise<UpstreamTestResult> {
  try {
    return { ok: true, manifest: await loadManifest(source, opts, true) };
  } catch (err) {
    return { ok: false, error: sourceFailure(source.name, err).message };
  }
}

/** Vide le cache des manifests (tests). */
export function clearUpstreamManifestCache(): void {
  manifestCache.clear();
  manifestFailures.clear();
}
