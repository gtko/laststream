import { deletePresence, putPresence, type Status, type Watching } from '../data/socialV2Api';
import { getState, subscribe } from '../data/socialStore';

/* Présence v2 (contrat social-v2 : PUT / DELETE `/user/social/presence`). C'est le seul émetteur de présence de
 * l'application : pendant la lecture il envoie le titre regardé (position, pause), et hors lecture le battement reste
 * actif avec `watching: null` (TTL 90 s côté serveur, battement ≤ 30 s). Un profil enfant n'envoie jamais rien ; le
 * statut « invisible » non plus. Erreurs silencieuses : la lecture n'en dépend pas.
 * Partie pure : construction du relevé, politique d'émission, détection d'un saut. Le contrôleur en bas branche
 * ces fonctions sur le réseau et l'horloge. */

/** Battement : au plus toutes les 25 s (le contrat exige ≤ 30 s). */
export const HEARTBEAT_MS = 25_000;
/** Contrôle des échéances hors lecteur (sans relevé de lecture). */
export const CHECK_MS = 5_000;
/** Délai minimal entre deux envois provoqués par la lecture (pause, reprise, saut) : les rafales sont fusionnées. */
export const DEBOUNCE_MS = 1_000;
/** Écart toléré entre la position attendue et la position relevée : au-delà, c'est un saut (seek). */
const JUMP_S = 2;

