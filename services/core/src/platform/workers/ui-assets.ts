import type { UiAssets } from '../types.js';
import type { AssetsFetcher } from './env.js';

/**
 * Interface web servie par Workers Assets (binding `ASSETS`, dossier du build de l'interface). La configuration
 * `html_handling: "none"` garde les chemins exacts (pas de redirection de /index.html). Un fichier absent donne null.
 */
export function createWorkersUiAssets(assets: AssetsFetcher): UiAssets {
  return {
    async serve(request, pathname) {
      const url = new URL(request.url);
      url.pathname = pathname;
      url.search = '';
      const response = await assets.fetch(new Request(url, { method: request.method, headers: request.headers }));
      if (response.status === 404) return null;
      return response;
    },
  };
}
