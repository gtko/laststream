// Espace Utilisateurs de la console d'administration : filtres à compteurs, sélection et actions groupées (confirmation, résultat
// partiel), export CSV, fiche compte (onglet Sessions, révocation unitaire, quota), invitations révocables, liste « En ligne ».
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

let adm: any;
let api: any;
let auth: any;
let closeAllLayers: () => void;

type Req = { method: string; url: URL; body: any };
type Handler = (r: Req) => Response | Promise<Response>;
interface Call { method: string; path: string; search: string; body: any }

let routes: Record<string, Handler> = {};
let calls: Call[] = [];

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const empty204 = () => new Response(null, { status: 204 });
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const toastText = () => document.getElementById('toast')!.textContent ?? '';

const ACC = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
  id, username, isOwner: false, createdAt: '2026-09-03T10:00:00.000Z', status: 'active', suspendedAt: null, referrer: null,
  lastActivityAt: '2026-10-19T10:00:00.000Z', profileCount: 2, libraryCount: 10, inviteQuota: 4, invitesUsed: 1, online: false,
  sessionCount: 2, ...extra,
});
const ACCOUNTS = [
  ACC('a1', 'marine', { online: true, lastActivityAt: '2026-10-20T09:59:00.000Z', inviteQuota: 4, invitesUsed: 4 }),
  ACC('a2', 'theo', { referrer: 'marine', inviteQuota: 2, invitesUsed: 0 }),
  ACC('a3', 'lucas', { referrer: 'marine', sessionCount: 1 }),
];
const COUNTS = { all: 148, online: 12, inactive30: 23, suspended: 2, noInvites: 9 };
const listFor = (filter: string) => ({ accounts: ACCOUNTS, nextCursor: null, total: ACCOUNTS.length, counts: COUNTS, filter });

const DETAIL_A1 = {
  account: ACC('a1', 'marine', { online: true, inviteQuota: 4, invitesUsed: 4 }),
  profiles: [{ id: 'p1', name: 'Marine', isKid: false, hasPin: false, libraryCount: 120 }],
  libraryCount: 214,
  invitees: [{ id: 'a2', username: 'theo', usedAt: '2026-09-10T10:00:00.000Z' }],
  sessions: [
    { id: 's1', device: 'Android · Laststream 1.4', createdAt: '2026-10-19T08:00:00.000Z', lastSeenAt: '2026-10-20T09:58:00.000Z', expiresAt: '2026-11-20T08:00:00.000Z' },
    { id: 's2', device: null, createdAt: '2026-10-01T08:00:00.000Z', lastSeenAt: null, expiresAt: '2026-11-01T08:00:00.000Z' },
  ],
  invites: [{ id: 'inv9', ownerId: 'a1', ownerUsername: 'marine', createdAt: '2026-09-05T08:00:00.000Z', expiresAt: null, usedAt: '2026-09-10T10:00:00.000Z', usedBy: 'theo', status: 'used' }],
};

const INVITE_ACTIVE = { id: 'inv1', ownerId: 'a1', ownerUsername: 'marine', createdAt: '2026-10-10T08:00:00.000Z', expiresAt: null, usedAt: null, usedBy: null, status: 'active' };

/** Réponses par défaut ; `extra` remplace une route « MÉTHODE /chemin ». */
function stubApi(extra: Record<string, Handler> = {}) {
  routes = {
    'GET /admin/accounts': ({ url }) => json(listFor(url.searchParams.get('filter') ?? 'all')),
    'GET /admin/accounts/a1': () => json(DETAIL_A1),
    'GET /admin/accounts/a1/timeline': () => json({ events: [] }),
    'GET /admin/accounts/export': () => json({ accounts: ACCOUNTS, truncated: false }),
    'POST /admin/accounts/bulk': ({ body }) => json({ done: body.ids.length, failed: [] }),
    'DELETE /admin/accounts/a1/sessions/s2': () => empty204(),
    'PUT /admin/accounts/a1/invite-quota': () => json({ ok: true }),
    'GET /admin/invites': () => json({ invites: [] }),
    'DELETE /admin/invites/inv1': () => empty204(),
    'GET /admin/referrals': () => json({ roots: [], total: 0, truncated: false }),
    'GET /admin/online': () => json({ accounts: [] }),
    'GET /admin/status': () => json({ status: 'ok', services: [] }),
    'GET /admin/inbox': () => json({ items: [], total: 0 }),
    'GET /admin/live': () => json({ online: 1, watching: 0, parties: 0, feed: [] }),
    'GET /admin/party/reports': () => json({ reports: [] }),
    ...extra,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = String(init?.method ?? 'GET');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body });
    const h = routes[method + ' ' + u.pathname];
    if (h) return h({ method, url: u, body });
    return json({ error: 'not_found' }, 404);
  }));
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  adm = await import('../src/ui/admin.js');
  api = await import('../src/data/adminApi');
  ({ auth } = await import('../src/data/auth'));
  ({ closeAllLayers } = await import('../src/ui/admin-dialog.js'));
});

