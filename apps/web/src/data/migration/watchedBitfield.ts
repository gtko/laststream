/* Champ « watched » d'un titre de la bibliothèque Stremio : `<id de l'épisode ancre>:<longueur>:<base64(zlib(bits))>`.
 * Le bit i vaut 1 si le i-ème épisode est vu, les épisodes étant triés par saison, numéro puis date de sortie (comme
 * stremio-watched-bitfield). L'ancre recale les bits quand la liste d'épisodes a changé depuis l'écriture (épisodes ajoutés
 * avant elle). Module sans réseau : la liste des épisodes est fournie par l'appelant. */

import type { EpisodeRef } from './types';

/** Épisode tel que listé par Cinemeta (`videos` de la fiche) : `id` du type `tt123:1:2`. */
export interface BitfieldVideo {
  id: string;
  season?: number;
  episode?: number;
  released?: string;
}

export type Inflate = (bytes: Uint8Array) => Promise<Uint8Array>;

/** Décompression zlib par l'API du navigateur (« deflate » y désigne le format zlib). */
export const browserInflate: Inflate = async (bytes) => {
  const stream = (new Response(bytes as BodyInit).body as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const order = (v: BitfieldVideo): [number, number, number] => [
  v.season ?? Number.MIN_SAFE_INTEGER,
  v.episode ?? Number.MIN_SAFE_INTEGER,
  v.released ? Date.parse(v.released) || Number.MIN_SAFE_INTEGER : Number.MIN_SAFE_INTEGER,
];

/** Épisodes dans l'ordre du champ « watched » de Stremio. */
export function sortVideos(videos: readonly BitfieldVideo[]): BitfieldVideo[] {
  return [...videos].sort((a, b) => {
    const x = order(a);
    const y = order(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

/**
 * Épisodes vus (hors saison 0) d'après le champ « watched ». Vide si le champ est illisible ou si l'ancre n'est plus dans la
 * liste (comme Stremio, qui repart alors de zéro). Lève seulement si la décompression échoue.
 */
export async function decodeWatched(serialized: string, videos: readonly BitfieldVideo[], inflate: Inflate = browserInflate): Promise<EpisodeRef[]> {
  const parts = serialized.split(':');
  if (parts.length < 3) return [];
  const packed = parts.pop() as string;
  const anchorLength = Number(parts.pop());
  const anchorId = parts.join(':');
  if (!Number.isInteger(anchorLength)) return [];
  const sorted = sortVideos(videos);
  const anchorIdx = sorted.findIndex((v) => v.id === anchorId);
  if (anchorIdx < 0) return [];
  const bits = await inflate(base64Bytes(packed));
  const get = (i: number): boolean => i >= 0 && (i >> 3) < bits.length && ((bits[i >> 3] >> (i & 7)) & 1) === 1;
  const offset = anchorLength - anchorIdx - 1;
  const out: EpisodeRef[] = [];
  sorted.forEach((v, i) => {
    if (get(i + offset) && v.season !== undefined && v.episode !== undefined && v.season > 0) out.push({ season: v.season, episode: v.episode });
  });
  return out;
}
