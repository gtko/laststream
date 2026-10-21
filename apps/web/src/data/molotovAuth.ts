import {
  connectMolotov,
  disconnectMolotov,
  exchangeGoogleToken,
  forgetMolotovCredentials,
  getMolotovStatus,
  type MolotovStatus,
} from './molotovApi';

/* Connexion Google du client Molotov.
 *
 * Le flux reprend celui de l'app web Molotov (contrat §3) : implicit flow Google (`id_token`), page de retour statique
 * `/oauth/google.html` qui renvoie le jeton à l'opener par `postMessage`, échange du jeton Google contre une session
 * Molotov (`PUT /oauth/google`), puis dépôt des jetons chez le serveur (chiffrés au repos).
 *
 * Deux difficultés réelles :
 *  - l'échange n'est vérifié par Molotov que pour les `aud` connus : un client id Google non enregistré par le compte
 *    est rejeté par l'API ; l'erreur est renvoyée telle quelle à l'interface ;
 *  - une popup bloquée, ou une page ouverte dans un onglet (WebView native), perd le `postMessage` : la page de retour
 *    dépose alors le jeton dans le stockage local de l'origine, que l'application vient chercher. */

export const MOLOTOV_CLIENT_ID_KEY = 'ls_molotov_client_id';
const MOLOTOV_PENDING_KEY = 'ls_molotov_google_pending';
const MOLOTOV_STATE_KEY = 'ls_molotov_google_state';

export type MolotovAuthErrorCode =
  | 'no_client_id' | 'popup_blocked' | 'popup_closed' | 'no_token' | 'state_mismatch' | 'exchange_failed' | 'server';

export class MolotovAuthError extends Error {
  constructor(readonly code: MolotovAuthErrorCode, message: string) {
    super(message);
    this.name = 'MolotovAuthError';
  }
}

/** Client id Google : variable de build (`VITE_MOLOTOV_GOOGLE_CLIENT_ID`) ou réglage utilisateur (prioritaire). */
export function molotovGoogleClientId(): string {
  try {
    const override = globalThis.localStorage?.getItem(MOLOTOV_CLIENT_ID_KEY)?.trim();
    if (override) return override;
  } catch { /* stockage indisponible */ }
  const env = import.meta.env?.VITE_MOLOTOV_GOOGLE_CLIENT_ID;
  return typeof env === 'string' ? env.trim() : '';
}

/** Surcharge (ou retrait) du client id Google par l'utilisateur. */
export function setMolotovGoogleClientId(id: string): void {
  try {
    const v = (id || '').trim();
    if (v) globalThis.localStorage?.setItem(MOLOTOV_CLIENT_ID_KEY, v);
    else globalThis.localStorage?.removeItem(MOLOTOV_CLIENT_ID_KEY);
  } catch { /* stockage indisponible */ }
}

