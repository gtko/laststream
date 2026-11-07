/* Résolution du lien d'un téléchargement d'après le flux choisi (ODY-204).
 *
 * Deux sortes de sources :
 *  - `copies` non vide (torrent sans lien, débridé sur l'appareil) : `debridLinkResolver` (inchangé, ODY-198) ;
 *  - `ref` seul (lien HTTP d'un addon) : les sources du titre sont rechargées, et le flux qui correspond à `ref.match` donne
 *    le lien. Ce lien vit en mémoire seulement : il n'est jamais écrit dans l'index, ni dans une erreur.
 *
 * Aucune URL n'entre dans `DownloadSource` : `streamToSource` ne copie que le titre et les indices du flux. */
import { debrid, type DebridManager } from '../sources/debridClient';
import { clientCopiesOf, type SourceView } from '../sources/info';
import { refreshSources, type SourceRequest } from '../sources/load';
import { isAddonLinkUrl, isNativeLinkUrl } from './linkHosts';
import { debridLinkResolver } from './resolver';
import { DownloadError, type DownloadRef, type DownloadSource, type LinkResolver, type ResolvedFile } from './types';

/** Titre visé par un téléchargement (même forme que `DownloadTarget` de service.ts). */
export interface ResolveTarget {
  key: string;
  type: 'movie' | 'tv';
  id: string;
  name: string;
  season?: number;
  episode?: number;
}

export interface StreamResolverDeps {
  /** Gestionnaire de débrideurs (tests : faux). */
  debrid?: () => Pick<DebridManager, 'resolve'>;
  /** Rechargement des sources d'un titre (tests : faux). */
  refresh?: (req: SourceRequest) => Promise<{ views: readonly SourceView[] }>;
  /** Hôtes acceptés pour un lien (défaut : hôtes publics https, comme le transport web). */
  linkPolicy?: LinkPolicy;
}

/** Vrai si le lien peut être téléchargé par la plateforme (hôte, schéma). */
export type LinkPolicy = (url: URL) => boolean;

/** Transfert natif (Android, coque avec transfert) : https public sur le port par défaut, comme le web (ODY-232). */
export const nativeLinkPolicy: LinkPolicy = isNativeLinkUrl;

/** Tolérance sur la taille (1 % ou un octet) : une même vidéo peut être annoncée à quelques octets près. */
const sizeClose = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1, b * 0.01);

