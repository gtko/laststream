import { cleanReportText, filterChat } from './filter.js';
import {
  CHAT_HISTORY,
  CLOSE,
  type ChatLine,
  type ClientMessage,
  EMPTY_ROOM_TTL_MS,
  HOST_GRACE_MS,
  type Identity,
  MAX_REPORTS,
  type Participant,
  type StoredChatLine,
  type PlaybackState,
  REACTIONS,
  ROOM_MAX_AGE_MS,
  type ReportEntry,
  type RoomData,
  type RoomInfo,
  type ServerMessage,
} from './protocol.js';
import { expectedPosition } from './sync.js';

/**
 * Cœur du salon : machine à états pure (aucune socket, aucune horloge, aucun stockage). Le Durable Object PartyRoom lui
 * confie les messages et applique les effets rendus (envoi, fermeture, fin) ; les tests l'exercent sans réseau.
 */

export type Effect =
  | { kind: 'send'; to: string; msg: ServerMessage }
  | { kind: 'broadcast'; msg: ServerMessage; except?: string }
  | { kind: 'close'; to: string; code: number; reason: string }
  /** Le salon est terminé : fermer toutes les connexions et effacer l'état. */
  | { kind: 'end' };

export type StoreKey = 'room' | 'chat' | 'reports';

export interface Member extends Identity {
  /** Identifie la connexion : la fermeture d'une ancienne connexion (remplacée) ne retire pas la nouvelle. */
  connId: string;
  joinedAt: number;
}

export type JoinCheck = 'ok' | 'room_full' | 'banned';

/** Fenêtres de débit par participant : `max` messages par `windowMs`. Au-delà de 2 fois la limite, la connexion est fermée. */
const LIMITS: Readonly<Record<string, { max: number; windowMs: number }>> = {
  ping: { max: 20, windowMs: 10_000 },
  sync: { max: 10, windowMs: 10_000 },
  ctl: { max: 30, windowMs: 10_000 },
  chat: { max: 5, windowMs: 10_000 },
  react: { max: 10, windowMs: 10_000 },
  report: { max: 5, windowMs: 60_000 },
  admin: { max: 20, windowMs: 10_000 },
};

/** Écart (s) à partir duquel le rapport de position de l'hôte corrige l'état diffusé. */
const HOST_SYNC_TOLERANCE_SEC = 0.75;

export class RoomCore {
  readonly members = new Map<string, Member>();
  /** Parties de l'état modifiées depuis le dernier enregistrement (le DO les écrit puis vide l'ensemble). */
  readonly dirty = new Set<StoreKey>();
  /** Signalements nouveaux, pas encore transmis à l'administration (le Durable Object les vide après envoi). */
  readonly fresh: { entry: ReportEntry; againstId: string }[] = [];
  private readonly hits = new Map<string, number[]>();
  private seq = 0;

  constructor(
    readonly data: RoomData,
    readonly chat: StoredChatLine[],
    readonly reports: ReportEntry[],
    private readonly clock: () => number,
  ) {}

  get hostId(): string {
    return this.data.meta.hostId;
  }

  /** Modération du serveur : retire un message de l'historique (et ses signalements) et prévient les participants. */
  removeMessage(messageId: string): { removed: boolean; effects: Effect[] } {
    const index = this.chat.findIndex((line) => line.id === messageId);
    if (index === -1) return { removed: false, effects: [] };
    this.chat.splice(index, 1);
    this.dirty.add('chat');
    const kept = this.reports.filter((report) => report.messageId !== messageId);
    if (kept.length !== this.reports.length) {
      this.reports.splice(0, this.reports.length, ...kept);
      this.dirty.add('reports');
    }
    return { removed: true, effects: [{ kind: 'broadcast', msg: { t: 'removed', messageId } }] };
  }

  info(): RoomInfo {
    const { meta } = this.data;
    return {
      id: meta.id,
      visibility: meta.visibility,
      title: meta.title,
      poster: meta.poster,
      language: meta.language,
      media: meta.media,
      fingerprint: meta.fingerprint,
      host: meta.hostName,
      participants: this.members.size,
      maxParticipants: meta.maxParticipants,
      createdAt: meta.createdAt,
    };
  }

