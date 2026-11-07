/* TURN facultatif du partage de lecture. Fourni par le salon (message `welcome`, lu par party/client.ts) : `null` = STUN seul.
 * Module sans dépendance, pour que le client de salon et la session relais le lisent sans import circulaire (session.ts
 * importe déjà PartyClient). Aucune URL ni identifiant n'est journalisé. */

import type { TurnConfig } from './peer';

export let relayTurn: TurnConfig | null = null;

/** TURN facultatif, injecté par l'application (jamais en dur dans le code). `null` : STUN seul. */
export function setRelayTurn(turn: TurnConfig | null): void {
  relayTurn = turn;
}