/** Flux HLS (.m3u8) : une playlist, pas un fichier : impossible à enregistrer tel quel. */
export const isHlsUrl = (url: string): boolean => /\.m3u8(?:[?#]|$)/i.test(url);

/** Lien d'un flux utilisable : URL analysable, acceptée par la politique, et pas une playlist HLS. */
function usableLink(url: string | undefined, policy: LinkPolicy): boolean {
  if (typeof url !== 'string' || isHlsUrl(url)) return false;
  try {
    return policy(new URL(url));
  } catch {
    return false;
  }
}

/**
 * Source téléchargeable : lien direct accepté par la politique, ou torrent sans lien débridé sur l'appareil.
 * Sans débrideur configuré (`debrid().hasAny()` faux, aujourd'hui), un torrent sans lien n'est pas téléchargeable.
 */
export function isDownloadable(v: SourceView, policy: LinkPolicy = isAddonLinkUrl): boolean {
  if (v.client) return debrid().hasAny() && clientCopiesOf(v.stream).copies.length > 0;
  return usableLink(v.stream.url, policy);
}

/** Langues de la source, sous forme de codes de langue (`fr`, `multi`…). */
export const langsOfView = (v: SourceView): string[] => (v.info ? [...v.info.languages] : []);

/** Source téléchargeable sans URL : titre, indices du flux et copies (torrent sans lien) quand il y en a. */
export function streamToSource(view: SourceView, t: ResolveTarget): DownloadSource {
  const copies = view.client ? clientCopiesOf(view.stream).copies : [];
  const addon = view.origins[0]?.name;
  const match: DownloadRef['match'] = {
    ...(view.stream.infoHash ? { infoHash: view.stream.infoHash.toLowerCase() } : {}),
    ...(typeof view.stream.fileIdx === 'number' ? { fileIdx: view.stream.fileIdx } : {}),
    ...(view.filename ? { filename: view.filename } : {}),
    ...(view.sizeBytes > 0 ? { size: view.sizeBytes } : {}),
    ...(addon ? { addon } : {}),
  };
  const ref: DownloadRef = {
    type: t.type,
    id: t.id,
    name: t.name,
    key: t.key,
    ...(t.season !== undefined ? { season: t.season } : {}),
    ...(t.episode !== undefined ? { episode: t.episode } : {}),
    match,
  };
  return {
    copies,
    ref,
    ...(t.season !== undefined || t.episode !== undefined ? { episode: { season: t.season, episode: t.episode } } : {}),
  };
}

/**
 * Flux qui correspond à `m` parmi `views`, par ordre de confiance : infoHash (+ fichier), puis nom de fichier + taille,
 * puis addon + taille. Les comparaisons ignorent la casse ; une taille manquante ne départage rien.
 */
export function findMatch(views: readonly SourceView[], m: DownloadRef['match']): SourceView | undefined {
  const sized = (v: SourceView): boolean => m.size === undefined || v.sizeBytes <= 0 || sizeClose(v.sizeBytes, m.size);
  if (m.infoHash) {
    const hit = views.find((v) => (v.stream.infoHash ?? '').toLowerCase() === m.infoHash
      && (m.fileIdx === undefined || v.stream.fileIdx === undefined || v.stream.fileIdx === m.fileIdx));
    if (hit) return hit;
  }
  if (m.filename) {
    const name = m.filename.toLowerCase();
    const hit = views.find((v) => v.filename.toLowerCase() === name && sized(v));
    if (hit) return hit;
  }
  // Un addon seul ne désigne pas un fichier (il en sert plusieurs) : ce repli exige la taille.
  if (m.addon && m.size !== undefined) {
    const addon = m.addon.toLowerCase();
    const hit = views.find((v) => (v.origins[0]?.name ?? '').toLowerCase() === addon && sized(v));
    if (hit) return hit;
  }
  return undefined;
}

const requestOf = (ref: DownloadRef): SourceRequest => ({
  type: ref.type,
  id: ref.id,
  name: ref.name,
  key: ref.key,
  season: ref.season ?? null,
  episode: ref.episode ?? null,
});

/** Résolveur composite : copies → débrideur de l'appareil ; sinon `ref` → sources rechargées et flux retrouvé. */
export function createStreamResolver(deps: StreamResolverDeps = {}): LinkResolver {
  const debridOf = deps.debrid ?? (() => debrid());
  const refresh = deps.refresh ?? refreshSources;
  const policy = deps.linkPolicy ?? isAddonLinkUrl;
  return {
    async resolve(src: DownloadSource, signal: AbortSignal): Promise<ResolvedFile> {
      if (src.copies.length > 0) return debridLinkResolver(debridOf()).resolve(src, signal);
      if (!src.ref) throw new DownloadError('content', false);
      let loaded: { views: readonly SourceView[] };
      try {
        loaded = await refresh(requestOf(src.ref));
      } catch (err) {
        // Le message de l'erreur d'origine n'est pas repris : seule la nature (réseau) compte pour le gestionnaire.
        throw new DownloadError('network', true, err);
      }
      if (signal.aborted) throw new DownloadError('cancelled', false);
      // Seuls les liens acceptés par la politique sont candidats : jamais une playlist HLS, jamais un torrent sans lien.
      const view = findMatch(loaded.views.filter((v) => !v.client && usableLink(v.stream.url, policy)), src.ref.match);
      const url = view?.stream.url;
      if (!view || typeof url !== 'string') throw new DownloadError('content', false);
      return {
        url,
        ...(view.sizeBytes > 0 ? { size: view.sizeBytes } : {}),
        ...(view.filename ? { filename: view.filename } : {}),
      };
    },
  };
}
