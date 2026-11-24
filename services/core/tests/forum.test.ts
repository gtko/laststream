import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartyBackend, PartyRoomStub } from '../src/party/backend.js';
import type { RoomInfo, RoomMeta } from '../src/party/protocol.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Cast, castOf, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';

/** Forum communautaire (LAST-1651) : lecture, écriture, réactions, signalements, modération, accès abonné. */

interface Author {
  pid: string;
  handle?: { full: string };
  role: 'owner' | 'mod' | 'member';
}
interface Topic {
  id: string;
  categoryId: string;
  title: string;
  author: Author;
  replyCount: number;
  pinned: boolean;
  locked: boolean;
  hidden: boolean;
  lastPoster: Author;
  event?: { startsAt: number; roomId: string | null; going: number; mine?: boolean };
}
interface Post {
  id: string;
  author: Author;
  body: string;
  hidden: '' | 'author' | 'mod' | 'auto';
  reactions: { emoji: string; count: number; mine: boolean }[];
  canEdit: boolean;
  reported: boolean;
  editedAt?: number;
}
interface TopicDetail extends Topic {
  attendees?: Author[];
  posts: Post[];
  more: boolean;
}
interface Home {
  me: { pid: string; role: string; bannedUntil?: number | null };
  categories: { id: string; topicCount: number; postCount: number; staffOnly: boolean }[];
  openReports?: number;
  pulse: {
    stats: { topics: number; posts: number; members: number; postsToday: number };
    recent: (Topic & { excerpt: string })[];
    trending: (Topic & { heat: number })[];
    activeMembers: { author: Author; posts: number }[];
    events: Topic[];
  };
}
interface ErrorBody {
  error: string;
}

const NOW = '2026-11-24T10:00:00.000Z';

let app: RunningApp;
let cast: Cast;
let rooms: Map<string, RoomMeta>;

/** Salons simulés : un salon existe de son `init` à son `close`. */
function fakeParty(): PartyBackend {
  return {
    room: (id) =>
      ({
        init: (meta: RoomMeta) => {
          if (rooms.has(meta.id)) return Promise.resolve('exists');
          rooms.set(meta.id, meta);
          return Promise.resolve('ok');
        },
        info: () => {
          const meta = rooms.get(id);
          return Promise.resolve(meta === undefined ? null : ({ id, title: meta.title, visibility: meta.visibility } as unknown as RoomInfo));
        },
        close: () => Promise.resolve(rooms.delete(id) ? 'ok' : 'not_found'),
      }) as unknown as PartyRoomStub,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  rooms = new Map();
  app = await startApp({ extra: { party: fakeParty() } });
  cast = await castOf(app);
  // Le forum n'existe que sur le service en ligne (Stripe configuré) ; accès libre pour tous pendant les tests.
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  vi.stubEnv('STRIPE_PRICE_ID', 'price_test');
  vi.stubEnv('LASTADDON_BILLING_FREE_UNTIL', '2030-01-01T00:00:00.000Z');
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await app.close();
});

async function newTopic(
  who: Persona,
  categoryId = 'bugs',
  title = 'La lecture coupe sur Android',
  body = 'Bonjour,\n\nla vidéo **s’arrête** après 10 min.',
): Promise<Topic> {
  const res = await as<{ topic: Topic }>(app, who, 'POST', '/user/forum/topics', { body: { categoryId, title, body } });
  expect(res.status).toBe(201);
  return res.body.topic;
}

async function reply(who: Persona, topicId: string, body: string): Promise<Post> {
  const res = await as<{ post: Post }>(app, who, 'POST', `/user/forum/topics/${topicId}/posts`, { body: { body } });
  expect(res.status).toBe(201);
  return res.body.post;
}

const read = async (who: Persona, topicId: string): Promise<TopicDetail> => {
  const res = await as<{ topic: TopicDetail }>(app, who, 'GET', `/user/forum/topics/${topicId}`);
  expect(res.status).toBe(200);
  return res.body.topic;
};

