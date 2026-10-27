import type { Evening, EveningGuest, EveningPage, EveningRecurrence, HomeFriend } from '@laststream/protocol/social';
import type { AppDeps } from '../deps.js';
import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { localSlotOf } from './evening-recurrence.js';
import type { UserBackend } from './repo.js';
import type { EveningChange, EveningFailure, EveningView, SeriesRuleInput } from './social-evenings-store.js';
import {
  eveningCreateSchema,
  eveningDeleteQuery,
  eveningGuestsSchema,
  eveningLeaveSchema,
  eveningListQuery,
  eveningResponseSchema,
  eveningUpdateSchema,
  type EveningUpdateBody,
  isEveningId,
} from './social-evenings-validation.js';
import { actorOf } from './social-v2-routes.js';
import type { Card } from './social-v2-store.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes des soirées planifiées (LAST-198, lot L2), montées sous `/user` : `/social/evenings*`. Profil agissant : en-tête
 * `X-Profile-Id`, comme les autres routes sociales ; un profil enfant reçoit 403 `kid_profile` sur les onze routes.
 *
 * Droits : un non-participant reçoit 404 `evening_not_found` (jamais 403). Un profil qui n'est pas mon ami, ou qui est en
 * attente ou bloqué, reçoit le même corps 403 `not_friend`. Les réponses de mutation sont sans corps (204), sauf la création
 * (201 avec la soirée). `open` renvoie 501 pour l'instant : le salon sera branché au lot suivant.
 */

type ProfileOf = (pid: string) => Promise<HomeFriend | undefined>;

