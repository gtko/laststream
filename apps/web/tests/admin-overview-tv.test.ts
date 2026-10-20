// Console d'administration : vue d'ensemble (balayage des comptes contre la validation du serveur), page TV (dernier passage du cron), rendu de la performance.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { setActiveProfile, setSession } from '../src/data/session';
import * as admin from '../src/data/adminApi';
import type { AccountList, Metrics } from '../src/data/adminApi';
import { ACCOUNT_PAGE_LIMIT, ACCOUNT_SCAN_PAGES, fmtInt, fmtMs, scanAccounts } from '../src/data/adminModel';
import { UserApiError } from '../src/data/userApi';
import { adminErr } from '../src/ui/admin/common.js';
import { overviewHTML } from '../src/ui/admin/pilotage.js';
import { performanceHTML, tasksHTML } from '../src/ui/admin/platform.js';

interface Call { url: string; method: string }
let calls: Call[] = [];
let handler: (c: Call) => Response;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
type Account = AccountList['accounts'][number];
const account = (i: number): Account => ({
  id: `acc-${i}`, username: `user${i}`, isOwner: i === 0, createdAt: '2026-01-01T00:00:00.000Z',
  status: i % 50 === 0 ? 'suspended' : 'active', suspendedAt: null, referrer: null,
  lastActivityAt: i % 5 === 0 ? '2026-10-19T08:00:00.000Z' : '2026-09-01T00:00:00.000Z',
  profileCount: 1, libraryCount: 0, inviteQuota: 0, invitesUsed: 0, online: false, sessionCount: 0,
});

/** Réponse de GET /admin/accounts : même contrat que le serveur (limit de 1 à 100, sinon 400 invalid_body ; curseur = offset). */
function accountsReply(c: Call, all: Account[]): Response {
  const u = new URL(c.url);
  const limit = Number(u.searchParams.get('limit') ?? '25');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: 'invalid_body', details: ['limit:too_big'] }, 400);
  const offset = Number((u.searchParams.get('cursor') ?? 'c0').slice(1));
  const next = offset + limit < all.length ? `c${offset + limit}` : null;
  return json({ accounts: all.slice(offset, offset + limit), nextCursor: next, total: all.length });
}

const accountCalls = () => calls.filter((c) => c.url.includes('/admin/accounts'));

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = { url: String(url), method: String(init?.method ?? 'GET') };
    calls.push(c);
    return handler(c);
  }));
});

beforeEach(() => {
  calls = [];
  setSession('sess-token', new Date(Date.now() + 3e9).toISOString(), 'greg');
  setActiveProfile('p-adulte');
});

