import type { Ctx } from '../http/app-env.js';
import { hashSessionToken, verifyProfileToken } from './crypto.js';
import type { UserRepo } from './repo.js';
import type { Account, ProfileRecord } from './store.js';
import { UserApiError } from './validation.js';

/** Authentification des requêtes /user et /party : session (jeton Bearer), profil et déverrouillage par PIN. */

export const nowIso = (): string => new Date().toISOString();

export function bearerToken(c: Ctx): string | undefined {
  const match = /^bearer\s+([A-Za-z0-9_-]{20,128})$/i.exec(c.req.header('authorization') ?? '');
  return match?.[1];
}

export interface Session {
  /** Empreinte du jeton de session : identifie la session (stockée en base). */
  tokenHash: string;
  account: Account;
}

/** Session valide de la requête (jeton Bearer), ou 401. */
export async function sessionOf(store: UserRepo, c: Ctx): Promise<Session> {
  const token = bearerToken(c);
  if (token === undefined) throw new UserApiError(401, 'unauthorized');
  const tokenHash = hashSessionToken(token);
  const account = await store.accountForSession(tokenHash, nowIso());
  if (account === undefined) throw new UserApiError(401, 'unauthorized');
  return { tokenHash, account };
}

export async function profileOf(store: UserRepo, account: Account, c: Ctx): Promise<ProfileRecord> {
  const profile = await store.findProfile(account.id, String(c.req.param('id')));
  if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
  return profile;
}

export interface Scope extends Session {
  profile: ProfileRecord;
}

/** Vérifie le déverrouillage d'un profil protégé par PIN (en-tête X-Profile-Token) ; 403 pin_required sinon. */
export function assertUnlocked(c: Ctx, session: Session, profile: ProfileRecord, secret: string): void {
  if (!profile.hasPin) return;
  const token = c.req.header('x-profile-token');
  const valid =
    token !== undefined &&
    verifyProfileToken(
      token,
      { accountId: session.account.id, profileId: profile.id, sessionHash: session.tokenHash, pinVersion: profile.pinVersion },
      Date.now(),
      secret,
    );
  if (!valid) throw new UserApiError(403, 'pin_required');
}

/**
 * Session et profil de la requête (`:id`). Si `unlock` et que le profil a un PIN, un jeton de profil valide est exigé
 * (en-tête X-Profile-Token) : lié à cette session et à la version courante du PIN, sinon 403 pin_required.
 */
export async function scopeOf(store: UserRepo, c: Ctx, secret: string, unlock: boolean): Promise<Scope> {
  const session = await sessionOf(store, c);
  const profile = await profileOf(store, session.account, c);
  if (unlock) assertUnlocked(c, session, profile, secret);
  return { ...session, profile };
}
