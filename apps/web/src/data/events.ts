/*
 * Bus d'événements de données : progression, « Reprendre la lecture », bibliothèque, « vu », synchro distante, lecteur.
 * Les stockages (userStore, serverUserStore) et le lecteur émettent après chaque changement ; l'accueil s'y abonne pour
 * redessiner ses rangées sans rechargement. Aucune dépendance DOM : utilisable dans les tests et pendant le chargement.
 */

export type DataKind =
  /** Progression écrite (lecteur, mini-lecteur, menu « Recommencer »). */
  | 'progress'
  /** « Reprendre la lecture » masqué ou rétabli. */
  | 'continue'
  /** Ajout ou retrait de « Ma bibliothèque ». */
  | 'library'
  /** Marqué vu ou non vu (film ou épisodes). */
  | 'watched'
  /** Profil actif changé. */
  | 'profile'
  /** Données relues depuis le serveur (autre appareil ou profil du même compte). */
  | 'remote'
  /** Lecteur ou mini-lecteur fermé : l'accueil peut se mettre à jour. */
  | 'player';

export interface DataEvent {
  kind: DataKind;
  /** Clé de titre concernée (`movie:550`, `tv:1399`), si l'événement porte sur un titre. */
  key?: string;
}

type Listener = (e: DataEvent) => void;
const listeners = new Set<Listener>();

/** Abonnement aux événements de données ; renvoie la fonction de désabonnement. */
export function onDataEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Émet un événement vers tous les abonnés. Une erreur d'abonné n'empêche ni les autres ni l'écriture qui l'a émis. */
export function emitDataEvent(e: DataEvent): void {
  listeners.forEach((fn) => {
    try {
      fn(e);
    } catch (err) {
      console.error('[laststream] abonné aux données :', err);
    }
  });
}
