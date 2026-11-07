import { describe, expect, it } from 'vitest';
import * as party from '../src/party.js';
import type { ClientMessage, ServerMessage } from '../src/party.js';

/** Contrat du salon : toute modification de ces valeurs change le protocole des deux côtés (bumper la version du paquet). */
const CONTRACT: Record<string, unknown> = {
  REACTIONS: ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉', '😱', '🤯', '😭', '🥹', '😍', '🙌', '💀', '🍿'],
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

/** Les dix premiers emojis : ils ne bougent ni ne se réordonnent (les nouveaux s'ajoutent à la fin). */
const REACTIONS_HISTORIQUES = ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉', '😱', '🤯'];

describe('réactions', () => {
  it('garde les emojis historiques dans leur ordre', () => {
    expect(party.REACTIONS.slice(0, REACTIONS_HISTORIQUES.length)).toEqual(REACTIONS_HISTORIQUES);
  });

  it("ajoute 😭 🥹 😍 🙌 💀 🍿 à la fin, sous la forme du sélecteur de l'app", () => {
    // Points de code explicites, sans sélecteur de variation U+FE0F : même forme que QUICK_EMOJIS et MORE_EMOJIS dans app-last-1615.
    const nouveaux = ['\u{1F62D}', '\u{1F979}', '\u{1F60D}', '\u{1F64C}', '\u{1F480}', '\u{1F37F}'];
    expect(party.REACTIONS.slice(REACTIONS_HISTORIQUES.length)).toEqual(nouveaux);
  });
});

describe('message source', () => {
  it('client : accepté avec une empreinte, avec ou sans langue', () => {
    const avecLangue: ClientMessage = { t: 'source', fingerprint: { fileName: 'film.mkv', size: 1024, hash: null }, language: 'fr' };
    const sansLangue: ClientMessage = { t: 'source', fingerprint: null };
    expect([avecLangue, sansLangue]).toEqual([
      { t: 'source', fingerprint: { fileName: 'film.mkv', size: 1024, hash: null }, language: 'fr' },
      { t: 'source', fingerprint: null },
    ]);
  });

  it('client : refusé sans empreinte, ou avec une langue qui n’est pas une chaîne', () => {
    // @ts-expect-error fingerprint est obligatoire (null accepté, absence refusée)
    const sansEmpreinte: ClientMessage = { t: 'source' };
    // @ts-expect-error language doit être une chaîne
    const langueInvalide: ClientMessage = { t: 'source', fingerprint: null, language: 42 };
    expect([sansEmpreinte.t, langueInvalide.t]).toEqual(['source', 'source']);
  });

  it('serveur : accepté avec la langue et le pseudo de l’auteur', () => {
    const diffuse: ServerMessage = { t: 'source', fingerprint: null, language: 'fr', by: 'alice' };
    expect(diffuse).toEqual({ t: 'source', fingerprint: null, language: 'fr', by: 'alice' });
  });

  it('serveur : refusé sans langue ni auteur', () => {
    // @ts-expect-error language et by sont requis côté serveur
    const incomplet: ServerMessage = { t: 'source', fingerprint: null };
    expect(incomplet.t).toBe('source');
  });
});
