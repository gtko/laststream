// Garde de la route #/admin : un membre ou un profil enfant est renvoyé à l'accueil, le propriétaire sur profil adulte y accède.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let parseRoute: () => { kind: string } | null;
let auth: any;

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  window.scrollTo = () => undefined;
  ({ parseRoute } = (await import('../src/ui/router.js')) as never);
  ({ auth } = await import('../src/data/auth'));
});

const as = (o: { owner: boolean; kid: boolean; status?: string; admin?: boolean }) => {
  auth.status = o.status ?? 'ready';
  auth.isOwner = o.owner;
  auth.profile = { id: 'p1', name: 'Greg', isKid: o.kid, kidMaxAge: o.kid ? 10 : null, hasPin: false, allowedCatalogs: [], isAdminProfile: o.admin ?? true };
  location.hash = '#/admin';
};

describe('garde #/admin', () => {
  it('propriétaire, profil adulte : route admin', () => {
    as({ owner: true, kid: false });
    expect(parseRoute()).toEqual({ kind: 'admin' });
  });
  it('membre : redirigé (route absente, adresse nettoyée)', () => {
    as({ owner: false, kid: false });
    expect(parseRoute()).toBeNull();
    expect(location.hash).toBe('');
  });
  it('propriétaire sur un profil enfant : redirigé', () => {
    as({ owner: true, kid: true });
    expect(parseRoute()).toBeNull();
    expect(location.hash).toBe('');
  });
  it('propriétaire sur un autre profil adulte (conjoint) : redirigé, lien Administration masqué', () => {
    as({ owner: true, kid: false, admin: false });
    expect(parseRoute()).toBeNull();
    expect(location.hash).toBe('');
  });
  it('mode local (sans compte serveur) : redirigé', () => {
    as({ owner: true, kid: false, status: 'local' });
    expect(parseRoute()).toBeNull();
  });
});

