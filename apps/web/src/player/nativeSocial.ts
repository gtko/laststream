import type { Message, Note, Status } from '../data/socialV2Api';
import type { SocialState } from '../data/socialStore';
import type { NativeMessage, NativeNote, NativeSocial, NativeViewer } from './native';
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

/** Ce qui décide si le social apparaît côté natif. */
export interface NativeSocialGate {
  /** Social disponible pour ce titre : session serveur, titre avec identifiant TMDB. */
  available: boolean;
  /** Profil enfant. */
  kid: boolean;
  status: Status;
  /** Mode cinéma actif à cet instant. */
  cinema: boolean;
}

/** Charge utile de `setSocial`. `enabled` faux : aucun spectateur n'est envoyé. */
export function nativeSocialOf(gate: NativeSocialGate, viewers: readonly NativeViewer[]): NativeSocial {
  const enabled = gate.available && !gate.kid && gate.status !== 'invisible' && !gate.cinema;
  return { enabled, quick: [...NATIVE_QUICK], more: [...NATIVE_MORE], viewers: enabled ? viewers.map((v) => ({ ...v })) : [] };
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
