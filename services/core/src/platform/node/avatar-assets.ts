import { parsePublicUrl } from '../../config/runtime-env.js';
import type { AvatarAssets, HttpClient, RuntimeEnv } from '../types.js';
import { createFsUiAssets } from './ui-assets.js';

/** En-têtes conservés d'une réponse relayée : validation (ETag, date) et type du contenu. */
const RELAYED_HEADERS = ['etag', 'last-modified', 'content-type'] as const;

function relayedHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * Fichiers des avatars sous Node : dossier LASTADDON_AVATARS_DIR s'il est défini (lu à chaque requête), sinon relais
 * vers `${LASTADDON_PUBLIC_URL}/avatars/<clé>` (le Worker public). Sans l'un ni l'autre : null (404).
 */
export function createNodeAvatarAssets(env: RuntimeEnv, http: Pick<HttpClient, 'fetch'>): AvatarAssets {
  return {
    async serve(request, key) {
      const dir = env.get('LASTADDON_AVATARS_DIR')?.trim();
      if (dir) return createFsUiAssets(dir).serve(request, `/${key}`);
      const publicUrl = env.get('LASTADDON_PUBLIC_URL')?.trim();
      if (!publicUrl) return null;
      const headers: Record<string, string> = {};
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatch !== null) headers['if-none-match'] = ifNoneMatch;
      let upstream: Response;
      try {
        upstream = await http.fetch(`${parsePublicUrl(publicUrl)}/avatars/${key}`, { headers });
      } catch {
        return null;
      }
      if (upstream.status === 304) return new Response(null, { status: 304, headers: relayedHeaders(upstream) });
      if (upstream.status !== 200) {
        await upstream.body?.cancel();
        return null;
      }
      return new Response(upstream.body, { status: 200, headers: relayedHeaders(upstream) });
    },
  };
}
