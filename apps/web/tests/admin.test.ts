// Console d'administration : client (en-têtes, élévation puis réessai), métriques, pagination, purge, page de réinitialisation, message `removed`.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { setActiveProfile, setSession } from '../src/data/session';
import * as admin from '../src/data/adminApi';
import {
  adminAllowed, aggregateGroups, alldebridRows, CursorPager, downsample, fmtMs, fmtPct, groupRows, purgeList, purgeView, summarize, upstreamRows,
} from '../src/data/adminModel';
import { passwordIssue, resetTokenFromLocation } from '../src/data/reset';
import { UserApiError } from '../src/data/userApi';
import { PartyClient, type SocketLike } from '../src/party/client';

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
let calls: Call[] = [];
let handler: (c: Call) => Response;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const future = () => new Date(Date.now() + 600_000).toISOString();

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = {
      url: String(url), method: String(init?.method ?? 'GET'), body: String(init?.body ?? ''),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
    };
    calls.push(c);
    return handler(c);
  }));
});

beforeEach(() => {
  calls = [];
  admin.clearElevation();
  admin.setElevationPrompt(null);
  setSession('sess-token', new Date(Date.now() + 3e9).toISOString(), 'greg');
  setActiveProfile('p-adulte');
});

describe('garde d’accès (fonction pure)', () => {
  it('propriétaire en session serveur sur un profil adulte seulement', () => {
    expect(adminAllowed({ serverMode: true, owner: true, kid: false })).toBe(true);
    expect(adminAllowed({ serverMode: true, owner: false, kid: false })).toBe(false);
    expect(adminAllowed({ serverMode: true, owner: true, kid: true })).toBe(false);
    expect(adminAllowed({ serverMode: false, owner: true, kid: false })).toBe(false);
  });
});

describe('client admin : en-têtes', () => {
  it('envoie la session, X-Profile-Id et la requête sous /admin', async () => {
    handler = () => json({ accounts: [], nextCursor: null, total: 0 });
    await admin.listAccounts({ q: 'ali', limit: 25, cursor: 'c1' });
    const c = calls[0];
    expect(c.url).toBe('http://localhost:7000/admin/accounts?q=ali&limit=25&cursor=c1');
    expect(c.headers.authorization).toBe('Bearer sess-token');
    expect(c.headers['x-profile-id']).toBe('p-adulte');
    expect(c.headers['x-admin-elevation']).toBeUndefined();
  });
});

