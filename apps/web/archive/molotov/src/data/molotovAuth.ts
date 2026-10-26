import {
  disconnectMolotov,
  forgetMolotovCredentials,
  resendMolotovMfa as apiResendMolotovMfa,
  signinMolotov,
  verifyMolotovMfa as apiVerifyMolotovMfa,
  type MolotovStatus,
} from './molotovApi';
import { UserApiError } from './userApi';

/* Connexion du client Molotov par email et mot de passe (formulaire de la carte « Molotov »).
 *
 * Le serveur échange les identifiants contre une session Molotov (`POST /account/molotov/signin`, contrat §8) et répond
 * avec l'état du compte, ou avec un jeton de défi quand l'API exige une vérification en deux étapes : le code reçu par
 * email est alors vérifié (`POST /account/molotov/signin/verify`), et peut être renvoyé (`/signin/resend`). Ni le mot de
 * passe, ni les jetons, ni le code ne sont gardés côté client : les jetons restent chiffrés au repos chez le serveur, et
 * les appels directs depuis l'appareil les lui demandent (`GET /account/molotov/credentials`).
 *
 * La voie OAuth Google (`PUT /oauth/google` avec un `googleToken`) reste implémentée côté serveur mais n'est pas exposée
 * dans l'interface : seul le formulaire email + mot de passe connecte un compte. */

export type MolotovAuthErrorCode = 'server' | 'invalid_credentials' | 'invalid_code' | 'rate_limited';

export class MolotovAuthError extends Error {
  constructor(readonly code: MolotovAuthErrorCode, message: string) {
    super(message);
    this.name = 'MolotovAuthError';
  }
}

/**
 * Erreur parlante : le refus attendu du flux courant (`rejected`), le blocage de la vérification en deux étapes
 * (`rate_limited`), les refus du serveur (403/404) avec `server`. Aucun jeton ni code ne figure dans ces messages.
 */
function molotovAuthError(err: unknown, rejected: { code: 'invalid_credentials' | 'invalid_code'; message: string }): MolotovAuthError {
  if (err instanceof UserApiError) {
    if (err.status === 401) return new MolotovAuthError(rejected.code, rejected.message);
    if (err.status === 429) return new MolotovAuthError('rate_limited', 'Trop d\'essais : réessaie dans quelques minutes.');
    if (err.status === 403) {
      // Un 403 recouvre trois refus du serveur : les distinguer évite de renvoyer l'utilisateur au mauvais endroit.
      if (err.code === 'profile_locked') {
        return new MolotovAuthError('server', 'Cette session est verrouillée sur un profil invité : reconnecte-toi avec le compte principal.');
      }
      if (err.code === 'pin_required') {
        return new MolotovAuthError('server', 'Ce profil est protégé par un code : déverrouille-le avant de connecter Molotov.');
      }
      return new MolotovAuthError('server', 'La connexion Molotov est gérée par le profil principal du compte (refus du serveur : ' + (err.code || 'inconnu') + ').');
    }
    if (err.status === 404) {
      return new MolotovAuthError('server', 'Ce serveur ne gère pas encore la connexion Molotov par mot de passe.');
    }
  }
  return new MolotovAuthError('server', err instanceof Error ? err.message : 'Connexion Molotov impossible.');
}

/**
 * Connexion par email et mot de passe : le serveur échange les identifiants contre une session Molotov
 * (`POST /account/molotov/signin`) et répond avec l'état du compte, ou `{ mfaToken }` quand la vérification en deux
 * étapes est demandée (le code est vérifié ensuite par `verifyMolotovMfa`). Les refus parlants sont remontés avec leur
 * code (`invalid_credentials`), les refus du serveur (403/404) avec `server`.
 */
export async function connectMolotovWithPassword(
  email: string,
  password: string,
): Promise<{ status: MolotovStatus } | { mfaToken: string }> {
  try {
    const result = await signinMolotov({ email, password });
    if ('mfaToken' in result) return { mfaToken: result.mfaToken };
    forgetMolotovCredentials();
    return { status: result.status };
  } catch (err) {
    throw molotovAuthError(err, { code: 'invalid_credentials', message: 'Email ou mot de passe Molotov incorrect.' });
  }
}

/**
 * Vérification du code reçu par email (`POST /account/molotov/signin/verify`) : réussie, le serveur enregistre la
 * session et répond avec l'état du compte. Code incorrect ou expiré : `invalid_code` ; trop d'essais : `rate_limited`.
 */
export async function verifyMolotovMfa(mfaToken: string, code: string): Promise<MolotovStatus> {
  try {
    const status = await apiVerifyMolotovMfa({ mfaToken, code });
    forgetMolotovCredentials();
    return status;
  } catch (err) {
    throw molotovAuthError(err, { code: 'invalid_code', message: 'Code incorrect ou expiré.' });
  }
}

/** Renvoi du code par email (`POST /account/molotov/signin/resend`) : renvoie le jeton de défi à utiliser ensuite. */
export async function resendMolotovMfa(mfaToken: string): Promise<string> {
  try {
    const result = await apiResendMolotovMfa({ mfaToken });
    return result.mfaToken;
  } catch (err) {
    throw molotovAuthError(err, { code: 'invalid_code', message: 'Code incorrect ou expiré.' });
  }
}

/** Déconnexion : le serveur oublie les jetons, l'appareil aussi. */
export async function disconnectMolotovAccount(): Promise<void> {
  await disconnectMolotov();
  forgetMolotovCredentials();
}
