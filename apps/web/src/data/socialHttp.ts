import { auth } from './auth';
import { call } from './userApi';

/* Appels communs aux clients sociaux v2 et v3 (`/user/social<chemin>`) : un seul endroit pour les en-têtes du profil
 * agissant et pour la construction des requêtes. */

export const SOCIAL = '/social';

/**
 * Appel `/user/social<path>` au nom du profil actif : X-Profile-Id (sans lui le serveur répond 400 `profile_required`),
 * et X-Profile-Token si ce profil a un PIN valable. Même mécanisme que `adminCall` et `asActor`.
 */
export function social<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const pid = auth.profile?.id;
  return call<T>(SOCIAL + path, { method, body, profileId: pid, headers: pid ? { 'x-profile-id': pid } : undefined });
}

/** Ajoute les paramètres renseignés (les `undefined` sont omis) à un chemin. */
export function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
