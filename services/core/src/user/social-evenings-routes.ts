import type { Evening, EveningEvent, EveningGuest, EveningPage, EveningRecurrence, HomeFriend } from '@laststream/protocol/social';
import type { AppDeps } from '../deps.js';
import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { createPartyRoom } from '../party/create-room.js';
import { DEFAULT_MAX_PARTICIPANTS } from '../party/protocol.js';
import { platform } from '../platform/index.js';
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
import { sessionOf } from './session.js';
import { emitSocialEvent } from './social-v2-events.js';
import { actorOf, type Actor } from './social-v2-routes.js';
import type { Card } from './social-v2-store.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes des soirées planifiées (LAST-198, lot L2), montées sous `/user` : `/social/evenings*`. Profil agissant : en-tête
 * `X-Profile-Id`, comme les autres routes sociales ; un profil enfant reçoit 403 `kid_profile` sur les onze routes.
 *
 * Droits : un non-participant reçoit 404 `evening_not_found` (jamais 403). Un profil qui n'est pas mon ami, ou qui est en
 * attente ou bloqué, reçoit le même corps 403 `not_friend`. Les réponses de mutation sont sans corps (204), sauf la création
 * (201 avec la soirée).
 *
 * Temps réel (trames `evening_*`, voir social-v2-events.ts) : invitation (création, ajout d'invité), modification et annulation
 * (`evening_update`), réponse (`evening_response`, aux autres participants), ouverture du salon (`evening_open`). Audience : l'hôte
 * et les invités qui n'ont pas dit non, sans les profils en blocage avec le profil agissant. `open` : hôte seul, de T-15 min à T+2 h,
 * rattache un salon privé à la soirée (idempotent) ; 200 avec la soirée.
 */

/** Ouverture possible de 15 minutes avant le début jusqu'à 2 heures après. */
const OPEN_LEAD_MS = 15 * 60_000;
const OPEN_GRACE_MS = 2 * 60 * 60_000;

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

/** Profil public de l'hôte pour la trame d'invitation. */
function hostProfileOf(me: Actor): HomeFriend {
  const profile: HomeFriend = { pid: me.pid, handle: { name: me.handle.name, tag: me.handle.tag, full: me.handle.full }, avatarColor: me.avatarColor };
  if (me.avatar !== undefined) profile.avatar = me.avatar;
  return profile;
}

export function registerSocialEveningRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const evenings = () => backend.socialEvenings();
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), social(), deps.secret);

  const emit = (pids: readonly string[], event: EveningEvent): void => emitSocialEvent(deps.socialEvents, pids, { t: 'evening', event });

  /** Profils sans blocage (dans un sens ou dans l'autre) avec le profil agissant ; lui-même reste. */
  const unblocked = async (actorPid: string, pids: readonly string[]): Promise<string[]> => {
    const distinct = [...new Set(pids)];
    const kept = await Promise.all(distinct.map(async (pid) => pid === actorPid || !(await social().isBlockedEither(actorPid, pid))));
    return distinct.filter((_, index) => kept[index]);
  };

  /** Audience d'une soirée : l'hôte et les invités qui n'ont pas dit non, hors `except` et hors profils bloqués avec l'acteur. */
  const audienceOf = (view: EveningView, actorPid: string, except?: string): Promise<string[]> =>
    unblocked(
      actorPid,
      [view.hostPid, ...view.guests.filter((guest) => guest.response !== 'no').map((guest) => guest.pid)].filter((pid) => pid !== except),
    );

  /** Vue de la soirée avant une écriture (audience à prévenir) ; `undefined` si le profil n'y participe pas. */
  const viewBefore = async (pid: string, id: string): Promise<EveningView | undefined> => {
    const outcome = await evenings().get(pid, id);
    return outcome.result === 'ok' ? outcome.evening : undefined;
  };

  /** Invitation envoyée aux profils `pids` (jamais à l'hôte), hors profils bloqués. */
  const sendInvites = async (me: Actor, view: EveningView, pids: readonly string[]): Promise<void> => {
    const audience = await unblocked(me.pid, pids.filter((pid) => pid !== me.pid));
    emit(audience, { type: 'evening_invite', eveningId: view.id, title: view.title, startsAt: view.startsAt, tz: view.tz, host: hostProfileOf(me) });
  };

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
    await sendInvites(
      me,
      outcome.evening,
      outcome.evening.guests.map((guest) => guest.pid),
    );
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
    if (outcome.evening !== null) emit(await audienceOf(outcome.evening, me.pid), { type: 'evening_update', eveningId: id, change: 'updated' });
    // Occurrences retirées par une modification de série : leurs participants les perdent, comme à l'annulation.
    for (const gone of outcome.removed ?? []) {
      emit(await unblocked(me.pid, [gone.hostPid, ...gone.pids]), { type: 'evening_update', eveningId: gone.eveningId, change: 'cancelled' });
    }
    return sendEmpty(c);
  });

  /** Annule une soirée (`?scope=occurrence`, défaut) ou arrête la série (`?scope=series`). Hôte seulement. 204. */
  router.delete('/social/evenings/:id', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const query = parseWith(eveningDeleteQuery, queryParams(c));
    const before = await viewBefore(me.pid, id);
    const outcome = await evenings().cancel(me.pid, id, query.scope, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    if (before !== undefined) emit(await audienceOf(before, me.pid), { type: 'evening_update', eveningId: id, change: 'cancelled' });
    return sendEmpty(c);
  });

  // Invités

  /** Invite des amis (`{ pids }`, hôte seulement). Un invité déjà présent garde sa réponse. 204. */
  router.post('/social/evenings/:id/guests', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const body = parseWith(eveningGuestsSchema, c.get('body'));
    const before = await viewBefore(me.pid, id);
    const outcome = await evenings().addGuests(me.pid, id, body.pids, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    const after = await viewBefore(me.pid, id);
    if (after !== undefined) {
      const known = new Set(before?.guests.map((guest) => guest.pid));
      await sendInvites(
        me,
        after,
        after.guests.map((guest) => guest.pid).filter((pid) => !known.has(pid)),
      );
    }
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
    const before = await viewBefore(me.pid, id);
    const outcome = await evenings().removeGuest(me.pid, id, pid, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    // Le profil retiré perd la soirée : même trame que pour une annulation.
    if (before?.guests.some((guest) => guest.pid === pid) === true) {
      emit(await unblocked(me.pid, [pid]), { type: 'evening_update', eveningId: id, change: 'cancelled' });
      // Les autres participants voient la liste des invités changer.
      emit(await audienceOf(before, me.pid, pid), { type: 'evening_update', eveningId: id, change: 'updated' });
    }
    return sendEmpty(c);
  });

  /** Ma réponse : `yes`, `maybe` ou `no` (invité seulement, avant le début). 204. */
  router.put('/social/evenings/:id/response', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const body = parseWith(eveningResponseSchema, c.get('body'));
    const outcome = await evenings().respond(me.pid, id, body.response, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    const view = await viewBefore(me.pid, id);
    if (view !== undefined) emit(await audienceOf(view, me.pid, me.pid), { type: 'evening_response', eveningId: id, pid: me.pid, response: body.response });
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
    const before = await viewBefore(me.pid, id);
    const outcome = await evenings().leave(me.pid, id, body.scope, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    if (before !== undefined) emit(await audienceOf(before, me.pid, me.pid), { type: 'evening_response', eveningId: id, pid: me.pid, response: 'no' });
    return sendEmpty(c);
  });

  /** Arrête la série de cette soirée : occurrences futures annulées. Hôte seulement ; 400 sur une soirée ponctuelle. 204. */
  router.post('/social/evenings/:id/stop', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const before = await viewBefore(me.pid, id);
    const outcome = await evenings().stop(me.pid, id, Date.now());
    if (outcome.result !== 'ok') throw failureOf(outcome);
    if (before !== undefined) emit(await audienceOf(before, me.pid), { type: 'evening_update', eveningId: id, change: 'cancelled' });
    return sendEmpty(c);
  });

  /**
   * Ouvre le salon de visionnage de la soirée (hôte seul) : de T-15 min à T+2 h, soirée non annulée. Crée un salon privé au titre
   * de la soirée et le rattache ; 200 avec la soirée (`party` renseigné) et `evening_open` aux participants. Idempotent : un salon
   * déjà rattaché est renvoyé tel quel (aucune trame). 403 `not_host` pour un invité, 409 `evening_closed` (annulée) ou
   * `evening_not_open` (hors fenêtre), 429 `too_many_rooms` au plafond de salons de l'hôte, 501 `party_unavailable` sans salons.
   */
  router.post('/social/evenings/:id/open', async (c) => {
    const me = await actor(c);
    const id = eveningIdOf(String(c.req.param('id')));
    const found = await evenings().get(me.pid, id);
    if (found.result !== 'ok') throw failureOf(found);
    const view = found.evening;
    if (view.role !== 'host') throw new UserApiError(403, 'not_host');
    if (view.status === 'cancelled') throw new UserApiError(409, 'evening_closed');
    if (view.partyId !== null) return sendJson(c, await presentOne(view));
    const now = Date.now();
    if (now < view.startsAt - OPEN_LEAD_MS || now > view.startsAt + OPEN_GRACE_MS) throw new UserApiError(409, 'evening_not_open');
    const party = deps.party ?? platform().createPartyBackend?.();
    if (party === undefined) throw new UserApiError(501, 'party_unavailable');

    const session = await sessionOf(backend.users(), c);
    const profile = await backend.users().findProfile(session.account.id, c.req.header('x-profile-id') ?? '');
    if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
    let created: Awaited<ReturnType<typeof createPartyRoom>>;
    try {
      created = await createPartyRoom(
        backend,
        party,
        { account: session.account, profile },
        {
          visibility: 'private',
          title: view.title,
          poster: null,
          language: null,
          media: { type: 'movie' },
          fingerprint: null,
          maxParticipants: DEFAULT_MAX_PARTICIPANTS,
        },
      );
    } catch (err) {
      // Une ouverture concurrente a pu gagner pendant ce temps : son salon est alors le bon, le plafond n'est pas une erreur.
      if (err instanceof UserApiError && err.code === 'too_many_rooms') {
        const raced = await viewBefore(me.pid, id);
        if (raced?.partyId != null) return sendJson(c, await presentOne(raced));
      }
      throw err;
    }
    // Le premier rattachement gagne (écriture atomique côté base) : en cas de course perdue, le salon en trop est supprimé.
    const effective = await evenings().attachParty(id, created.id);
    if (effective !== created.id) {
      await party
        .room(created.id)
        .close(session.account.id)
        .catch(() => undefined);
      await backend.social().deletePartyRoom(created.id);
      if (effective === undefined) throw new UserApiError(404, 'evening_not_found');
      const winner = await viewBefore(me.pid, id);
      if (winner === undefined) throw new UserApiError(404, 'evening_not_found');
      return sendJson(c, await presentOne(winner));
    }
    const opened = await viewBefore(me.pid, id);
    if (opened === undefined) throw new UserApiError(404, 'evening_not_found');
    emit(await audienceOf(opened, me.pid), { type: 'evening_open', eveningId: id, party: { partyId: created.id, title: opened.title } });
    return sendJson(c, await presentOne(opened));
  });
}
