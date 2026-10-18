import { deletePresence, putPresence, type PresenceBody } from './socialApi';
import type { MediaKind } from './userApi';

/* Présence : battement de cœur léger (PUT /user/presence toutes les 45 s) tant que l'application est ouverte, avec le titre
 * regardé quand le lecteur est ouvert. Un profil enfant n'annonce jamais de titre (le serveur l'ignore aussi). */

export const PRESENCE_EVERY_MS = 45_000;
const INVISIBLE_KEY = 'laststream.presence.invisible';

export interface WatchingNow {
  type: MediaKind;
  tmdbId: number;
  title: string;
  season?: number;
  episode?: number;
}

interface Sender {
  put(body: PresenceBody): Promise<unknown>;
  del(): Promise<unknown>;
}

let sender: Sender = { put: putPresence, del: deletePresence };
/** Remplace l'envoi réseau (tests). */
export function setPresenceSender(s: Sender | null): void {
  sender = s ?? { put: putPresence, del: deletePresence };
}

let timer: ReturnType<typeof setInterval> | undefined;
let profileId = '';
let kid = false;
let watching: WatchingNow | null = null;

export function isInvisible(): boolean {
  try {
    return globalThis.localStorage?.getItem(INVISIBLE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setInvisible(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(INVISIBLE_KEY, on ? '1' : '0');
  } catch { /* préférence non conservée */ }
  beat();
}

/** Corps du battement : pas de titre pour un profil enfant. */
export function presenceBody(): PresenceBody {
  const w = !kid && watching ? { type: watching.type, tmdbId: watching.tmdbId, title: watching.title, ...(watching.season != null ? { season: watching.season } : {}), ...(watching.episode != null ? { episode: watching.episode } : {}) } : null;
  return { profileId, watching: w, invisible: isInvisible() };
}

function beat(): void {
  if (!profileId) return;
  sender.put(presenceBody()).catch(() => undefined);
}

function onHide(): void {
  if (profileId) sender.del().catch(() => undefined);
}

/** Démarre les battements pour le profil actif (remplace les précédents). */
export function startPresence(id: string, isKid: boolean): void {
  stopPresence(false);
  profileId = id;
  kid = isKid;
  watching = null;
  beat();
  timer = setInterval(beat, PRESENCE_EVERY_MS);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
}

/** Arrête les battements ; `offline` : prévient le serveur (hors ligne tout de suite). */
export function stopPresence(offline = true): void {
  clearInterval(timer);
  timer = undefined;
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
  if (offline && profileId) sender.del().catch(() => undefined);
  profileId = '';
  watching = null;
}

/** Titre en cours de lecture (null : simplement en ligne). Envoyé tout de suite. */
export function setWatching(w: WatchingNow | null): void {
  const same = watching === w || (watching && w && watching.type === w.type && watching.tmdbId === w.tmdbId && watching.season === w.season && watching.episode === w.episode);
  watching = w;
  if (!same) beat();
}
