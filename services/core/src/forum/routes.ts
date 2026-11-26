import type { AppDeps } from '../deps.js';
import type { App, Ctx } from '../http/app-env.js';
import { billingConfig } from '../billing/config.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { createPartyRoom } from '../party/create-room.js';
import { DEFAULT_MAX_PARTICIPANTS } from '../party/protocol.js';
import { platform } from '../platform/index.js';
import type { UserBackend } from '../user/repo.js';
import { sessionOf } from '../user/session.js';
import { parseHandle } from '../user/social-handles.js';
import { actorOf, pidParam } from '../user/social-v2-routes.js';
import { parseWith, UserApiError } from '../user/validation.js';
import { type ForumMe, type ForumWrite, isStaff } from './store.js';
import {
  banSchema,
  cleanForumText,
  feedbackSchema,
  moderatePostSchema,
  moderatorSchema,
  postSchema,
  reactionSchema,
  reportSchema,
  rsvpSchema,
  searchQuery,
  topicCreateSchema,
  topicModSchema,
  topicQuery,
  topicsQuery,
} from './validation.js';

/**
 * Routes du forum communautaire (`/user/forum`, LAST-1651). Chaque route agit au nom d'un profil non enfant (X-Profile-Id,
 * comme le social) et ouvre une session : un compte sans abonnement de soutien reçoit donc 402 `subscription_required`
 * avant toute lecture (voir billing/access.ts). Le forum est réservé au service en ligne : sans Stripe (serveur
 * auto-hébergé), il est désactivé (404 `forum_unavailable`). Les routes `/forum/mod/*` et les actions de modération demandent le rôle `owner` ou `mod`.
 */
