import type { RunningApp } from './lt-harness.js';
import { bootstrapOwner, type InviteBody, inviteAndRegister, type Member } from './social-harness.js';
import { type AccountBody, createProfileVia, loginAs, PASSWORD, request, type RequestOptions, type Reply } from './user-harness.js';

/** Routes v2 : profil agissant = en-tête X-Profile-Id (et X-Profile-Token si le profil a un PIN). */
export interface Acting {
  token: string;
  /** Identifiant interne du profil : utilisé seulement dans l'en-tête X-Profile-Id, jamais comparé aux réponses. */
  profile: string;
}

/** Profil social : pid public et handle complet, obtenus par GET /user/social/me. */
export interface Persona extends Acting {
  name: string;
  pid: string;
  full: string;
}

export interface MeBody {
  pid: string;
  handle: { name: string; tag: string; full: string };
  status: string;
  avatarColor: string;
}

/**
 * Délai des hooks qui créent des comptes (scrypt à chaque inscription) : sous charge (suite Workers complète), 10 s ne
 * suffisent pas toujours.
 */
export const HOOK_TIMEOUT_MS = 30_000;

/** Requête vers une route v2, au nom du profil agissant. */
export function as<T = unknown>(app: RunningApp, who: Acting, method: string, path: string, options: Omit<RequestOptions, 'token'> = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}), 'x-profile-id': who.profile };
  return request<T>(app, method, path, { ...options, token: who.token, headers });
}

/** Pid et handle d'un profil du compte (GET /user/social/me). */
export async function personaOf(app: RunningApp, token: string, profile: string, name: string): Promise<Persona> {
  const res = await request<MeBody>(app, 'GET', '/user/social/me', { token, headers: { 'x-profile-id': profile } });
  if (res.status !== 200) throw new Error(`profil social refusé (${res.status})`);
  return { name, token, profile, pid: res.body.pid, full: res.body.handle.full };
}

/** Distribution de test : alice (propriétaire, foyer avec alice2 et un enfant), bob et carol (amis invités). */
export interface Cast {
  alice: Persona;
  /** Second profil adulte d'alice : même compte, donc foyer. */
  alice2: Persona;
  bob: Persona;
  carol: Persona;
  /** Profil enfant d'alice : aucune identité sociale. */
  kid: Acting;
  owner: Member;
}

/**
 * Compte sans profil, inscrit par un lien libre de `inviter`. Un parrain sans profil principal n'ouvre aucune amitié v2
 * à ses filleuls (voir linkInvitedPrincipals) : castOf s'en sert pour que bob et carol ne soient amis de personne.
 */
export async function registerWithoutProfile(app: RunningApp, inviter: Member, username: string): Promise<Member> {
  const list = await request<InviteBody>(app, 'GET', '/user/invites', { token: inviter.token });
  const free = list.body.invites.find((invite) => invite.state !== 'used');
  if (free === undefined) throw new Error('aucun lien libre');
  const res = await request<AccountBody>(app, 'POST', '/user/register', { body: { username, password: PASSWORD, invite: free.code } });
  if (res.status !== 201) throw new Error(`inscription refusée (${res.status})`);
  return { username, token: await loginAs(app, username), profile: '' };
}

/**
 * Crée alice (propriétaire), bob et carol (invités par un compte sans profil, lui-même invité par alice), un second
 * profil adulte pour alice et un profil enfant. Aucune amitié n'est créée : chaque test fait ses demandes par les routes v2.
 */
export async function castOf(app: RunningApp): Promise<Cast> {
  const alice = await bootstrapOwner(app, 'alice');
  const hub = await registerWithoutProfile(app, alice, 'hub');
  const bob = await inviteAndRegister(app, hub, 'bob');
  const carol = await inviteAndRegister(app, hub, 'carol');
  const twin = await createProfileVia<{ id: string }>(app, alice.token, { name: 'Alice Deux' });
  const kid = await createProfileVia<{ id: string }>(app, alice.token, { name: 'Petit', isKid: true });
  return {
    owner: alice,
    alice: await personaOf(app, alice.token, alice.profile, 'alice'),
    alice2: await personaOf(app, alice.token, twin.body.id, 'Alice Deux'),
    bob: await personaOf(app, bob.token, bob.profile, 'bob'),
    carol: await personaOf(app, carol.token, carol.profile, 'carol'),
    kid: { token: alice.token, profile: kid.body.id },
  };
}

/** Ami accepté dans les deux sens : `from` demande par handle, `to` accepte. */
export async function befriend(app: RunningApp, from: Persona, to: Persona): Promise<void> {
  const sent = await as(app, from, 'POST', '/user/social/requests', { body: { handle: to.full } });
  if (sent.status !== 201) throw new Error(`demande refusée (${sent.status})`);
  const accepted = await as(app, to, 'POST', `/user/social/requests/${from.pid}/accept`);
  if (accepted.status !== 200) throw new Error(`acceptation refusée (${accepted.status})`);
}

/** Blocage de `target` par `who` (POST /user/social/blocks/:pid, 204) : retire aussi l'amitié, dans les deux sens. */
export async function block(app: RunningApp, who: Acting, target: Persona): Promise<void> {
  const res = await as(app, who, 'POST', `/user/social/blocks/${target.pid}`);
  if (res.status !== 204) throw new Error(`blocage refusé (${res.status})`);
}

/** Corps de réponse d'erreur v2 : `{ error, issues? }`. */
export interface ErrorBodyV2 {
  error: string;
  issues?: string[];
}
