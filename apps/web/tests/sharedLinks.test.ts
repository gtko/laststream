import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearSession, setActiveProfile, setLocalMode, setSession } from '../src/data/session';
import { DebridManager, MemoryStatusStore, type KeyValueStore } from '../src/sources/debridClient';
import type { DebridProvider, ProviderId } from '../src/sources/debrid/types';
import { getSharedLink, publishSharedLink, sourceKeyFor } from '../src/sources/sharedLinks';

/* Liens débridés partagés : serveur simulé (fetch), débrideur simulé. Aucun appel réseau réel, aucune clé réelle. */

const H1 = 'a1'.repeat(20);
const URL_DEV = 'https://dl.alldebrid.test/f.mkv';
const URL_SRV = 'https://shared.test/f.mkv';
const EXP = '2026-10-19T12:00:00.000Z';
const KEY_RE = /^[A-Za-z0-9:._-]{8,256}$/;

interface Sent { method: string; url: string; headers: Record<string, string>; body: unknown }
type Reply = { status: number; body?: unknown };

/** Route chaque appel fetch ; 'throw' simule une coupure réseau. Renvoie la liste des appels reçus. */
function stubApi(route: (s: Sent) => Reply | 'throw'): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const s: Sent = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(s);
    const r = route(s);
    if (r === 'throw') throw new Error('réseau coupé');
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }));
  return sent;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'https://srv.example', config: 'CFG' }));
  reloadSettings();
  setSession('tok', new Date(Date.now() + 1e9).toISOString(), 'greg');
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
  localStorage.clear();
});

describe('clé de partage', () => {
  it('infoHash:fileIdx en minuscules, conforme au motif du serveur', () => {
    const key = sourceKeyFor({ infoHash: H1.toUpperCase(), fileIdx: 3 });
    expect(key).toBe(`${H1}:3`);
    expect(key).toMatch(KEY_RE);
  });

  it('absente sans index de fichier fiable ou hash valide (pas de partage d’un épisode à l’autre)', () => {
    expect(sourceKeyFor({ infoHash: H1 })).toBeNull();
    expect(sourceKeyFor({ infoHash: H1, fileIdx: -1 })).toBeNull();
    expect(sourceKeyFor({ infoHash: H1, fileIdx: 1.5 })).toBeNull();
    expect(sourceKeyFor({ infoHash: 'xyz', fileIdx: 0 })).toBeNull();
  });
});

describe('lecture du partage', () => {
  it('renvoie le lien du serveur, avec le profil actif en X-Profile-Id', async () => {
    setActiveProfile('p1');
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV, expiresAt: EXP } }));
    expect(await getSharedLink(`${H1}:0`)).toEqual({ url: URL_SRV, expiresAt: EXP });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toBe(`https://srv.example/user/debrid-links?sourceKey=${encodeURIComponent(`${H1}:0`)}`);
    expect(sent[0].headers.authorization).toBe('Bearer tok');
    expect(sent[0].headers['x-profile-id']).toBe('p1');
  });

  it.each([404, 401, 500])('réponse %i : aucun lien, sans lever', async (status) => {
    stubApi(() => ({ status, body: { error: 'x' } }));
    expect(await getSharedLink(`${H1}:0`)).toBeNull();
  });

  it('coupure réseau : aucun lien, sans lever', async () => {
    stubApi(() => 'throw');
    expect(await getSharedLink(`${H1}:0`)).toBeNull();
  });

  it('réponse sans lien http(s) exploitable : ignorée', async () => {
    stubApi(() => ({ status: 200, body: { url: 'javascript:alert(1)' } }));
    expect(await getSharedLink(`${H1}:0`)).toBeNull();
  });

  it('non connecté (session absente) ou mode local : aucun appel serveur', async () => {
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV } }));
    clearSession();
    expect(await getSharedLink(`${H1}:0`)).toBeNull();
    setSession('tok', new Date(Date.now() + 1e9).toISOString(), 'greg');
    setLocalMode(true);
    expect(await getSharedLink(`${H1}:0`)).toBeNull();
    setLocalMode(false);
    expect(sent).toHaveLength(0);
  });

  it('clé hors motif : aucun appel', async () => {
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV } }));
    expect(await getSharedLink('court')).toBeNull();
    expect(await getSharedLink(`${H1}/../x`)).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('publication du partage', () => {
  it('PUT {sourceKey, url} sans expiresAt quand elle est inconnue', async () => {
    const sent = stubApi(() => ({ status: 200, body: { expiresAt: EXP } }));
    await publishSharedLink(`${H1}:0`, URL_DEV);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].url).toBe('https://srv.example/user/debrid-links');
    expect(sent[0].body).toEqual({ sourceKey: `${H1}:0`, url: URL_DEV });
  });

  it('ajoute expiresAt quand elle est connue', async () => {
    const sent = stubApi(() => ({ status: 200, body: { expiresAt: EXP } }));
    await publishSharedLink(`${H1}:0`, URL_DEV, EXP);
    expect(sent[0].body).toEqual({ sourceKey: `${H1}:0`, url: URL_DEV, expiresAt: EXP });
  });

  it('échec serveur ou coupure réseau : ne lève pas', async () => {
    stubApi(() => ({ status: 500, body: { error: 'boom' } }));
    await expect(publishSharedLink(`${H1}:0`, URL_DEV)).resolves.toBeUndefined();
    stubApi(() => 'throw');
    await expect(publishSharedLink(`${H1}:0`, URL_DEV)).resolves.toBeUndefined();
  });

  it('non connecté : aucun appel', async () => {
    clearSession();
    const sent = stubApi(() => ({ status: 200, body: {} }));
    await publishSharedLink(`${H1}:0`, URL_DEV);
    expect(sent).toHaveLength(0);
  });
});

