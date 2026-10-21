/* Re-résolution du lien d'un téléchargement, côté appareil (ODY-198). Seul module du socle qui connaît le gestionnaire de débrideurs :
 * il n'en importe que le type. Les `DebridError` remontent telles quelles : le gestionnaire décide quoi en faire d'après leur `kind`. */
import type { DebridManager } from '../sources/debridClient';
import type { DownloadSource, LinkResolver, ResolvedFile } from './types';

export function debridLinkResolver(dm: Pick<DebridManager, 'resolve'>): LinkResolver {
  return {
    async resolve(src: DownloadSource, signal: AbortSignal): Promise<ResolvedFile> {
      // Hors ligne : pas de lecture du lien partagé du compte, et aucune publication vers le serveur.
      const link = await dm.resolve(src.copies, src.episode ?? {}, signal, { skipShared: true, skipPublish: true });
      return { url: link.url, size: link.size, filename: link.filename };
    },
  };
}
