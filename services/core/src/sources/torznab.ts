import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ContentRef, RawStream } from '../types.js';
import {
  SourceError,
  fetchText,
  isRecord,
  maskSecrets,
  resolveOptions,
  sourceFailure,
  type FetchFn,
  type HttpOptions,
  type SourceTestResult,
} from './http.js';
import type { TitleInfo } from './indexers.js';
import {
  MAX_PARALLEL_QUERIES,
  SEARCH_BUDGET_MS,
  mapBounded,
  mergeRequestResults,
  releaseAliases,
  type Candidate,
} from './query-merge.js';
import { buildQueries, filterByYear, variantsFor, type TitleVariants } from './query-titles.js';

/** Indexeur Torznab (Jackett, Prowlarr ou compatible). */
export interface TorznabSource {
  name: string;
  baseUrl: string;
  apiKey: string;
  categories?: number[];
}

type XmlRecord = Record<string, unknown>;

const MAX_ERROR_LENGTH = 200;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** Construit l'URL de l'API : ajoute /api sauf si le chemin finit déjà par /api (Jackett : .../torznab/api). */
function apiUrl(baseUrl: string, params: Record<string, string>): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SourceError('URL source invalide');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api') ? path : `${path}/api`;
  url.search = new URLSearchParams(params).toString();
  url.hash = '';
  return url.toString();
}

function searchParams(source: TorznabSource, ref: ContentRef): Record<string, string> {
  const params: Record<string, string> = { t: 'movie', imdbid: ref.imdbId.replace(/^tt/i, '') };
  if (ref.type === 'series') {
    params.t = 'tvsearch';
    if (ref.season !== undefined) params.season = String(ref.season);
    if (ref.episode !== undefined) params.ep = String(ref.episode);
  }
  if (source.categories && source.categories.length > 0) params.cat = source.categories.join(',');
  params.apikey = source.apiKey;
  return params;
}

/** Retire la clé API d'un message venant de l'indexeur (brute, URL-encodée, base64) et le tronque. */
function scrubMessage(message: string, apiKey: string): string {
  return maskSecrets(message, [apiKey]).slice(0, MAX_ERROR_LENGTH);
}

function describeError(node: unknown, apiKey: string): string {
  const attrs: XmlRecord = isRecord(node) ? node : {};
  const description = text(attrs['@_description']) ?? 'erreur inconnue';
  const code = text(attrs['@_code']);
  return scrubMessage(code ? `${description} (code ${code})` : description, apiKey);
}

/**
 * Exécute une requête Torznab et renvoie le document XML parsé.
 * Une réponse <error> de l'indexeur est prioritaire sur le code HTTP.
 */
