import type { ParsedRelease, RawStream } from '../types.js';
import { parseLanguages } from './language.js';
import { extractInfoHash, parseSeeders, parseSize } from './meta.js';
import { releaseScope } from './scope.js';
import { parseVideo, type VideoInfo } from './video.js';

const nonEmpty = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** Assemble le ParsedRelease : infos vidéo fournies, langues, taille, seeders et infoHash extraits de `text`. */
function buildRelease(text: string, video: VideoInfo, title: string | undefined): ParsedRelease {
  const languages = parseLanguages(text);
  const release: ParsedRelease = {
    resolution: video.resolution,
    height: video.height,
    source: video.source,
    codec: video.codec,
    hdr: video.hdr,
    audio: video.audio,
    languages: languages.languages,
    multi: languages.multi,
    subsFr: languages.subsFr,
    title,
  };
  if (video.channels !== undefined) release.channels = video.channels;
  if (video.group !== undefined) release.group = video.group;
  if (languages.frVariant !== undefined) release.frVariant = languages.frVariant;

  const sizeBytes = parseSize(text);
  if (sizeBytes !== undefined) release.sizeBytes = sizeBytes;
  const seeders = parseSeeders(text);
  if (seeders !== undefined) release.seeders = seeders;
  const infoHash = extractInfoHash(text);
  if (infoHash !== undefined) release.infoHash = infoHash;
  return release;
}

/**
 * Parse un texte de release (nom, nom de fichier ou description) en ParsedRelease complet :
 * résolution, source, codec, HDR, audio, langues, variante FR, taille, seeders et infoHash.
 * `title` vaut le texte fourni.
 */
export function parseRelease(text: string): ParsedRelease {
  return buildRelease(text, parseVideo(text), text);
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Lignes textuelles d'un stream, par ordre de priorité : filename, title, name, description, sans doublons.
 * Une ligne par partie : le groupe final d'un nom (« -GRP ») n'est reconnu qu'en fin de texte, or un titre
 * Torrentio est suivi de sa description. Le champ `name` est ignoré quand il reprend le nom de la source
 * configurée (indexeur Torznab) : ce libellé ne décrit pas la release et fausserait la détection des langues.
 */
function streamParts(raw: RawStream): string[] {
  const name = raw.name === raw.sourceName ? undefined : raw.name;
  const lines = [raw.filename, raw.title, name, raw.description]
    .filter(nonEmpty)
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return unique(lines);
}

/**
 * Fusionne les infos vidéo de chaque partie, dans l'ordre de priorité : la première valeur connue l'emporte.
 * Chaque partie est analysée seule, car le groupe final (« -GRP ») n'est reconnu qu'en fin de texte.
 */
function mergeVideo(infos: readonly VideoInfo[]): VideoInfo {
  const byResolution = infos.find((info) => info.resolution !== 'unknown');
  const bySource = infos.find((info) => info.source !== 'unknown');
  const byCodec = infos.find((info) => info.codec !== 'unknown');
  const merged: VideoInfo = {
    resolution: byResolution?.resolution ?? 'unknown',
    height: byResolution?.height ?? 0,
    source: bySource?.source ?? 'unknown',
    codec: byCodec?.codec ?? 'unknown',
    hdr: unique(infos.flatMap((info) => info.hdr)),
    audio: unique(infos.flatMap((info) => info.audio)),
    tags: unique(infos.flatMap((info) => info.tags)),
  };
  const channels = infos.find((info) => info.channels !== undefined)?.channels;
  if (channels !== undefined) merged.channels = channels;
  const group = infos.find((info) => info.group !== undefined)?.group;
  if (group !== undefined) merged.group = group;
  return merged;
}

/**
 * Parse un stream amont. Les langues, la taille, les seeders et l'infoHash viennent du texte complet ;
 * les caractéristiques vidéo viennent de chaque partie, par ordre de priorité.
 * Les champs structurés fournis par la source (sizeBytes, seeders, infoHash, fileIdx) l'emportent sur le texte.
 */
export function parseRawStream(raw: RawStream): ParsedRelease {
  const parts = streamParts(raw);
  const title = [raw.filename, raw.title, raw.name].find(nonEmpty);
  const text = parts.join('\n');
  const release = buildRelease(text, mergeVideo(parts.map((part) => parseVideo(part))), title);
  const scope = releaseScope(text);
  if (Object.keys(scope).length > 0) release.scope = scope;

  if (raw.sizeBytes !== undefined) release.sizeBytes = raw.sizeBytes;
  if (raw.seeders !== undefined) release.seeders = raw.seeders;
  if (raw.fileIdx !== undefined) release.fileIdx = raw.fileIdx;

  const structuredHash = nonEmpty(raw.infoHash) ? raw.infoHash.toLowerCase() : undefined;
  const magnetHash = nonEmpty(raw.magnet) ? extractInfoHash(raw.magnet) : undefined;
  const infoHash = structuredHash ?? release.infoHash ?? magnetHash;
  if (infoHash !== undefined) release.infoHash = infoHash;
  return release;
}
