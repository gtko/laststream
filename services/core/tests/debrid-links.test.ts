import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryKvCache } from '../src/platform/memory-kv-cache.js';
import { platform, setPlatform } from '../src/platform/index.js';
import type { KvCache } from '../src/platform/types.js';
import { DEBRID_LINK_DEFAULT_TTL_MS, DEBRID_LINK_MAX_TTL_MS, DEBRID_LINK_NAMESPACE } from '../src/user/debrid-links.js';
import { addKidProfile, type AdminRig, inviteAndRegister, type Member, request, startAdmin } from './admin-harness.js';

/*
 * Liens débridés partagés entre profils (GET/PUT /user/debrid-links). L'appareil débloque, le serveur stocke chiffré et
 * ne rend le lien qu'au même compte, depuis la même IP publique, avant l'échéance.
 */

interface Write {
  key: string;
  value: string;
  ttlSeconds: number | undefined;
}

// Cache enregistré : le test lit ce que l'application écrit réellement (valeur, clé, TTL).
const writes: Write[] = [];
const memory = createMemoryKvCache();
const recording: KvCache = {
  get: (key) => memory.get(key),
  set: (key, value, ttlSeconds) => {
    writes.push({ key, value, ttlSeconds });
    return memory.set(key, value, ttlSeconds);
  },
  delete: (key) => memory.delete(key),
};

const original = platform();
const IP_A = '203.0.113.7';
const IP_B = '198.51.100.20';
const SOURCE = `${'a'.repeat(40)}:3`;
const TOKEN = 'SECRET-TOKEN-XYZ';
const URL_A = `https://debrid.example.test/d/${TOKEN}/film.mkv`;

interface LinkBody {
  url?: string;
  expiresAt?: string;
  error?: string;
  issues?: string[];
}

