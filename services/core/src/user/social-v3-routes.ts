import type { z } from 'zod';
import type { App, Ctx } from '../http/app-env.js';
import { sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { createRateLimiter } from '../rate-limit.js';
import type { UserBackend } from './repo.js';
import { emitSocialEvent } from './social-v2-events.js';
import { actorOf } from './social-v2-routes.js';
import { cleanMessageBody } from './social-v2-validation.js';
import { type SharePayload } from './social-v3-store.js';
import {
  cleanShareNote,
  LIST_ID,
  listCreateSchema,
  listItemKeySchema,
  listItemSchema,
  listUpdateSchema,
  SHARE_CODE,
  shareLinkSchema,
  shareSchema,
} from './social-v3-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes de partage (S3b, contrat « Social v3 ») sous `/user/social/*` : partage à des amis (`/share`), liens publics
 * (`/share-links`, GET public), listes partagées (`/lists`). Profil agissant et contrôle d'accès comme les autres routes v2
 * (`actorOf`). Le lien public sert l'app sur `/t/:code` : c'est le repli de l'interface (ui.ts), rien à ajouter ici.
 */

type ShareInput = z.infer<typeof shareSchema>;

/** Liens publics créés par profil et par heure (au-delà : 429). */
const SHARE_LINKS_PER_HOUR = 30;
/** Lectures publiques d'un lien par adresse IP et par minute (au-delà : 429). */
const PUBLIC_SHARE_READS_PER_MINUTE = 60;

/** Retire les clés à `undefined` (un champ facultatif absent n'est pas une valeur). */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function invalid(issues: string[]): UserApiError {
  return new UserApiError(400, 'invalid_body', issues);
}

/** Contenu du message : un titre ou un moment, cohérent avec `kind`. */
function payloadOf(input: ShareInput): SharePayload {
  if (input.kind === 'title') {
    if (input.title === undefined) throw invalid(['title:required']);
    return defined({ kind: 'title' as const, ...input.title });
  }
  if (input.moment === undefined) throw invalid(['moment:required']);
  return defined({ kind: 'moment' as const, ...input.moment });
}

/** Erreur HTTP d'une écriture de liste refusée (le résultat `ok` est traité par l'appelant). */
function listFailure(result: string): UserApiError {
  switch (result) {
    case 'owner_only':
      return new UserApiError(403, 'owner_only');
    case 'unknown':
      return new UserApiError(404, 'profile_not_found');
    case 'not_friend':
      return new UserApiError(403, 'not_friend');
    case 'too_many_members':
      return new UserApiError(409, 'too_many_members');
    case 'list_limit_reached':
      return new UserApiError(429, 'list_limit_reached');
    case 'list_full':
      return new UserApiError(409, 'list_full');
    case 'item_exists':
      return new UserApiError(409, 'item_exists');
    case 'item_not_found':
      return new UserApiError(404, 'item_not_found');
    default:
      return new UserApiError(404, 'list_not_found');
  }
}

export function registerSocialV3Routes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = () => backend.users();
  const socialV2 = () => backend.socialV2();
  const store = () => backend.socialV3();
  const actor = (c: Ctx) => actorOf(c, users(), socialV2(), deps.secret);
  const linkWrites = createRateLimiter(SHARE_LINKS_PER_HOUR, 3_600_000);
  const publicReads = createRateLimiter(PUBLIC_SHARE_READS_PER_MINUTE, 60_000);

  /** Diffuse une modification de liste à son audience (membres avant et après la modification). */
  const announceList = (audience: readonly string[], listId: string): void => {
    emitSocialEvent(deps.socialEvents, audience, { t: 'list', listId });
  };

  /** Identifiant de liste d'une URL : mal formé équivaut à une liste inconnue. */
  const listIdOf = (c: Ctx): string => {
    const id = String(c.req.param('id'));
    if (!LIST_ID.test(id)) throw new UserApiError(404, 'list_not_found');
    return id;
  };

  // Partage multiple

  /**
   * Partage d'un titre ou d'un moment à plusieurs amis : un message par destinataire, avec son contenu structuré (`payload`).
   * `to` : `{ pid }` pour un ami ; `{ group }` est ignoré tant que les groupes n'existent pas. 201 `{ messages }`.
   * 400 `self` / `no_recipient` / `invalid_body`, 404 `profile_not_found`, 403 `not_friend` (rien n'est envoyé), 429 `rate_limited`.
   */
  router.post('/social/share', async (c) => {
    const me = await actor(c);
    const input = parseWith(shareSchema, c.get('body'));
    const payload = payloadOf(input);
    const text = cleanMessageBody(input.body ?? '');
    if (text.issues.length > 0 && text.body !== '') throw invalid(text.issues);
    // Texte du message (repli lisible) : le corps saisi, sinon le titre partagé.
    const body = text.body !== '' ? text.body : payload.title;
    const recipients = [...new Set(input.to.flatMap((target) => ('pid' in target ? [target.pid] : [])))];
    if (recipients.length === 0) throw new UserApiError(400, 'no_recipient');
    const outcome = await store().shareTo(me.pid, recipients, payload, body, Date.now());
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result !== 'sent') {
      if (outcome.result === 'self') throw new UserApiError(400, 'self');
      if (outcome.result === 'unknown') throw new UserApiError(404, 'profile_not_found');
      throw new UserApiError(403, 'not_friend');
    }
    for (const message of outcome.messages) {
      emitSocialEvent(deps.socialEvents, [message.to], { t: 'message', message });
    }
    return sendJson(c, { messages: outcome.messages }, 201);
  });

  // Liens publics

  /**
   * Crée un lien public vers un titre (ou un moment si `pos` est donné). `title` facultatif : sans lui, le titre de l'index
   * des fiches. `withInvite` réserve un emplacement d'invitation libre du compte (consommé seulement à l'inscription).
   * 201 `{ url, code, inviteCode? }` ; 429 `invite_quota_reached` si plus d'emplacement, 429 `rate_limited`, 400 `title_required`.
   */
  router.post('/social/share-links', async (c) => {
    const me = await actor(c);
    const verdict = linkWrites(me.pid);
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    const input = parseWith(shareLinkSchema, c.get('body'));
    const note = cleanShareNote(input.note);
    if (note.issues.length > 0) throw invalid(note.issues);
    const title = input.title ?? (await store().titleOfMedia(input.type, input.tmdbId));
    if (title === undefined) throw new UserApiError(400, 'title_required');
    const outcome = await store().createShareLink(
      me.accountId,
      me.pid,
      defined({
        type: input.type,
        tmdbId: input.tmdbId,
        title,
        poster: input.poster,
        pos: input.pos,
        note: note.note,
        withInvite: input.withInvite,
      }),
      Date.now(),
    );
    if (outcome.result === 'invite_quota_reached') throw new UserApiError(429, 'invite_quota_reached');
    const url = `${new URL(c.req.url).origin}/t/${outcome.code}`;
    return sendJson(c, defined({ url, code: outcome.code, inviteCode: outcome.inviteCode }), 201);
  });

  /**
   * Lien public, sans session : `{ type, tmdbId, title, poster?, pos?, from: { handle, avatarColor }, note?, inviteCode? }`.
   * Aucun pid de l'auteur, aucune bibliothèque ; `pos` seulement pour un moment, `inviteCode` seulement tant qu'il est libre.
   * 404 `share_not_found` ; 429 `rate_limited` par adresse IP.
   */
  router.get('/social/share-links/:code', async (c) => {
    const verdict = publicReads(c.get('ip') ?? 'inconnu');
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    const code = String(c.req.param('code'));
    if (!SHARE_CODE.test(code)) throw new UserApiError(404, 'share_not_found');
    const view = await store().shareLinkByCode(code);
    if (view === undefined) throw new UserApiError(404, 'share_not_found');
    return sendJson(c, view);
  });

  // Listes partagées

  /** Listes où je suis membre : `{ lists: [{ id, name, members, count }] }`, les plus récentes d'abord. */
  router.get('/social/lists', async (c) => {
    const me = await actor(c);
    return sendJson(c, { lists: await store().listsOf(me.pid, Date.now()) });
  });

  /**
   * Crée une liste (je suis propriétaire) avec des amis membres. 201 : la liste (`{ id, name, members, items }`).
   * 403 `not_friend`, 404 `profile_not_found`, 429 `list_limit_reached`.
   */
  router.post('/social/lists', async (c) => {
    const me = await actor(c);
    const input = parseWith(listCreateSchema, c.get('body'));
    const outcome = await store().createList(me.pid, input.name, input.members ?? [], Date.now());
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, outcome.list.id);
    return sendJson(c, outcome.list, 201);
  });

  /** Une liste où je suis membre : `{ id, name, members, items }`. 404 `list_not_found` sinon (même réponse pour une liste absente). */
  router.get('/social/lists/:id', async (c) => {
    const me = await actor(c);
    const list = await store().listDetail(me.pid, listIdOf(c), Date.now());
    if (list === undefined) throw new UserApiError(404, 'list_not_found');
    return sendJson(c, list);
  });

  /**
   * Renomme et change les membres (propriétaire seulement) : `{ name?, add?: pid[], remove?: pid[] }`. Un membre ajouté doit être
   * ami. 200 : la liste. 403 `owner_only`, 403 `not_friend`, 409 `too_many_members`.
   */
  router.put('/social/lists/:id', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const input = parseWith(listUpdateSchema, c.get('body'));
    const patch = defined({ name: input.name, add: input.add, remove: input.remove });
    const outcome = await store().updateList(me.pid, id, patch, Date.now());
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    return sendJson(c, outcome.list);
  });

  /** Supprime une liste (propriétaire seulement). 204. */
  router.delete('/social/lists/:id', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const outcome = await store().deleteList(me.pid, id);
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    return sendEmpty(c, 204);
  });

  /** Ajoute un titre à la liste (tout membre). 201 `{ item }` ; 409 `item_exists`, 409 `list_full`. */
  router.post('/social/lists/:id/items', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const input = parseWith(listItemSchema, c.get('body'));
    const outcome = await store().addItem(me.pid, id, defined({ type: input.type, tmdbId: input.tmdbId, title: input.title, poster: input.poster }), Date.now());
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    return sendJson(c, { item: outcome.item }, 201);
  });

  /** Retire un titre de la liste (tout membre). 204 ; 404 `item_not_found`. */
  router.delete('/social/lists/:id/items/:type/:tmdbId', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const key = listItemKeySchema.safeParse({ type: c.req.param('type'), tmdbId: c.req.param('tmdbId') });
    if (!key.success) throw new UserApiError(404, 'item_not_found');
    const outcome = await store().removeItem(me.pid, id, key.data.type, key.data.tmdbId);
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    return sendEmpty(c, 204);
  });
}
