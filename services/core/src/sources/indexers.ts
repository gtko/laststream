import { SourceError, maskSecrets } from './http.js';

/** Indexeur découvert via Prowlarr ou Jackett, déjà filtré (torrent, activé ou configuré). Jamais de clé ni d'URL. */
export interface IndexerInfo {
  id: number | string;
  name: string;
  protocol: 'torrent';
  enabled: boolean;
  privacy: IndexerPrivacy;
  supportsImdb: boolean;
  supportsTvdb: boolean;
  supportsSeason: boolean;
  /** Recherche par IMDb disponible pour les films. */
  movieImdb: boolean;
  /** Recherche par IMDb disponible pour les séries. */
  tvImdb: boolean;
}

export type IndexerPrivacy = 'public' | 'private' | 'semiPrivate';

/** Titre et année, pour la recherche texte de repli. */
export interface TitleInfo {
  title: string;
  year?: number;
}

/** Délai maximal par requête vers Prowlarr ou Jackett, en millisecondes. */
export const INDEXER_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_CODE_LENGTH = 120;

/** URL d'un point d'API : le chemin est ajouté à la base (préfixe de reverse proxy conservé). */
export function endpointUrl(baseUrl: string, path: string, params?: URLSearchParams): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SourceError('URL source invalide');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = params?.toString() ?? '';
  url.hash = '';
  return url.toString();
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('réponse JSON invalide');
  }
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Message d'échec sûr pour l'historique de santé : sans clé, sans URL, tronqué. */
export function describeFailure(err: unknown, apiKey: string): string {
  const detail = err instanceof SourceError ? err.message : 'erreur inattendue';
  return maskSecrets(detail, [apiKey]).slice(0, MAX_ERROR_CODE_LENGTH);
}

export function isMagnet(value: string | undefined): value is string {
  return value !== undefined && value.toLowerCase().startsWith('magnet:');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) de 32 caractères vers hexadécimal de 40 caractères minuscules. */
function base32ToHex(value: string): string | undefined {
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const char of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return undefined;
    acc = ((acc << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length === 20 ? bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('') : undefined;
}

/** Info-hash BitTorrent (hex 40 ou base32 32) normalisé en hex 40 minuscules. */
export function normalizeInfoHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(trimmed)) return base32ToHex(trimmed);
  return undefined;
}

const BTIH = /btih:([0-9a-z]{40}|[0-9a-z]{32})(?![0-9a-z])/i;

/** Info-hash extrait du paramètre xt=urn:btih d'un magnet, en hex 40 minuscules. */
export function infoHashFromMagnet(magnet: string | undefined): string | undefined {
  const match = BTIH.exec(magnet ?? '');
  return match?.[1] === undefined ? undefined : normalizeInfoHash(match[1]);
}
