import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as social from '../src/social.js';
import type {
  ActivityItem,
  ConversationV3,
  FriendView,
  GroupConversation,
  GuestEntry,
  HiddenItemDto,
  InviteDto,
  JoinTicket,
  ListDetail,
  Message,
  MessageV3,
  ProfileStats,
  ShareLinkView,
  SocialPrefs,
  SocialProfile,
  Watching,
} from '../src/social.js';

const handle = { name: 'Ana', tag: '1234', full: 'Ana#1234' };
const friend: FriendView = {
  pid: 'p-ana',
  handle,
  avatarColor: '#e11d48',
  status: 'online',
  household: false,
  favorite: true,
  muted: false,
};

const watching: Watching = {
  type: 'series',
  tmdbId: 1399,
  title: 'Game of Thrones',
  season: 1,
  episode: 2,
  paused: false,
  pos: 120,
  duration: 3300,
  at: 1_000,
  movedAt: 1_000,
};

const dmMessage: Message = {
  id: 'm1',
  conv: 'dm:p-ana',
  from: 'p-ana',
  to: 'p-me',
  kind: 'text',
  body: 'salut',
  reactions: [{ emoji: '🔥', count: 2, mine: false }],
  createdAt: 1_700_000_000_000,
};

/** Message de groupe : pas de `to`. */
const groupMessage: MessageV3 = {
  id: 'm2',
  conv: 'g:grp1',
  from: 'p-ana',
  kind: 'poll',
  body: '',
  poll: {
    id: 'm2',
    question: 'Quel film ce soir ?',
    options: [{ id: 'o1', label: 'Matrix', votes: 2, mine: true }],
    closed: false,
  },
  reactions: [],
  createdAt: 1_700_000_000_100,
};

const direct: ConversationV3 = {
  conv: 'dm:p-ana',
  pid: 'p-ana',
  handle,
  avatarColor: '#e11d48',
  last: dmMessage,
  unread: 1,
};

const group: GroupConversation = {
  conv: 'g:grp1',
  unread: 0,
  group: { id: 'grp1', name: 'Soirée', ownerPid: 'p-me', members: [friend] },
};

/** Historique masqué à un ami : `hoursWatched` et `notes` absents. */
const stats: ProfileStats = { friends: 3 };

const profile: SocialProfile = {
  pid: 'p-ana',
  handle,
  avatarColor: '#e11d48',
  favorites: [],
  stats,
  friendSince: 1_690_000_000_000,
  commonTitles: 2,
  mutualFriends: 1,
};

const prefs: SocialPrefs = {
  activityVisibility: 'friends',
  watchWith: 'ask',
  libraryVisibility: 'household',
  messagesFrom: 'friends',
  historyVisible: true,
  antiSpoiler: true,
  playbackSocial: 'cinema',
  notify: {
    messages: true,
    requests: true,
    parties: false,
    friendStarts: false,
    vibrate: false,
    sound: true,
  },
};

const shared: ShareLinkView = {
  type: 'movie',
  tmdbId: 603,
  title: 'Matrix',
  from: { handle, avatarColor: '#e11d48' },
  pos: 3600,
  note: 'à voir',
};

const list: ListDetail = {
  id: 'l1',
  name: 'Week-end',
  members: [friend],
  items: [{ type: 'movie', tmdbId: 603, title: 'Matrix', addedBy: 'p-ana', addedAt: 1_700_000_000_000 }],
};

const activity: ActivityItem = {
  id: 'a1',
  pid: 'p-ana',
  handle,
  avatarColor: '#e11d48',
  kind: 'rated',
  media: { type: 'movie', tmdbId: 603, title: 'Matrix' },
  rating: 4.5,
  at: 1_700_000_000_200,
};

const invite: InviteDto = {
  id: 'i1',
  code: 'ABC123',
  state: 'free',
  createdAt: '2026-10-01T00:00:00.000Z',
  sentAt: null,
  usedAt: null,
  revokedAt: null,
  message: null,
  picks: [],
  expiresAt: null,
  number: 4321,
  invitee: null,
};

const hidden: HiddenItemDto = {
  key: 'movie:603',
  title: 'Matrix',
  poster: '/poster.jpg',
  addedAt: 1_700_000_000_300,
};

const ticket: JoinTicket = {
  ticket: 'tkt',
  expiresAt: '2026-10-23T12:00:00.000Z',
  wsPath: '/party/p1/ws',
  room: {
    id: 'p1',
    visibility: 'public',
    title: 'Matrix',
    poster: null,
    language: 'fr',
    media: { type: 'movie', tmdbId: 603, imdbId: null, season: null, episode: null },
    fingerprint: null,
    host: 'Ana',
    participants: 2,
    maxParticipants: 20,
    createdAt: 1_700_000_000_000,
  },
};

const guest: GuestEntry = {
  sessionToken: 'sess',
  expiresAt: '2026-10-23T12:00:00.000Z',
  name: 'Invité 2',
};

describe('formes de réponse (compilation et contrat)', () => {
  it('chaque DTO principal se construit avec ses champs requis', () => {
    expect(watching.paused).toBe(false);
    expect(friend.status).toBe('online');
    expect(dmMessage.reactions).toHaveLength(1);
    expect(groupMessage.poll?.options[0].votes).toBe(2);
    expect(profile.stats.friends).toBe(3);
    expect(prefs.notify.sound).toBe(true);
    expect(shared.from.handle.full).toBe('Ana#1234');
    expect(list.items).toHaveLength(1);
    expect(activity.kind).toBe('rated');
    expect(invite.number).toBe(4321);
    expect(hidden.addedAt).toBe(1_700_000_000_300);
    expect(ticket.room.id).toBe('p1');
    expect(guest.name).toBe('Invité 2');
  });

  it('une conversation de groupe se distingue par `group`', () => {
    expect('group' in group).toBe(true);
    expect('group' in direct).toBe(false);
  });
});

describe('écarts de forme refusés à la compilation', () => {
  it('HiddenItemDto.addedAt est un nombre (ms), pas une chaîne', () => {
    // @ts-expect-error addedAt doit être un nombre
    const bad: HiddenItemDto = { key: 'movie:603', title: 'Matrix', poster: '/p.jpg', addedAt: '2026-10-23' };
    expect(bad.key).toBe('movie:603');
  });

  it('SocialPrefs.watchWith n\'a pas la valeur « sometimes »', () => {
    // @ts-expect-error valeurs permises : 'open' | 'ask' | 'never'
    const badPrefs: SocialPrefs = { ...prefs, watchWith: 'sometimes' };
    expect(badPrefs.watchWith).toBe('sometimes');
  });

  it('une conversation de groupe n\'a pas de pid', () => {
    // @ts-expect-error un groupe porte ses membres, pas un pid
    const badGroup: GroupConversation = { conv: 'g:grp1', unread: 0, group: group.group, pid: 'p-ana' };
    expect(badGroup.conv).toBe('g:grp1');
  });
});

describe('paquet', () => {
  it('le module social ne porte aucune valeur à l\'exécution', () => {
    expect(Object.keys(social)).toEqual([]);
  });

  it('exports["./social"] pointe vers dist/social', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./social']).toEqual({ types: './dist/social.d.ts', default: './dist/social.js' });
  });
});
