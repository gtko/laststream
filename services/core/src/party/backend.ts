import type { JoinCheck } from './room-core.js';
import type { ReportEntry, RoomInfo, RoomMeta } from './protocol.js';

/**
 * Accès aux salons de visionnage. Seule la plateforme Workers en fournit un (Durable Object `PartyRoom`, un par salon) ;
 * sous Node il est absent et les routes /party répondent 501. Les tests Workers l'injectent via `AppDeps.party`.
 */
export interface PartyRoomStub {
  /** Crée le salon (une seule fois). */
  init(meta: RoomMeta): Promise<'ok' | 'exists'>;
  /** Description du salon, ou null s'il n'existe pas / plus. */
  info(): Promise<RoomInfo | null>;
  /** Un compte peut-il se connecter (salon plein, exclu) ? `closed` : le salon n'existe plus. */
  check(accountId: string): Promise<JoinCheck | 'closed'>;
  /** Termine le salon. `requesterId` doit être l'hôte, sauf `null` (propriétaire du serveur). */
  close(requesterId: string | null): Promise<'ok' | 'forbidden' | 'not_found'>;
  /** Signalements reçus (hôte, ou propriétaire du serveur avec `null`). */
  reports(requesterId: string | null): Promise<ReportEntry[] | 'forbidden' | 'not_found'>;
  /** Modération du serveur : retire un message de l'historique du salon. `not_found` : salon terminé ou message absent. */
  deleteMessage(messageId: string): Promise<'ok' | 'not_found'>;
  /** Mise à niveau WebSocket (identité dans l'en-tête interne `x-party-identity`, posé par handlePartyWs). */
  fetch(request: Request): Promise<Response>;
}

export interface PartyBackend {
  room(id: string): PartyRoomStub;
}

/** En-tête interne entre le Worker et le Durable Object : identité vérifiée (jamais fournie par le client). */
export const IDENTITY_HEADER = 'x-party-identity';