describe('vue d’ensemble : balayage des comptes', () => {
  it('le serveur refuse une page de 200 (cause d’origine : « Erreur (invalid_body). »)', async () => {
    handler = (c) => accountsReply(c, [account(0)]);
    const err = await admin.listAccounts({ limit: 200, order: 'newest' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserApiError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_body' });
    expect(adminErr(err)).toBe('Erreur (invalid_body).');
  });

  it('chaque page demandée respecte la limite du serveur et le total est exact', async () => {
    const all = Array.from({ length: 250 }, (_, i) => account(i));
    handler = (c) => accountsReply(c, all);
    const scan = await scanAccounts((cursor) => admin.listAccounts({ limit: ACCOUNT_PAGE_LIMIT, order: 'newest', cursor }), NOW);
    expect(scan).toEqual({ total: 250, active24: 50, suspended: 5, scanned: 250, truncated: false });
    expect(accountCalls().length).toBe(3);
    for (const c of accountCalls()) expect(Number(new URL(c.url).searchParams.get('limit'))).toBeLessThanOrEqual(100);
  });

  it('au-delà de 1 000 comptes : plafond de pages, résultat marqué partiel', async () => {
    const all = Array.from({ length: 1500 }, (_, i) => account(i));
    handler = (c) => accountsReply(c, all);
    const scan = await scanAccounts((cursor) => admin.listAccounts({ limit: ACCOUNT_PAGE_LIMIT, order: 'newest', cursor }), NOW);
    expect(accountCalls().length).toBe(ACCOUNT_SCAN_PAGES);
    expect(scan).toMatchObject({ total: 1500, scanned: ACCOUNT_PAGE_LIMIT * ACCOUNT_SCAN_PAGES, truncated: true });
  });

  it('la vue affiche les chiffres au lieu de l’erreur', () => {
    const html = overviewHTML({
      ov: {
        status: 'ready', error: '',
        value: { total: 250, active24: 50, suspended: 5, scanned: 250, truncated: false, signups7: 4, metrics: null, rooms: 0, reports: 0, maintenance: false },
      },
    });
    expect(html).toContain(fmtInt(250));
    expect(html).toContain(fmtInt(50));
    expect(html).toContain(`${fmtInt(5)} suspendu(s)`);
    expect(html).not.toContain('adm-error');
  });
});

describe('page TV : dernier passage du cron', () => {
  const lastCron = {
    startedAt: '2026-10-18T03:00:00.000Z', finishedAt: '2026-10-18T03:04:12.000Z', durationMs: 252_000,
    ok: true, channels: 708, programmes: 15_230, epgOk: true, error: null,
  };

  it('affiche date, durée, chaînes, programmes, EPG et erreur', () => {
    const html = tasksHTML({ tv: { status: 'ready', error: '', value: { lastCron } } });
    expect(html).toContain('Dernier passage');
    expect(html).toContain('Début');
    expect(html).toContain(fmtMs(252_000));
    expect(html).toContain(fmtInt(708));
    expect(html).toContain('Programmes EPG');
    expect(html).toContain(fmtInt(15_230));
    expect(html).toContain('EPG reconstruit');
    expect(html).toContain('data-adm-tvrerun');
    expect(html).not.toContain('Aucun passage enregistré');
    expect(html).not.toContain('pas encore branchée');
  });

  it('un échec du passage est visible (code d’erreur, réussi : non)', () => {
    const failed = { ...lastCron, ok: false, channels: null, programmes: null, epgOk: false, error: 'construction_echouee' };
    const html = tasksHTML({ tv: { status: 'ready', error: '', value: { lastCron: failed } } });
    expect(html).toContain('construction_echouee');
    expect(html).toContain('Réussi');
  });

  it('aucun passage enregistré : message clair, pas d’erreur', () => {
    const html = tasksHTML({ tv: { status: 'ready', error: '', value: { lastCron: null } } });
    expect(html).toContain('Aucun passage enregistré.');
  });

  it('serveur sans API TV (501) : le message « non branchée » ne s’affiche que pour ce cas', () => {
    expect(adminErr(new UserApiError(501, 'tv_admin_unavailable'))).toContain('branchée');
  });
});

describe('performance : rendu d’un rapport au format du serveur', () => {
  const from = '2026-10-18T10:00:00.000Z';
  const report: Metrics = {
    range: '1h', from, to: '2026-10-18T11:00:00.000Z', stepSec: 300,
    totals: { requests: 120, status: { '2xx': 100, '3xx': 0, '4xx': 10, '5xx': 10 }, p50: 20, p95: 300, avgMs: 45 },
    groups: {
      stream: { requests: 120, status: { '2xx': 100, '3xx': 0, '4xx': 10, '5xx': 10 }, p50: 20, p95: 300, avgMs: 45 },
      user: { requests: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, p50: null, p95: null, avgMs: null } as never,
    },
    series: Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.parse(from) + i * 300_000).toISOString(), requests: 10, errors5xx: i === 3 ? 5 : 0, p95: 300 })),
    upstreams: [{ host: 'addon.example', calls: 40, failures: 2, timeouts: 1, avgMs: 120 }],
    alldebrid: { unlock: { ok: 5, errors: {} }, magnet: { ok: 0, errors: { AUTH_BAD_APIKEY: 2 } }, other: { ok: 0, errors: {} } },
    caches: [{ prefix: 'packs', hits: 3, misses: 1, hitRate: 0.75 }],
    errors: [{ at: '2026-10-18T10:20:00.000Z', route: '/:config/stream/:type/:id', status: 500, message: 'boom' }],
  };

  it('rend le résumé, les groupes, les addons, AllDebrid et les erreurs', () => {
    const html = performanceHTML({ range: '1h', updatedAt: NOW, perf: { status: 'ready', error: '', value: report } });
    expect(html).toContain('Erreurs 5xx');
    expect(html).toContain(fmtInt(120));
    expect(html).toContain('addon.example');
    expect(html).toContain('AUTH_BAD_APIKEY');
    expect(html).toContain('/:config/stream/:type/:id');
    expect(html).not.toContain('Erreur (');
  });

  it('une période sans trafic (valeurs à null) se rend sans erreur', () => {
    const empty: Metrics = {
      ...report,
      totals: { requests: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, p50: null, p95: null, avgMs: null } as never,
      groups: { stream: { requests: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, p50: null, p95: null, avgMs: null } as never },
      series: report.series.map((s) => ({ ...s, requests: 0, errors5xx: 0, p95: null })) as never,
      upstreams: [], alldebrid: { unlock: { ok: 0, errors: {} } }, caches: [], errors: [],
    };
    const html = performanceHTML({ range: '1h', updatedAt: NOW, perf: { status: 'ready', error: '', value: empty } });
    expect(html).toContain('Aucun appel amont sur cette période.');
    expect(html).toContain('Aucune erreur 5xx récente.');
  });
});