/** Propriétaire sur un profil adulte : la console est accessible. */
function asOwner() {
  auth.status = 'ready';
  auth.isOwner = true;
  auth.profile = { id: 'p1', name: 'Greg', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true };
  location.hash = '#/admin';
}

function open(sec: string) {
  adm.__admin.S.sec = sec;
  adm.showAdmin();
}

/** Champ d'un formulaire, typé. */
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;

const pathCalls = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  calls = [];
  api.clearElevation();
  api.setElevationPrompt(null);
  const S = adm.__admin.S;
  S.accSel.clear();
  S.accQuery = { q: '', status: '', order: 'newest', filter: 'all' };
  S.accPager.reset();
  S.invStatus = 'active';
  asOwner();
  stubApi();
});

afterEach(() => {
  closeAllLayers();
  vi.useRealTimers();
});

describe('comptes : filtres rapides et compteurs', () => {
  it('compteurs affichés depuis la réponse, filtre envoyé au serveur, filtre courant marqué', async () => {
    open('accounts');
    await settle();
    const chip = (v: string) => document.querySelector('[data-adm-filter="' + v + '"]') as HTMLButtonElement;
    expect(chip('all').textContent).toContain('148');
    expect(chip('online').textContent).toContain('12');
    expect(chip('inactive30').textContent).toContain('23');
    expect(chip('suspended').textContent).toContain('2');
    expect(chip('noInvites').textContent).toContain('9');
    expect(chip('all').getAttribute('aria-pressed')).toBe('true');

    chip('suspended').click();
    await settle();
    expect(pathCalls('GET', '/admin/accounts').at(-1)!.search).toContain('filter=suspended');
    expect(chip('suspended').getAttribute('aria-pressed')).toBe('true');
    expect(chip('all').getAttribute('aria-pressed')).toBe('false');
    expect(adm.__admin.S.accQuery.filter).toBe('suspended');
  });

  it('la recherche garde le filtre choisi', async () => {
    open('accounts');
    await settle();
    (document.querySelector('[data-adm-filter="noInvites"]') as HTMLElement).click();
    await settle();
    const form = document.querySelector('[data-adm-accsearch]') as HTMLFormElement;
    field(form, 'q').value = 'ma';
    form.requestSubmit();
    await settle();
    expect(adm.__admin.S.accQuery).toMatchObject({ q: 'ma', filter: 'noInvites' });
    expect(pathCalls('GET', '/admin/accounts').at(-1)!.search).toContain('q=ma');
  });

  it('colonne dernière activité : point « en ligne » pour les comptes présents', async () => {
    open('accounts');
    await settle();
    const rows = document.querySelectorAll('.adm-accounts tbody tr');
    expect(rows[0].querySelector('.adm-online-dot')).not.toBeNull();
    expect(rows[0].textContent).toContain('en ligne');
    expect(rows[1].querySelector('.adm-online-dot')).toBeNull();
  });
});