  /** Description du salon envoyée aux participants (sans le nombre, qui évolue). */
  private roomView(): Omit<RoomInfo, 'participants'> {
    const { participants: _count, ...view } = this.info();
    void _count;
    return view;
  }

  /** Un compte déjà connecté peut se reconnecter même si le salon est plein (sa connexion est remplacée). */
  canJoin(accountId: string): JoinCheck {
    if (this.data.banned.includes(accountId)) return 'banned';
    if (!this.members.has(accountId) && this.members.size >= this.data.meta.maxParticipants) return 'room_full';
    return 'ok';
  }

  private participant(member: Member): Participant {
    return {
      username: member.username,
      avatarColor: member.avatarColor,
      ...(member.avatar ? { avatar: member.avatar } : {}),
      host: member.accountId === this.hostId,
      muted: this.data.muted.includes(member.accountId),
      joinedAt: member.joinedAt,
    };
  }

  /** Accepte une connexion (après canJoin). Remplace une éventuelle connexion précédente du même compte. */
  join(member: Member): Effect[] {
    const effects: Effect[] = [];
    // Une ancienne connexion du même compte est fermée par l'hôte du cœur (code CLOSE.replaced) avant cet appel.
    const previous = this.members.get(member.accountId);
    this.members.set(member.accountId, member);
    this.data.emptySince = null;
    if (member.accountId === this.hostId) this.data.hostAbsentSince = null;
    this.dirty.add('room');
    const now = this.clock();
    effects.push({
      kind: 'send',
      to: member.accountId,
      msg: {
        t: 'welcome',
        you: { username: member.username, host: member.accountId === this.hostId, muted: this.data.muted.includes(member.accountId) },
        room: this.roomView(),
        state: this.data.state,
        serverTime: now,
        participants: [...this.members.values()].map((m) => this.participant(m)),
        chat: this.chat.map(publicLine),
      },
    });
    if (previous === undefined) effects.push({ kind: 'broadcast', msg: { t: 'join', participant: this.participant(member) }, except: member.accountId });
    return effects;
  }

  /** Déconnexion : sans effet si la connexion a déjà été remplacée par une plus récente. */
  leave(accountId: string, connId: string): Effect[] {
    const member = this.members.get(accountId);
    if (member === undefined || member.connId !== connId) return [];
    this.members.delete(accountId);
    const now = this.clock();
    if (accountId === this.hostId) this.data.hostAbsentSince = now;
    if (this.members.size === 0) this.data.emptySince = now;
    this.dirty.add('room');
    return [{ kind: 'broadcast', msg: { t: 'leave', user: member.username } }];
  }

  /** Limite de débit : `true` si le message est admis. */
  private allow(accountId: string, kind: keyof typeof LIMITS): 'ok' | 'limited' | 'abusive' {
    const limit = LIMITS[kind];
    if (limit === undefined) return 'ok';
    const now = this.clock();
    const key = `${accountId}|${kind}`;
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < limit.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (recent.length > limit.max * 2) return 'abusive';
    return recent.length > limit.max ? 'limited' : 'ok';
  }

  private err(to: string, code: string): Effect[] {
    return [{ kind: 'send', to, msg: { t: 'error', code } }];
  }

  private nextState(playing: boolean, pos: number): PlaybackState {
    return { playing, pos, at: this.clock(), rev: this.data.state.rev + 1 };
  }

  private findByName(username: string): Member | undefined {
    for (const member of this.members.values()) if (member.username === username) return member;
    return undefined;
  }