describe('rendu de la console', () => {
  it('navigation groupée en 5 espaces, vue d’ensemble, tableau des comptes et panneau de détail', async () => {
    const acct = { id: 'a1', username: 'alice', isOwner: false, createdAt: '2026-01-01T00:00:00Z', status: 'active', suspendedAt: null, referrer: 'greg', lastActivityAt: new Date().toISOString(), profileCount: 2, libraryCount: 5, inviteQuota: 4, invitesUsed: 1, online: false, sessionCount: 1 };
    const grp = { requests: 100, status: { '2xx': 95, '3xx': 0, '4xx': 3, '5xx': 2 }, p50: 40, p95: 200, avgMs: 60 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(String(url));
      const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (u.pathname === '/admin/accounts') return j({ accounts: [acct], nextCursor: null, total: 1, counts: { all: 1, online: 0, inactive30: 0, suspended: 0, noInvites: 0 } });
      if (u.pathname === '/admin/accounts/a1') return j({
        account: acct, profiles: [{ name: 'Alice', isKid: false, hasPin: false, libraryCount: 5 }], libraryCount: 5,
        invitees: [{ id: 'i1', username: 'bob', usedAt: '2026-02-01T10:00:00Z' }],
        sessions: [{ id: 's1', device: 'Firefox · Windows', createdAt: '2026-03-01T08:00:00Z', lastSeenAt: new Date().toISOString(), expiresAt: '2026-04-01T08:00:00Z' }],
        invites: [],
      });
      if (u.pathname === '/admin/metrics') return j({ range: '24h', from: 0, to: 86400, stepSec: 300, totals: grp, groups: { ui: grp }, series: [{ t: 1, requests: 5, errors5xx: 0, p95: 100 }, { t: 2, requests: 9, errors5xx: 1, p95: 150 }], upstreams: [], alldebrid: {}, caches: [], errors: [] });
      if (u.pathname === '/admin/party/rooms') return j({ rooms: [] });
      if (u.pathname === '/admin/party/reports') return j({ reports: [{}, {}] });
      if (u.pathname === '/admin/settings') return j({ inviteDefaultQuota: 4, invitesOpen: true, maintenance: { enabled: false, message: '' } });
      return new Response('{}', { status: 404 });
    }));
    as({ owner: true, kid: false });
    const { reloadSettings, SETTINGS_STORAGE_KEY } = await import('../src/data/config');
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
    reloadSettings();
    const { showAdmin } = await import('../src/ui/admin.js');
    showAdmin();
    const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
    await wait();
    const detail = document.getElementById('detail')!;
    expect(Array.from(detail.querySelectorAll('[data-adm-sec]')).map((b) => b.querySelector('.adm-navi-l')!.textContent)).toEqual([
      'Tableau de bord', 'À traiter', 'Comptes', 'Invitations', 'En ligne',
      'Sources et addons', 'Performance', 'Caches et stockage', 'Tâches planifiées',
      'Watch parties', 'Modération',
      'Réglages', 'Annonces', 'Journal d’audit',
    ]);
    expect(detail.querySelectorAll('.adm-kpi')).toHaveLength(8);
    expect(detail.querySelector('[data-adm-badge="reports"]')!.textContent).toBe('2');
    expect(detail.querySelector('[data-adm-badge="todo"]')!.hasAttribute('hidden')).toBe(true);
    expect(detail.textContent).toContain('Signalements en attente');
    (detail.querySelector('[data-adm-sec="accounts"]') as HTMLElement).click();
    await wait();
    expect(detail.querySelector('[data-adm-acc="a1"]')!.textContent).toBe('alice');
    (detail.querySelector('[data-adm-acc="a1"]') as HTMLElement).click();
    await wait();
    const layer = document.querySelector('.adm-layer--drawer')!;
    expect(layer.querySelector('[role="dialog"]')!.getAttribute('aria-modal')).toBe('true');
    expect(layer.textContent).toContain('Lien de réinitialisation');
    expect(layer.querySelector('[data-adm-do="delete"]')).not.toBeNull();
    (layer.querySelector('[data-adm-close]') as HTMLElement).click();
    expect(document.querySelector('.adm-layer')).toBeNull();
  });
});

describe('profil principal : Réglages', () => {
  const as2 = (isMainProfile: boolean | undefined, kid = false) => {
    auth.status = 'ready';
    auth.isOwner = true;
    auth.profile = { id: 'p1', name: 'Jessica', isKid: kid, kidMaxAge: kid ? 10 : null, hasPin: false, allowedCatalogs: [], isMainProfile };
  };
  const cats = async () => {
    const { showSettings } = (await import('../src/ui/settings.js')) as any;
    await showSettings();
    return Array.from(document.querySelectorAll('#detail [data-set-cat]')).map((b) => (b.textContent ?? '').trim());
  };
  it('profil principal : Sources et Serveur lastAddon visibles, formulaire de clés présent', async () => {
    as2(true);
    const c = await cats();
    expect(c).toEqual(expect.arrayContaining(['Sources', 'Serveur lastAddon', 'Apparence']));
    expect(document.querySelector('#set-la')).not.toBeNull();
  });
  it('profil secondaire (Jessica) : ni Sources, ni Serveur lastAddon, ni clés ; ses préférences restent', async () => {
    as2(false);
    const c = await cats();
    expect(c).not.toContain('Sources');
    expect(c).not.toContain('Serveur lastAddon');
    expect(c).toEqual(expect.arrayContaining(['Profil et compte', 'Langue et région', 'Audio et sous-titres', 'Apparence', 'Lecture', 'Accueil et recommandations']));
    expect(document.querySelector('#set-la')).toBeNull();
  });
  it('profil enfant : pas de Sources ni de Serveur', async () => {
    as2(false, true);
    const c = await cats();
    expect(c).not.toContain('Sources');
    expect(c).not.toContain('Serveur lastAddon');
  });
});
