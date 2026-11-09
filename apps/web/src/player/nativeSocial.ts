import type { Message, Note, Status } from '../data/socialV2Api';
import type { SocialState } from '../data/socialStore';
import { CHAT_MAX_CHARS } from '../party/protocol';
import type { PartyWait } from '../party/client';
import type { NativeMessage, NativeNote, NativeRoom, NativeSocial, NativeViewer } from './native';
import { RECENT_MS, REPLY_EMOJIS, SEND_FAILED, SEND_LIMIT, knownMessages, senderOf, shouldShowBubble, truncateText } from './messageBubble';
import { QUICK_EMOJIS } from './notesTimeline';
import { FAN_COUNT, MORE_EMOJIS } from './notesView';
import { friendsWatching, initialOf, type WatchMedia } from './playbackSocial';

/* Pont social du lecteur natif Android (LAST-1612) : fonctions pures, sans réseau ni DOM. Le natif n'affiche que ; les
 * réactions passent par postReact (sessionSocial) et les réponses par socialStore.sendMessage, comme sur le web. Tout ce
 * qui vient du natif est une entrée non fiable : validée ici avant usage. */

/** Rangée rapide du natif : les premiers emojis rapides, ceux de l'éventail tactile. */
export const NATIVE_QUICK: readonly string[] = QUICK_EMOJIS.slice(0, FAN_COUNT);
/** Emojis derrière le « + » : ceux de la maquette, puis les rapides au-delà de la rangée. */
export const NATIVE_MORE: readonly string[] = [...MORE_EMOJIS, ...QUICK_EMOJIS.slice(FAN_COUNT)];
const ALLOWED_REACTIONS: ReadonlySet<string> = new Set([...NATIVE_QUICK, ...NATIVE_MORE]);

function viewerOf(id: string, name: string): NativeViewer {
  return { id, name, initial: initialOf(name) };
}

/** Note du store au format du natif. `meId` (profil connecté) marque les notes qui sont à moi. */
function toNativeNote(n: Note, meId: string | null | undefined): NativeNote {
  return {
    id: n.id,
    pos: n.pos,
    kind: n.kind,
    body: n.body,
    by: viewerOf(n.author.pid, n.author.handle.name),
    mine: !!meId && n.author.pid === meId,
  };
}

/** Liste complète des marqueurs au format du natif (le regroupement des voisins se fait côté natif). */
export function toNativeNotes(list: readonly Note[], meId: string | null | undefined): NativeNote[] {
  return list.map((n) => toNativeNote(n, meId));
}

/** Spectateurs du titre : amis et foyer qui le regardent (même règle que la puce « Un ami regarde aussi »). */
export function watchingViewers(s: SocialState, media: WatchMedia | null, now: number, duration: number, room: readonly { username: string }[] | null = null): NativeViewer[] {
  return friendsWatching(s, media, now, duration, room).map((f) => viewerOf(f.pid, f.name));
}

/** Spectateurs en salon (LAST-1627) : les membres du salon, sauf moi (`me` : mon nom dans le salon, null si inconnu). */
export function roomViewers(members: readonly { username: string }[], me: string | null): NativeViewer[] {
  return members.filter((m) => m.username !== me).map((m) => viewerOf(m.username, m.username));
}

/** Ce qui décide si le social apparaît côté natif. */
export interface NativeSocialGate {
  /** Social disponible pour ce titre : session serveur, titre avec identifiant TMDB. */
  available: boolean;
  /** Profil enfant. */
  kid: boolean;
  status: Status;
  /** Mode cinéma actif à cet instant. */
  cinema: boolean;
  /** Salon actif (LAST-1627) : la rangée et les réactions vont au salon, sans dépendre du social « amis ». */
  room?: boolean;
}

/** Écart (s) à partir duquel le lecteur est « en rattrapage » : même seuil que « Resynchronisation… » du salon web (syncText). */
export const CATCHUP_DRIFT_S = 1.5;

