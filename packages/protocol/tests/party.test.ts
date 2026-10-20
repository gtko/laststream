import { describe, expect, it } from 'vitest';
import * as party from '../src/party.js';
import type { ClientMessage, ServerMessage } from '../src/party.js';

/** Contrat du salon : toute modification de ces valeurs change le protocole des deux côtés (bumper la version du paquet). */
const CONTRACT: Record<string, unknown> = {
  REACTIONS: ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉', '😱', '🤯'],
  CHAT_MAX_CHARS: 500,
  MAX_FRAME_BYTES: 4096,
  PARTY_RESUME_AHEAD_SEC: 10,
  PARTY_WAIT_MAX_MS: 45_000,
  COUNTDOWN_MIN_SEC: 1,
  COUNTDOWN_MAX_SEC: 10,
  COUNTDOWN_DEFAULT_SEC: 5,
  VOTE_MIN_OPTIONS: 2,
  VOTE_MAX_OPTIONS: 6,
  PREP_STATUSES: ['searching', 'ready', 'buffering'],
  CONTROL_MODES: ['all', 'host'],
  WAIT_LATE_MODES: ['off', '10s', 'always'],
  REACTION_MODES: ['float', 'discreet', 'off'],
  EVENT_KINDS: ['pause', 'play', 'seek', 'join', 'leave'],
  DEFAULT_SETTINGS: { control: 'all', waitLate: 'always', reactions: 'float' },
  WAIT_LATE_MS: { off: 0, '10s': 10_000, always: 45_000 },
  CLOSE: { ended: 4000, expired: 4001, kicked: 4003, banned: 4004, rateLimited: 4008, replaced: 4009, full: 4010, nameTaken: 4011, nameChanged: 4012 },
};

describe('contrat du salon', () => {
  for (const [name, expected] of Object.entries(CONTRACT)) {
    it(`${name} garde sa valeur`, () => {
      expect((party as Record<string, unknown>)[name]).toEqual(expected);
    });
  }

  it('les messages typés se construisent (compilation)', () => {
    const client: ClientMessage = { t: 'chat', text: 'salut', pos: null };
    const server: ServerMessage = { t: 'pong', c: 1, s: 2 };
    expect([client.t, server.t]).toEqual(['chat', 'pong']);
  });
});