describe('liens débridés partagés entre profils', () => {
  let rig: AdminRig;
  let bob: Member;
  let kid: string;

  beforeAll(async () => {
    setPlatform({
      ...original,
      createKvCache: (namespace) => (namespace === DEBRID_LINK_NAMESPACE ? recording : original.createKvCache(namespace)),
    });
    rig = await startAdmin();
    bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    kid = await addKidProfile(rig.app, rig.owner);
  });
  afterAll(async () => {
    await rig.app.close();
    setPlatform(original);
  });

  // `null` = pas d'en-tête CF-Connecting-IP (la socket de test sert d'IP) ; `undefined` garde la valeur par défaut.
  const headersOf = (ip: string | null, profile?: string): Record<string, string> => ({
    ...(ip === null ? {} : { 'cf-connecting-ip': ip }),
    ...(profile === undefined ? {} : { 'x-profile-id': profile }),
  });
  const put = (token: string | undefined, body: unknown, ip: string | null = IP_A, profile?: string) =>
    request<LinkBody>(rig.app, 'PUT', '/user/debrid-links', { token, headers: headersOf(ip, profile), body: body as never });
  const get = (token: string | undefined, sourceKey: string, ip: string | null = IP_A, profile?: string) =>
    request<LinkBody>(rig.app, 'GET', `/user/debrid-links?sourceKey=${encodeURIComponent(sourceKey)}`, { token, headers: headersOf(ip, profile) });

  it('sans session (invité ou non authentifié) : 401 en lecture comme en écriture', async () => {
    expect((await put(undefined, { sourceKey: SOURCE, url: URL_A })).status).toBe(401);
    expect((await get(undefined, SOURCE)).status).toBe(401);
    expect((await get('x'.repeat(43), SOURCE)).status).toBe(401);
  });

  it('même compte et même IP : le lien est rendu, à tout profil du compte (enfant compris)', async () => {
    const stored = await put(rig.owner.token, { sourceKey: SOURCE, url: URL_A });
    expect(stored.status).toBe(200);
    expect(typeof stored.body.expiresAt).toBe('string');

    const mine = await get(rig.owner.token, SOURCE, IP_A, rig.owner.profile);
    expect(mine.status).toBe(200);
    expect(mine.body.url).toBe(URL_A);
    expect(mine.headers.get('cache-control')).toBe('no-store');

    const child = await get(rig.owner.token, SOURCE, IP_A, kid);
    expect(child.status).toBe(200);
    expect(child.body.url).toBe(URL_A);
  });

  it('autre IP publique : 404 (l appareil débloquera lui-même) ; sans en-tête CF, la socket de test ne correspond pas non plus', async () => {
    const other = await get(rig.owner.token, SOURCE, IP_B);
    expect(other.status).toBe(404);
    expect(other.body.error).toBe('debrid_link_not_found');
    expect(JSON.stringify(other.body)).not.toContain(TOKEN);
    expect((await get(rig.owner.token, SOURCE, null)).status).toBe(404);
  });

  it('autre compte : 404 pour la même clé de source et la même IP', async () => {
    await put(bob.token, { sourceKey: 'bob-source-0001', url: 'https://debrid.example.test/d/BOB/x.mkv' }, IP_A);
    const res = await get(bob.token, SOURCE, IP_A, bob.profile);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    // Le propriétaire ne voit pas non plus le lien de Bob.
    expect((await get(rig.owner.token, 'bob-source-0001', IP_A)).status).toBe(404);
  });

  it('clé de source inconnue : 404 ; clé mal formée ou absente : 400', async () => {
    expect((await get(rig.owner.token, 'z'.repeat(40), IP_A)).status).toBe(404);
    expect((await get(rig.owner.token, 'trop court', IP_A)).status).toBe(400);
    const missing = await request<LinkBody>(rig.app, 'GET', '/user/debrid-links', { token: rig.owner.token, headers: headersOf(IP_A) });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_body');
  });

  it('un nouveau dépôt remplace le lien de la même source ; l ancienne IP ne le voit plus', async () => {
    const source = 'replace-source-0001';
    await put(rig.owner.token, { sourceKey: source, url: 'https://debrid.example.test/d/ANCIEN/a.mkv' }, IP_A);
    await put(rig.owner.token, { sourceKey: source, url: 'https://debrid.example.test/d/NOUVEAU/a.mkv' }, IP_B);
    const fromB = await get(rig.owner.token, source, IP_B);
    expect(fromB.body.url).toBe('https://debrid.example.test/d/NOUVEAU/a.mkv');
    expect((await get(rig.owner.token, source, IP_A)).status).toBe(404);
  });

  it('expiré : non rendu une fois l échéance passée (horloge simulée)', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(t0);
      const expiresAt = new Date(t0 + 60_000).toISOString();
      const stored = await put(rig.owner.token, { sourceKey: 'expiry-source-0001', url: URL_A, expiresAt });
      expect(stored.status).toBe(200);
      expect(stored.body.expiresAt).toBe(expiresAt);
      expect((await get(rig.owner.token, 'expiry-source-0001', IP_A)).status).toBe(200);
      vi.setSystemTime(t0 + 61_000);
      const late = await get(rig.owner.token, 'expiry-source-0001', IP_A);
      expect(late.status).toBe(404);
      expect(JSON.stringify(late.body)).not.toContain(TOKEN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('durée : 3 h par défaut ; expiresAt lointain ramené au plafond de 24 h', async () => {
    const t0 = Date.now();
    const def = await put(rig.owner.token, { sourceKey: 'default-ttl-source-1', url: URL_A });
    expect(Math.abs(Date.parse(def.body.expiresAt as string) - (t0 + DEBRID_LINK_DEFAULT_TTL_MS))).toBeLessThan(5_000);
    const defWrite = writes.at(-1);
    expect(defWrite?.ttlSeconds).toBeGreaterThan(3 * 3600 - 5);
    expect(defWrite?.ttlSeconds).toBeLessThanOrEqual(3 * 3600 + 5);

    const far = await put(rig.owner.token, { sourceKey: 'far-ttl-source-0001', url: URL_A, expiresAt: new Date(t0 + 30 * 3600_000).toISOString() });
    expect(far.status).toBe(200);
    expect(Math.abs(Date.parse(far.body.expiresAt as string) - (t0 + DEBRID_LINK_MAX_TTL_MS))).toBeLessThan(5_000);
    expect(writes.at(-1)?.ttlSeconds).toBeLessThanOrEqual(24 * 3600 + 5);
  });

  it('validation : URL non http(s) ou trop longue, clé mal formée, expiresAt passé ou non ISO : 400 sans recopier l URL', async () => {
    const invalidUrls = [
      `file:///etc/passwd?t=${TOKEN}`,
      `javascript:alert('${TOKEN}')`,
      `ftp://debrid.example.test/${TOKEN}`,
      `https://debrid.example.test/${'a'.repeat(4096)}`,
      'pas une url',
    ];
    for (const url of invalidUrls) {
      const res = await put(rig.owner.token, { sourceKey: SOURCE, url }, IP_A);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_body');
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    }
    expect((await put(rig.owner.token, { sourceKey: 'bad key with spaces', url: URL_A })).status).toBe(400);
    expect((await put(rig.owner.token, { url: URL_A })).status).toBe(400);
    const past = await put(rig.owner.token, { sourceKey: SOURCE, url: URL_A, expiresAt: '2001-01-01T00:00:00Z' });
    expect(past.status).toBe(400);
    expect(past.body.issues).toEqual(['expiresAt:passe']);
    expect((await put(rig.owner.token, { sourceKey: SOURCE, url: URL_A, expiresAt: 'demain' })).status).toBe(400);
  });

  it('valeur stockée chiffrée : ni URL, ni jeton, ni IP, ni clé de source en clair ; la clé KV ne contient pas la clé de source', async () => {
    writes.length = 0;
    const source = 'encrypted-source-0001';
    expect((await put(rig.owner.token, { sourceKey: source, url: URL_A })).status).toBe(200);
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write?.value).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const needle of [URL_A, TOKEN, 'debrid.example.test', IP_A, source]) {
      expect(write?.value).not.toContain(needle);
      expect(write?.key).not.toContain(needle);
    }
    expect(write?.key).toMatch(/^[^:]+:[0-9a-f]{64}$/);
    // Déchiffrée à la lecture : le même compte retrouve bien le lien.
    expect((await get(rig.owner.token, source, IP_A)).body.url).toBe(URL_A);
  });

  it('le lien et l IP ne sont jamais journalisés', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      await put(rig.owner.token, { sourceKey: 'log-source-0001', url: URL_A });
      await get(rig.owner.token, 'log-source-0001', IP_B);
      await get(rig.owner.token, 'log-source-0001', IP_A);
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const text = JSON.stringify(call);
          expect(text).not.toContain(TOKEN);
          expect(text).not.toContain(IP_A);
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
