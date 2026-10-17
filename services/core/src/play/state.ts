import { HostHealth } from './hosts.js';
import { PackStore } from './packs.js';

/**
 * État partagé de /play, par processus : fichiers des packs déjà vus et hébergeurs signalés en panne.
 * Les routes prennent cet état en paramètre (défaut : ces singletons), ce qui permet de l'isoler dans les tests.
 */
export interface PlayState {
  packStore: PackStore;
  hostHealth: HostHealth;
}

export const packStore = new PackStore();
export const hostHealth = new HostHealth();

export const defaultPlayState: PlayState = { packStore, hostHealth };
