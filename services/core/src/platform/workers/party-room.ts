import type { DurableObjectNamespace, DurableObjectState, WebSocket as CfWebSocket } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { IDENTITY_HEADER } from '../../party/backend.js';
import { AVATAR_PATTERN } from '../../user/avatar.js';
import {
  CLOSE,
  type Identity,
  MAX_FRAME_BYTES,
  type ReportEntry,
  type RoomData,
  type RoomInfo,
  type RoomMeta,
  RTC_MAX_FRAME_CHARS,
  type RtcRelay,
  type ServerMessage,
  type StoredChatLine,
  parseClientMessage,
} from '../../party/protocol.js';
import { type Effect, type EntryVerdict, type InviteVerdict, type JoinCheck, type LinkVerdict, type Member, RoomCore, guestRefusal } from '../../party/room-core.js';
import { refusedSocket } from '../../party/refuse.js';
import { USER_STORE_NAME } from './user-backend.js';
import type { UserStoreDO } from './user-store-do.js';

/** Constructeur de paires WebSocket de l'exécution Workers (non déclaré par les types retenus ici). */
declare const WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket };

/** Données attachées à chaque socket (survivent à l'hibernation du Durable Object). */
interface Attachment extends Identity {
  connId: string;
  joinedAt: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function decodeIdentity(header: string | null): Identity | undefined {
  if (header === null) return undefined;
  try {
    const value = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Partial<Identity>;
    if (typeof value.accountId === 'string' && typeof value.username === 'string' && typeof value.avatarColor === 'string') {
      const avatar = typeof value.avatar === 'string' && AVATAR_PATTERN.test(value.avatar) ? { avatar: value.avatar } : {};
      const guest = value.guest === true ? { guest: true as const } : {};
      return { accountId: value.accountId, username: value.username, avatarColor: value.avatarColor, ...avatar, ...guest };
    }
  } catch {
    // en-tête illisible
  }
  return undefined;
}

/**
 * Salon de visionnage : un Durable Object par salon, WebSocket avec l'API d'hibernation (le DO dort quand personne ne
 * parle, sans couper les connexions). L'état persistant (lecture, muets, exclus, chat, signalements) est écrit dans le
 * stockage du DO ; la logique vit dans RoomCore (src/party/room-core.ts). Les méthodes publiques sont appelées en RPC
 * par le Worker (voir party-backend.ts) ; `fetch` reçoit la mise à niveau WebSocket après vérification du ticket.
 */
export class PartyRoom extends DurableObject {
  private core: RoomCore | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    void ctx.blockConcurrencyWhile(() => this.load());
  }

