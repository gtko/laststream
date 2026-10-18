import type { RunningApp } from './lt-harness.js';
import { type AccountBody, loginAs, PASSWORD, request, createProfileVia } from './user-harness.js';

export interface InviteBody {
  quota: number;
  invites: { id: string; code: string; state: 'free' | 'sent' | 'used'; createdAt: string; sentAt: string | null; usedAt: string | null; invitee: string | null }[];
}

export interface Member {
  username: string;
  token: string;
  /** Profil par défaut créé pour les tests. */
  profile: string;
}

/** Premier compte (propriétaire), sans lien, et un profil adulte. */
export async function bootstrapOwner(app: RunningApp, username = 'alice'): Promise<Member> {
  const res = await request<AccountBody>(app, 'POST', '/user/register', { body: { username, password: PASSWORD } });
  if (res.status !== 201) throw new Error(`premier compte refusé (${res.status})`);
  return await withProfile(app, username);
}

async function withProfile(app: RunningApp, username: string): Promise<Member> {
  const token = await loginAs(app, username);
  const profile = await createProfileVia(app, token, { name: username });
  return { username, token, profile: profile.body.id };
}

/** Prend un lien libre du parrain et inscrit `username` avec. */
export async function inviteAndRegister(app: RunningApp, inviter: Member, username: string): Promise<Member> {
  const list = await request<InviteBody>(app, 'GET', '/user/invites', { token: inviter.token });
  const free = list.body.invites.find((invite) => invite.state !== 'used');
  if (free === undefined) throw new Error('aucun lien libre');
  const res = await request<AccountBody>(app, 'POST', '/user/register', { body: { username, password: PASSWORD, invite: free.code } });
  if (res.status !== 201) throw new Error(`inscription refusée (${res.status})`);
  return await withProfile(app, username);
}

/** Crée un profil enfant pour le membre. */
export async function addKidProfile(app: RunningApp, member: Member, name = 'petit'): Promise<string> {
  const res = await createProfileVia(app, member.token, { name, isKid: true });
  return res.body.id;
}