describe('résolution sur l’appareil et partage', () => {
  const memStore = (): KeyValueStore => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
  };
  interface Fake extends DebridProvider { resolveCalls: number }
  function fake(id: ProviderId = 'alldebrid'): Fake {
    const f: Fake = {
      id, label: id, resolveCalls: 0,
      checkCache: (hashes) => Promise.resolve(new Map(hashes.map((h) => [h, true]))),
      resolve: () => { f.resolveCalls += 1; return Promise.resolve({ url: URL_DEV, filename: 'f.mkv', size: 1 }); },
      status: () => Promise.resolve({ state: 'ok' }),
    };
    return f;
  }
  function manager(p: Fake): DebridManager {
    const m = new DebridManager({ store: memStore(), statuses: new MemoryStatusStore(), native: () => 'shell', makeProvider: () => p });
    m.setKey('alldebrid', 'k-alldebrid');
    return m;
  }

  it('lien partagé trouvé : aucun débrideur appelé, le lien du serveur est utilisé', async () => {
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV, expiresAt: EXP } }));
    const ad = fake();
    const r = await manager(ad).resolve([{ infoHash: H1, fileIdx: 0, filename: 'f.mkv', size: 7 }]);
    expect(r).toEqual({ url: URL_SRV, filename: 'f.mkv', size: 7 });
    expect(r.provider).toBeUndefined();
    expect(ad.resolveCalls).toBe(0);
    expect(sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('absent (404) : débloque sur l’appareil, puis publie {sourceKey, url} sans attendre', async () => {
    const sent = stubApi((s) => (s.method === 'GET' ? { status: 404, body: { error: 'not_found' } } : { status: 200, body: { expiresAt: EXP } }));
    const ad = fake();
    const r = await manager(ad).resolve([{ infoHash: H1, fileIdx: 0 }]);
    expect(r).toMatchObject({ url: URL_DEV, provider: 'alldebrid' });
    expect(ad.resolveCalls).toBe(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('sourceKey=' + encodeURIComponent(`${H1}:0`));
    await vi.waitFor(() => expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(1));
    expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({ sourceKey: `${H1}:0`, url: URL_DEV });
  });

  it('publication en échec : la lecture aboutit quand même', async () => {
    const sent = stubApi((s) => (s.method === 'GET' ? { status: 404 } : 'throw'));
    const r = await manager(fake()).resolve([{ infoHash: H1, fileIdx: 2 }]);
    expect(r.url).toBe(URL_DEV);
    await vi.waitFor(() => expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(1));
  });

  it('serveur injoignable pendant la lecture : débridage sur l’appareil, sans blocage', async () => {
    stubApi(() => 'throw');
    const ad = fake();
    const r = await manager(ad).resolve([{ infoHash: H1, fileIdx: 0 }]);
    expect(r.url).toBe(URL_DEV);
    expect(ad.resolveCalls).toBe(1);
  });

  it('non connecté : aucun appel serveur, débridage sur l’appareil seulement', async () => {
    clearSession();
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV } }));
    const ad = fake();
    const r = await manager(ad).resolve([{ infoHash: H1, fileIdx: 0 }]);
    expect(r.url).toBe(URL_DEV);
    expect(sent).toHaveLength(0);
  });

  it('copie sans index de fichier : ni lecture ni publication serveur', async () => {
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV } }));
    const ad = fake();
    const r = await manager(ad).resolve([{ infoHash: H1 }]);
    expect(r.url).toBe(URL_DEV);
    expect(sent).toHaveLength(0);
  });

  it('ne journalise jamais les liens', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    const sent = stubApi((s) => (s.method === 'GET' ? { status: 404 } : { status: 500, body: { error: 'x' } }));
    await manager(fake()).resolve([{ infoHash: H1, fileIdx: 0 }]);
    await vi.waitFor(() => expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(1));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});