/** Ce que le natif doit savoir du client de salon. */
export interface NativeRoomSource {
  participants: readonly unknown[];
  isHost: boolean;
  waiting: PartyWait | null;
}

/**
 * Salon au format du natif (LAST-1632) : membres (moi compris, au moins 1), hôte ou invité, et synchro. L'attente du tampon d'un
 * membre l'emporte sur l'écart ; l'écart (`drift`, signé, null avant la première mesure) ne compte qu'à partir de CATCHUP_DRIFT_S.
 */
export function nativeRoomOf(c: NativeRoomSource, drift: number | null): NativeRoom {
  const waiting = !!c.waiting && c.waiting.who.length > 0;
  const catching = drift !== null && Number.isFinite(drift) && Math.abs(drift) >= CATCHUP_DRIFT_S;
  return { members: Math.max(1, c.participants.length), host: c.isHost, sync: waiting ? 'waiting' : catching ? 'catching' : 'synced' };
}

/**
 * Charge utile de `setSocial`. `enabled` faux : aucun spectateur ni salon n'est envoyé. `room` : état du salon, transmis
 * seulement en salon (`gate.room`).
 */
export function nativeSocialOf(gate: NativeSocialGate, viewers: readonly NativeViewer[], room: NativeRoom | null = null): NativeSocial {
  const social = gate.available && !gate.kid && gate.status !== 'invisible' && !gate.cinema;
  // En salon, la rangée reste active même sans social « amis » (indisponible, invisible, cinéma) ; le profil enfant reste exclu.
  const enabled = gate.room ? !gate.kid : social;
  return {
    enabled,
    quick: [...NATIVE_QUICK],
    more: [...NATIVE_MORE],
    viewers: enabled ? viewers.map((v) => ({ ...v })) : [],
    room: enabled && gate.room && room ? { ...room } : null,
  };
}

/**
 * Messages reçus à pousser au natif, dans l'ordre d'arrivée, avec les règles de la bulle web : ni envoyés par moi, ni en
 * « Ne pas déranger » (`shouldShowBubble`), ni trop anciens par rapport à `since`. Chaque message n'est considéré qu'une
 * fois : `seen` les garde en mémoire, y compris ceux qu'une règle écarte (comme la bulle web).
 */
export function freshIncoming(s: SocialState, seen: Set<string>, since: number): Message[] {
  const fresh: Message[] = [];
  for (const m of knownMessages(s)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.createdAt < since - RECENT_MS || !shouldShowBubble(m, s.me, s.status)) continue;
    fresh.push(m);
  }
  return fresh.sort((a, b) => a.createdAt - b.createdAt);
}

/** Message au format du natif : texte rogné comme la bulle web. */
export function toNativeMessage(m: Message, s: SocialState): NativeMessage {
  return { id: m.id, from: viewerOf(m.from, senderOf(s, m.from).who), body: truncateText(m.body) };
}

/** Réaction venant du natif : emoji de la rangée (sinon rejetée) et position finie. */
export function reactionOf(d: unknown): { emoji: string; pos: number } | null {
  const r = (d ?? {}) as { emoji?: unknown; pos?: unknown };
  if (typeof r.emoji !== 'string' || !ALLOWED_REACTIONS.has(r.emoji)) return null;
  if (typeof r.pos !== 'number' || !Number.isFinite(r.pos)) return null;
  return { emoji: r.emoji, pos: Math.max(0, r.pos) };
}

/** Réponse venant du natif : identifiant de message non vide et emoji de réponse de la bulle (rien d'autre). */
export function replyOf(d: unknown): { messageId: string; emoji: string } | null {
  const r = (d ?? {}) as { messageId?: unknown; emoji?: unknown };
  if (typeof r.messageId !== 'string' || r.messageId === '') return null;
  if (typeof r.emoji !== 'string' || !REPLY_EMOJIS.some((x) => x.e === r.emoji)) return null;
  return { messageId: r.messageId, emoji: r.emoji };
}

