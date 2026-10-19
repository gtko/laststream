import type { R2Bucket } from '@cloudflare/workers-types';
import type { AvatarAssets } from '../types.js';

/** Comparaison d'ETag faibles (If-None-Match), comme pour les réponses construites en mémoire (common.ts). */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const weak = (value: string): string => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => weak(candidate) === weak(etag));
}

/**
 * Fichiers des avatars dans R2 (bucket lastaddon-avatars, clés catalog.json, c/<colId>.json, i/<colId>/<charId>.webp).
 * ETag de l'objet ; 304 sans corps quand If-None-Match le couvre. Clé absente : null.
 */
export function createR2AvatarAssets(bucket: R2Bucket): AvatarAssets {
  return {
    async serve(request, key) {
      const object = await bucket.get(key);
      if (object === null) return null;
      const headers = new Headers({ ETag: object.httpEtag });
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatch !== null && etagMatches(ifNoneMatch, object.httpEtag)) {
        await object.body.cancel();
        return new Response(null, { status: 304, headers });
      }
      return new Response(object.body, { status: 200, headers });
    },
  };
}