function randomState(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

/** Page de retour OAuth : l'origine de l'application (c'est une page statique de l'app). */
function molotovRedirectUri(): string {
  const origin = globalThis.location?.origin ?? '';
  return origin ? origin + '/oauth/google.html' : '';
}

/** URL d'autorisation Google (implicit flow : `id_token`). */
export function googleAuthUrl(clientId: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: molotovRedirectUri(),
    response_type: 'id_token token',
    scope: 'openid profile email',
    prompt: 'consent',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

/** Prépare une connexion : génère l'état (anti-falsification), le mémorise et renvoie l'URL d'autorisation. */
export function beginMolotovAuth(): { url: string; state: string } {
  const clientId = molotovGoogleClientId();
  if (!clientId) {
    throw new MolotovAuthError('no_client_id', 'Aucun client id Google : configure VITE_MOLOTOV_GOOGLE_CLIENT_ID ou renseigne-le ci-dessous.');
  }
  const state = randomState();
  try { globalThis.localStorage?.setItem(MOLOTOV_STATE_KEY, state); } catch { /* stockage indisponible */ }
  return { url: googleAuthUrl(clientId, state), state };
}

interface PendingAuth {
  idToken?: string;
  error?: string;
  state?: string;
  at?: number;
}

/** Dépôt du jeton par la page de retour (popup sans lien avec l'opener, ou WebView native). */
function readPending(): PendingAuth | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(MOLOTOV_PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as PendingAuth | null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Efface le dépôt une fois le jeton consommé (ou périmé). */
function clearPending(): void {
  try { globalThis.sessionStorage?.removeItem(MOLOTOV_PENDING_KEY); } catch { /* ignoré */ }
}

/** Reprend une connexion faite dans un autre onglet ou une autre fenêtre : le jeton y a été déposé. */
export function pickupMolotovAuth(): string {
  const pending = readPending();
  if (!pending) throw new MolotovAuthError('no_token', 'Aucune connexion Google en attente.');
  let expected = '';
  try { expected = globalThis.localStorage?.getItem(MOLOTOV_STATE_KEY) ?? ''; } catch { /* ignoré */ }
  try { globalThis.localStorage?.removeItem(MOLOTOV_STATE_KEY); } catch { /* ignoré */ }
  // Le state est obligatoire : sans lui, un jeton déposé par une autre page serait accepté.
  if (!expected || pending.state !== expected) {
    clearPending();
    throw new MolotovAuthError('state_mismatch', 'Connexion Google expirée : reprends la connexion.');
  }
  clearPending();
  if (pending.error) throw new MolotovAuthError('no_token', 'Connexion refusée par Google (' + pending.error + ').');
  if (!pending.idToken) throw new MolotovAuthError('no_token', 'Google n’a renvoyé aucun jeton.');
  return pending.idToken;
}

/**
 * Demande un jeton Google à l'utilisateur (popup). Renvoie l'`id_token`.
 * Erreurs : `no_client_id`, `popup_blocked`, `popup_closed`, `no_token`, `state_mismatch`.
 */
export function requestGoogleIdToken(timeoutMs = 180_000): Promise<string> {
  const { url, state } = beginMolotovAuth();
  const popup = globalThis.open?.(url, 'laststream-molotov-google', 'width=520,height=700');
  if (!popup) throw new MolotovAuthError('popup_blocked', 'La fenêtre de connexion a été bloquée : autorise les fenêtres pop-up, ou utilise « Ouvrir dans un onglet ».');
  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closedTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (err: MolotovAuthError | null, token?: string): void => {
      if (timer) clearTimeout(timer);
      if (closedTimer) clearInterval(closedTimer);
      clearInterval(poll);
      globalThis.removeEventListener?.('message', onMessage as EventListener);
      if (err) reject(err);
      else resolve(token ?? '');
    };
    const onMessage = (ev: MessageEvent): void => {
      if (ev.origin !== globalThis.location?.origin) return; // seul notre origine parle à l'app
      if (ev.source !== popup) return; // seule la fenêtre de connexion attendue peut répondre
      const data = ev.data as { type?: string; idToken?: string; error?: string; state?: string } | null;
      if (!data || data.type !== 'laststream:molotov-google') return;
      if (data.state !== state) {
        finish(new MolotovAuthError('state_mismatch', 'Connexion Google expirée : reprends la connexion.'));
        return;
      }
      if (data.error) {
        finish(new MolotovAuthError('no_token', 'Connexion refusée par Google (' + data.error + ').'));
        return;
      }
      if (!data.idToken) {
        finish(new MolotovAuthError('no_token', 'Google n’a renvoyé aucun jeton.'));
        return;
      }
      finish(null, data.idToken);
    };
    globalThis.addEventListener?.('message', onMessage as EventListener);
    // WebView native ou onglet : la page de retour dépose le jeton dans le stockage de session.
    const poll = setInterval(() => {
      const pending = readPending();
      if (!pending) return;
      if (pending.state !== state) {
        finish(new MolotovAuthError('state_mismatch', 'Connexion Google expirée : reprends la connexion.'));
        return;
      }
      if (pending.error) {
        clearPending();
        finish(new MolotovAuthError('no_token', 'Connexion refusée par Google (' + pending.error + ').'));
        return;
      }
      if (pending.idToken) {
        clearPending();
        finish(null, pending.idToken);
      }
    }, 700);
    timer = setTimeout(() => {
      finish(new MolotovAuthError('popup_closed', 'Connexion Google expirée.'));
    }, timeoutMs);
    // L'utilisateur ferme la fenêtre : on ne laisse pas la promesse en suspens.
    closedTimer = setInterval(() => {
      try {
        if (popup.closed) {
          finish(new MolotovAuthError('popup_closed', 'Fenêtre de connexion fermée.'));
        }
      } catch { /* fenêtre déjà inaccessible */ }
    }, 700);
  });
}

/**
 * Connexion complète : Google → jeton Google → session Molotov → dépôt chez le serveur.
 * Renvoie l'état de la connexion (connecté, palier, nombre de chaînes).
 */
export async function connectMolotovWithGoogle(): Promise<MolotovStatus> {
  const googleToken = await requestGoogleIdToken();
  return connectMolotovWithToken(googleToken);
}

/** Enchaîne l'échange d'un jeton Google déjà obtenu et le dépôt des jetons chez le serveur. */
export async function connectMolotovWithToken(googleToken: string): Promise<MolotovStatus> {
  let tokens;
  try {
    tokens = await exchangeGoogleToken(googleToken);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MolotovAuthError('exchange_failed', 'Molotov a refusé la connexion Google : ' + detail);
  }
  await connectMolotov(tokens);
  forgetMolotovCredentials();
  return getMolotovStatus();
}

/** Déconnexion : le serveur oublie les jetons, l'appareil aussi. */
export async function disconnectMolotovAccount(): Promise<void> {
  await disconnectMolotov();
  forgetMolotovCredentials();
}