  /** Traite un message d'un participant connecté. */
  handle(accountId: string, message: ClientMessage): Effect[] {
    const member = this.members.get(accountId);
    if (member === undefined) return [];
    const kind = rateKind(message);
    const verdict = this.allow(accountId, kind);
    if (verdict === 'abusive') return [{ kind: 'close', to: accountId, code: CLOSE.rateLimited, reason: 'rate_limited' }];
    if (verdict === 'limited') return this.err(accountId, 'rate_limited');
    const now = this.clock();
    const isHost = accountId === this.hostId;

    switch (message.t) {
      case 'ping':
        return [{ kind: 'send', to: accountId, msg: { t: 'pong', c: message.c, s: now } }];
      case 'sync':
        return [{ kind: 'send', to: accountId, msg: { t: 'state', state: this.data.state, serverTime: now, by: this.data.meta.hostName } }];
      case 'ctl': {
        if (!isHost) return this.err(accountId, 'not_host');
        const current = this.data.state;
        if (message.action === 'sync') {
          // Rapport périodique de l'hôte : on ne rediffuse que si la position diffère de ce que les autres suivent.
          if (Math.abs(message.pos - expectedPosition(current, now)) <= HOST_SYNC_TOLERANCE_SEC) return [];
          this.data.state = this.nextState(current.playing, message.pos);
        } else {
          this.data.state = this.nextState(message.action === 'seek' ? current.playing : message.action === 'play', message.pos);
        }
        this.dirty.add('room');
        return [{ kind: 'broadcast', msg: { t: 'state', state: this.data.state, serverTime: now, by: member.username } }];
      }
      case 'episode': {
        if (!isHost) return this.err(accountId, 'not_host');
        const meta = this.data.meta;
        if (meta.media.type !== 'series') return this.err(accountId, 'not_series');
        meta.media = { ...meta.media, season: message.season, episode: message.episode };
        meta.fingerprint = message.fingerprint;
        this.data.state = this.nextState(false, 0);
        this.dirty.add('room');
        return [{ kind: 'broadcast', msg: { t: 'media', media: meta.media, fingerprint: meta.fingerprint, state: this.data.state, serverTime: now } }];
      }
      case 'chat': {
        if (this.data.muted.includes(accountId)) return this.err(accountId, 'muted');
        const filtered = filterChat(message.text);
        if (!filtered.ok) return this.err(accountId, 'empty_message');
        const line: StoredChatLine = { id: `${now.toString(36)}${(this.seq++).toString(36)}`, from: member.username, fromId: accountId, text: filtered.text, at: now };
        this.chat.push(line);
        if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
        this.dirty.add('chat');
        return [{ kind: 'broadcast', msg: { t: 'chat', line: publicLine(line) } }];
      }
      case 'react': {
        if (this.data.muted.includes(accountId)) return this.err(accountId, 'muted');
        if (!(REACTIONS as readonly string[]).includes(message.emoji)) return this.err(accountId, 'invalid_reaction');
        return [{ kind: 'broadcast', msg: { t: 'react', user: member.username, emoji: message.emoji, at: now } }];
      }
      case 'report': {
        const line = this.chat.find((entry) => entry.id === message.messageId);
        if (line === undefined) return this.err(accountId, 'message_not_found');
        if (line.fromId === accountId) return this.err(accountId, 'cannot_report_self');
        const already = this.reports.some((r) => r.messageId === line.id && r.by === member.username);
        if (!already) {
          const entry: ReportEntry = {
            messageId: line.id,
            by: member.username,
            against: line.from,
            text: cleanReportText(line.text),
            reason: message.reason === null ? null : cleanReportText(message.reason) || null,
            at: now,
          };
          this.reports.push(entry);
          this.fresh.push({ entry, againstId: line.fromId });
          if (this.reports.length > MAX_REPORTS) this.reports.splice(0, this.reports.length - MAX_REPORTS);
          this.dirty.add('reports');
        }
        const effects: Effect[] = [{ kind: 'send', to: accountId, msg: { t: 'reported', messageId: line.id } }];
        if (!already && this.hostId !== accountId && this.members.has(this.hostId)) {
          effects.push({ kind: 'send', to: this.hostId, msg: { t: 'reported', messageId: line.id, by: member.username, against: line.from, text: line.text } });
        }
        return effects;
      }
      case 'kick': {
        if (!isHost) return this.err(accountId, 'not_host');
        const target = this.findByName(message.user);
        if (target === undefined) return this.err(accountId, 'user_not_found');
        if (target.accountId === accountId) return this.err(accountId, 'cannot_target_self');
        if (!this.data.banned.includes(target.accountId)) this.data.banned.push(target.accountId);
        this.members.delete(target.accountId);
        this.dirty.add('room');
        return [
          { kind: 'close', to: target.accountId, code: CLOSE.kicked, reason: 'kicked' },
          { kind: 'broadcast', msg: { t: 'leave', user: target.username } },
        ];
      }
      case 'mute': {
        if (!isHost) return this.err(accountId, 'not_host');
        const target = this.findByName(message.user);
        if (target === undefined) return this.err(accountId, 'user_not_found');
        if (target.accountId === accountId) return this.err(accountId, 'cannot_target_self');
        const muted = this.data.muted.filter((id) => id !== target.accountId);
        if (message.muted) muted.push(target.accountId);
        this.data.muted = muted;
        this.dirty.add('room');
        return [{ kind: 'broadcast', msg: { t: 'muted', user: target.username, muted: message.muted } }];
      }
      case 'transfer': {
        if (!isHost) return this.err(accountId, 'not_host');
        const target = this.findByName(message.user);
        if (target === undefined) return this.err(accountId, 'user_not_found');
        if (target.accountId === accountId) return this.err(accountId, 'cannot_target_self');
        this.setHost(target);
        return [{ kind: 'broadcast', msg: { t: 'host', user: target.username } }];
      }
      case 'end':
        if (!isHost) return this.err(accountId, 'not_host');
        return [{ kind: 'broadcast', msg: { t: 'ended', reason: 'host_ended' } }, { kind: 'end' }];
    }
  }