describe('comptes : sélection et actions groupées', () => {
  it('tout sélectionner, suspension seulement après confirmation, résultat partiel en toast, échec gardé coché', async () => {
    stubApi({
      'POST /admin/accounts/bulk': () => json({ done: 2, failed: [{ id: 'a2', error: 'cannot_target_owner' }] }),
    });
    open('accounts');
    await settle();
    const all = document.querySelector('[data-adm-selall]') as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new Event('change'));
    await settle();
    expect(document.querySelectorAll('[data-adm-sel]:checked')).toHaveLength(3);
    expect(document.querySelector('.adm-bulk-n')!.textContent).toBe('3 sélectionnés');

    (document.querySelector('[data-adm-bulk="suspend"]') as HTMLElement).click();
    await settle();
    const dialog = document.querySelector('[data-adm-confirm]') as HTMLFormElement;
    expect(dialog).not.toBeNull();
    expect(document.querySelector('.adm-layer--modal h2')!.textContent).toBe('Suspendre 3 comptes');
    expect(pathCalls('POST', '/admin/accounts/bulk')).toHaveLength(0);

    dialog.requestSubmit();
    await settle();
    const bulk = pathCalls('POST', '/admin/accounts/bulk');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].body).toEqual({ ids: ['a1', 'a2', 'a3'], action: 'suspend' });
    expect(toastText()).toContain('2 sur 3');
    expect(toastText()).toContain('1 échec');
    expect(toastText()).toContain('theo');
    const kept = Array.from(document.querySelectorAll('[data-adm-sel]:checked')).map((x) => (x as HTMLElement).dataset.admSel);
    expect(kept).toEqual(['a2']);
  });

  it('annuler la confirmation n’envoie rien', async () => {
    open('accounts');
    await settle();
    (document.querySelector('[data-adm-sel="a3"]') as HTMLInputElement).click();
    await settle();
    (document.querySelector('[data-adm-bulk="revoke-sessions"]') as HTMLElement).click();
    await settle();
    (document.querySelector('[data-adm-confirm] [data-adm-close]') as HTMLElement).click();
    await settle();
    expect(pathCalls('POST', '/admin/accounts/bulk')).toHaveLength(0);
    expect(document.querySelector('[data-adm-confirm]')).toBeNull();
  });

  it('quota +1 : envoi en delta, sans confirmation ; valeur hors bornes refusée', async () => {
    open('accounts');
    await settle();
    (document.querySelector('[data-adm-sel="a2"]') as HTMLInputElement).click();
    await settle();
    (document.querySelector('[data-adm-bulk="quota"][data-delta="1"]') as HTMLElement).click();
    await settle();
    expect(document.querySelector('[data-adm-confirm]')).toBeNull();
    expect(pathCalls('POST', '/admin/accounts/bulk')[0].body).toEqual({ ids: ['a2'], action: 'quota', delta: 1 });
    // Succès complet : la sélection est vidée, il faut recocher le compte pour revoir la barre.
    expect(document.querySelector('[data-adm-bulk-quota]')).toBeNull();
    (document.querySelector('[data-adm-sel="a2"]') as HTMLInputElement).click();
    await settle();

    // Hors bornes : la validation native bloque l'envoi (aucun appel de plus).
    const form = document.querySelector('[data-adm-bulk-quota]') as HTMLFormElement;
    field(form, 'quota').value = '150';
    expect(field(form, 'quota').checkValidity()).toBe(false);
    form.requestSubmit();
    await settle();
    expect(pathCalls('POST', '/admin/accounts/bulk')).toHaveLength(1);

    field(form, 'quota').value = '3';
    form.requestSubmit();
    await settle();
    expect(pathCalls('POST', '/admin/accounts/bulk').at(-1)!.body).toEqual({ ids: ['a2'], action: 'quota', quota: 3 });
  });
});

describe('comptes : export CSV', () => {
  it('téléchargement daté, BOM UTF-8, filtre courant envoyé, lignes des comptes', async () => {
    const downloads: string[] = [];
    let blob: Blob | null = null;
    (URL as any).createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:test'; });
    (URL as any).revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });

    open('accounts');
    await settle();
    (document.querySelector('[data-adm-filter="online"]') as HTMLElement).click();
    await settle();
    (document.querySelector('[data-adm-export]') as HTMLElement).click();
    await settle();

    expect(pathCalls('GET', '/admin/accounts/export').at(-1)!.search).toContain('filter=online');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^laststream-comptes-\d{4}-\d{2}-\d{2}\.csv$/);
    // Lecture des octets : FileReader.readAsText retirerait le BOM au décodage.
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.readAsArrayBuffer(blob as unknown as Blob);
    }));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8').decode(bytes.slice(3));
    const lines = text.split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('Identifiant,Pseudo,Statut');
    expect(lines[1].startsWith('a1,marine,active,')).toBe(true);
    expect(lines).toHaveLength(ACCOUNTS.length + 1);
    clickSpy.mockRestore();
  });
});

