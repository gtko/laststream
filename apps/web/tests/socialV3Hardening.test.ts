// Social v3 : client aligné sur les règles serveur durcies (groupes à propriétaire, limites, liens publics, présence des inconnus).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth } from '../src/data/auth';
import { saveProfileToken, setSession } from '../src/data/session';
import * as v3 from '../src/data/socialV3Api';
import { groupErrorMessage, joinErrorMessage, reactionErrorMessage, reportErrorMessage } from '../src/ui/socialChat.js';
import { convInfo, hasPresence, personName } from '../src/ui/socialConvModel.js';
import { linkRow, linksErrorText } from '../src/ui/shareModel.js';
import { UserApiError } from '../src/data/userApi';

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
let sent: Array<{ method: string; url: string }> = [];

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  setSession('sess-token', FUTURE, 'greg');
  saveProfileToken('p1', { token: 'prof-token', expiresAt: FUTURE });
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg' } as any;
});
beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', url: String(url) });
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ links: [] }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('liens publics : API', () => {
  it('liste mes liens et révoque un lien', async () => {
    await v3.getMyShareLinks();
    await v3.revokeShareLink('AbCdEfGhIj');
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'http://localhost:7000/user/social/share-links' });
    expect(sent[1]).toMatchObject({ method: 'DELETE', url: 'http://localhost:7000/user/social/share-links/AbCdEfGhIj' });
  });
  it('ligne « Mes liens » : actif, expiré', () => {
    const now = Date.UTC(2026, 5, 10);
    const live = linkRow({ title: 'Dune', pos: 125, createdAt: now - 86_400_000, expiresAt: now + 5 * 86_400_000, expired: false }, now);
    expect(live.expired).toBe(false);
    expect(live.title).toBe('Dune · à 2:05');
    expect(live.sub).toContain('expire le');
    const old = linkRow({ title: 'Dune', createdAt: now - 40 * 86_400_000, expiresAt: now - 86_400_000, expired: true }, now);
    expect(old.expired).toBe(true);
    expect(old.sub).toContain('expiré');
  });
  it('erreurs de « Mes liens »', () => {
    expect(linksErrorText(new UserApiError(404, 'share_not_found'), 'revoke')).toMatch(/n’existe déjà plus/);
    expect(linksErrorText(new UserApiError(429, 'rate_limited'), 'list')).toMatch(/Trop de demandes/);
  });
});

describe('messages d’erreur', () => {
  it('groupe : refus par nom, propriétaire, limite de débit', () => {
    const names: Record<string, string> = { a: 'Léa', b: 'Hugo', c: 'Sam' };
    const nameOf = (p: string) => names[p];
    expect(groupErrorMessage(new UserApiError(403, 'not_allowed', { issues: ['a'] }), nameOf)).toBe('Léa n’accepte pas les messages de groupe.');
    expect(groupErrorMessage(new UserApiError(403, 'not_allowed', { issues: ['a', 'b', 'c'] }), nameOf)).toBe('Léa, Hugo et Sam n’acceptent pas les messages de groupe.');
    expect(groupErrorMessage(new UserApiError(403, 'owner_only'))).toMatch(/propriétaire/);
    expect(groupErrorMessage(new UserApiError(429, 'rate_limited'))).toMatch(/Trop de groupes/);
  });
  it('réaction, demande de rejoindre, signalement', () => {
    expect(reactionErrorMessage(new UserApiError(409, 'too_many_reactions'))).toMatch(/Six emojis/);
    expect(reactionErrorMessage(new UserApiError(429, 'rate_limited'))).toMatch(/Trop de réactions/);
    expect(reactionErrorMessage(new UserApiError(403, 'not_allowed'))).toMatch(/plus réagir/);
    expect(joinErrorMessage(new UserApiError(429, 'rate_limited'))).toMatch(/Trop de demandes/);
    expect(reportErrorMessage(new UserApiError(429, 'rate_limited'))).toMatch(/Trop de signalements/);
  });
});

const fr = (pid: string, name: string, extra: any = {}) =>
  ({ pid, handle: { name, tag: 'AB23', full: name + '#AB23' }, avatarColor: '#7b5cff', household: false, status: 'online', ...extra });
const state = (ownerPid?: string) => ({
  me: { pid: 'me' }, friends: [fr('p1', 'Léa')], household: [], conversations: [{ pid: 'z9', handle: fr('z9', 'Zoé').handle, avatarColor: '#000', unread: 0 }],
  groups: [{ conv: 'g:1', unread: 0, group: { id: '1', name: 'Ciné', ownerPid, members: [fr('p1', 'Léa'), fr('x7', 'Inconnu', { status: 'offline' })] } }],
}) as any;

describe('propriétaire et présence', () => {
  it('seul le propriétaire est marqué owner ; sans ownerPid, personne', () => {
    expect(convInfo('g:1', state('me'))!.owner).toBe(true);
    expect(convInfo('g:1', state('p1'))!.owner).toBe(false);
    expect(convInfo('g:1', state())!.owner).toBe(false);
  });
  it('présence : seulement pour un ami ou le foyer', () => {
    const s = state('p1');
    expect(hasPresence('p1', s)).toBe(true);
    expect(hasPresence('x7', s)).toBe(false);
    expect(convInfo('dm:p1', s)!.known).toBe(true);
    expect(convInfo('dm:z9', s)!.known).toBe(false);
    expect(personName('x7', s)).toBe('Inconnu');
    expect(personName('nope', s)).toBe('Quelqu’un');
  });
});