async function requestTorznab(
  fetchFn: FetchFn,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<XmlRecord> {
  const res = await fetchText(fetchFn, url, { headers: { Accept: 'application/xml, text/xml' } }, timeoutMs);
  const isXml = res.text.trim() !== '' && XMLValidator.validate(res.text) === true;
  const doc: unknown = isXml ? parser.parse(res.text) : undefined;
  if (isRecord(doc) && doc.error !== undefined) {
    throw new SourceError(`erreur Torznab : ${describeError(doc.error, apiKey)}`);
  }
  if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
  if (!isRecord(doc)) throw new SourceError('réponse XML invalide');
  return doc;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number') return String(value);
  if (isRecord(value) && typeof value['#text'] === 'string') return text(value['#text']);
  return undefined;
}

/** Normalise une valeur XML en tableau : un seul élément donne un objet, plusieurs donnent une liste. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function torznabAttrs(item: XmlRecord): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const node of asArray(item['torznab:attr']).filter(isRecord)) {
    const name = text(node['@_name']);
    const value = text(node['@_value']);
    if (name !== undefined && value !== undefined && !attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

function isMagnet(value: string | undefined): boolean {
  return value !== undefined && value.toLowerCase().startsWith('magnet:');
}

function normalizeInfoHash(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}

function infoHashFromMagnet(magnet: string | undefined): string | undefined {
  const match = /btih:([0-9a-f]{40})/i.exec(magnet ?? '');
  return match?.[1]?.toLowerCase();
}

function parseSize(value: unknown): number | undefined {
  const raw = text(value);
  return raw !== undefined && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : undefined;
}

function parseCount(value: unknown): number | undefined {
  const raw = text(value);
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Convertit un <item> RSS en RawStream.
 * Les items sans infoHash ni magnet sont ignorés (renvoie undefined).
 * `tagIndexer` (Jackett agrégé) : le flux porte le nom de son indexeur (<jackettindexer>, à défaut la source).
 */
function toRawStream(item: XmlRecord, sourceName: string, tagIndexer: boolean): RawStream | undefined {
  const attrs = torznabAttrs(item);
  const enclosure = asArray(item.enclosure).find(isRecord);
  const title = text(item.title);
  const magnet = [attrs.get('magneturl'), text(item.link), text(enclosure?.['@_url'])].find(isMagnet);
  const infoHash = normalizeInfoHash(attrs.get('infohash')) ?? infoHashFromMagnet(magnet);
  if (infoHash === undefined && magnet === undefined) return undefined;

  const indexer = tagIndexer ? (text(asArray(item.jackettindexer)[0]) ?? sourceName) : undefined;
  const label = indexer ?? sourceName;
  const stream: RawStream = { sourceName: label, sourceKind: 'torznab', name: label };
  if (indexer !== undefined) stream.indexers = [indexer];
  if (title !== undefined) {
    stream.title = title;
    stream.filename = title;
  }
  const sizeBytes = parseSize(item.size) ?? parseSize(attrs.get('size')) ?? parseSize(enclosure?.['@_length']);
  if (sizeBytes !== undefined) stream.sizeBytes = sizeBytes;
  const seeders = parseCount(attrs.get('seeders'));
  if (seeders !== undefined) stream.seeders = seeders;
  if (infoHash !== undefined) stream.infoHash = infoHash;
  if (magnet !== undefined) stream.magnet = magnet;
  return stream;
}

/** Requête texte Torznab : t=movie ou t=tvsearch avec `q` (sans identifiant), catégories de la source. */
function textParams(source: TorznabSource, ref: ContentRef, query: string): Record<string, string> {
  const params: Record<string, string> = { t: ref.type === 'movie' ? 'movie' : 'tvsearch', q: query };
  if (source.categories && source.categories.length > 0) params.cat = source.categories.join(',');
  params.apikey = source.apiKey;
  return params;
}

/** Une requête Torznab : items convertis en flux, avec leurs alias (guid, lien de téléchargement sans secret). */
async function fetchCandidates(
  fetchFn: FetchFn,
  source: TorznabSource,
  params: Record<string, string>,
  timeoutMs: number,
  tagIndexers: boolean,
): Promise<Candidate[]> {
  const doc = await requestTorznab(fetchFn, apiUrl(source.baseUrl, params), source.apiKey, timeoutMs);
  if (doc.rss === undefined) throw new SourceError('réponse Torznab inattendue');
  const channel = asArray(isRecord(doc.rss) ? doc.rss.channel : undefined).find(isRecord);
  if (!channel) return [];
  return asArray(channel.item)
    .filter(isRecord)
    .flatMap((item) => {
      const stream = toRawStream(item, source.name, tagIndexers);
      return stream ? [{ stream, aliases: releaseAliases(text(item.guid), text(item.link)) }] : [];
    });
}

/**
 * Options de searchTorznab. `tagIndexers` : chaque flux porte le nom de son indexeur (Jackett agrégé).
 * `titles` (ou `titleInfo`) : requêtes texte en plus de la recherche par id ; `budgetMs` borne ces requêtes.
 */
export interface TorznabSearchOptions extends HttpOptions {
  tagIndexers?: boolean;
  titles?: TitleVariants;
  titleInfo?: TitleInfo;
  budgetMs?: number;
}

/**
 * Recherche Torznab pour un film (t=movie) ou un épisode (t=tvsearch) via l'identifiant IMDb. Si des titres sont
 * connus, une requête texte part aussi par requête (en parallèle, budget borné) ; les résultats sont fusionnés sans
 * doublon et, pour un film, filtrés sur l'année. Sans titre, seule la requête par id part.
 * Lève une SourceError sûre (sans URL ni clé) si toutes les requêtes échouent (la requête par id en premier).
 */
export async function searchTorznab(
  source: TorznabSource,
  ref: ContentRef,
  opts: TorznabSearchOptions = {},
): Promise<RawStream[]> {
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  const tagIndexers = opts.tagIndexers === true;
  try {
    const variants = variantsFor(opts);
    const queries = variants === undefined ? [] : buildQueries(variants, ref);
    const plans: { params: Record<string, string>; text: boolean }[] = [
      { params: searchParams(source, ref), text: false },
      ...queries.map((query) => ({ params: textParams(source, ref, query), text: true })),
    ];
    const deadline = Date.now() + (opts.budgetMs ?? SEARCH_BUDGET_MS);
    const settled = await mapBounded(plans, MAX_PARALLEL_QUERIES, async (plan) => {
      if (!plan.text) return fetchCandidates(fetchFn, source, plan.params, timeoutMs, tagIndexers);
      const left = Math.ceil(deadline - Date.now());
      if (left <= 0) return undefined; // budget épuisé : cette requête texte est ignorée
      return fetchCandidates(fetchFn, source, plan.params, Math.min(timeoutMs, left), tagIndexers);
    });
    const ran = settled.filter((outcome) => outcome.status === 'rejected' || outcome.value !== undefined);
    const failed = ran.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed.length > 0 && failed.length === ran.length) throw failed[0]?.reason;
    const batches = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' && outcome.value !== undefined ? [outcome.value] : [],
    );
    return filterByYear(mergeRequestResults(batches), ref, variants);
  } catch (err) {
    throw sourceFailure(source.name, err);
  }
}

/** Vérifie qu'un indexeur répond à t=caps avec un document <caps> valide. */
export async function testTorznab(source: TorznabSource, opts: HttpOptions = {}): Promise<SourceTestResult> {
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  try {
    const url = apiUrl(source.baseUrl, { t: 'caps', apikey: source.apiKey });
    const doc = await requestTorznab(fetchFn, url, source.apiKey, timeoutMs);
    if (doc.caps === undefined) throw new SourceError('réponse inattendue (<caps> absent)');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sourceFailure(source.name, err).message };
  }
}