export function registerForumRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const forum = () => backend.forum();

  /**
   * Profil agissant, son rôle et son éventuelle exclusion. Le forum n'existe que sur le service en ligne (abonnement de
   * soutien configuré) : un serveur auto-hébergé, sans Stripe, répond 404 `forum_unavailable` à toutes les routes.
   */
  const meOf = async (c: Ctx): Promise<ForumMe> => {
    if (billingConfig() === undefined) throw new UserApiError(404, 'forum_unavailable');
    const actor = await actorOf(c, backend.users(), backend.socialV2(), deps.secret);
    return forum().me(actor.accountId, actor.pid, actor.lockedProfileId !== null, Date.now());
  };
  const staffOf = async (c: Ctx): Promise<ForumMe> => {
    const me = await meOf(c);
    if (!isStaff(me.role)) throw new UserApiError(403, 'moderator_only');
    return me;
  };

  /** Traduit un refus du store en erreur HTTP ; rend le résultat sinon. */
  function ok<T extends object>(outcome: ForumWrite<T>, notFound = 'not_found'): T {
    switch (outcome.result) {
      case 'ok':
        return outcome;
      case 'not_found':
        throw new UserApiError(404, notFound);
      case 'forbidden':
        throw new UserApiError(403, 'forbidden');
      case 'locked':
        throw new UserApiError(403, 'topic_locked');
      case 'banned':
        throw new UserApiError(403, 'forum_banned');
      case 'staff_only':
        throw new UserApiError(403, 'staff_only');
      case 'invalid_event':
        throw new UserApiError(400, 'invalid_body', ['startsAt:invalid']);
      case 'event_not_open':
        throw new UserApiError(409, 'event_not_open');
      case 'rate_limited':
        throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    }
  }

  const text = (raw: string, field: 'title' | 'body'): string => {
    const { text: cleaned, issues } = cleanForumText(raw, field);
    if (issues.length > 0) throw new UserApiError(400, 'invalid_body', issues);
    return cleaned;
  };

  /**
   * Accueil du forum : profil (rôle, exclusion), catégories, activité (`pulse` : chiffres, dernières discussions, sujets en
   * vue, membres actifs, prochaines watch parties), et pour l'équipe le nombre de messages signalés.
   */
  router.get('/forum', async (c) => {
    const me = await meOf(c);
    const body: Record<string, unknown> = {
      me,
      categories: await forum().categories(),
      pulse: await forum().pulse(me, Date.now()),
    };
    if (isStaff(me.role)) body.openReports = await forum().openReportCount();
    return sendJson(c, body);
  });

  /** Sujets d'une catégorie : `{ topics, more }` (épinglés en tête de la première page ; `?before=` lastPostAt). */
  router.get('/forum/categories/:id/topics', async (c) => {
    const me = await meOf(c);
    const query = parseWith(topicsQuery, queryParams(c));
    const page = await forum().topics(String(c.req.param('id')), me.role, query.before);
    if (page === undefined) throw new UserApiError(404, 'category_not_found');
    return sendJson(c, page);
  });

  /** Recherche (titres et messages) : `{ topics }`. */
  router.get('/forum/search', async (c) => {
    const me = await meOf(c);
    const query = parseWith(searchQuery, queryParams(c));
    return sendJson(c, { topics: await forum().search(query.q, me.role) });
  });

  /** Ouvre un sujet. 201 `{ topic }`. */
  router.post('/forum/topics', async (c) => {
    const me = await meOf(c);
    const input = parseWith(topicCreateSchema, c.get('body'));
    const outcome = ok(
      await forum().createTopic(me, input.categoryId, text(input.title, 'title'), text(input.body, 'body'), Date.now(), input.startsAt),
      'category_not_found',
    );
    return sendJson(c, { topic: outcome.topic }, 201);
  });

  /**
   * Feedback envoyé depuis l'app (LAST-1654) : bug ou idée publié au nom du profil. Un bug de même empreinte (`code`) qu'un
   * sujet ouvert y est ajouté en réponse (« Moi aussi ») ; sinon un sujet est ouvert. Le détail technique est dans Sentry :
   * le forum ne montre que le titre de l'erreur, le message, la version et le type d'appareil. 201 `{ topic, grouped,
   * reporters }`.
   */
  router.post('/forum/feedback', async (c) => {
    const me = await meOf(c);
    const input = parseWith(feedbackSchema, c.get('body'));
    const message = input.message.replace(/\r\n?/g, '\n').trim();
    if (input.kind === 'idea' && message === '') throw new UserApiError(400, 'invalid_body', ['message:too_short']);
    const footer = feedbackFooter(input.version, input.platform);
    const errorTitle = input.title === undefined ? '' : input.title.replace(/\s+/g, ' ').trim();
    const said = message === '' ? '_Pas de description._' : message;
    const body = input.kind === 'bug' && errorTitle !== '' ? `**Erreur :** ${errorTitle}\n\n${said}\n\n${footer}` : `${said}\n\n${footer}`;
    const replyBody = `**Moi aussi.**${message === '' ? '' : `\n\n${message}`}\n\n${footer}`;
    const title = feedbackTitle(input.kind, errorTitle, message);
    const outcome = ok(
      await forum().feedback(
        me,
        {
          kind: input.kind,
          signature: input.kind === 'bug' && input.code !== undefined ? `bug:${input.code}` : '',
          title: text(title, 'title'),
          body: text(body, 'body'),
          replyBody: text(replyBody, 'body'),
          sentryEventId: input.sentryEventId,
        },
        Date.now(),
      ),
    );
    return sendJson(c, { topic: outcome.topic, grouped: outcome.grouped, reporters: outcome.reporters }, 201);
  });

  /** S'inscrit à la séance d'une watch party (`on`), ou se désinscrit. `{ event }`. */
  router.put('/forum/topics/:id/rsvp', async (c) => {
    const me = await meOf(c);
    const input = parseWith(rsvpSchema, c.get('body'));
    const outcome = ok(await forum().rsvp(me, String(c.req.param('id')), input.on, Date.now()), 'event_not_found');
    return sendJson(c, { event: outcome.event });
  });

  /**
   * Ouvre le salon de visionnage d'une séance (auteur du sujet ou équipe), de 15 min avant le début à 3 h après : salon
   * public au titre du sujet, sans titre imposé (chacun lance ce qu'annonce le sujet), rattaché au sujet. Idempotent tant
   * que le salon vit ; un salon terminé est remplacé. `{ roomId }`. 403 `forbidden`, 409 `event_not_open`,
   * 429 `too_many_rooms`, 501 `party_unavailable` sans salons (serveur Node).
   */
  router.post('/forum/topics/:id/open', async (c) => {
    const me = await meOf(c);
    const id = String(c.req.param('id'));
    const now = Date.now();
    const opening = ok(await forum().eventOpening(me, id, now), 'event_not_found');
    const party = deps.party ?? platform().createPartyBackend?.();
    if (party === undefined) throw new UserApiError(501, 'party_unavailable');
    if (opening.roomId !== null) {
      if ((await party.room(opening.roomId).info()) !== null) return sendJson(c, { roomId: opening.roomId });
      await forum().detachRoom(id, opening.roomId);
      // Salon terminé : la fenêtre d'ouverture s'applique de nouveau.
      ok(await forum().eventOpening(me, id, now), 'event_not_found');
    }
    const session = await sessionOf(backend.users(), c);
    const profile = await backend.users().findProfile(session.account.id, c.req.header('x-profile-id') ?? '');
    if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
    const created = await createPartyRoom(
      backend,
      party,
      { account: session.account, profile },
      {
        visibility: 'public',
        title: opening.title,
        poster: null,
        language: null,
        media: { type: 'movie' },
        fingerprint: null,
        maxParticipants: DEFAULT_MAX_PARTICIPANTS,
      },
    );
    const effective = await forum().attachRoom(id, created.id);
    if (effective !== created.id) {
      // Ouverture concurrente : le premier salon rattaché gagne, celui-ci est fermé.
      await party
        .room(created.id)
        .close(session.account.id)
        .catch(() => undefined);
      await backend.social().deletePartyRoom(created.id);
      if (effective === undefined) throw new UserApiError(404, 'event_not_found');
    }
    return sendJson(c, { roomId: effective });
  });

  /** Sujet et une page de messages (`?after=` createdAt du dernier message reçu). */
  router.get('/forum/topics/:id', async (c) => {
    const me = await meOf(c);
    const query = parseWith(topicQuery, queryParams(c));
    const topic = await forum().topic(String(c.req.param('id')), me, query.after);
    if (topic === undefined) throw new UserApiError(404, 'topic_not_found');
    return sendJson(c, { topic });
  });

  /** Répond dans un sujet. 201 `{ post, topic }`. */
  router.post('/forum/topics/:id/posts', async (c) => {
    const me = await meOf(c);
    const input = parseWith(postSchema, c.get('body'));
    const outcome = ok(await forum().reply(me, String(c.req.param('id')), text(input.body, 'body'), Date.now()), 'topic_not_found');
    return sendJson(c, { post: outcome.post, topic: outcome.topic }, 201);
  });

  /** Modération d'un sujet : épingler, verrouiller, masquer, déplacer, renommer. `{ topic }`. */
  router.patch('/forum/topics/:id', async (c) => {
    await staffOf(c);
    const input = parseWith(topicModSchema, c.get('body'));
    const flags = {
      ...input,
      ...(input.title !== undefined ? { title: text(input.title, 'title') } : {}),
    };
    const outcome = ok(await forum().setTopic(String(c.req.param('id')), flags), 'topic_not_found');
    return sendJson(c, { topic: outcome.topic });
  });

  /** Modifie un message (auteur ou équipe). `{ post }`. */
  router.patch('/forum/posts/:id', async (c) => {
    const me = await meOf(c);
    const input = parseWith(postSchema, c.get('body'));
    const outcome = ok(await forum().editPost(me, String(c.req.param('id')), text(input.body, 'body'), Date.now()), 'post_not_found');
    return sendJson(c, { post: outcome.post });
  });

  /** Supprime un message (auteur ou équipe). `{ topicRemoved }` : vrai si le sujet, sans réponse, part avec lui. */
  router.delete('/forum/posts/:id', async (c) => {
    const me = await meOf(c);
    const outcome = ok(await forum().deletePost(me, String(c.req.param('id'))), 'post_not_found');
    return sendJson(c, { topicRemoved: outcome.topicRemoved });
  });

  /** Ajoute ou retire une réaction. `{ reactions }`. */
  router.put('/forum/posts/:id/reactions', async (c) => {
    const me = await meOf(c);
    const input = parseWith(reactionSchema, c.get('body'));
    const outcome = ok(await forum().react(me, String(c.req.param('id')), input.emoji, input.on, Date.now()), 'post_not_found');
    return sendJson(c, { reactions: outcome.reactions });
  });

  /** Signale un message. 204. Les exclus peuvent encore signaler. */
  router.post('/forum/posts/:id/report', async (c) => {
    const me = await meOf(c);
    const input = parseWith(reportSchema, c.get('body'));
    ok(await forum().report(me, String(c.req.param('id')), input.reason, input.details, Date.now()), 'post_not_found');
    return sendEmpty(c, 204);
  });

  /** Masque ou rétablit un message (équipe). 204. */
  router.post('/forum/posts/:id/moderate', async (c) => {
    await staffOf(c);
    const input = parseWith(moderatePostSchema, c.get('body'));
    ok(await forum().moderatePost(String(c.req.param('id')), input.hide), 'post_not_found');
    return sendEmpty(c, 204);
  });

  // ---- Équipe de modération ----

  /** File des messages signalés : `{ reports }`. */
  router.get('/forum/mod/reports', async (c) => {
    await staffOf(c);
    return sendJson(c, { reports: await forum().reports() });
  });

  /** Classe les signalements d'un message sans suite (le message reste, rétabli s'il avait été masqué automatiquement). */
  router.post('/forum/mod/reports/:postId/dismiss', async (c) => {
    await staffOf(c);
    ok(await forum().dismissReports(String(c.req.param('postId'))), 'post_not_found');
    return sendEmpty(c, 204);
  });

  /** Exclusions en cours : `{ bans }`. */
  router.get('/forum/mod/bans', async (c) => {
    await staffOf(c);
    return sendJson(c, { bans: await forum().bans(Date.now()) });
  });

  /** Exclut un profil (`days` : 1 à 365, ou null sans fin). `{ until }`. */
  router.put('/forum/mod/bans/:pid', async (c) => {
    const me = await staffOf(c);
    const pid = pidParam(String(c.req.param('pid')), 'profile_not_found');
    const input = parseWith(banSchema, c.get('body'));
    const outcome = ok(await forum().ban(me.pid, pid, input.days, input.reason, Date.now()), 'profile_not_found');
    return sendJson(c, { until: outcome.until });
  });

  router.delete('/forum/mod/bans/:pid', async (c) => {
    await staffOf(c);
    const pid = pidParam(String(c.req.param('pid')), 'ban_not_found');
    if (!(await forum().unban(pid))) throw new UserApiError(404, 'ban_not_found');
    return sendEmpty(c, 204);
  });

  /** Modérateurs nommés : `{ moderators }` (lecture pour l'équipe ; nomination et retrait par le propriétaire seul). */
  router.get('/forum/mod/moderators', async (c) => {
    await staffOf(c);
    return sendJson(c, { moderators: await forum().moderators() });
  });

  router.post('/forum/mod/moderators', async (c) => {
    const me = await meOf(c);
    if (me.role !== 'owner') throw new UserApiError(403, 'owner_only');
    const input = parseWith(moderatorSchema, c.get('body'));
    const handle = parseHandle(input.handle);
    if (handle === null) throw new UserApiError(400, 'invalid_body', ['handle:invalid']);
    const outcome = ok(await forum().addModerator(handle.key, handle.tag, Date.now()), 'profile_not_found');
    return sendJson(c, { moderator: outcome.moderator }, 201);
  });

  router.delete('/forum/mod/moderators/:pid', async (c) => {
    const me = await meOf(c);
    if (me.role !== 'owner') throw new UserApiError(403, 'owner_only');
    const pid = pidParam(String(c.req.param('pid')), 'moderator_not_found');
    if (!(await forum().removeModerator(pid))) throw new UserApiError(404, 'moderator_not_found');
    return sendEmpty(c, 204);
  });
}

const PLATFORM_LABEL = { web: 'navigateur', windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', tv: 'TV' } as const;

/** Pied d'un feedback : origine, version et type d'appareil (rien d'autre n'est public). */
function feedbackFooter(version: string | undefined, platform: keyof typeof PLATFORM_LABEL | undefined): string {
  const parts = ['Envoyé depuis l’app'];
  if (version !== undefined) parts.push(`version ${version}`);
  if (platform !== undefined) parts.push(PLATFORM_LABEL[platform]);
  return `_${parts.join(' · ')}_`;
}

/** Titre d'un nouveau sujet : titre de l'erreur, sinon début du message (première ligne, 100 caractères), sinon un titre neutre. */
function feedbackTitle(kind: 'bug' | 'idea', errorTitle: string, message: string): string {
  if (kind === 'bug' && errorTitle !== '') return [...errorTitle].slice(0, 120).join('');
  const line = (message.split('\n')[0] ?? '').trim();
  const chars = [...line];
  if (chars.length >= 3) return chars.length > 100 ? `${chars.slice(0, 99).join('').trimEnd()}…` : line;
  return kind === 'bug' ? 'Problème signalé depuis l’app' : 'Idée envoyée depuis l’app';
}
