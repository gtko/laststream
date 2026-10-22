import {
  disconnectMolotov,
  forgetMolotovCredentials,
  signinMolotov,
  type MolotovStatus,
} from './molotovApi';
import { UserApiError } from './userApi';

/* Connexion du client Molotov par email et mot de passe (formulaire de la carte « Molotov »).
 *
 * Le serveur échange les identifiants contre une session Molotov (`POST /account/molotov/signin`, contrat §8) et répond
 * avec l'état du compte. Ni le mot de passe ni les jetons ne sont gardés côté client : les jetons restent chiffrés au
 * repos chez le serveur, et les appels directs depuis l'appareil les lui demandent (`GET /account/molotov/credentials`).
 *
 * La voie OAuth Google (`PUT /oauth/google` avec un `googleToken`) reste implémentée côté serveur mais n'est pas exposée
 * dans l'interface : seul le formulaire email + mot de passe connecte un compte. */

export type MolotovAuthErrorCode = 'server' | 'invalid_credentials' | 'mfa_required';

export class MolotovAuthError extends Error {
  constructor(readonly code: MolotovAuthErrorCode, message: string) {
    super(message);
    this.name = 'MolotovAuthError';
  }
}

/**
 * Connexion par email et mot de passe : le serveur échange les identifiants contre une session Molotov
 * (`POST /account/molotov/signin`) et répond avec l'état du compte. Les refus parlants sont remontés avec leur code
 * (`invalid_credentials`, `mfa_required`), les refus du serveur (403/404) avec `server`.
 */
export async function connectMolotovWithPassword(email: string, password: string): Promise<MolotovStatus> {
  try {
    const status = await signinMolotov({ email, password });
    forgetMolotovCredentials();
    return status;
  } catch (err) {
    if (err instanceof UserApiError && err.status === 401) {
      if (err.code === 'mfa_required') {
        throw new MolotovAuthError('mfa_required', 'La connexion Molotov demande une vérification en deux étapes : non gérée pour l’instant.');
      }
      throw new MolotovAuthError('invalid_credentials', 'Email ou mot de passe Molotov incorrect.');
    }
    if (err instanceof UserApiError && err.status === 403) {
      // Un 403 recouvre trois refus du serveur : les distinguer évite de renvoyer l'utilisateur au mauvais endroit.
      if (err.code === 'profile_locked') {
        throw new MolotovAuthError('server', 'Cette session est verrouillée sur un profil invité : reconnecte-toi avec le compte principal.');
      }
      if (err.code === 'pin_required') {
        throw new MolotovAuthError('server', 'Ce profil est protégé par un code : déverrouille-le avant de connecter Molotov.');
      }
      throw new MolotovAuthError('server', 'La connexion Molotov est gérée par le profil principal du compte (refus du serveur : ' + (err.code || 'inconnu') + ').');
    }
    if (err instanceof UserApiError && err.status === 404) {
      throw new MolotovAuthError('server', 'Ce serveur ne gère pas encore la connexion Molotov par mot de passe.');
    }
    throw new MolotovAuthError('server', err instanceof Error ? err.message : 'Connexion Molotov impossible.');
  }
}

/** Déconnexion : le serveur oublie les jetons, l'appareil aussi. */
export async function disconnectMolotovAccount(): Promise<void> {
  await disconnectMolotov();
  forgetMolotovCredentials();
}