describe('élévation puis réessai', () => {
  it('403 elevation_required : mot de passe, élévation, réessai avec X-Admin-Elevation, puis jeton réutilisé', async () => {
    handler = (c) => {
      if (c.url.endsWith('/admin/elevate')) return json({ token: 'ELEV-1', expiresAt: future() });
      if (c.headers['x-admin-elevation'] === 'ELEV-1') return new Response(null, { status: 204 });
      return json({ error: 'elevation_required' }, 403);
    };
    const prompt = vi.fn(async () => 'secret-pw');
    admin.setElevationPrompt(prompt);
    await admin.revokeSessions('a1');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.method + ' ' + c.url.replace('http://localhost:7000', ''))).toEqual([
      'POST /admin/accounts/a1/revoke-sessions', 'POST /admin/elevate', 'POST /admin/accounts/a1/revoke-sessions',
    ]);
    expect(JSON.parse(calls[1].body)).toEqual({ password: 'secret-pw' });
    expect(calls[1].headers['x-profile-id']).toBe('p-adulte');
    expect(calls[2].headers['x-admin-elevation']).toBe('ELEV-1');
    await admin.revokeSessions('a2');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)!.headers['x-admin-elevation']).toBe('ELEV-1');
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('ELEV-1');
    expect(stored).not.toContain('secret-pw');
  });

  it('mot de passe faux : la fenêtre se rouvre avec l’erreur ; annuler abandonne l’action', async () => {
    handler = (c) => {
      if (c.url.endsWith('/admin/elevate')) return JSON.parse(c.body).password === 'bon' ? json({ token: 'T', expiresAt: future() }) : json({ error: 'invalid_password' }, 403);
      return c.headers['x-admin-elevation'] === 'T' ? new Response(null, { status: 204 }) : json({ error: 'elevation_expired' }, 403);
    };
    const answers = ['mauvais', 'bon'];
    const errors: Array<string | undefined> = [];
    admin.setElevationPrompt(async ({ error }) => { errors.push(error); return answers.shift() ?? null; });
    await admin.deleteAccount('a1');
    expect(errors).toEqual([undefined, 'Mot de passe incorrect.']);

    admin.clearElevation();
    admin.setElevationPrompt(async () => null);
    await expect(admin.deleteAccount('a1')).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('une action sans élévation requise (réactiver, quota) n’en demande pas', async () => {
    handler = () => json({});
    const prompt = vi.fn(async () => 'x');
    admin.setElevationPrompt(prompt);
    await admin.reactivateAccount('a1');
    await admin.setInviteQuota('a1', 5);
    expect(prompt).not.toHaveBeenCalled();
    expect(calls[1].method).toBe('PUT');
    expect(JSON.parse(calls[1].body)).toEqual({ quota: 5 });
  });

  it('activer la maintenance passe par l’élévation, pas les autres réglages', async () => {
    handler = (c) => (c.headers['x-admin-elevation'] ? json({ ok: true }) : c.url.endsWith('/elevate') ? json({ token: 'M', expiresAt: future() }) : json({ ok: true }));
    const prompt = vi.fn(async () => 'pw');
    admin.setElevationPrompt(prompt);
    await admin.putSettings({ invitesOpen: false });
    expect(prompt).not.toHaveBeenCalled();
    handler = (c) => (c.headers['x-admin-elevation'] ? json({ ok: true }) : c.url.endsWith('/elevate') ? json({ token: 'M', expiresAt: future() }) : json({ error: 'elevation_required' }, 403));
    await admin.putSettings({ maintenance: { enabled: true, message: 'Retour à 14 h' } });
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe('élévation : annonces, test de fournisseur, série « Tester tout »', () => {
  it('création d’annonce : 403 elevation_required, mot de passe, puis réessai avec le jeton', async () => {
    handler = (c) => {
      if (c.url.endsWith('/admin/elevate')) return json({ token: 'E-ANN', expiresAt: future() });
      return c.headers['x-admin-elevation'] === 'E-ANN' ? json({ id: 'n1', title: 'T' }) : json({ error: 'elevation_required' }, 403);
    };
    const prompt = vi.fn(async () => 'pw');
    admin.setElevationPrompt(prompt);
    await admin.createAnnouncement({ title: 'T', message: 'M', level: 'info' });
    expect(prompt).toHaveBeenCalledTimes(1);
    const last = calls.at(-1)!;
    expect(last.method).toBe('POST');
    expect(last.url).toContain('/admin/announcements');
    expect(last.headers['x-admin-elevation']).toBe('E-ANN');
  });

  it('« Tester tout » : ensureElevation demande le mot de passe une fois, les tests partent avec le jeton', async () => {
    handler = (c) => {
      if (c.url.endsWith('/admin/elevate')) return json({ token: 'E-SER', expiresAt: future() });
      return c.headers['x-admin-elevation'] === 'E-SER' ? json({ id: 'tmdb', ok: true, latencyMs: 12 }) : json({ error: 'elevation_required' }, 403);
    };
    const prompt = vi.fn(async () => 'pw');
    admin.setElevationPrompt(prompt);
    await admin.ensureElevation();
    await Promise.all([admin.testProvider('tmdb'), admin.testProvider('alldebrid')]);
    expect(prompt).toHaveBeenCalledTimes(1);
    const tests = calls.filter((c) => c.url.includes('/providers/'));
    expect(tests).toHaveLength(2);
    expect(tests.every((c) => c.headers['x-admin-elevation'] === 'E-SER')).toBe(true);
    await admin.ensureElevation();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('« Tester tout » annulé : aucun test ne part', async () => {
    admin.clearElevation();
    admin.setElevationPrompt(async () => null);
    await expect(admin.ensureElevation()).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls.filter((c) => c.url.includes('/providers/'))).toHaveLength(0);
  });
});

describe('formatage des métriques', () => {
  const group = (requests: number, s5: number, p50: number, p95: number) => ({ requests, status: { '2xx': requests - s5, '3xx': 0, '4xx': 0, '5xx': s5 }, p50, p95, avgMs: p50 });
  const metrics = {
    range: '1h' as const, from: 1_700_000_000, to: 1_700_003_600, stepSec: 300,
    totals: group(1200, 12, 80, 450), groups: { stream: group(200, 8, 300, 900), ui: group(900, 0, 20, 60), user: group(100, 4, 40, 120) },
    series: [], upstreams: [], alldebrid: {}, caches: [], errors: [],
  };

  it('requêtes par minute, taux d’erreur 5xx et p95', () => {
    const s = summarize(metrics);
    expect(s.minutes).toBe(60);
    expect(s.rpm).toBe(20);
    expect(s.errorRate).toBeCloseTo(0.01);
    expect(s.p95).toBe(450);
  });

  it('agrège les groupes (sommes exactes, percentiles pondérés)', () => {
    const a = aggregateGroups(Object.values(metrics.groups));
    expect(a.requests).toBe(1200);
    expect(a.status['5xx']).toBe(12);
    expect(a.p95).toBeCloseTo((200 * 900 + 900 * 60 + 100 * 120) / 1200);
    expect(summarize({ ...metrics, totals: undefined as never }).requests).toBe(1200);
    expect(aggregateGroups([]).requests).toBe(0);
  });

  it('lignes par groupe : tri par volume, part et taux d’erreur', () => {
    const rows = groupRows(metrics);
    expect(rows.map((r) => r.id)).toEqual(['ui', 'stream', 'user']);
    expect(rows[0]).toMatchObject({ label: 'Interface', share: 0.75 });
    expect(rows[1].errorRate).toBeCloseTo(0.04);
  });

  it('santé des addons et AllDebrid', () => {
    const up = upstreamRows({ upstreams: [{ host: 'a.io', calls: 100, failures: 2, timeouts: 1, avgMs: 120 }, { host: 'b.io', calls: 10, failures: 5, timeouts: 0, avgMs: 900 }] });
    expect(up.map((u) => u.host)).toEqual(['b.io', 'a.io']);
    expect(up[0].failureRate).toBe(0.5);
    const ad = alldebridRows({ alldebrid: { unlock: { ok: 90, errors: { LINK_DOWN: 2, AUTH_BAD_APIKEY: 8 } } } });
    expect(ad[0]).toMatchObject({ label: 'Déblocage de lien', ok: 90, errTotal: 10, successRate: 0.9 });
    expect(ad[0].errors[0]).toEqual({ code: 'AUTH_BAD_APIKEY', n: 8 });
  });

  it('formats FR', () => {
    expect(fmtMs(412)).toBe('412 ms');
    expect(fmtMs(1530)).toBe('1,53 s');
    expect(fmtMs(NaN)).toBe('—');
    expect(fmtPct(0.0123, 2)).toBe('1,23 %');
  });

  it('réduit une série en gardant les pics', () => {
    expect(downsample([1, 9, 2, 3, 4, 5], 3)).toEqual([9, 3, 5]);
    expect(downsample([1, 2], 5)).toEqual([1, 2]);
  });
});

describe('pagination des comptes', () => {
  it('pile de curseurs : suivant, précédent, retour à la première page', () => {
    const p = new CursorPager();
    expect(p.cursor).toBeNull();
    expect(p.next(null)).toBe(false);
    expect(p.next('c1')).toBe(true);
    expect(p.next('c2')).toBe(true);
    expect([p.cursor, p.page, p.hasPrev]).toEqual(['c2', 3, true]);
    expect(p.prev()).toBe(true);
    expect(p.cursor).toBe('c1');
    p.reset();
    expect([p.cursor, p.page, p.hasPrev, p.prev()]).toEqual([null, 1, false, false]);
  });

  it('chaque page demande le curseur reçu à la précédente', async () => {
    handler = (c) => (c.url.includes('cursor=c1') ? json({ accounts: [{ id: 'b' }], nextCursor: null, total: 2 }) : json({ accounts: [{ id: 'a' }], nextCursor: 'c1', total: 2 }));
    const p = new CursorPager();
    const first = await admin.listAccounts({ limit: 1, cursor: p.cursor });
    p.next(first.nextCursor);
    const second = await admin.listAccounts({ limit: 1, cursor: p.cursor });
    expect(second.accounts[0].id).toBe('b');
    expect(calls[0].url).not.toContain('cursor');
    expect(calls[1].url).toContain('cursor=c1');
  });
});

describe('purge de cache', () => {
  it('progression : plafonnée à 99 en cours, 100 à la fin, échec signalé', () => {
    expect(purgeView({ status: 'running', deleted: 250 }, 1000)).toMatchObject({ state: 'running', pct: 25 });
    expect(purgeView({ status: 'running', deleted: 5000 }, 1000).pct).toBe(99);
    expect(purgeView({ status: 'running', deleted: 10 }).pct).toBeNull();
    expect(purgeView({ status: 'done', deleted: 1234 }, 1000)).toMatchObject({ state: 'done', pct: 100 });
    expect(purgeView({ status: 'failed', deleted: 3, error: 'kv' })).toMatchObject({ state: 'failed' });
  });

  it('lance la purge (élévation) puis suit le job', async () => {
    admin.setElevationPrompt(async () => 'pw');
    handler = (c) => (c.url.endsWith('/elevate') ? json({ token: 'E', expiresAt: future() })
      : c.headers['x-admin-elevation'] ? json({ id: 'j1', prefix: 'hosts', status: 'running', deleted: 0 }, 202) : json({ error: 'elevation_required' }, 403));
    const job = await admin.purgeCache('hosts');
    expect(job.id).toBe('j1');
    expect(calls.at(-1)!.url).toContain('/admin/caches/hosts/purge');
    handler = () => json({ id: 'j1', prefix: 'hosts', status: 'done', deleted: 42 });
    expect((await admin.getPurge('j1')).status).toBe('done');
    expect(purgeList({ purges: [{ id: 'j1' }] })).toHaveLength(1);
    expect(purgeList([{ id: 'j2' }])).toHaveLength(1);
    expect(purgeList(null)).toEqual([]);
  });
});

describe('page de réinitialisation du mot de passe', () => {
  const T = 'abcdEFGH0123456789_-xyz';

  it('lit le jeton dans #/reset/<jeton> ou /reset-password?token=', () => {
    expect(resetTokenFromLocation('', '#/reset/' + T)).toBe(T);
    expect(resetTokenFromLocation('?token=' + T, '', '/reset-password')).toBe(T);
    expect(resetTokenFromLocation('', '#/reset/court')).toBe('');
    expect(resetTokenFromLocation('', '#/settings')).toBe('');
    expect(resetTokenFromLocation('?token=' + T, '', '/')).toBe('');
  });

  it('valide le nouveau mot de passe', () => {
    expect(passwordIssue('court', 'court')).toMatch(/8 caractères/);
    expect(passwordIssue('longlonglong', 'autrechose1')).toMatch(/pas identiques/);
    expect(passwordIssue('longlonglong', 'longlonglong')).toBe('');
  });

  it('envoie le jeton et le mot de passe sans session, puis confirme ; jeton invalide : message clair', async () => {
    const { runResetFlow } = await import('../src/ui/reset-ui.js');
    let status = 204;
    handler = () => (status === 204 ? new Response(null, { status: 204 }) : json({ error: 'reset_invalid' }, 400));
    const done = runResetFlow(T);
    const form = document.querySelector('#reset-form') as HTMLFormElement;
    expect(form).not.toBeNull();
    const fill = (a: string, b: string) => {
      (form.elements.namedItem('password') as HTMLInputElement).value = a;
      (form.elements.namedItem('confirm') as HTMLInputElement).value = b;
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    };
    const wait = () => new Promise((r) => setTimeout(r, 20));
    fill('motdepasse1', 'different');
    await wait();
    expect(document.querySelector('#reset-msg')!.textContent).toMatch(/pas identiques/);
    expect(calls).toHaveLength(0);
    status = 400;
    fill('motdepasse1', 'motdepasse1');
    await wait();
    expect(document.querySelector('#reset-msg')!.textContent).toMatch(/invalide, expiré/);
    status = 204;
    fill('motdepasse1', 'motdepasse1');
    await wait();
    const ok = calls.at(-1)!;
    expect(ok.url).toBe('http://localhost:7000/user/password-reset');
    expect(ok.headers.authorization).toBeUndefined();
    expect(JSON.parse(ok.body)).toEqual({ token: T, password: 'motdepasse1' });
    (document.querySelector('[data-reset-done]') as HTMLElement).click();
    await done;
    expect(document.querySelector('#reset')).toBeNull();
  });
});

describe('message de salon `removed`', () => {
  class Sock implements SocketLike {
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onclose: SocketLike['onclose'] = null;
    onerror: SocketLike['onerror'] = null;
    send() { /* ignoré */ }
    close() { /* ignoré */ }
  }

  it('retire le message du chat et prévient les écouteurs', async () => {
    const sock = new Sock();
    const client = new PartyClient({ connect: async () => sock, setTimer: () => 0, clearTimer: () => undefined });
    const removed: string[] = [];
    client.on('removed', (r) => removed.push(r.messageId));
    client.start();
    await new Promise((r) => setTimeout(r, 0));
    sock.onopen?.();
    const recv = (m: unknown) => sock.onmessage?.({ data: JSON.stringify(m) });
    recv({
      t: 'welcome', you: { username: 'bob', host: false, muted: false }, room: { id: 'r1', host: 'alice' }, state: { playing: false, pos: 0, at: 1, rev: 1 },
      serverTime: 1, participants: [], chat: [{ id: 'm1', from: 'a', text: 'ok', at: 1 }, { id: 'm2', from: 'c', text: 'vilain', at: 2 }],
    });
    expect(client.chat.map((l) => l.id)).toEqual(['m1', 'm2']);
    recv({ t: 'removed', messageId: 'm2' });
    expect(client.chat.map((l) => l.id)).toEqual(['m1']);
    expect(removed).toEqual(['m2']);
    recv({ t: 'removed', messageId: 'inconnu' });
    expect(client.chat).toHaveLength(1);
    client.close();
  });
});

describe('erreurs', () => {
  it('UserApiError conserve statut et code', async () => {
    handler = () => json({ error: 'kid_profile' }, 403);
    await expect(admin.adminMe()).rejects.toBeInstanceOf(UserApiError);
    await expect(admin.adminMe()).rejects.toMatchObject({ status: 403, code: 'kid_profile' });
  });
});
