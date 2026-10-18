import { platform, sharedKvCache } from '../platform/index.js';
import { TorrentCache } from '../torrent/fetch-torrent.js';
import { HostHealth } from './hosts.js';
import { PackStore } from './packs.js';

/**
 * État partagé de /play, par processus : fichiers des packs déjà vus, hébergeurs signalés en panne, et octets
 * des .torrent privés (par guid). Les routes prennent cet état en paramètre (défaut : `defaultPlayState()`), ce qui
 * permet de l'isoler dans les tests. Sous Workers (`capabilities.sharedState`), chaque élément a un second niveau dans
 * le KV partagé : /stream et /play peuvent être servis par des instances différentes.
 */
export interface PlayState {
  packStore: PackStore;
  hostHealth: HostHealth;
  /** Cache des .torrent lus à l'affichage ; seuls les octets d'un torrent privé y sont gardés. */
  torrentCache: TorrentCache;
}

let shared: PlayState | undefined;

/**
 * État du processus, créé au premier appel (la plateforme doit être installée). `torrentCache` : cache des .torrent
 * (TTL 6 h), rempli à l'affichage des flux et relu par /play pour les torrents privés.
 */
export function defaultPlayState(): PlayState {
  shared ??= {
    packStore: new PackStore({ kv: sharedKvCache('packs'), background: (work) => platform().scheduler.background(work) }),
    hostHealth: new HostHealth({ kv: sharedKvCache('hosts'), background: (work) => platform().scheduler.background(work) }),
    torrentCache: new TorrentCache({ kv: sharedKvCache('torrents') }),
  };
  return shared;
}
