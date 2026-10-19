import { describe, expect, it } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { LIVE_PONG_FRAME, liveEnvelopes, liveFrame, parseLiveClientFrame, SOCIAL_LIVE_MAX_FRAME_CHARS } from '../src/user/social-v2-live.js';
import type { FriendRequestView, FriendView, MessageView, NoteView } from '../src/user/social-v2-store.js';

/** Diffusion pure du flux temps réel social : formes JSON du contrat, audience, invisible, trames client. */

const BOB_PID = 'BBBBBBBBBBBBBBBB';
const ALICE_PID = 'AAAAAAAAAAAAAAAA';

const bob: FriendView = {
  pid: BOB_PID,
  handle: { name: 'bob', tag: 'A7K2', full: 'bob#A7K2' },
  avatarColor: '#3366ff',
  household: false,
  status: 'online',
  lastSeen: 1_700_000_000_000,
  watching: { type: 'series', tmdbId: 1399, title: 'Game of Thrones', season: 2, episode: 4, pos: 754, paused: false, at: 1_700_000_000_000 },
};

const message: MessageView = {
  id: 'msg-1',
  conv: `dm:${ALICE_PID}`,
  from: ALICE_PID,
  to: BOB_PID,
  kind: 'text',
  body: 'Salut',
  context: { type: 'movie', tmdbId: 603, pos: 12 },
  reactions: [],
  createdAt: 1_700_000_000_500,
};

const request: FriendRequestView = {
  pid: ALICE_PID,
  handle: { name: 'alice', tag: 'K9M2', full: 'alice#K9M2' },
  avatarColor: '#aa5500',
  createdAt: 1_700_000_000_100,
};

const note: NoteView = {
  id: 'note-1',
  author: { pid: ALICE_PID, handle: { name: 'alice', tag: 'K9M2', full: 'alice#K9M2' }, avatarColor: '#aa5500' },
  pos: 1234,
  kind: 'text',
  body: 'Ce passage !',
  createdAt: 1_700_000_000_900,
};

/** Trame JSON parsée pour la destination `pid` (une seule attendue). */
function frameFor(pid: string, event: SocialEvent): Record<string, unknown> {
  const found = liveEnvelopes([pid], event);
  expect(found).toHaveLength(1);
  return JSON.parse(found[0]?.frame ?? 'null') as Record<string, unknown>;
}

describe('audience', () => {
  it('sans destinataire, aucune trame', () => {
    expect(liveEnvelopes([], { t: 'unfriend', pid: BOB_PID })).toEqual([]);
  });

  it('une trame par profil, identique, sans doublon', () => {
    const event: SocialEvent = { t: 'unfriend', pid: BOB_PID };
    const out = liveEnvelopes([ALICE_PID, BOB_PID, ALICE_PID], event);
    expect(out.map((e) => e.pid)).toEqual([ALICE_PID, BOB_PID]);
    expect(out[0]?.frame).toBe(out[1]?.frame);
  });
});