/** Média lu, tel que la présence le décrit (film, ou série avec saison et épisode). */
export interface MediaInfo {
  type: 'movie' | 'series'; tmdbId: number; imdbId?: string; title: string;
  season?: number; episode?: number; poster?: string;
}
/** Relevé du lecteur, en secondes ; `rate` (vitesse) vaut 1 par défaut. */
export interface Playback { time: number; duration?: number; paused: boolean; rate?: number }
/** Relevé précédent du lecteur, pour repérer un saut entre deux relevés. */
export interface Tick { time: number; at: number; paused: boolean }
/** Dernier envoi : clé du média, pause, instant (ms). */
export interface Mark { key: string; paused: boolean; at: number }
export type Reason = 'media' | 'state' | 'heartbeat';
/** Émetteur réseau (remplaçable en tests). */
export interface Sender {
  put(w: Watching | null): Promise<unknown>;
  del(): Promise<unknown>;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Clé d'un média : deux relevés de même clé concernent le même film ou le même épisode. */
export function mediaKey(m: MediaInfo | null): string {
  return m ? [m.type, m.tmdbId, m.season ?? '', m.episode ?? ''].join(':') : '';
}

/** Corps `watching` d'un relevé : position au dixième de seconde, durée seulement si connue, saison et épisode pour une série. */
export function buildWatching(m: MediaInfo, pb: Playback, now: number): Watching {
  const w: Watching = {
    type: m.type, tmdbId: m.tmdbId, title: m.title,
    pos: finite(pb.time) && pb.time > 0 ? Math.round(pb.time * 10) / 10 : 0,
    paused: pb.paused, at: now,
  };
  if (m.imdbId) w.imdbId = m.imdbId;
  if (m.poster) w.poster = m.poster;
  if (m.type === 'series') {
    if (m.season != null) w.season = m.season;
    if (m.episode != null) w.episode = m.episode;
  }
  if (finite(pb.duration) && pb.duration > 0) w.duration = Math.round(pb.duration * 10) / 10;
  return w;
}

/** Saut de lecture : la position n'a pas avancé comme le temps écoulé au débit annoncé (une pause ne compte pas). */
export function isJump(prev: Tick, time: number, now: number, rate: number): boolean {
  const moved = prev.paused ? 0 : ((now - prev.at) / 1000) * rate;
  return Math.abs(time - (prev.time + moved)) > JUMP_S;
}

/**
 * Politique d'émission. Changement de média : immédiat. Pause, reprise ou saut : après le délai minimal depuis le dernier
 * envoi. Sinon le battement, une fois échu. `null` : rien à envoyer.
 */
export function reasonFor(last: Mark | null, cur: { key: string; paused: boolean; pending: boolean; now: number }): Reason | null {
  if (!last || last.key !== cur.key) return 'media';
  if ((cur.paused !== last.paused || cur.pending) && cur.now - last.at >= DEBOUNCE_MS) return 'state';
  if (cur.now - last.at >= HEARTBEAT_MS) return 'heartbeat';
  return null;
}

// ---- Contrôleur ----

const defaultSender: Sender = { put: (w) => putPresence(w), del: () => deletePresence() };
let sender: Sender = defaultSender;
const storeStatus = (): Status => getState().status;
let statusOf: () => Status = storeStatus;

/** Remplace l'émetteur réseau (tests) ; `null` le rétablit. */
export function setPresenceSender(s: Sender | null): void {
  sender = s ?? defaultSender;
}

/** Remplace la lecture du statut (tests) ; `null` le rétablit (statut du store). */
export function setPresenceStatusSource(fn: (() => Status) | null): void {
  statusOf = fn ?? storeStatus;
}

let active = false;
let kid = false;
let timer: ReturnType<typeof setInterval> | undefined;
let media: MediaInfo | null = null;
let playback: Playback | null = null;
let tick: Tick | null = null;
let last: Mark | null = null;
let pending = false;
let unsubStatus: (() => void) | null = null;
let wasInvisible = false;

/** Appel réseau sans attente ni erreur visible. */
function fire(call: () => Promise<unknown>): void {
  try {
    Promise.resolve(call()).catch(() => undefined);
  } catch { /* ignoré : la présence ne doit jamais casser la lecture */ }
}

/** Applique la politique et envoie si besoin. Rien en invisible, rien pour un profil enfant. */
function flush(now: number): void {
  if (!active || kid) return;
  if (media && !playback) return; // le média attend son premier relevé de lecture
  if (statusOf() === 'invisible') return;
  const key = mediaKey(media);
  const paused = media && playback ? playback.paused : false;
  const reason = reasonFor(last, { key, paused, pending, now });
  if (!reason) return;
  last = { key, paused, at: now };
  pending = false;
  const body = media && playback ? buildWatching(media, playback, now) : null;
  fire(() => sender.put(body));
}

function onHide(): void {
  if (active && !kid && statusOf() !== 'invisible') fire(() => sender.del());
}

/** Abonnement au statut du store : la bascule vers « invisible » retire la présence tout de suite (DELETE), sans attendre. */
function onStatusChange(): void {
  const invisible = statusOf() === 'invisible';
  if (invisible && !wasInvisible && active && !kid) fire(() => sender.del());
  wasInvisible = invisible;
}

/** Démarre la présence pour le profil actif (remplace la précédente). Profil enfant : rien. */
export function startPresenceV2(isKid: boolean): void {
  stopPresenceV2(false);
  active = true;
  kid = isKid;
  if (kid) return;
  flush(Date.now());
  timer = setInterval(() => flush(Date.now()), CHECK_MS);
  wasInvisible = statusOf() === 'invisible';
  unsubStatus = subscribe(onStatusChange);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
}

/** Arrête la présence ; `offline` prévient le serveur (hors ligne tout de suite). */
export function stopPresenceV2(offline = true): void {
  const was = active && !kid;
  clearInterval(timer);
  timer = undefined;
  unsubStatus?.();
  unsubStatus = null;
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
  if (offline && was && statusOf() !== 'invisible') fire(() => sender.del());
  active = false;
  kid = false;
  media = null;
  playback = null;
  tick = null;
  last = null;
  pending = false;
}

/**
 * Média lu (`null` à la fermeture). Sans relevé, l'envoi attend le prochain relevé de la lecture ; `null` part tout de suite.
 */
export function setPresenceMedia(m: MediaInfo | null): void {
  media = active && !kid ? m : null;
  playback = null;
  tick = null;
  pending = false;
  if (!media) flush(Date.now());
}

/** Relevé de la boucle de lecture : repère les sauts puis applique la politique d'émission. */
export function presenceTick(p: Playback): void {
  if (!active || kid) return;
  const now = Date.now();
  const time = finite(p.time) ? p.time : 0;
  const rate = finite(p.rate) && p.rate > 0 ? p.rate : 1;
  if (media) {
    if (tick && isJump(tick, time, now, rate)) pending = true;
    tick = { time, at: now, paused: !!p.paused };
    playback = { time, duration: p.duration, paused: !!p.paused, rate };
  }
  flush(now);
}
