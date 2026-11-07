import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTvSources } from '../src/user/tv-sources.js';
import { addKidProfile, inviteAndRegister, type Member, request, startAdmin, type AdminRig } from './admin-harness.js';
import { createProfileVia } from './user-harness.js';

interface ListsBody {
  lists: unknown[] | null;
}

const asProfile = (profile: string) => ({ 'x-profile-id': profile });
const SECRET_URL = 'http://iptv.example.net:8080/get.php?username=alice&password=tres-secret';
const lists = [
  { id: 'a', name: 'Ma box', kind: 'freebox', url: 'http://mafreebox.freebox.fr/freeboxtv/playlist.m3u', guideUrl: '', enabled: true },
  { id: 'b', name: 'IPTV', kind: 'url', url: SECRET_URL, guideUrl: 'https://epg.example.net/guide.xml.gz', enabled: false },
];
const fetchStub = () => Promise.resolve(new Response('{}', { status: 404 }));

describe('sources TV du compte', () => {
  let rig: AdminRig;
  let other: Member;
  let kid: string;
  let jessica: string;

  beforeAll(async () => {
    rig = await startAdmin({ fetch: fetchStub });
    other = await inviteAndRegister(rig.app, rig.owner, 'bob');
    kid = await addKidProfile(rig.app, rig.owner);
    jessica = (await createProfileVia(rig.app, rig.owner.token, { name: 'Jessica' })).body.id;
  });
  afterAll(async () => {
    await rig.app.close();
  });

  const put = (token: string, profile: string | undefined, body: unknown) =>
    request<{ error?: string; ok?: boolean }>(rig.app, 'PUT', '/user/account/tv-sources', { token, headers: profile === undefined ? {} : asProfile(profile), body: body as never });

  it('sans session : 401 ; compte vide : { lists: null }', async () => {
    expect((await request(rig.app, 'GET', '/user/account/tv-sources')).status).toBe(401);
    expect((await request(rig.app, 'PUT', '/user/account/tv-sources', { body: { lists } })).status).toBe(401);
    const res = await request<ListsBody>(rig.app, 'GET', '/user/account/tv-sources', { token: rig.owner.token });
    expect(res.body).toEqual({ lists: null });
  });

  it('profil secondaire, enfant ou sans profil : écriture refusée (403 main_profile_required)', async () => {
    for (const profile of [jessica, kid, undefined]) {
      const res = await put(rig.owner.token, profile, { lists });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('main_profile_required');
    }
  });

  it('le principal écrit ; tous les profils (enfant compris) lisent en clair, no-store', async () => {
    const res = await put(rig.owner.token, rig.owner.profile, { lists });
    expect(res.status).toBe(200);
    for (const profile of [kid, jessica, rig.owner.profile]) {
      const raw = await fetch(`${rig.app.baseUrl}/user/account/tv-sources`, { headers: { authorization: `Bearer ${rig.owner.token}`, 'x-profile-id': profile } });
      expect(raw.status).toBe(200);
      expect(raw.headers.get('cache-control')).toBe('no-store');
      expect(((await raw.json()) as ListsBody).lists).toEqual(lists);
    }
  });

  it('autre compte : rien en lecture, profil étranger refusé, écriture sans effet sur le premier', async () => {
    const mine = await request<ListsBody>(rig.app, 'GET', '/user/account/tv-sources', { token: other.token, headers: asProfile(other.profile) });
    expect(mine.body).toEqual({ lists: null });
    expect((await request(rig.app, 'GET', '/user/account/tv-sources', { token: other.token, headers: asProfile(rig.owner.profile) })).status).toBe(404);
    await put(other.token, other.profile, { lists: [{ ...lists[0], name: 'Autre' }] });
    const alice = await request<ListsBody>(rig.app, 'GET', '/user/account/tv-sources', { token: rig.owner.token });
    expect(alice.body.lists).toEqual(lists);
  });

  it('null supprime les sources', async () => {
    const tmp = await inviteAndRegister(rig.app, rig.owner, 'erin');
    await put(tmp.token, tmp.profile, { lists });
    expect((await put(tmp.token, tmp.profile, { lists: null })).status).toBe(200);
    expect((await request<ListsBody>(rig.app, 'GET', '/user/account/tv-sources', { token: tmp.token })).body).toEqual({ lists: null });
  });

  it('validation : trop de listes, URL non http(s) ou trop longue, nom trop long, type inconnu', async () => {
    const h = rig.owner.profile;
    const bad = (value: unknown) => put(rig.owner.token, h, { lists: value }).then((r) => r.status);
    expect(await bad(Array.from({ length: 21 }, (_, i) => ({ ...lists[0], id: `x${i}` })))).toBe(400);
    expect(await bad(Array.from({ length: 20 }, (_, i) => ({ ...lists[0], id: `x${i}` })))).toBe(200);
    expect(await bad([{ ...lists[0], url: 'file:///etc/passwd' }])).toBe(400);
    expect(await bad([{ ...lists[0], url: 'ftp://exemple.net/a.m3u' }])).toBe(400);
    expect(await bad([{ ...lists[0], url: 'http://exemple.net/' + 'a'.repeat(2048) }])).toBe(400);
    expect(await bad([{ ...lists[0], guideUrl: 'javascript:alert(1)' }])).toBe(400);
    expect(await bad([{ ...lists[0], name: 'n'.repeat(81) }])).toBe(400);
    expect(await bad([{ ...lists[0], kind: 'autre' }])).toBe(400);
    expect(await bad([{ ...lists[0], enabled: 'oui' }])).toBe(400);
    expect(await bad('x')).toBe(400);
    expect((await put(rig.owner.token, h, {})).status).toBe(400);
    expect(await bad([{ ...lists[0], name: 'n'.repeat(80) }])).toBe(200);
    await put(rig.owner.token, h, { lists });
  });

  it('une erreur de validation ne recopie pas l URL', async () => {
    const res = await request(rig.app, 'PUT', '/user/account/tv-sources', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { lists: [{ ...lists[1], url: 'ftp://hote.example/chemin?password=tres-secret' }] } as never,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('tres-secret');
  });

  it('chiffrement au repos : la valeur stockée est opaque (aucune URL ni mot de passe en clair)', async () => {
    await put(rig.owner.token, rig.owner.profile, { lists });
    const accounts = await rig.backend.admin().listAccounts({ limit: 50 } as never);
    let stored: string | null = null;
    for (const a of accounts.accounts) {
      const v = await rig.backend.users().getTvSources(a.id);
      if (v !== null) stored = v;
    }
    expect(stored).not.toBeNull();
    expect(stored).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const needle of ['example.net', 'tres-secret', 'freebox', 'http']) expect(stored).not.toContain(needle);
  });

  it('parseTvSources : guideUrl absent accepté (chaîne vide)', () => {
    const { guideUrl: _g, ...rest } = lists[0] as Record<string, unknown>;
    expect(parseTvSources([rest])?.[0]?.guideUrl).toBe('');
  });
});
