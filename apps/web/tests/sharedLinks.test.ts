import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearSession, setActiveProfile, setSession } from '../src/data/session';
import { DebridManager, MemoryStatusStore, type KeyValueStore } from '../src/sources/debridClient';
import type { DebridProvider, ProviderId } from '../src/sources/debrid/types';
import { forgetSharedLink, getSharedLink, publishSharedLink, sourceKeyFor } from '../src/sources/sharedLinks';

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

  it('épisode ajouté à la clé : s<saison>e<épisode>, conforme au motif ; film : inchangé', () => {
    expect(sourceKeyFor({ infoHash: H1, fileIdx: 3 }, { season: 1, episode: 2 })).toBe(`${H1}:3:s1e2`);
    expect(sourceKeyFor({ infoHash: H1, fileIdx: 3 }, { season: 0, episode: 1 })).toBe(`${H1}:3:s0e1`);
    expect(sourceKeyFor({ infoHash: H1, fileIdx: 3 }, {})).toBe(`${H1}:3`);
    expect(KEY_RE.test(sourceKeyFor({ infoHash: H1, fileIdx: 3 }, { season: 12, episode: 104 })!)).toBe(true);
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

  it('non connecté (session absente) : aucun appel serveur', async () => {
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV } }));
    clearSession();
    expect(await getSharedLink(`${H1}:0`)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('clé hors motif : aucun appel', async () => {
    const sent = stubApi(() => ({ status: 200, body: { url: URL_SRV } }));
    expect(await getSharedLink('court')).toBeNull();
    expect(await getSharedLink(`${H1}/../x`)).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('invalidation du partage', () => {
  it('DELETE de la clé encodée ; coupure réseau : ne lève pas', async () => {
    const sent = stubApi(() => ({ status: 200, body: { ok: true } }));
    await forgetSharedLink(`${H1}:0`);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('DELETE');
    expect(sent[0].url).toContain('/debrid-links/' + encodeURIComponent(`${H1}:0`));

    stubApi(() => 'throw');
    await expect(forgetSharedLink(`${H1}:0`)).resolves.toBeUndefined();
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

  it('lien partagé en échec : DELETE du lien, déblocage sur l’appareil sans relire le partage, puis publication du nouveau lien', async () => {
    const sent = stubApi((s) => (s.method === 'GET' ? { status: 200, body: { url: URL_SRV, expiresAt: EXP } } : { status: 200, body: { ok: true, expiresAt: EXP } }));
    const ad = fake();
    const r = await manager(ad).recoverShared([{ infoHash: H1, fileIdx: 0, filename: 'f.mkv', size: 7 }]);
    expect(r).toMatchObject({ url: URL_DEV, provider: 'alldebrid' });
    expect(ad.resolveCalls).toBe(1);
    expect(sent[0].method).toBe('DELETE');
    expect(sent[0].url).toContain('/debrid-links/' + encodeURIComponent(`${H1}:0`));
    expect(sent.some((s) => s.method === 'GET')).toBe(false);
    await vi.waitFor(() => expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(1));
    expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({ sourceKey: `${H1}:0`, url: URL_DEV });
  });

  it('partage : 3 copies au plus interrogées', async () => {
    const sent = stubApi(() => ({ status: 404 }));
    const copies = [0, 1, 2, 3, 4].map((fileIdx) => ({ infoHash: H1, fileIdx }));
    await manager(fake()).resolve(copies);
    expect(sent.filter((s) => s.method === 'GET')).toHaveLength(3);
  });

  it('copie sans index de fichier : ni lecture ni publication serveur',async () => {
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

  // Régression : un pack dont l'addon donne le même fileIdx pour plusieurs épisodes (ou un fileIdx faux). Le lien de
  // l'épisode 2 publié sous `hash:0` était servi plus tard pour l'épisode 1 : mauvais épisode à l'écran.
  it('épisode dans la clé : le lien partagé d’un épisode n’est jamais demandé ni publié pour un autre', async () => {
    const store = new Map<string, string>();
    const sent = stubApi((s) => {
      const key = s.method === 'GET' ? new URL(s.url).searchParams.get('sourceKey') ?? '' : (s.body as { sourceKey: string }).sourceKey;
      if (s.method === 'PUT') { store.set(key, (s.body as { url: string }).url); return { status: 200, body: { expiresAt: EXP } }; }
      const url = store.get(key);
      return url ? { status: 200, body: { url } } : { status: 404 };
    });
    const ad = fake();
    ad.resolve = (_hash, hint) => {
      ad.resolveCalls += 1;
      const name = `Show.S01E0${hint.episode}.mkv`;
      return Promise.resolve({ url: `https://dl.alldebrid.test/${name}`, filename: name, size: 1 });
    };
    const m = manager(ad);
    const e2 = await m.resolve([{ infoHash: H1, fileIdx: 0 }], { season: 1, episode: 2 });
    expect(e2.url).toContain('S01E02');
    await vi.waitFor(() => expect(store.size).toBe(1));
    expect([...store.keys()]).toEqual([`${H1}:0:s1e2`]);
    const e1 = await m.resolve([{ infoHash: H1, fileIdx: 0 }], { season: 1, episode: 1 });
    expect(e1.url).toContain('S01E01');
    expect(ad.resolveCalls).toBe(2);
    expect(sent.filter((s) => s.method === 'GET').map((s) => new URL(s.url).searchParams.get('sourceKey'))).toEqual([`${H1}:0:s1e2`, `${H1}:0:s1e1`]);
  });

  it('fichier débloqué qui n’est pas l’épisode demandé : jamais partagé', async () => {
    const sent = stubApi((s) => (s.method === 'GET' ? { status: 404 } : { status: 200, body: { expiresAt: EXP } }));
    const ad = fake();
    ad.resolve = () => { ad.resolveCalls += 1; return Promise.resolve({ url: URL_DEV, filename: 'Show.S01E05.mkv', size: 1 }); };
    await manager(ad).resolve([{ infoHash: H1, fileIdx: 3 }], { season: 1, episode: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });
});