describe('fiche compte', () => {
  it('onglet Sessions : appareils réels, « inconnu » sans activité, révocation unitaire appelle l’API', async () => {
    open('accounts');
    await settle();
    (document.querySelector('[data-adm-acc="a1"]') as HTMLElement).click();
    await settle();
    const drawer = document.querySelector('.adm-layer--drawer') as HTMLElement;
    expect(drawer.querySelector('[role="dialog"]')).not.toBeNull();
    expect(drawer.querySelector('[role="dialog"]')!.getAttribute('aria-modal')).toBe('true');

    (drawer.querySelector('[data-adm-tab="sessions"]') as HTMLElement).click();
    await settle();
    const items = drawer.querySelectorAll('.adm-sess');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Android · Laststream 1.4');
    expect(items[1].textContent).toContain('Appareil inconnu');
    expect(items[1].textContent).toContain('inconnu');

    (items[1].querySelector('button') as HTMLElement).click();
    await settle();
    expect(pathCalls('DELETE', '/admin/accounts/a1/sessions/s2')).toHaveLength(1);
    expect(pathCalls('GET', '/admin/accounts/a1').length).toBeGreaterThanOrEqual(2);
  });

  it('Aperçu : quota +1 envoie la nouvelle valeur', async () => {
    open('accounts');
    await settle();
    (document.querySelector('[data-adm-acc="a1"]') as HTMLElement).click();
    await settle();
    const drawer = document.querySelector('.adm-layer--drawer') as HTMLElement;
    expect(drawer.querySelector('[data-adm-quota-step="1"]')).not.toBeNull();
    (drawer.querySelector('[data-adm-quota-step="1"]') as HTMLElement).click();
    await settle();
    const put = pathCalls('PUT', '/admin/accounts/a1/invite-quota');
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({ quota: 5 });
  });

  it('suspendre depuis la zone sensible demande confirmation avant l’appel', async () => {
    stubApi({ 'POST /admin/accounts/a1/suspend': () => json({ ok: true }) });
    open('accounts');
    await settle();
    (document.querySelector('[data-adm-acc="a1"]') as HTMLElement).click();
    await settle();
    const drawer = document.querySelector('.adm-layer--drawer') as HTMLElement;
    (drawer.querySelector('[data-adm-do="suspend"]') as HTMLElement).click();
    await settle();
    expect(pathCalls('POST', '/admin/accounts/a1/suspend')).toHaveLength(0);
    (document.querySelector('[data-adm-confirm]') as HTMLFormElement).requestSubmit();
    await settle();
    expect(pathCalls('POST', '/admin/accounts/a1/suspend')).toHaveLength(1);
  });
});

describe('invitations et parrainages', () => {
  it('liste des liens filtrée par statut, révocation après confirmation', async () => {
    stubApi({
      'GET /admin/invites': ({ url }) => json({ invites: url.searchParams.get('status') === 'active' ? [INVITE_ACTIVE] : [] }),
    });
    open('invites');
    await settle();
    expect(pathCalls('GET', '/admin/invites').at(-1)!.search).toContain('status=active');
    expect(document.querySelector('[data-adm-invstatus="active"]')!.getAttribute('aria-pressed')).toBe('true');

    (document.querySelector('[data-adm-revoke="inv1"]') as HTMLElement).click();
    await settle();
    expect(document.querySelector('[data-adm-confirm]')).not.toBeNull();
    expect(pathCalls('DELETE', '/admin/invites/inv1')).toHaveLength(0);
    (document.querySelector('[data-adm-confirm]') as HTMLFormElement).requestSubmit();
    await settle();
    expect(pathCalls('DELETE', '/admin/invites/inv1')).toHaveLength(1);

    (document.querySelector('[data-adm-invstatus="used"]') as HTMLElement).click();
    await settle();
    expect(pathCalls('GET', '/admin/invites').at(-1)!.search).toContain('status=used');
    expect(document.querySelector('[data-adm-revoke]')).toBeNull();
  });
});

describe('en ligne', () => {
  it('liste des comptes présents ; actualisation toutes les 30 s seulement si l’onglet est visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const now = Date.now();
    stubApi({
      'GET /admin/online': () => json({
        accounts: [
          { id: 'a1', username: 'marine', lastSeenAt: new Date(now - 30_000).toISOString(), watching: { title: 'Dune', mediaType: 'movie' } },
          { id: 'a2', username: 'theo', lastSeenAt: new Date(now - 90_000).toISOString(), watching: null },
        ],
      }),
    });
    open('online');
    await settle();
    const rows = document.querySelectorAll('#adm-content table tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('marine');
    expect(rows[0].textContent).toContain('Dune');
    expect(rows[1].textContent).toContain('theo');
    expect(rows[1].textContent).toContain('Rien pour le moment');

    const before = pathCalls('GET', '/admin/online').length;
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(pathCalls('GET', '/admin/online')).toHaveLength(before + 1);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(pathCalls('GET', '/admin/online')).toHaveLength(before + 1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    // Quitter la section arrête l'actualisation au tic suivant.
    adm.__admin.setSection('accounts');
    await settle();
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(pathCalls('GET', '/admin/online')).toHaveLength(before + 1);
  });
});