  private async load(): Promise<void> {
    const data = await this.ctx.storage.get<RoomData>('room');
    if (data === undefined) return;
    const chat = (await this.ctx.storage.get<StoredChatLine[]>('chat')) ?? [];
    const reports = (await this.ctx.storage.get<ReportEntry[]>('reports')) ?? [];
    const core = new RoomCore(data, chat, reports, () => Date.now());
    // Après une hibernation, les participants sont ceux dont la socket est encore ouverte.
    for (const ws of this.ctx.getWebSockets() as unknown as CfWebSocket[]) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment !== null) core.members.set(attachment.accountId, { ...attachment });
    }
    this.core = core;
  }

  // Appels RPC du Worker

  async init(meta: RoomMeta): Promise<'ok' | 'exists'> {
    if (this.core !== undefined) return 'exists';
    const now = Date.now();
    const data: RoomData = {
      meta,
      state: { playing: false, pos: 0, at: now, rev: 0 },
      muted: [],
      banned: [],
      hostAbsentSince: now,
      emptySince: now,
    };
    this.core = new RoomCore(data, [], [], () => Date.now());
    this.core.dirty.add('room');
    await this.settle();
    return 'ok';
  }

  info(): RoomInfo | null {
    return this.core?.info() ?? null;
  }

  check(accountId: string): JoinCheck | 'closed' {
    return this.core === undefined ? 'closed' : this.core.canJoin(accountId);
  }

  /** Droit d'émettre une invitation (voir RoomCore.inviteVerdict) ; compté dans le débit du salon si `ok`. */
  invite(requesterId: string): InviteVerdict {
    return this.core === undefined ? 'not_found' : this.core.inviteVerdict(requesterId);
  }

  /** Lien d'invitation partagé (voir RoomCore.inviteLink). */
  async inviteLink(requesterId: string, rotate: boolean): Promise<LinkVerdict> {
    const core = this.core;
    if (core === undefined) return { ok: false, reason: 'not_found' };
    const verdict = core.inviteLink(requesterId, rotate);
    await this.settle();
    return verdict;
  }

  /** Entrée d'un invité par le lien partagé (voir RoomCore.enterGuest). */
  async enterGuest(guestId: string, name: string, epoch: number): Promise<EntryVerdict> {
    const core = this.core;
    if (core === undefined) return { ok: false, reason: 'not_found' };
    const verdict = core.enterGuest(guestId, name, epoch);
    await this.settle();
    return verdict;
  }

  async close(requesterId: string | null): Promise<'ok' | 'forbidden' | 'not_found'> {
    const core = this.core;
    if (core === undefined) return 'not_found';
    if (requesterId !== null && requesterId !== core.hostId) return 'forbidden';
    await this.apply(core.end('closed'));
    return 'ok';
  }

  reports(requesterId: string | null): ReportEntry[] | 'forbidden' | 'not_found' {
    const core = this.core;
    if (core === undefined) return 'not_found';
    if (requesterId !== null && requesterId !== core.hostId) return 'forbidden';
    return core.reports;
  }

  async deleteMessage(messageId: string): Promise<'ok' | 'not_found'> {
    const core = this.core;
    if (core === undefined) return 'not_found';
    const { removed, effects } = core.removeMessage(messageId);
    if (!removed) return 'not_found';
    await this.apply(effects);
    return 'ok';
  }

  // WebSocket

  async fetch(request: Request): Promise<Response> {
    const core = this.core;
    const identity = decodeIdentity(request.headers.get(IDENTITY_HEADER));
    if (identity?.guest === true) {
      // Invité sans compte : un refus est une fermeture WebSocket 4xxx propre au motif (lue par l'application).
      if (core === undefined) return refusedSocket(CLOSE.ended, 'ended');
      const refusal = guestRefusal(core.canJoinGuest(identity));
      if (refusal !== undefined) return refusedSocket(refusal.code, refusal.reason);
      return this.accept(core, identity);
    }
    if (core === undefined) return json(404, { error: 'room_not_found' });
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'upgrade_required' });
    if (identity === undefined) return json(400, { error: 'identity_required' });
    const check = core.canJoin(identity.accountId);
    if (check === 'banned') return json(403, { error: 'banned' });
    if (check !== 'ok') return json(409, { error: check });
    return this.accept(core, identity);
  }

  /** Mise à niveau acceptée : entre dans le salon, en remplaçant l'éventuelle connexion précédente du même identifiant. */
  private async accept(core: RoomCore, identity: Identity): Promise<Response> {
    // Une nouvelle connexion remplace l'ancienne du même compte.
    for (const old of this.socketsOf(identity.accountId)) old.close(CLOSE.replaced, 'replaced');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: Attachment = { ...identity, connId: crypto.randomUUID(), joinedAt: Date.now() };
    this.ctx.acceptWebSocket(server as never);
    server.serializeAttachment(attachment);
    const member: Member = { ...attachment };
    await this.apply(core.join(member));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const core = this.core;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (core === undefined || attachment === null) {
      ws.close(1011, 'room_closed');
      return;
    }
    if (typeof message !== 'string' || message.length > RTC_MAX_FRAME_CHARS) {
      ws.close(1009, 'frame_too_large');
      return;
    }
    // Message d'une connexion remplacée entre-temps : ignoré.
    if (core.members.get(attachment.accountId)?.connId !== attachment.connId) return;
    const parsed = parseClientMessage(message);
    if (parsed === undefined) {
      // Hors signalisation, une trame de plus de MAX_FRAME_BYTES ferme la connexion (comme avant).
      if (message.length > MAX_FRAME_BYTES) {
        ws.close(1009, 'frame_too_large');
        return;
      }
      this.send(ws, { t: 'error', code: 'invalid_message' });
      return;
    }
    await this.apply(core.handle(attachment.accountId, parsed));
    await this.forwardReports(core);
  }

  /** Transmet les nouveaux signalements à la file de l'administration (Durable Object des utilisateurs) ; sans effet sur le salon en cas d'échec. */
  private async forwardReports(core: RoomCore): Promise<void> {
    if (core.fresh.length === 0) return;
    const fresh = core.fresh.splice(0, core.fresh.length);
    const users = (this.env as { USER_STORE?: DurableObjectNamespace<UserStoreDO> }).USER_STORE;
    if (users === undefined) return;
    const stub = users.getByName(USER_STORE_NAME);
    for (const { entry, againstId } of fresh) {
      try {
        await stub.manage('addReport', [
          { roomId: core.data.meta.id, messageId: entry.messageId, by: entry.by, againstId, against: entry.against, text: entry.text, reason: entry.reason, at: entry.at },
        ]);
      } catch {
        // La file d'administration est facultative : le signalement reste dans le salon.
      }
    }
  }

  async webSocketClose(ws: CfWebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // déjà fermée
    }
    await this.disconnected(ws);
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    await this.disconnected(ws);
  }

  private async disconnected(ws: CfWebSocket): Promise<void> {
    const core = this.core;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (core === undefined || attachment === null) return;
    await this.apply(core.leave(attachment.accountId, attachment.connId));
  }

  /** Alarme : fin du salon vide ou trop ancien, promotion d'un hôte absent. */
  async alarm(): Promise<void> {
    const core = this.core;
    if (core === undefined) return;
    const { effects } = core.tick();
    await this.apply(effects);
  }

  // Effets

  private socketsOf(accountId: string): CfWebSocket[] {
    return (this.ctx.getWebSockets() as unknown as CfWebSocket[]).filter(
      (ws) => (ws.deserializeAttachment() as Attachment | null)?.accountId === accountId,
    );
  }

  private send(ws: CfWebSocket, msg: ServerMessage | RtcRelay): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket en cours de fermeture
    }
  }

  private async apply(effects: readonly Effect[]): Promise<void> {
    const core = this.core;
    let ended = false;
    for (const effect of effects) {
      switch (effect.kind) {
        case 'send':
          for (const ws of this.socketsOf(effect.to)) this.send(ws, effect.msg);
          break;
        case 'broadcast':
          for (const ws of this.ctx.getWebSockets() as unknown as CfWebSocket[]) {
            const attachment = ws.deserializeAttachment() as Attachment | null;
            if (attachment !== null && attachment.accountId !== effect.except) this.send(ws, effect.msg);
          }
          break;
        case 'close':
          for (const ws of this.socketsOf(effect.to)) ws.close(effect.code, effect.reason);
          break;
        case 'peer':
          // Signalisation : une seule connexion, celle du pair visé (identifiant de connexion).
          for (const ws of this.ctx.getWebSockets() as unknown as CfWebSocket[]) {
            if ((ws.deserializeAttachment() as Attachment | null)?.connId === effect.peerId) this.send(ws, effect.msg);
          }
          break;
        case 'end':
          ended = true;
          break;
      }
    }
    if (ended) {
      for (const ws of this.ctx.getWebSockets() as unknown as CfWebSocket[]) {
        try {
          ws.close(CLOSE.ended, 'ended');
        } catch {
          // déjà fermée
        }
      }
      this.core = undefined;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    if (core !== undefined) await this.settle();
  }

  /** Écrit les parties modifiées et programme le prochain réveil. */
  private async settle(): Promise<void> {
    const core = this.core;
    if (core === undefined) return;
    const writes: Promise<void>[] = [];
    for (const key of core.dirty) {
      writes.push(this.ctx.storage.put(key, key === 'room' ? core.data : key === 'chat' ? core.chat : core.reports));
    }
    core.dirty.clear();
    await Promise.all(writes);
    const wake = core.nextWake();
    if (wake !== null) await this.ctx.storage.setAlarm(wake);
  }
}
