import { exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/**
 * Lien public sans session contre le vrai Worker (src/worker.ts) : mêmes réponses que sous Node (404 `share_not_found`
 * pour un code inconnu, 400 `ip_required` sans adresse du client, 200 pour un lien existant), jamais 500.
 */

const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const ADMIN = 'admin-test-secret-with-more-than-32-chars';
const PASSWORD = 'mot-de-passe-test-1';
const UNKNOWN_CODE = 'abcdefghijklmnopqrstuv';

let counter = 0;
/** Adresse distincte par requête (les limites Rate Limiting sont par IP). */
const nextIp = (): string => `198.51.${Math.floor(counter / 250) % 250}.${(counter += 1) % 250}`;

interface CallOptions {
  /** Adresse du client (en-tête posé par Cloudflare) : absente si non précisée. */
  ip?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de test non typés */
async function call(method: string, path: string, options: CallOptions = {}): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.ip !== undefined) headers['cf-connecting-ip'] = options.ip;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(`https://worker.test${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
/** Compte neuf (invitation système), profil et jeton : en-têtes d'un profil agissant. */
async function owner(prefix: string): Promise<Record<string, string>> {
  const name = `${prefix}${++counter}x${Math.floor(Math.random() * 1e6)}`.toLowerCase().slice(0, 30);
  const invite = await call('POST', '/__admin/invite', { headers: { 'x-admin-secret': ADMIN } });
  expect(invite.status).toBe(200);
  const reg = await call('POST', '/user/register', { ip: nextIp(), body: { username: name, password: PASSWORD, invite: invite.body.code } });
  expect(reg.status).toBe(201);
  const login = await call('POST', '/user/login', { ip: nextIp(), body: { username: name, password: PASSWORD } });
  const authorization = `Bearer ${login.body.token as string}`;
  const profile = await call('POST', '/user/profiles', { ip: nextIp(), headers: { authorization }, body: { name, avatarColor: '#aa5500' } });
  return { authorization, 'x-profile-id': profile.body.id as string };
}

describe('lien public sans session (Worker)', () => {
  it('code inconnu de 22 caractères : 404 share_not_found (pas de 500)', async () => {
    const res = await call('GET', `/user/social/share-links/${UNKNOWN_CODE}`, { ip: nextIp() });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'share_not_found' });
  });

  it('code mal formé : 404 share_not_found', async () => {
    const res = await call('GET', '/user/social/share-links/court', { ip: nextIp() });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'share_not_found' });
  });

  it('sans adresse du client : 400 ip_required', async () => {
    const res = await call('GET', `/user/social/share-links/${UNKNOWN_CODE}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'ip_required' });
  });

  it('code valide créé par un compte (base non vide) : 200 sans session, puis code inconnu : 404', async () => {
    const headers = await owner('partage');
    const created = await call('POST', '/user/social/share-links', {
      ip: nextIp(),
      headers,
      body: { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg', withInvite: false },
    });
    expect(created.status).toBe(201);
    const valid = await call('GET', `/user/social/share-links/${created.body.code as string}`, { ip: nextIp() });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ type: 'movie', tmdbId: 603, title: 'Matrix' });
    const unknown = await call('GET', `/user/social/share-links/${UNKNOWN_CODE}`, { ip: nextIp() });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'share_not_found' });
  });
});