/** Réaction de salon reçue (écho du salon) au format de bulle du natif (LAST-1615) ; null si elle est incomplète. */
export function partyReactMessageOf(d: unknown, id: string): NativeMessage | null {
  const r = (d ?? {}) as { by?: unknown; user?: unknown; emoji?: unknown };
  const by = typeof r.by === 'string' && r.by !== '' ? r.by : typeof r.user === 'string' ? r.user : '';
  if (by === '' || typeof r.emoji !== 'string' || r.emoji === '') return null;
  return { id, from: viewerOf(by, by), body: truncateText(r.emoji) };
}

/** Ce que le pont appelle côté web : réaction (postReact), message retrouvé, envoi (socialStore), erreur affichée. */
export interface NativeSocialHandlers {
  react(pos: number, emoji: string): void;
  messageOf(id: string): Message | undefined;
  send(pid: string, body: string): Promise<unknown>;
  error(message: string): void;
}

/** Réaction du natif, transmise à `react` si elle est valide. Renvoie vrai si elle l'a été. */
export function handleNativeReact(d: unknown, h: Pick<NativeSocialHandlers, 'react'>): boolean {
  const r = reactionOf(d);
  if (!r) return false;
  h.react(r.pos, r.emoji);
  return true;
}

/**
 * Réponse du natif à un message affiché : envoyée à son auteur. Renvoie la promesse de l'envoi (échec affiché : 429 à part),
 * ou null si la réponse est invalide ou si le message n'est plus connu.
 */
export function handleNativeReply(d: unknown, h: NativeSocialHandlers): Promise<void> | null {
  const r = replyOf(d);
  if (!r) return null;
  const m = h.messageOf(r.messageId);
  if (!m) return null;
  return h.send(m.from, r.emoji).then(() => undefined, (x: unknown) => {
    h.error((x as { status?: number } | null)?.status === 429 ? SEND_LIMIT : SEND_FAILED);
  });
}

/** Réponse texte venant du natif (LAST-1632) : texte non vide une fois rogné, coupé à CHAT_MAX_CHARS ; `messageId` facultatif. */
export function replyTextOf(d: unknown): { messageId: string; text: string } | null {
  const r = (d ?? {}) as { messageId?: unknown; text?: unknown };
  if (typeof r.text !== 'string') return null;
  const text = r.text.trim().slice(0, CHAT_MAX_CHARS);
  if (text === '') return null;
  return { messageId: typeof r.messageId === 'string' ? r.messageId : '', text };
}

/** Ce que la réponse texte appelle : en salon, le chat du salon (`chat`, faux si non envoyé) ; sinon l'envoi à l'auteur. */
export interface NativeReplyTextHandlers extends NativeSocialHandlers {
  /** Chat du salon actif, ou null hors salon. */
  chat: ((text: string) => boolean) | null;
}

/**
 * Réponse texte du natif. En salon, elle part dans le chat du salon (le message d'origine peut être une réaction du salon) ;
 * hors salon, elle va à l'auteur du message, comme une réponse de la bulle web. Renvoie la promesse de l'envoi (échec affiché),
 * ou null si la réponse est invalide ou si le message n'est plus connu.
 */
export function handleNativeReplyText(d: unknown, h: NativeReplyTextHandlers): Promise<void> | null {
  const r = replyTextOf(d);
  if (!r) return null;
  if (h.chat) {
    if (!h.chat(r.text)) h.error(SEND_FAILED);
    return Promise.resolve();
  }
  const m = r.messageId ? h.messageOf(r.messageId) : undefined;
  if (!m) return null;
  return h.send(m.from, r.text).then(() => undefined, (x: unknown) => {
    h.error((x as { status?: number } | null)?.status === 429 ? SEND_LIMIT : SEND_FAILED);
  });
}