  private setHost(member: Member): void {
    this.data.meta.hostId = member.accountId;
    this.data.meta.hostName = member.username;
    this.data.muted = this.data.muted.filter((id) => id !== member.accountId);
    this.data.hostAbsentSince = null;
    this.dirty.add('room');
  }

  /** Fin de salon demandée de l'extérieur (route DELETE) : prévient et ferme. */
  end(reason: string): Effect[] {
    return [{ kind: 'broadcast', msg: { t: 'ended', reason } }, { kind: 'end' }];
  }

  /**
   * Maintenance à l'alarme : fin du salon trop ancien ou resté vide, promotion d'un nouvel hôte si l'hôte est absent depuis
   * trop longtemps. `next` : prochain instant (ms) où rappeler tick, ou null.
   */
  tick(): { effects: Effect[]; next: number | null } {
    const now = this.clock();
    const { data } = this;
    if (now - data.meta.createdAt >= ROOM_MAX_AGE_MS) return { effects: this.end('expired'), next: null };
    if (this.members.size === 0) {
      const since = data.emptySince ?? now;
      if (data.emptySince === null) {
        data.emptySince = now;
        this.dirty.add('room');
      }
      if (now - since >= EMPTY_ROOM_TTL_MS) return { effects: this.end('empty'), next: null };
      return { effects: [], next: since + EMPTY_ROOM_TTL_MS };
    }
    const effects: Effect[] = [];
    if (!this.members.has(this.hostId)) {
      const since = data.hostAbsentSince ?? now;
      if (data.hostAbsentSince === null) {
        data.hostAbsentSince = now;
        this.dirty.add('room');
      }
      if (now - since >= HOST_GRACE_MS) {
        const successor = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (successor !== undefined) {
          this.setHost(successor);
          effects.push({ kind: 'broadcast', msg: { t: 'host', user: successor.username } });
        }
      } else {
        return { effects, next: since + HOST_GRACE_MS };
      }
    }
    return { effects, next: data.meta.createdAt + ROOM_MAX_AGE_MS };
  }

  /** Prochain réveil nécessaire (ms) selon l'état courant, ou null. */
  nextWake(): number | null {
    const { data } = this;
    const expiry = data.meta.createdAt + ROOM_MAX_AGE_MS;
    if (this.members.size === 0) return Math.min(expiry, (data.emptySince ?? this.clock()) + EMPTY_ROOM_TTL_MS);
    if (!this.members.has(this.hostId)) return Math.min(expiry, (data.hostAbsentSince ?? this.clock()) + HOST_GRACE_MS);
    return expiry;
  }
}

function publicLine(line: StoredChatLine): ChatLine {
  return { id: line.id, from: line.from, text: line.text, at: line.at };
}

function rateKind(message: ClientMessage): string {
  switch (message.t) {
    case 'kick':
    case 'mute':
    case 'transfer':
    case 'end':
    case 'episode':
      return 'admin';
    default:
      return message.t;
  }
}
