import { TorrentCache } from '../torrent/fetch-torrent.js';
import { HostHealth } from './hosts.js';
import { PackStore } from './packs.js';

/**
 * État partagé de /play, par processus : fichiers des packs déjà vus, hébergeurs signalés en panne, et octets
 * des .torrent privés (par guid). Les routes prennent cet état en paramètre (défaut : ces singletons), ce qui
 * permet de l'isoler dans les tests.
 */
export interface PlayState {
  packStore: PackStore;
  hostHealth: HostHealth;
  /** Cache des .torrent lus à l'affichage ; seuls les octets d'un torrent privé y sont gardés. */
  torrentCache: TorrentCache;
}

export const packStore = new PackStore();
export const hostHealth = new HostHealth();
/** Cache partagé des .torrent (TTL 6 h). Rempli à l'affichage des flux, relu par /play pour les torrents privés. */
export const torrentCache = new TorrentCache();

export const defaultPlayState: PlayState = { packStore, hostHealth, torrentCache };
