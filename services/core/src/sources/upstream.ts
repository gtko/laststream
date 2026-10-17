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

/** Chemin de base d'un addon amont, sans /manifest.json ni slashes finaux. */
function addonPath(url: URL): string {
  return url.pathname.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
}

function parseSourceUrl(sourceUrl: string): URL {
  try {
    return new URL(sourceUrl);
  } catch {
    throw new SourceError('URL source invalide');
  }
}

/** URL GET `{base}/stream/{type}/{id}.json` ; la query string de la source est conservée. */
function streamUrl(sourceUrl: string, ref: ContentRef): string {
  const url = parseSourceUrl(sourceUrl);
  url.pathname = `${addonPath(url)}/stream/${ref.type}/${encodeURIComponent(ref.id)}.json`;
  url.hash = '';
  return url.toString();
}

function manifestUrl(sourceUrl: string): string {
  const url = parseSourceUrl(sourceUrl);
  url.pathname = `${addonPath(url)}/manifest.json`;
  url.hash = '';
  return url.toString();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('réponse JSON invalide');
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
 * Interroge un addon Stremio amont pour un contenu et renvoie ses streams.
 * Lève une SourceError sûre (sans URL ni clé) en cas d'erreur HTTP, de JSON invalide ou de délai dépassé.
 */
export async function fetchUpstream(
  source: UpstreamSource,
  ref: ContentRef,
  opts: HttpOptions = {},
): Promise<RawStream[]> {
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  try {
    const res = await fetchText(
      fetchFn,
      streamUrl(source.url, ref),
      { headers: { Accept: 'application/json' } },
      timeoutMs,
    );
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
    const body = parseJson(res.text);
    if (!isRecord(body) || !Array.isArray(body.streams)) {
      throw new SourceError('réponse inattendue (champ streams absent)');
    }
    return body.streams.filter(isRecord).map((raw) => toRawStream(raw, source.name));
  } catch (err) {
    throw sourceFailure(source.name, err);
  }
}

/** Vérifie qu'un addon amont répond et expose un manifest (champ id ou resources). */
export async function testUpstream(source: UpstreamSource, opts: HttpOptions = {}): Promise<SourceTestResult> {
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  try {
    const res = await fetchText(
      fetchFn,
      manifestUrl(source.url),
      { headers: { Accept: 'application/json' } },
      timeoutMs,
    );
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
    const manifest = parseJson(res.text);
    if (!isRecord(manifest) || !(typeof manifest.id === 'string' || Array.isArray(manifest.resources))) {
      throw new SourceError('manifest invalide (id ou resources absent)');
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sourceFailure(source.name, err).message };
  }
}
