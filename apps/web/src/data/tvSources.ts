/* TV en direct : état des playlists de l'utilisateur sur cet appareil, actualisation (1 fois par jour au plus) et synchronisation
 * de leurs DÉFINITIONS (nom, adresse, guide, activée) avec le compte. Le serveur garde ces définitions chiffrées et ne télécharge jamais
 * une playlist ni un flux : c'est toujours l'appareil qui lit la playlist et le guide (un fournisseur qui verrait des IP de serveur
 * pourrait bloquer le compte). Rien n'est journalisé. */

import {
  activeChannels, BoxError, fetchBytes, getBoxReach, loadLists, mergeRemote, newListId, refreshDue, refreshList, saveLists, setBoxReach, toWire,
  type BoxList, type BoxListWire, type BoxTransport,
} from './tvBox';
import { guideFromBytes, saveGuide, type GuideData } from './tvXmltv';

export const BOX_CHANGED = 'ls:box-changed';

let lists: BoxList[] | null = null;
let pusher: ((wire: BoxListWire[]) => void) | null = null;

export const setTvSourcesPusher = (fn: ((wire: BoxListWire[]) => void) | null): void => { pusher = fn; };

export function getLists(): BoxList[] {
  if (!lists) lists = loadLists();
  return lists;
}

const notify = (): void => {
  try { globalThis.dispatchEvent?.(new Event(BOX_CHANGED)); } catch { /* hors navigateur */ }
};

/** Remplace les playlists (stockage local, évènement, et envoi au compte si `push`). */
export function setLists(next: BoxList[], push = true): void {
  lists = next;
  saveLists(next);
  if (push && pusher) pusher(toWire(next));
  notify();
}

export function updateList(id: string, patch: Partial<BoxList>): void {
  const cur = getLists();
  setLists(cur.map((l) => (l.id === id ? { ...l, ...patch } : l)), true);
}

export function removeList(id: string): void {
  setLists(getLists().filter((l) => l.id !== id), true);
}

export function addList(l: Omit<BoxList, 'id' | 'at'> & { id?: string; at?: number }): BoxList {
  const full: BoxList = { ...l, id: l.id ?? newListId(), at: l.at ?? Date.now() };
  setLists(getLists().filter((x) => x.id !== full.id).concat(full), true);
  return full;
}

/** Chaînes des playlists actives. */
export const activeBoxChannels = () => activeChannels(getLists());

/**
 * À la connexion ou au changement de profil : les playlists du compte font foi pour les listes synchronisées.
 * Renvoie 'pulled' si les listes locales ont été remplacées, 'push' si le compte n'en a pas mais que cet appareil en a
 * (à envoyer par le profil principal), sinon 'none'.
 */
export function reconcileTvSources(remote: readonly BoxListWire[] | null): 'pulled' | 'push' | 'none' {
  const local = getLists();
  const localWire = toWire(local);
  if (!remote || !remote.length) return localWire.length ? 'push' : 'none';
  const same = JSON.stringify(remote) === JSON.stringify(localWire);
  if (same) return 'none';
  setLists(mergeRemote(local, remote), false);
  return 'pulled';
}

/** Envoie les playlists synchronisées de cet appareil au compte (sans effet si le pousseur n'est pas branché ou refuse). */
export function pushTvSources(): void {
  if (pusher) pusher(toWire(getLists()));
}

/** Quitter le compte : les listes synchronisées (et leur guide) quittent l'appareil ; les listes propres à l'appareil restent. */
export function dropSyncedLists(): void {
  lists = getLists().filter((l) => !l.synced);
  saveLists(lists);
  saveGuide(null);
  notify();
}

// ---------- Actualisation ----------

let refreshing: Promise<void> | null = null;
const reachKey = (ls: readonly BoxList[]): string => ls.map((l) => `${l.id}:${getBoxReach(l.id)}`).join('|');

/** Guide XMLTV des playlists actives qui en déclarent un : lu en flux sur l'appareil, gardé de maintenant à +24 h. */
export async function refreshGuides(cur: readonly BoxList[], tr?: BoxTransport): Promise<void> {
  const withGuide = cur.filter((l) => l.enabled && l.guideUrl);
  if (!withGuide.length) { saveGuide(null); return; }
  const merged: GuideData = { at: Date.now(), progs: {} };
  for (const l of withGuide) {
    try {
      const bytes = await fetchBytes(l.guideUrl, tr);
      const g = await guideFromBytes(bytes, l.channels.map((c) => ({ id: c.id, name: c.name, tvgId: c.tvgId })));
      Object.assign(merged.progs, g.progs);
    } catch (err) {
      if (!(err instanceof BoxError) && !(err instanceof Error)) throw err;
    }
  }
  saveGuide(merged);
}

/**
 * Au lancement : relit les playlists actives dont la dernière lecture date de plus d'un jour (`force` : toutes) et la Freebox
 * (qui sert aussi de test de joignabilité), puis le guide si une playlist a changé ou si `force`. Les erreurs sont avalées.
 */
export function refreshAll(force = false, tr?: BoxTransport): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cur = getLists();
    const reachBefore = reachKey(cur);
    let changed = false;
    let guideDue = false;
    const next: BoxList[] = [];
    for (const l of cur) {
      const probe = l.kind === 'freebox' && l.enabled;
      const due = force || refreshDue(l);
      if (due || probe) {
        const upd = await refreshList(l, tr);
        const content = upd !== l && JSON.stringify(upd.channels) !== JSON.stringify(l.channels);
        // Simple test de la box (pas encore l'heure de l'actualisation) : on ne touche ni à la date ni au guide si rien n'a changé.
        if (upd !== l && (due || content)) { changed = true; next.push(content || due ? upd : l); } else next.push(l);
        if (upd !== l && due) guideDue = true;
        if (content) guideDue = true;
      } else {
        if (l.kind === 'file') setBoxReach(l.id, true);
        next.push(l);
      }
    }
    const reachNow = reachKey(next);
    if (changed) setLists(next, false);
    else if (reachNow !== reachBefore) notify();
    if (guideDue || force) {
      await refreshGuides(next, tr);
      notify();
    }
  })().catch(() => undefined).finally(() => { refreshing = null; });
  return refreshing;
}