describe('formes JSON du contrat', () => {
  it('texte exact d\'une dissolution d\'amitié', () => {
    expect(liveEnvelopes([ALICE_PID], { t: 'unfriend', pid: BOB_PID })[0]?.frame).toBe('{"t":"unfriend","pid":"BBBBBBBBBBBBBBBB"}');
  });

  it('refus ou annulation de demande : une seule trame unfriend, adressée à l’autre profil', () => {
    expect(liveEnvelopes([ALICE_PID], { t: 'unfriend', pid: BOB_PID })).toEqual([{ pid: ALICE_PID, frame: '{"t":"unfriend","pid":"BBBBBBBBBBBBBBBB"}' }]);
  });

  it('message : { t, message } avec les champs du contrat', () => {
    expect(frameFor(BOB_PID, { t: 'message', message })).toEqual({ t: 'message', message });
  });

  it('lecture : { t, pid, at }', () => {
    expect(frameFor(ALICE_PID, { t: 'read', pid: BOB_PID, at: 1_700_000_001_000 })).toEqual({ t: 'read', pid: BOB_PID, at: 1_700_000_001_000 });
  });

  it('présence : { t, friend } avec le drapeau « foyer » du destinataire', () => {
    const friend = frameFor(ALICE_PID, { t: 'presence', friend: { ...bob, household: false } });
    expect(friend).toEqual({ t: 'presence', friend: { ...bob, household: false } });
    const household = frameFor(ALICE_PID, { t: 'presence', friend: { ...bob, household: true } });
    expect((household.friend as FriendView).household).toBe(true);
  });

  it('demande reçue : { t, request }', () => {
    expect(frameFor(BOB_PID, { t: 'request', request })).toEqual({ t: 'request', request });
  });

  it('nouvel ami : { t, friend }', () => {
    expect(frameFor(ALICE_PID, { t: 'friend', friend: { ...bob, household: false } })).toEqual({ t: 'friend', friend: { ...bob, household: false } });
  });

  it('note : { t, media, note } ; saison et épisode gardés pour une série seulement', () => {
    const series = frameFor(BOB_PID, {
      t: 'note',
      media: { type: 'series', tmdbId: 1399, season: 2, episode: 4 },
      note,
    });
    expect(series).toEqual({ t: 'note', media: { type: 'series', tmdbId: 1399, season: 2, episode: 4 }, note });
    const movie = frameFor(BOB_PID, { t: 'note', media: { type: 'movie', tmdbId: 603, season: 2, episode: 4 } as never, note });
    expect(movie.media).toEqual({ type: 'movie', tmdbId: 603 });
  });
});

describe('confidentialité', () => {
  it('invisible (vu hors ligne) : jamais de titre en cours', () => {
    const hidden: FriendView = { ...bob, status: 'offline', household: false, lastSeen: undefined };
    const frame = frameFor(ALICE_PID, { t: 'presence', friend: { ...hidden, watching: bob.watching } as FriendView });
    expect(frame).toEqual({ t: 'presence', friend: { pid: BOB_PID, handle: bob.handle, avatarColor: bob.avatarColor, household: false, status: 'offline' } });
  });

  it('aucun identifiant interne ne sort : seuls les champs du contrat', () => {
    const leaky = { ...bob, accountId: 'compte-interne-42', id: 42, profileId: 'profil-interne' } as unknown as FriendView;
    const raw = liveEnvelopes([ALICE_PID], { t: 'friend', friend: leaky })[0]?.frame ?? '';
    expect(raw).not.toContain('compte-interne-42');
    expect(raw).not.toContain('profil-interne');
    const friend = (JSON.parse(raw) as { friend: Record<string, unknown> }).friend;
    expect(Object.keys(friend).sort()).toEqual(['avatarColor', 'handle', 'household', 'lastSeen', 'pid', 'status', 'watching']);
  });
});

describe('trames client', () => {
  it('ping reconnu, pong renvoyé', () => {
    expect(parseLiveClientFrame('{"t":"ping"}')).toBe('ping');
    expect(LIVE_PONG_FRAME).toBe('{"t":"pong"}');
  });

  it('autres trames ignorées', () => {
    for (const raw of ['{"t":"ping","x":1}', '{"t":"pong"}', '{"t":"message"}', 'pas du json', '[]', 'null', '"ping"', '{}']) {
      expect(parseLiveClientFrame(raw)).toBeUndefined();
    }
  });

  it('trame trop grosse refusée', () => {
    const big = `{"t":"ping","p":"${'x'.repeat(SOCIAL_LIVE_MAX_FRAME_CHARS)}"}`;
    expect(parseLiveClientFrame(big)).toBeUndefined();
  });

  it('liveFrame ne retient que les champs connus d\'un message', () => {
    const extra = { ...message, internal: 'secret' } as unknown as MessageView;
    expect(liveFrame({ t: 'message', message: extra })).toEqual({ t: 'message', message });
  });
});