/** Profil public (identité, couleur, avatar s'il existe) d'une carte : champ par champ, sans surnom ni donnée interne. */
function profileOf(card: Card): HomeFriend {
  const profile: HomeFriend = {
    pid: card.pid,
    handle: { name: card.handle.name, tag: card.handle.tag, full: card.handle.full },
    avatarColor: card.avatarColor,
  };
  if (card.avatar !== undefined) profile.avatar = card.avatar;
  return profile;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Erreur HTTP d'un échec du store. Un même échec donne toujours le même statut et le même code. */
function failureOf(outcome: EveningFailure): UserApiError {
  switch (outcome.result) {
    case 'evening_not_found':
      return new UserApiError(404, 'evening_not_found');
    case 'not_host':
      return new UserApiError(403, 'not_host');
    case 'not_friend':
      return new UserApiError(403, 'not_friend');
    case 'evening_closed':
      return new UserApiError(409, 'evening_closed');
    case 'too_many_evenings':
      return new UserApiError(429, 'too_many_evenings');
    case 'invalid_body':
      return new UserApiError(400, 'invalid_body');
  }
}

/** Identifiant de soirée de la route : mal formé ou inconnu, la même réponse 404. */
function eveningIdOf(raw: string): string {
  if (!isEveningId(raw)) throw new UserApiError(404, 'evening_not_found');
  return raw;
}

/** Invité au format du protocole ; `undefined` si son profil public n'existe plus (profil devenu enfant). */
async function guestOf(guest: EveningView['guests'][number], profile: ProfileOf): Promise<EveningGuest | undefined> {
  const person = await profile(guest.pid);
  if (person === undefined) return undefined;
  const entry: EveningGuest = { profile: person, response: guest.response };
  if (guest.respondedAt !== null) entry.respondedAt = guest.respondedAt;
  return entry;
}

/**
 * Soirée au format du protocole, vue par un de ses participants. `undefined` si l'hôte n'a plus de profil public : la
 * soirée n'est alors pas montrée. `myResponse` est absent pour l'hôte ; `party` n'apparaît qu'après rattachement d'un salon.
 */
async function presentEvening(view: EveningView, profile: ProfileOf): Promise<Evening | undefined> {
  const host = await profile(view.hostPid);
  if (host === undefined) return undefined;
  const guests = (await Promise.all(view.guests.map((guest) => guestOf(guest, profile)))).filter(isPresent);
  const evening: Evening = {
    id: view.id,
    title: view.title,
    startsAt: view.startsAt,
    tz: view.tz,
    host,
    isHost: view.role === 'host',
    guests,
    status: view.status,
    overridden: view.overridden,
  };
  if (view.series !== null) {
    evening.seriesId = view.series.id;
    const recurrence: EveningRecurrence = { freq: 'weekly', interval: view.series.interval };
    if (view.series.untilAt !== null) recurrence.until = view.series.untilAt;
    evening.recurrence = recurrence;
  }
  if (!evening.isHost) evening.myResponse = view.myResponse;
  // Le titre du salon est celui de la soirée : le store ne garde pas d'autre titre (lot « ouverture »).
  if (view.partyId !== null) evening.party = { partyId: view.partyId, title: view.title };
  return evening;
}

/** Règle d'une série : jour et heure murale du premier instant, dans le fuseau du corps. */
function seriesRuleOf(tz: string, startsAt: number, recurrence: EveningRecurrence): SeriesRuleInput {
  const slot = localSlotOf(tz, startsAt);
  return {
    tz,
    weekday: slot.weekday,
    localTime: slot.localTime,
    interval: recurrence.interval,
    untilAt: recurrence.until ?? null,
  };
}

export function registerSocialEveningRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const evenings = () => backend.socialEvenings();
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), social(), deps.secret);

  /** Profils publics d'une même réponse : chaque pid n'est lu qu'une fois. */
  const profilesOfRequest = (): ProfileOf => {
    const cache = new Map<string, Promise<HomeFriend | undefined>>();
    return (pid) => {
      let profile = cache.get(pid);
      if (profile === undefined) {
        profile = social()
          .card(pid)
          .then((card) => (card === undefined ? undefined : profileOf(card)));
        cache.set(pid, profile);
      }
      return profile;
    };
  };

  /** Soirée d'une réponse unitaire : 404 si son hôte n'a plus de profil public. */
  const presentOne = async (view: EveningView): Promise<Evening> => {
    const evening = await presentEvening(view, profilesOfRequest());
    if (evening === undefined) throw new UserApiError(404, 'evening_not_found');
    return evening;
  };

  /**
   * Modification demandée. Une série dont l'instant change prend le jour et l'heure de ce nouvel instant, dans le fuseau de la
   * série (lu avant la modification). Sans série lisible, la modification passe telle quelle : le store la refuse alors.
   */
  const changeOf = async (viewer: string, id: string, body: EveningUpdateBody): Promise<EveningChange> => {
    const title = body.title === undefined ? {} : { title: body.title };
    if (body.scope === 'occurrence') {
      const startsAt = body.startsAt === undefined ? {} : { startsAt: body.startsAt };
      return { scope: 'occurrence', ...title, ...startsAt };
    }
    if (body.startsAt === undefined) return { scope: 'series', ...title };
    const current = await evenings().get(viewer, id);
    if (current.result !== 'ok' || current.evening.series === null) return { scope: 'series', ...title };
    return { scope: 'series', ...title, ...localSlotOf(current.evening.series.tz, body.startsAt) };
  };

  // Liste et lecture

  /**
   * Soirées de mon profil : `{ items, nextCursor }`. `?scope=` upcoming (défaut), past ou invites ; `?cursor=` (page suivante) ;
   * `?limit=` (20 par défaut, 50 au plus). `nextCursor` vaut null en fin de liste. Profil enfant : 403.
   */
  router.get('/social/evenings', async (c) => {
    const me = await actor(c);
    const query = parseWith(eveningListQuery, queryParams(c));
    const outcome = await evenings().list(me.pid, query, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    const profile = profilesOfRequest();
    const items = (await Promise.all(outcome.items.map((view) => presentEvening(view, profile)))).filter(isPresent);
    const page: EveningPage = { items, nextCursor: outcome.nextCursor };
    return sendJson(c, page);
  });

  /** Une soirée à laquelle je participe (hôte ou invité). 404 `evening_not_found` sinon. */
  router.get('/social/evenings/:id', async (c) => {
    const me = await actor(c);
    const outcome = await evenings().get(me.pid, eveningIdOf(String(c.req.param('id'))));
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendJson(c, await presentOne(outcome.evening));
  });

  // Création et modification

  /**
   * Crée une soirée (ponctuelle, ou série si `recurrence`). 201 avec la soirée. 403 `not_friend` si un invité n'est pas mon ami,
   * 400 `invalid_body`, 429 `too_many_evenings` au-delà de 10 soirées à venir (5 séries actives).
   */
  router.post('/social/evenings', async (c) => {
    const me = await actor(c);
    const body = parseWith(eveningCreateSchema, c.get('body'));
    const outcome = await evenings().create(
      me.pid,
      {
        title: body.title,
        startsAt: body.startsAt,
        tz: body.tz,
        guests: body.guests,
        series: body.recurrence === undefined ? undefined : seriesRuleOf(body.tz, body.startsAt, body.recurrence),
      },
      Date.now(),
    );
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendJson(c, await presentOne(outcome.evening), 201);
  });

  /**
   * Modifie le titre ou le début d'une soirée (hôte seulement). `scope` : l'occurrence seule, ou la série. `scope` seul : 400.
   * 204. 409 `evening_closed` si la soirée est annulée ou commencée.
   */
  router.patch('/social/evenings/:id', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const body = parseWith(eveningUpdateSchema, c.get('body'));
    const outcome = await evenings().update(me.pid, id, await changeOf(me.pid, id, body), Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendEmpty(c);
  });

  /** Annule une soirée (`?scope=occurrence`, défaut) ou arrête la série (`?scope=series`). Hôte seulement. 204. */
  router.delete('/social/evenings/:id', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const query = parseWith(eveningDeleteQuery, queryParams(c));
    const outcome = await evenings().cancel(me.pid, id, query.scope, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendEmpty(c);
  });

  // Invités

  /** Invite des amis (`{ pids }`, hôte seulement). Un invité déjà présent garde sa réponse. 204. */
  router.post('/social/evenings/:id/guests', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const body = parseWith(eveningGuestsSchema, c.get('body'));
    const outcome = await evenings().addGuests(me.pid, id, body.pids, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendEmpty(c);
  });

  /**
   * Retire un invité (hôte seulement). Un pid mal formé équivaut à un pid inconnu : il n'est pas invité, donc 204 sans effet.
   * L'hôte ne se retire pas (400).
   */
  router.delete('/social/evenings/:id/guests/:pid', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const pid = String(c.req.param('pid'));
    const outcome = await evenings().removeGuest(me.pid, id, pid, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendEmpty(c);
  });

  /** Ma réponse : `yes`, `maybe` ou `no` (invité seulement, avant le début). 204. */
  router.put('/social/evenings/:id/response', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const body = parseWith(eveningResponseSchema, c.get('body'));
    const outcome = await evenings().respond(me.pid, id, body.response, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendEmpty(c);
  });

  /**
   * Quitte une soirée (`{ scope }`) : `occurrence` met ma réponse à « non » ; `series` retire mes occurrences futures et ne me
   * génère plus. Invité seulement ; 400 si `series` sur une soirée ponctuelle. 204.
   */
  router.post('/social/evenings/:id/leave', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const body = parseWith(eveningLeaveSchema, c.get('body'));
    const outcome = await evenings().leave(me.pid, id, body.scope, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendEmpty(c);
  });

  /** Arrête la série de cette soirée : occurrences futures annulées. Hôte seulement ; 400 sur une soirée ponctuelle. 204. */
  router.post('/social/evenings/:id/stop', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const outcome = await evenings().stop(me.pid, id, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    return sendEmpty(c);
  });

  /** Ouverture du salon de visionnage : pas encore disponible (lot suivant). Le profil et la soirée sont vérifiés d'abord. */
  router.post('/social/evenings/:id/open', async (c) => {
    const me = await actor(c);
    const outcome = await evenings().get(me.pid, eveningIdOf(String(c.req.param('id'))));
    if (outcome.result !== 'ok') throw failureOf(outcome);
    throw new UserApiError(501, 'not_implemented');
  });
}
