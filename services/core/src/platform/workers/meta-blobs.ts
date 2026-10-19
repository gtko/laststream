import type { R2Bucket } from '@cloudflare/workers-types';
import type { MetaBlob, MetaBlobStore } from '../../lt/meta.js';
import type { RowBlob, RowBlobStore } from '../../lt/rows.js';

/**
 * Fiches partagées dans R2 (bucket lastaddon-meta, clés meta/<type>/<tmdbId>.json). Le contenu JSON est le corps de
 * l'objet ; l'empreinte (etag) et l'échéance (expiresAt, ms epoch) sont ses métadonnées personnalisées.
 */
export function createR2MetaBlobs(bucket: R2Bucket): MetaBlobStore {
  return {
    async get(key) {
      const object = await bucket.get(key);
      if (object === null) return undefined;
      const etag = object.customMetadata?.etag;
      const expiresAt = Number(object.customMetadata?.expiresAt);
      if (etag === undefined || !Number.isFinite(expiresAt)) return undefined;
      return { body: await object.text(), etag, expiresAt };
    },
    async put(key, blob: MetaBlob) {
      await bucket.put(key, blob.body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { etag: blob.etag, expiresAt: String(blob.expiresAt) },
      });
    },
  };
}

/**
 * Rangées d'accueil communes dans le même bucket (clés rows/<identifiant>.json, voir src/lt/rows.ts). Le corps est la
 * réponse `{ metas }` telle que servie ; l'empreinte (etag) et la date de génération (ms epoch) sont les métadonnées.
 */
export function createR2RowBlobs(bucket: R2Bucket): RowBlobStore {
  return {
    async get(key) {
      const object = await bucket.get(key);
      if (object === null) return undefined;
      const etag = object.customMetadata?.etag;
      const generatedAt = Number(object.customMetadata?.generatedAt);
      if (etag === undefined || !Number.isFinite(generatedAt)) return undefined;
      return { body: await object.text(), etag, generatedAt };
    },
    async put(key, blob: RowBlob) {
      await bucket.put(key, blob.body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { etag: blob.etag, generatedAt: String(blob.generatedAt) },
      });
    },
  };
}
