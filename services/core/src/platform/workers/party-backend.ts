import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import type { PartyBackend, PartyRoomStub } from '../../party/backend.js';
import type { PartyRoom } from './party-room.js';

/** Salons de visionnage d'un Worker : un Durable Object `PartyRoom` par salon, nommé par l'identifiant du salon. */
export function createDurableObjectPartyBackend(namespace: DurableObjectNamespace<PartyRoom>): PartyBackend {
  return { room: (id) => namespace.getByName(id) as unknown as PartyRoomStub };
}