describe('forum : lecture et écriture', () => {
  it('accueil : catégories dans l’ordre, rôle du profil (propriétaire, membre)', async () => {
    const home = await as<Home>(app, cast.alice, 'GET', '/user/forum');
    expect(home.status).toBe(200);
    expect(home.body.categories.map((c) => c.id)).toEqual([
      'annonces',
      'bugs',
      'idees',
      'aide',
      'guides',
      'extensions',
      'films',
      'watch-parties',
      'hors-sujet',
    ]);
    expect(home.body.me.role).toBe('owner');
    expect(home.body.openReports).toBe(0);
    const bob = await as<Home>(app, cast.bob, 'GET', '/user/forum');
    expect(bob.body.me.role).toBe('member');
    expect(bob.body.openReports).toBeUndefined();
  });

  it('profil enfant et requête sans profil refusés', async () => {
    expect((await as<ErrorBody>(app, cast.kid, 'GET', '/user/forum')).status).toBe(403);
  });

  it('sujet, réponses, compteurs et pages', async () => {
    const topic = await newTopic(cast.bob);
    expect(topic.author.handle?.full).toBe(cast.bob.full);
    vi.setSystemTime(new Date(Date.parse(NOW) + 1000));
    await reply(cast.carol, topic.id, 'Pareil chez moi, sur une Shield.');
    const detail = await read(cast.alice, topic.id);
    expect(detail.replyCount).toBe(1);
    expect(detail.lastPoster.pid).toBe(cast.carol.pid);
    expect(detail.posts.map((p) => p.author.pid)).toEqual([cast.bob.pid, cast.carol.pid]);
    expect(detail.posts[0]?.body).toContain('**s’arrête**');
    const list = await as<{ topics: Topic[]; more: boolean }>(app, cast.carol, 'GET', '/user/forum/categories/bugs/topics');
    expect(list.body.topics.map((t) => t.id)).toEqual([topic.id]);
    const home = await as<Home>(app, cast.carol, 'GET', '/user/forum');
    expect(home.body.categories.find((c) => c.id === 'bugs')).toMatchObject({ topicCount: 1, postCount: 2 });
    expect((await as(app, cast.bob, 'GET', '/user/forum/categories/inconnue/topics')).status).toBe(404);
  });

  it('textes validés : titre trop court, message vide, catégorie réservée à l’équipe', async () => {
    const short = await as<ErrorBody>(app, cast.bob, 'POST', '/user/forum/topics', { body: { categoryId: 'aide', title: 'ab', body: 'texte' } });
    expect(short.status).toBe(400);
    const empty = await as<ErrorBody>(app, cast.bob, 'POST', '/user/forum/topics', { body: { categoryId: 'aide', title: 'Une question', body: '   ' } });
    expect(empty.status).toBe(400);
    const staff = await as<ErrorBody>(app, cast.bob, 'POST', '/user/forum/topics', { body: { categoryId: 'annonces', title: 'Annonce', body: 'texte' } });
    expect(staff.status).toBe(403);
    expect(staff.body.error).toBe('staff_only');
    await newTopic(cast.alice, 'annonces', 'Bienvenue sur le forum', 'Présentez-vous !');
  });

  it('limite : 5 sujets par heure pour un membre', async () => {
    for (let i = 0; i < 5; i++) await newTopic(cast.bob, 'hors-sujet', `Sujet ${i + 1}`);
    const sixth = await as<ErrorBody>(app, cast.bob, 'POST', '/user/forum/topics', { body: { categoryId: 'hors-sujet', title: 'Sujet 6', body: 'x' } });
    expect(sixth.status).toBe(429);
  });

  it('modifier et supprimer son message ; un autre membre ne peut pas', async () => {
    const topic = await newTopic(cast.bob);
    const post = await reply(cast.carol, topic.id, 'Réponse');
    expect((await as(app, cast.bob, 'PATCH', `/user/forum/posts/${post.id}`, { body: { body: 'piraté' } })).status).toBe(403);
    const edited = await as<{ post: Post }>(app, cast.carol, 'PATCH', `/user/forum/posts/${post.id}`, { body: { body: 'Réponse corrigée' } });
    expect(edited.status).toBe(200);
    expect(edited.body.post.body).toBe('Réponse corrigée');
    expect(edited.body.post.editedAt).toBeDefined();
    const removed = await as<{ topicRemoved: boolean }>(app, cast.carol, 'DELETE', `/user/forum/posts/${post.id}`);
    expect(removed.body.topicRemoved).toBe(false);
    const after = await read(cast.bob, topic.id);
    expect(after.posts[1]).toMatchObject({ hidden: 'author', body: '' });
  });

  it('supprimer le premier message d’un sujet sans réponse retire le sujet', async () => {
    const topic = await newTopic(cast.bob);
    const first = (await read(cast.bob, topic.id)).posts[0];
    const removed = await as<{ topicRemoved: boolean }>(app, cast.bob, 'DELETE', `/user/forum/posts/${first?.id}`);
    expect(removed.body.topicRemoved).toBe(true);
    expect((await as(app, cast.carol, 'GET', `/user/forum/topics/${topic.id}`)).status).toBe(404);
  });

  it('réactions : palette fixe, une par emoji et par profil', async () => {
    const topic = await newTopic(cast.bob);
    const postId = (await read(cast.bob, topic.id)).posts[0]?.id;
    const on = await as<{ reactions: Post['reactions'] }>(app, cast.carol, 'PUT', `/user/forum/posts/${postId}/reactions`, { body: { emoji: '👍', on: true } });
    expect(on.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    await as(app, cast.carol, 'PUT', `/user/forum/posts/${postId}/reactions`, { body: { emoji: '👍', on: true } });
    await as(app, cast.alice, 'PUT', `/user/forum/posts/${postId}/reactions`, { body: { emoji: '👍', on: true } });
    expect((await read(cast.bob, topic.id)).posts[0]?.reactions).toEqual([{ emoji: '👍', count: 2, mine: false }]);
    expect((await as(app, cast.carol, 'PUT', `/user/forum/posts/${postId}/reactions`, { body: { emoji: '💩', on: true } })).status).toBe(400);
    const off = await as<{ reactions: Post['reactions'] }>(app, cast.carol, 'PUT', `/user/forum/posts/${postId}/reactions`, {
      body: { emoji: '👍', on: false },
    });
    expect(off.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('recherche dans les titres et les messages', async () => {
    await newTopic(cast.bob, 'aide', 'Sous-titres décalés', 'Comment recaler les sous-titres ?');
    await newTopic(cast.bob, 'films', 'Votre film culte', 'Le mien : Metropolis (1927).');
    const byTitle = await as<{ topics: Topic[] }>(app, cast.carol, 'GET', '/user/forum/search?q=sous-titres');
    expect(byTitle.body.topics.map((t) => t.title)).toEqual(['Sous-titres décalés']);
    const byBody = await as<{ topics: Topic[] }>(app, cast.carol, 'GET', '/user/forum/search?q=metropolis');
    expect(byBody.body.topics.map((t) => t.title)).toEqual(['Votre film culte']);
    expect((await as(app, cast.carol, 'GET', '/user/forum/search?q=%25')).status).toBe(400);
  });
});

describe('forum : modération', () => {
  it('trois signalements masquent un message ; l’équipe voit la file et tranche', async () => {
    const topic = await newTopic(cast.bob, 'hors-sujet', 'Liens gratuits', 'Voici un lien douteux');
    const postId = (await read(cast.bob, topic.id)).posts[0]?.id ?? '';
    expect((await as(app, cast.bob, 'POST', `/user/forum/posts/${postId}/report`, { body: { reason: 'spam' } })).status).toBe(403);
    for (const who of [cast.carol, cast.alice2]) {
      expect((await as(app, who, 'POST', `/user/forum/posts/${postId}/report`, { body: { reason: 'piracy', details: 'lien pirate' } })).status).toBe(204);
    }
    expect((await read(cast.carol, topic.id)).posts[0]).toMatchObject({ hidden: '', reported: true });
    await as(app, cast.alice, 'POST', `/user/forum/posts/${postId}/report`, { body: { reason: 'spam' } });
    const hiddenForMember = (await read(cast.carol, topic.id)).posts[0];
    expect(hiddenForMember).toMatchObject({ hidden: 'auto', body: '' });
    // L'équipe voit encore le texte, et la file de modération.
    expect((await read(cast.alice, topic.id)).posts[0]?.body).toBe('Voici un lien douteux');
    expect((await as(app, cast.carol, 'GET', '/user/forum/mod/reports')).status).toBe(403);
    const queue = await as<{ reports: { postId: string; count: number; reasons: string[] }[] }>(app, cast.alice, 'GET', '/user/forum/mod/reports');
    expect(queue.body.reports).toEqual([expect.objectContaining({ postId, count: 3, reasons: expect.arrayContaining(['piracy', 'spam']) })]);
    // Classé sans suite : rétabli.
    expect((await as(app, cast.alice, 'POST', `/user/forum/mod/reports/${postId}/dismiss`)).status).toBe(204);
    expect((await read(cast.carol, topic.id)).posts[0]?.hidden).toBe('');
    expect((await as<Home>(app, cast.alice, 'GET', '/user/forum')).body.openReports).toBe(0);
    // Masqué par un modérateur.
    expect((await as(app, cast.alice, 'POST', `/user/forum/posts/${postId}/moderate`, { body: { hide: true } })).status).toBe(204);
    expect((await read(cast.carol, topic.id)).posts[0]?.hidden).toBe('mod');
  });

  it('épingler, verrouiller, déplacer un sujet', async () => {
    const old = await newTopic(cast.bob, 'aide', 'Ancien sujet');
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    const recent = await newTopic(cast.carol, 'aide', 'Sujet récent');
    expect((await as(app, cast.bob, 'PATCH', `/user/forum/topics/${old.id}`, { body: { pinned: true } })).status).toBe(403);
    await as(app, cast.alice, 'PATCH', `/user/forum/topics/${old.id}`, { body: { pinned: true, locked: true } });
    const list = await as<{ topics: Topic[] }>(app, cast.carol, 'GET', '/user/forum/categories/aide/topics');
    expect(list.body.topics.map((t) => t.id)).toEqual([old.id, recent.id]);
    const locked = await as<ErrorBody>(app, cast.carol, 'POST', `/user/forum/topics/${old.id}/posts`, { body: { body: 'encore une question' } });
    expect(locked.status).toBe(403);
    expect(locked.body.error).toBe('topic_locked');
    await reply(cast.alice, old.id, 'Réponse de l’équipe malgré le verrou');
    const moved = await as<{ topic: Topic }>(app, cast.alice, 'PATCH', `/user/forum/topics/${recent.id}`, { body: { categoryId: 'bugs' } });
    expect(moved.body.topic.categoryId).toBe('bugs');
  });

  it('exclusion : lecture permise, écriture refusée, levée', async () => {
    const topic = await newTopic(cast.carol);
    const ban = await as<{ until: number }>(app, cast.alice, 'PUT', `/user/forum/mod/bans/${cast.bob.pid}`, { body: { days: 7, reason: 'spam' } });
    expect(ban.status).toBe(200);
    expect(ban.body.until).toBe(Date.parse(NOW) + 7 * 86_400_000);
    expect((await as<Home>(app, cast.bob, 'GET', '/user/forum')).body.me.bannedUntil).toBe(ban.body.until);
    await read(cast.bob, topic.id);
    const refused = await as<ErrorBody>(app, cast.bob, 'POST', `/user/forum/topics/${topic.id}/posts`, { body: { body: 'coucou' } });
    expect(refused.body.error).toBe('forum_banned');
    // Le propriétaire ne s'exclut pas.
    expect((await as(app, cast.alice, 'PUT', `/user/forum/mod/bans/${cast.alice.pid}`, { body: { days: 1 } })).status).toBe(403);
    // Exclusion échue au bout de 7 jours.
    vi.setSystemTime(new Date(Date.parse(NOW) + 8 * 86_400_000));
    await reply(cast.bob, topic.id, 'De retour');
    // Levée manuelle.
    await as(app, cast.alice, 'PUT', `/user/forum/mod/bans/${cast.bob.pid}`, { body: { days: null } });
    expect((await as<{ bans: unknown[] }>(app, cast.alice, 'GET', '/user/forum/mod/bans')).body.bans).toHaveLength(1);
    expect((await as(app, cast.alice, 'DELETE', `/user/forum/mod/bans/${cast.bob.pid}`)).status).toBe(204);
    await reply(cast.bob, topic.id, 'Merci');
  });

  it('modérateurs : nommés par le propriétaire seul, par handle', async () => {
    expect((await as(app, cast.bob, 'POST', '/user/forum/mod/moderators', { body: { handle: cast.carol.full } })).status).toBe(403);
    const added = await as<{ moderator: Author }>(app, cast.alice, 'POST', '/user/forum/mod/moderators', { body: { handle: cast.carol.full.toLowerCase() } });
    expect(added.status).toBe(201);
    expect(added.body.moderator).toMatchObject({ pid: cast.carol.pid, role: 'mod' });
    expect((await as<Home>(app, cast.carol, 'GET', '/user/forum')).body.me.role).toBe('mod');
    const topic = await newTopic(cast.bob);
    expect((await as(app, cast.carol, 'PATCH', `/user/forum/topics/${topic.id}`, { body: { locked: true } })).status).toBe(200);
    // Un modérateur ne nomme personne et ne s'exclut pas entre pairs.
    expect((await as(app, cast.carol, 'POST', '/user/forum/mod/moderators', { body: { handle: cast.bob.full } })).status).toBe(403);
    expect((await as(app, cast.alice, 'DELETE', `/user/forum/mod/moderators/${cast.carol.pid}`)).status).toBe(204);
    expect((await as<Home>(app, cast.carol, 'GET', '/user/forum')).body.me.role).toBe('member');
    expect((await as(app, cast.alice, 'POST', '/user/forum/mod/moderators', { body: { handle: 'Personne#ABCD' } })).status).toBe(404);
  });
});

describe('forum : accès abonné', () => {
  it('serveur auto-hébergé (sans Stripe) : forum désactivé pour tous, propriétaire compris', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_PRICE_ID', '');
    for (const who of [cast.alice, cast.bob]) {
      const res = await as<ErrorBody>(app, who, 'GET', '/user/forum');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('forum_unavailable');
    }
    expect((await as<ErrorBody>(app, cast.bob, 'POST', '/user/forum/topics', { body: { categoryId: 'aide', title: 'Question', body: 'texte' } })).status).toBe(404);
  });

  it('Stripe configuré : 402 pour un compte sans abonnement, le propriétaire passe', async () => {
    vi.stubEnv('LASTADDON_BILLING_FREE_UNTIL', '');
    const blocked = await as<ErrorBody>(app, cast.bob, 'GET', '/user/forum');
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe('subscription_required');
    expect((await as(app, cast.alice, 'GET', '/user/forum')).status).toBe(200);
  });
});

describe('forum : accueil vivant et watch parties', () => {
  const HOUR = 60 * 60 * 1000;
  const at = (offsetMs: number): void => {
    vi.setSystemTime(new Date(Date.parse(NOW) + offsetMs));
  };

  it('accueil : chiffres, dernières discussions avec extrait sans spoiler, sujets en vue, membres actifs', async () => {
    const first = await newTopic(cast.bob, 'films', 'Fin de la saison 2', 'La fin ? ||le héros meurt|| et **quelle** scène.');
    at(1000);
    const second = await newTopic(cast.carol, 'aide', 'Profil enfant', 'Comment créer un profil enfant ?');
    at(2000);
    await reply(cast.carol, first.id, 'Je n’en reviens toujours pas.');
    at(3000);
    await reply(cast.alice, first.id, 'Ajoutez des balises spoiler, merci !');
    const home = await as<Home>(app, cast.bob, 'GET', '/user/forum');
    const pulse = home.body.pulse;
    expect(pulse.stats).toEqual({ topics: 2, posts: 4, members: 3, postsToday: 4 });
    expect(pulse.recent.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(pulse.recent[0]?.excerpt).toBe('Ajoutez des balises spoiler, merci !');
    expect(pulse.trending.map((t) => [t.id, t.heat])).toEqual([
      [first.id, 3],
      [second.id, 1],
    ]);
    expect(pulse.activeMembers.map((m) => [m.author.pid, m.posts])).toEqual([
      [cast.carol.pid, 2],
      [cast.bob.pid, 1],
      [cast.alice.pid, 1],
    ]);
    // L'extrait masque un spoiler et retire le Markdown.
    at(4000);
    await reply(cast.bob, second.id, '||secret|| et **gras**');
    const again = await as<Home>(app, cast.bob, 'GET', '/user/forum');
    expect(again.body.pulse.recent[0]?.excerpt).toBe('[spoiler] et gras');
  });

  it('séance : date obligatoire dans la catégorie, refusée ailleurs, auteur inscrit', async () => {
    const post = (categoryId: string, startsAt?: number) =>
      as<ErrorBody>(app, cast.bob, 'POST', '/user/forum/topics', {
        body: { categoryId, title: 'Soirée Ghibli', body: 'On regarde Totoro ensemble.', ...(startsAt ? { startsAt } : {}) },
      });
    expect((await post('watch-parties')).status).toBe(400);
    expect((await post('films', Date.parse(NOW) + 2 * HOUR)).status).toBe(400);
    expect((await post('watch-parties', Date.parse(NOW) + 60_000)).status).toBe(400);
    expect((await post('watch-parties', Date.parse(NOW) + 100 * 24 * HOUR)).status).toBe(400);
    const created = await as<{ topic: Topic }>(app, cast.bob, 'POST', '/user/forum/topics', {
      body: { categoryId: 'watch-parties', title: 'Soirée Ghibli', body: 'On regarde Totoro ensemble.', startsAt: Date.parse(NOW) + 2 * HOUR },
    });
    expect(created.status).toBe(201);
    expect(created.body.topic.event).toEqual({ startsAt: Date.parse(NOW) + 2 * HOUR, roomId: null, going: 1 });
    const detail = await read(cast.carol, created.body.topic.id);
    expect(detail.event?.mine).toBe(false);
    expect(detail.attendees?.map((a) => a.pid)).toEqual([cast.bob.pid]);
  });

  it('inscription, désinscription, accueil des prochaines séances', async () => {
    const created = await as<{ topic: Topic }>(app, cast.bob, 'POST', '/user/forum/topics', {
      body: { categoryId: 'watch-parties', title: 'Marathon Alien', body: 'Les quatre films, pause pizza.', startsAt: Date.parse(NOW) + 3 * HOUR },
    });
    const id = created.body.topic.id;
    const on = await as<{ event: { going: number; mine: boolean } }>(app, cast.carol, 'PUT', `/user/forum/topics/${id}/rsvp`, { body: { on: true } });
    expect(on.status).toBe(200);
    expect(on.body.event).toMatchObject({ going: 2, mine: true });
    const home = await as<Home>(app, cast.carol, 'GET', '/user/forum');
    expect(home.body.pulse.events.map((t) => [t.id, t.event?.going, t.event?.mine])).toEqual([[id, 2, true]]);
    const off = await as<{ event: { going: number; mine: boolean } }>(app, cast.carol, 'PUT', `/user/forum/topics/${id}/rsvp`, { body: { on: false } });
    expect(off.body.event).toMatchObject({ going: 1, mine: false });
    expect((await as(app, cast.carol, 'PUT', `/user/forum/topics/${(await newTopic(cast.bob)).id}/rsvp`, { body: { on: true } })).status).toBe(404);
    // Passé de plus de 3 h : la séance quitte l'accueil et n'accepte plus d'inscription.
    at(7 * HOUR);
    expect((await as<Home>(app, cast.carol, 'GET', '/user/forum')).body.pulse.events).toEqual([]);
    expect((await as<ErrorBody>(app, cast.carol, 'PUT', `/user/forum/topics/${id}/rsvp`, { body: { on: true } })).status).toBe(409);
  });

  it('salon : ouvert par l’auteur dans la fenêtre, public, idempotent, remplacé une fois terminé', async () => {
    const created = await as<{ topic: Topic }>(app, cast.bob, 'POST', '/user/forum/topics', {
      body: { categoryId: 'watch-parties', title: 'Soirée Ghibli', body: 'On regarde Totoro ensemble.', startsAt: Date.parse(NOW) + 2 * HOUR },
    });
    const id = created.body.topic.id;
    const early = await as<ErrorBody>(app, cast.bob, 'POST', `/user/forum/topics/${id}/open`);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('event_not_open');
    at(2 * HOUR - 10 * 60_000);
    expect((await as<ErrorBody>(app, cast.carol, 'POST', `/user/forum/topics/${id}/open`)).status).toBe(403);
    const opened = await as<{ roomId: string }>(app, cast.bob, 'POST', `/user/forum/topics/${id}/open`);
    expect(opened.status).toBe(200);
    const roomId = opened.body.roomId;
    expect(rooms.get(roomId)).toMatchObject({ title: 'Soirée Ghibli', visibility: 'public' });
    expect((await read(cast.carol, id)).event?.roomId).toBe(roomId);
    expect((await as<{ roomId: string }>(app, cast.bob, 'POST', `/user/forum/topics/${id}/open`)).body.roomId).toBe(roomId);
    rooms.delete(roomId);
    const reopened = await as<{ roomId: string }>(app, cast.bob, 'POST', `/user/forum/topics/${id}/open`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.roomId).not.toBe(roomId);
    expect(rooms.size).toBe(1);
  });
});
