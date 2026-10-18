import type { RunningApp } from './lt-harness.js';

/** Mot de passe de test (jamais un secret réel). */
export const PASSWORD = 'mot-de-passe-test-1';

export interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Corps brut (ex. JSON invalide). */
  raw?: string;
}

/** Requête HTTP vers l'application de test. Le corps est typé par l'appelant (aucune validation ici). */
export async function request<T = unknown>(app: RunningApp, method: string, path: string, options: RequestOptions = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  let payload: string | undefined = options.raw;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
  }
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${app.baseUrl}${path}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? undefined : JSON.parse(text)) as T, headers: res.headers };
}

export interface AccountBody {
  account: { id: string; username: string; isOwner: boolean; createdAt: string };
}

export interface LoginBody {
  token: string;
  expiresAt: string;
}

export interface ErrorBody {
  error: string;
  issues?: string[];
}

/** Connexion d'un compte existant : renvoie le jeton de session. */
export async function loginAs(app: RunningApp, username: string, password: string = PASSWORD): Promise<string> {
  const res = await request<LoginBody>(app, 'POST', '/user/login', { body: { username, password } });
  if (res.status !== 200) throw new Error(`connexion de test refusée (${res.status})`);
  return res.body.token;
}

/**
 * Crée un profil comme le fait l'app : le premier est libre, les suivants passent par le profil principal
 * (X-Profile-Id), dont le jeton de PIN peut être fourni.
 */
export async function createProfileVia<T = { id: string }>(
  app: RunningApp,
  token: string,
  body: Record<string, unknown>,
  mainToken?: string,
): Promise<Reply<T>> {
  const list = await request<{ profiles: Array<{ id: string; isMainProfile: boolean }> }>(app, 'GET', '/user/profiles', { token });
  const main = list.body.profiles.find((p) => p.isMainProfile);
  const headers: Record<string, string> = main ? { 'x-profile-id': main.id } : {};
  if (main && mainToken) headers['x-profile-token'] = mainToken;
  return request<T>(app, 'POST', '/user/profiles', { token, body, headers });
}
