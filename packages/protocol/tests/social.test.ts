import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as social from '../src/social.js';
import type {
  ActivityItem,
  ConversationV3,
  CreateEveningBody,
  Evening,
  EveningEvent,
  EveningGuest,
  EveningPage,
  EveningRecurrence,
  EveningResponse,
  EveningResponseBody,
  FriendView,
  GroupConversation,
  GuestEntry,
  HiddenItemDto,
  HomeFriend,
  HomeMedia,
  HomeProgressResponse,
  HomeRecommendation,
  HomeRecommendationsResponse,
  HomeTitleProgress,
  HomeWatchingItem,
  HomeWatchingResponse,
  InviteDto,
  JoinTicket,
  ListDetail,
  Message,
  MessageV3,
  ProfileStats,
  RecommendationInput,
  ShareLinkView,
  SocialPrefs,
  SocialProfile,
  UpdateEveningBody,
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

const homeFriend: HomeFriend = { pid: 'p-ana', handle, avatarColor: '#e11d48' };

const homeWatching: HomeWatchingItem = {
  friend: homeFriend,
  media: { type: 'series', tmdbId: 1399, title: 'Game of Thrones', season: 1, episode: 2 },
  pos: 120,
  duration: 3300,
  finished: false,
  live: true,
  updatedAt: 1_000,
};
const homeWatchingPage: HomeWatchingResponse = { items: [homeWatching] };

const homeProgress: HomeTitleProgress = {
  friend: homeFriend,
  type: 'movie',
  tmdbId: 603,
  pos: 3600,
  finished: true,
  updatedAt: 1_700_000_000_400,
};
const homeProgressPage: HomeProgressResponse = { items: [homeProgress] };

const homeRecommendation: HomeRecommendation = {
  friend: homeFriend,
  media: { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/poster.jpg' },
  word: 'à voir',
  createdAt: 1_700_000_000_500,
};
const homeRecommendations: HomeRecommendationsResponse = { items: [homeRecommendation], next: 1_700_000_000_500 };

const recommendationInput: RecommendationInput = { type: 'movie', tmdbId: 603, title: 'Matrix', word: 'à voir' };

const eveningGuest: EveningGuest = { profile: homeFriend, response: 'yes', respondedAt: 1_700_000_000_100 };
const evening: Evening = {
  id: 'e1',
  title: 'Soirée Dune',
  startsAt: 1_700_000_000_000,
  tz: 'Europe/Paris',
  host: homeFriend,
  isHost: false,
  myResponse: 'pending',
  guests: [eveningGuest],
  status: 'scheduled',
  overridden: false,
};
const seriesEvening: Evening = {
  id: 'e2',
  seriesId: 's1',
  title: 'Soirée Dune',
  startsAt: 1_700_000_000_000,
  tz: 'Europe/Paris',
  host: homeFriend,
  isHost: true,
  guests: [],
  recurrence: { freq: 'weekly', interval: 2, until: 1_710_000_000_000 },
  status: 'scheduled',
  overridden: true,
  party: { partyId: 'p1', title: 'Soirée Dune' },
};
const eveningPage: EveningPage = { items: [evening, seriesEvening], nextCursor: 'c2' };
const lastEveningPage: EveningPage = { items: [seriesEvening], nextCursor: null };

const createBody: CreateEveningBody = {
  title: 'Soirée Dune',
  startsAt: 1_700_000_000_000,
  tz: 'Europe/Paris',
  guests: ['p-ana'],
  recurrence: { freq: 'weekly', interval: 1 },
};
const updateBody: UpdateEveningBody = { startsAt: 1_700_003_600_000, scope: 'occurrence' };
const responseBody: EveningResponseBody = { response: 'maybe' };

const eveningEvents: EveningEvent[] = [
  { type: 'evening_invite', eveningId: 'e1', title: 'Soirée Dune', startsAt: 1_700_000_000_000, tz: 'Europe/Paris', host: homeFriend },
  { type: 'evening_update', eveningId: 'e1', change: 'cancelled' },
  { type: 'evening_response', eveningId: 'e1', pid: 'p-ana', response: 'yes' },
  { type: 'evening_reminder', eveningId: 'e1', title: 'Soirée Dune', startsAt: 1_700_000_000_000, tz: 'Europe/Paris' },
  { type: 'evening_open', eveningId: 'e1', party: { partyId: 'p1', title: 'Soirée Dune' } },
];

/**
 * Identifiant de la soirée d'une trame. Compile seulement si chaque trame est traitée : une trame ajoutée ou retirée de
 * `EveningEvent` casse la compilation ici.
 */
function eveningIdOf(event: EveningEvent): string {
  switch (event.type) {
    case 'evening_invite':
    case 'evening_update':
    case 'evening_response':
    case 'evening_reminder':
    case 'evening_open':
      return event.eveningId;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

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

describe('accueil social (formes de réponse et écarts refusés)', () => {
  it('chaque réponse de l\'accueil se construit avec ses champs', () => {
    expect(homeWatchingPage.items[0].live).toBe(true);
    expect(homeProgressPage.items[0].finished).toBe(true);
    expect(homeRecommendations.next).toBe(1_700_000_000_500);
    expect(recommendationInput.word).toBe('à voir');
  });

  it('HomeFriend ne porte que l\'identité minimale, sans statut', () => {
    // @ts-expect-error status n'appartient pas à HomeFriend
    const withStatus: HomeFriend = { pid: 'p-ana', handle, avatarColor: '#e11d48', status: 'online' };
    expect(withStatus.pid).toBe('p-ana');
  });

  it('HomeWatchingItem exige `live`', () => {
    // @ts-expect-error live est requis
    const noLive: HomeWatchingItem = { friend: homeFriend, media: homeWatching.media, pos: 0, finished: false, updatedAt: 1 };
    expect(noLive.pos).toBe(0);
  });

  it('RecommendationInput exige `word`', () => {
    // @ts-expect-error word est requis
    const noWord: RecommendationInput = { type: 'movie', tmdbId: 603, title: 'Matrix' };
    expect(noWord.tmdbId).toBe(603);
  });

  it('HomeMedia.type reste un genre connu', () => {
    // @ts-expect-error genre inconnu
    const badMedia: HomeMedia = { type: 'anime', tmdbId: 1 };
    expect(badMedia.tmdbId).toBe(1);
  });
});

describe('soirées planifiées (formes de réponse et trames)', () => {
  it('chaque forme de soirée se construit avec ses champs', () => {
    expect(evening.guests[0].response).toBe('yes');
    expect(seriesEvening.recurrence?.interval).toBe(2);
    expect(seriesEvening.party?.partyId).toBe('p1');
    expect(eveningPage.nextCursor).toBe('c2');
    expect(lastEveningPage.nextCursor).toBeNull();
    expect(createBody.guests).toEqual(['p-ana']);
    expect(updateBody.scope).toBe('occurrence');
    expect(responseBody.response).toBe('maybe');
  });

  it('chaque trame temps réel s\'identifie par son `type` et porte l\'identifiant de sa soirée', () => {
    expect(eveningEvents.map((event) => event.type)).toEqual([
      'evening_invite',
      'evening_update',
      'evening_response',
      'evening_reminder',
      'evening_open',
    ]);
    expect(eveningEvents.map(eveningIdOf)).toEqual(['e1', 'e1', 'e1', 'e1', 'e1']);
  });
});

describe('soirées planifiées : écarts de forme refusés à la compilation', () => {
  it('EveningResponseBody n\'accepte pas `pending`', () => {
    // @ts-expect-error `pending` n'est pas une réponse envoyable
    const badBody: EveningResponseBody = { response: 'pending' };
    expect(badBody.response).toBe('pending');
  });

  it('EveningResponse se limite aux valeurs connues', () => {
    // @ts-expect-error « later » n'est pas une réponse
    const badResponse: EveningResponse = 'later';
    expect(badResponse).toBe('later');
  });

  it('EveningRecurrence ne prend un intervalle que de 1 ou 2', () => {
    // @ts-expect-error interval ne peut pas valoir 3
    const badRecurrence: EveningRecurrence = { freq: 'weekly', interval: 3 };
    expect(badRecurrence.freq).toBe('weekly');
  });

  it('Evening.startsAt est un nombre (ms UTC), pas une chaîne', () => {
    // @ts-expect-error startsAt doit être un nombre
    const bad: Evening = { ...evening, startsAt: '2026-10-27T20:00:00Z' };
    expect(bad.id).toBe('e1');
  });

  it('Evening exige `tz` (fuseau IANA)', () => {
    // @ts-expect-error tz est requis
    const noTz: Evening = { id: 'e3', title: 'Soirée', startsAt: 1, host: homeFriend, isHost: false, guests: [], status: 'scheduled', overridden: false };
    expect(noTz.id).toBe('e3');
  });

  it('Evening.status ne prend que `scheduled` ou `cancelled`', () => {
    // @ts-expect-error statut inconnu
    const badStatus: Evening = { ...evening, status: 'draft' };
    expect(badStatus.status).toBe('draft');
  });

  it('UpdateEveningBody exige `scope`', () => {
    // @ts-expect-error scope est requis
    const noScope: UpdateEveningBody = { title: 'Autre titre' };
    expect(noScope.title).toBe('Autre titre');
  });

  it('une trame evening_update ne porte que `updated` ou `cancelled`', () => {
    // @ts-expect-error change inconnu
    const badChange: EveningEvent = { type: 'evening_update', eveningId: 'e1', change: 'moved' };
    expect(badChange.type).toBe('evening_update');
  });

  it('EveningPage exige `nextCursor` (`null` en fin de liste)', () => {
    // @ts-expect-error nextCursor est requis
    const noCursor: EveningPage = { items: [] };
    expect(noCursor.items).toEqual([]);
  });

  it('EveningPage.nextCursor n\'accepte pas `undefined`', () => {
    // @ts-expect-error undefined n'est pas une valeur de curseur : utiliser null
    const undefinedCursor: EveningPage = { items: [], nextCursor: undefined };
    expect(undefinedCursor.items).toEqual([]);
  });

  it('une trame evening_response n\'accepte pas `pending`', () => {
    // @ts-expect-error `pending` n'est pas une réponse à une invitation
    const pendingFrame: EveningEvent = { type: 'evening_response', eveningId: 'e1', pid: 'p-ana', response: 'pending' };
    expect(pendingFrame.type).toBe('evening_response');
  });

  it('evening_invite exige `tz`', () => {
    // @ts-expect-error tz est requis
    const noTzInvite: EveningEvent = { type: 'evening_invite', eveningId: 'e1', title: 'Soirée Dune', startsAt: 1, host: homeFriend };
    expect(noTzInvite.type).toBe('evening_invite');
  });

  it('evening_reminder exige `tz`', () => {
    // @ts-expect-error tz est requis
    const noTzReminder: EveningEvent = { type: 'evening_reminder', eveningId: 'e1', title: 'Soirée Dune', startsAt: 1 };
    expect(noTzReminder.type).toBe('evening_reminder');
  });

  it('une trame de type inconnu est refusée', () => {
    // @ts-expect-error type de trame inconnu
    const unknownFrame: EveningEvent = { type: 'evening_started', eveningId: 'e1' };
    expect(unknownFrame.type).toBe('evening_started');
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
