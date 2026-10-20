// Centre de contrôle (Pilotage) : tuiles de santé, « À traiter » (groupes, « Marquer vu », actions), « En direct » (rafraîchissement
// toutes les 30 s), pastille d'état dégradée, câblage de la palette (Ctrl+K), fonctions pures de adminModel.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import * as M from '../src/data/adminModel';

let auth: any;
let adm: any;
let pilotage: any;
let shell: any;
let sections: any;

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
/** Laisse aboutir les réponses fetch (les minuteries factices ne sont pas touchées). */
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

const GRP = { requests: 120, status: { '2xx': 100, '3xx': 0, '4xx': 10, '5xx': 10 }, p50: 20, p95: 300, avgMs: 45 };
const METRICS = {
  range: '24h', from: NOW - 86_400_000, to: NOW, stepSec: 300, totals: GRP, groups: { stream: GRP }, upstreams: [], alldebrid: {}, caches: [], errors: [],
  series: [{ t: ago(60), requests: 10, errors5xx: 1, p95: 300 }],
};
const SERIES = {
  points: Array.from({ length: 6 }, (_, i) => ({ t: ago(10 * (5 - i)), requests: 20 + i, errors5xx: i === 3 ? 4 : 0, p95: 250 + i })),
  deltas: { requests: 12.34, errors5xx: 0.04, p95: -2 },
};
const ACC = { id: 'a1', username: 'marine', isOwner: false, createdAt: ago(9000), status: 'active', suspendedAt: null, referrer: null, lastActivityAt: ago(60), profileCount: 1, libraryCount: 0, inviteQuota: 0, invitesUsed: 0, online: true, sessionCount: 1 };
const ACCOUNTS = { accounts: [ACC], nextCursor: null, total: 42, counts: { all: 42, online: 1, inactive30: 0, suspended: 0, noInvites: 0 } };
const LIVE = { online: 12, watching: 7, parties: 2, feed: [{ at: ago(10), kind: 'party', label: 'a lancé une watch party (4 personnes)', target: 'marine' }, { at: ago(20), kind: 'audit', label: 'a purgé le préfixe cache meta:', target: 'Toi' }] };

/** Réponses par défaut de la console ; `over` remplace une route (chemin → valeur, fabrique ou Response). */
const DEFAULTS: Record<string, () => unknown> = {
  '/admin/status': () => ({ status: 'ok', services: [] }),
  '/admin/accounts': () => ACCOUNTS,
  '/admin/settings': () => ({ inviteDefaultQuota: 4, invitesOpen: true, maintenance: { enabled: false, message: '' } }),
  '/admin/metrics': () => METRICS,
  '/admin/overview-series': () => SERIES,
  '/admin/live': () => LIVE,
  '/admin/inbox': () => ({ items: [], total: 0 }),
  '/admin/party/reports': () => ({ reports: [] }),
  '/admin/party/rooms': () => ({ rooms: [] }),
  '/admin/accounts/a1': () => ({ account: ACC, profiles: [], libraryCount: 0, invitees: [], sessions: [], invites: [] }),
};
let calls: Array<{ path: string; method: string }> = [];
let hiddenTab = false;

function stub(over: Record<string, () => unknown> = {}) {
  const table = { ...DEFAULTS, ...over };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = String(init?.method ?? 'GET');
    calls.push({ path: u.pathname, method });
    const fn = table[u.pathname];
    if (!fn) return json({}, 404);
    const out = fn();
    return out instanceof Response ? out : json(out);
  }));
}

const callsTo = (p: string) => calls.filter((c) => c.path === p);

/** Propriétaire sur un profil adulte : la console est accessible. */
function asOwner() {
  auth.status = 'ready';
  auth.isOwner = true;
  auth.profile = { id: 'p1', name: 'Greg', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true };
  location.hash = '#/admin';
}

/** Ouvre la console sur une section, puis attend les réponses. */
async function openSection(sec: string, over: Record<string, () => unknown> = {}) {
  stub(over);
  asOwner();
  adm.__admin.S.sec = sec;
  adm.showAdmin();
  await settle();
  calls = [];
}

const item = (over: Record<string, unknown>) => ({
  key: 'k', kind: 'report', severity: 'warn', title: 'Titre', detail: 'Détail', at: ago(40), action: { label: 'Examiner', route: '#/admin/moderation' }, ...over,
});

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenTab });
  adm = await import('../src/ui/admin.js');
  pilotage = await import('../src/ui/admin/pilotage.js');
  shell = await import('../src/ui/admin/shell.js');
  sections = await import('../src/ui/admin/sections.js');
  ({ auth } = await import('../src/data/auth'));
  // Minuteries factices (intervalles de la coquille et de « En direct ») : une seule horloge pour tout le fichier.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

beforeEach(() => {
  hiddenTab = false;
  calls = [];
});

afterEach(() => {
  adm.__admin.stopTick();
});

// ---------- Santé des services ----------
describe('tuiles de santé', () => {
  it('cinq tuiles dans l’ordre de la maquette, valeur et détail du serveur, ton selon l’état', async () => {
    await openSection('overview', {
      '/admin/status': () => ({
        status: 'degraded',
        services: [
          { id: 'api', label: 'API Worker', status: 'ok', value: '182 ms', detail: 'p95 · 0,4 % 5xx' },
          { id: 'accounts', label: 'Base comptes', status: 'ok', value: 'OK', detail: 'Durable Object · 38 ms' },
          { id: 'kv', label: 'Cache KV', status: 'ok', value: '87 %', detail: 'taux de succès' },
          { id: 'upstream', label: 'Addons amont', status: 'degraded', value: '5 / 6', detail: '1 dégradé : lenteur' },
          { id: 'cron', label: 'Cron TV', status: 'ok', value: 'il y a 2 h', detail: 'prochain dans 4 h' },
        ],
      }),
    });
    const tiles = $$('.adm-health-t');
    expect(tiles).toHaveLength(5);
    expect(tiles.map((t) => t.querySelector('.adm-health-n')!.textContent)).toEqual(['API Worker', 'Base comptes', 'Cache KV', 'Addons amont', 'Cron TV']);
    expect(tiles[0].textContent).toContain('182 ms');
    expect(tiles[0].textContent).toContain('p95 · 0,4 % 5xx');
    expect(tiles[0].classList.contains('is-ok')).toBe(true);
    expect(tiles[3].classList.contains('is-warn')).toBe(true);
    expect(tiles[3].textContent).toContain('5 / 6');
    expect(tiles[3].querySelector('.adm-health-st')!.textContent).toBe('Dégradé');
  });

  it('service absent du rapport : tuile « Inconnu », valeur « — », aucune valeur inventée', async () => {
    await openSection('overview', { '/admin/status': () => ({ status: 'ok', services: [{ id: 'api', status: 'ok', value: '90 ms', detail: '' }] }) });
    const kv = $$('.adm-health-t')[2];
    expect(kv.querySelector('.adm-health-v')!.textContent).toBe('—');
    expect(kv.querySelector('.adm-health-st')!.textContent).toBe('Inconnu');
    expect(kv.classList.contains('is-neutral')).toBe(true);
  });

  it('pastille dégradée en ambre ; si l’état du serveur est indisponible, « Inconnu » et les autres blocs restent affichés', async () => {
    await openSection('overview', {
      '/admin/status': () => new Response('{}', { status: 500 }),
      '/admin/accounts': () => ACCOUNTS,
    });
    expect($('[data-adm-status]')!.textContent).toBe('Inconnu');
    expect($('.adm-health-wrap .adm-error')).not.toBeNull();
    expect($$('.adm-kpi')[0].querySelector('.adm-kpi-v')!.textContent).toBe('42');
    expect($('[data-adm-status]')!.classList.contains('is-warn')).toBe(false);

    stub({ '/admin/status': () => ({ status: 'degraded', services: [] }) });
    await adm.__admin.refreshShell();
    await settle();
    expect($('[data-adm-status]')!.textContent).toBe('Dégradé');
    expect($('[data-adm-status]')!.classList.contains('is-warn')).toBe(true);
    expect(shell.statusHTML('degraded')).toContain('is-warn');
  });
});

// ---------- « À traiter » ----------
describe('À traiter', () => {
  const twoItems = {
    '/admin/inbox': () => ({
      total: 2,
      items: [
        item({ key: 'r1', severity: 'warn', title: '3 signalements en attente', detail: 'Watch party « Soirée Dune »', action: { label: 'Examiner', route: '#/admin/moderation' } }),
        item({ key: 'e1', kind: 'errors5xx', severity: 'critical', title: 'Pic de 41 erreurs 5xx', detail: 'Route /meta', action: { label: 'Voir les erreurs', route: '#/admin/metrics' } }),
      ],
    }),
  };

  it('groupé par sévérité, le critique en premier ; chaque item a son action et « Marquer vu »', async () => {
    await openSection('inbox', twoItems);
    const groups = $$('.adm-todo-gt').map((h) => h.textContent);
    expect(groups[0]).toMatch(/^Critique/);
    expect(groups[1]).toMatch(/^À surveiller/);
    expect($$('.adm-todo')).toHaveLength(2);
    expect($('[data-adm-inbox-act="e1"]')!.textContent).toBe('Voir les erreurs');
    expect($$('[data-adm-inbox-seen]')).toHaveLength(2);
  });

  it('liste vide : message « Rien à traiter. » (et pas d’erreur)', async () => {
    await openSection('inbox');
    expect($('.adm-inbox-empty')!.textContent).toContain('Rien à traiter.');
    expect($('.adm-error')).toBeNull();
  });

  it('« Marquer vu » retire l’item tout de suite, appelle dismissInbox et met le compteur à jour', async () => {
    await openSection('inbox', { ...twoItems, '/admin/inbox/e1/dismiss': () => ({ ok: true }) });
    expect($('[data-adm-badge="todo"]')!.textContent).toBe('2');
    ($('[data-adm-inbox-seen="e1"]') as HTMLElement).click();
    expect($('[data-adm-inbox-act="e1"]')).toBeNull(); // retrait optimiste, avant la réponse du serveur
    expect($('[data-adm-badge="todo"]')!.textContent).toBe('1');
    await settle();
    expect(callsTo('/admin/inbox/e1/dismiss')).toEqual([{ path: '/admin/inbox/e1/dismiss', method: 'POST' }]);
    expect($('[data-adm-inbox-act="r1"]')).not.toBeNull();
  });

  it('« Marquer vu » en échec : l’item revient et un message s’affiche', async () => {
    await openSection('inbox', { ...twoItems, '/admin/inbox/e1/dismiss': () => new Response('{}', { status: 500 }) });
    ($('[data-adm-inbox-seen="e1"]') as HTMLElement).click();
    await settle();
    expect($('[data-adm-inbox-act="e1"]')).not.toBeNull();
    expect($('[data-adm-badge="todo"]')!.textContent).toBe('2');
    expect(document.getElementById('toast')!.textContent!.length).toBeGreaterThan(0);
  });

  it('action de route : ouvre la section visée (« #/admin/metrics » ouvre la performance)', async () => {
    await openSection('inbox', twoItems);
    ($('[data-adm-inbox-act="e1"]') as HTMLElement).click();
    await settle();
    expect(adm.__admin.S.sec).toBe('performance');
    expect($('[data-adm-sec][aria-current="page"]')!.getAttribute('data-adm-sec')).toBe('performance');
  });

  it('action « tv-rerun » : confirmation, puis POST /admin/tv/rerun', async () => {
    const cron = { '/admin/inbox': () => ({ total: 1, items: [item({ key: 'c1', kind: 'cron', severity: 'warn', title: 'Passage TV en retard', action: { label: 'Relancer la TV', route: '#/admin/tasks', call: 'tv-rerun' } })] }), '/admin/tv/rerun': () => ({ ok: true }) };
    await openSection('inbox', cron);
    ($('[data-adm-inbox-act="c1"]') as HTMLElement).click();
    await settle();
    const submit = $('form[data-adm-confirm] [type=submit]') as HTMLElement;
    expect(submit).not.toBeNull();
    expect(callsTo('/admin/tv/rerun')).toHaveLength(0);
    submit.click();
    await settle();
    expect(callsTo('/admin/tv/rerun')).toEqual([{ path: '/admin/tv/rerun', method: 'POST' }]);
    expect(document.getElementById('toast')!.textContent).toBe('Relance demandée.');
  });

  it('échec de la liste : bloc d’erreur avec réessai, la navigation reste utilisable', async () => {
    await openSection('inbox', { '/admin/inbox': () => new Response('{}', { status: 500 }) });
    expect($('.adm-error')).not.toBeNull();
    expect($('[data-adm-badge="todo"]')!.hidden).toBe(true);
    ($('[data-adm-sec="accounts"]') as HTMLElement).click();
    await settle();
    expect(adm.__admin.S.sec).toBe('accounts');
  });
});

// ---------- « En direct » ----------
describe('En direct', () => {
  it('en ligne, en lecture, watch parties et flux des derniers événements', async () => {
    await openSection('overview');
    const counts = $$('.adm-live-counts strong').map((s) => s.textContent);
    expect(counts).toEqual(['12', '7', '2']);
    const rows = $$('.adm-feed li');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('marine');
    expect(rows[0].textContent).toContain('a lancé une watch party (4 personnes)');
  });

  it('flux vide : « Aucun événement récent. »', async () => {
    await openSection('overview', { '/admin/live': () => ({ online: 0, watching: 0, parties: 0, feed: [] }) });
    expect($('.adm-live-counts')).not.toBeNull();
    expect($('.adm-feed')).toBeNull();
    expect(document.querySelector('[aria-label="En direct"]')!.textContent).toContain('Aucun événement récent.');
  });

  it('échec de « En direct » seul : les tuiles de santé et les chiffres restent affichés', async () => {
    await openSection('overview', { '/admin/live': () => new Response('{}', { status: 500 }) });
    expect($('[aria-label="En direct"] .adm-error')).not.toBeNull();
    expect($$('.adm-health-t')).toHaveLength(5);
    expect($$('.adm-kpi')).toHaveLength(8);
    expect(document.querySelector('.adm-kpis-dash')!.textContent).toContain('Signalements en attente');
  });

  it('un cycle de 30 s : un seul appel à /admin/live, ouverture du tableau de bord comprise', async () => {
    stub();
    asOwner();
    adm.__admin.S.sec = 'overview';
    adm.showAdmin();
    await settle();
    const live = () => callsTo('/admin/live').length;
    expect(live()).toBe(1);

    calls = [];
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(live()).toBe(1);
    expect(callsTo('/admin/status')).toHaveLength(1);
    expect(callsTo('/admin/inbox')).toHaveLength(1);
  });

  it('rafraîchi toutes les 30 s seulement quand la section est affichée et l’onglet visible', async () => {
    await openSection('overview');
    const live = () => callsTo('/admin/live').length;

    // Section affichée, onglet visible : la coquille interroge /admin/live une fois par cycle.
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(live()).toBe(1);

    // Onglet masqué : plus aucune actualisation.
    hiddenTab = true;
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(live()).toBe(1);

    // Onglet visible, autre section : la coquille continue, un appel par cycle.
    hiddenTab = false;
    adm.__admin.setSection('accounts');
    await settle();
    calls = [];
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(live()).toBe(1);
  });

  it('une saisie en cours n’est pas repeinte par le rafraîchissement automatique ; sinon la valeur est reprise', async () => {
    await openSection('accounts');
    const detail = document.getElementById('detail') as HTMLElement;
    detail.hidden = false; // le focus ne va pas sur un élément caché (attribut hidden de index.html)
    try {
      const input = $('[data-adm-focus="acc:q"]') as HTMLInputElement;
      input.value = 'ali';
      input.focus();
      expect(document.activeElement).toBe(input);
      adm.__admin.paint(true);
      expect($('[data-adm-focus="acc:q"]')).toBe(input);
      expect(input.value).toBe('ali');

      input.blur();
      adm.__admin.paint(true);
      expect(($('[data-adm-focus="acc:q"]') as HTMLInputElement).value).toBe('ali');
    } finally {
      detail.hidden = true;
    }
  });
});

// ---------- Palette de commandes (câblage Ctrl+K) ----------
describe('palette de commandes dans la console', () => {
  const ctrlK = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));

  it('Ctrl+K ouvre la palette avec les sections et les actions ; Échap la ferme', async () => {
    await openSection('overview');
    ctrlK();
    const layer = $('.adm-pal-layer');
    expect(layer).not.toBeNull();
    const labels = $$('.adm-pal-item .adm-pal-label').map((n) => n.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Tableau de bord', 'À traiter', 'Journal d’audit', 'Relancer la tâche TV']));
    ($('.adm-pal-input') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.adm-pal-layer')).toBeNull();
  });

  it('choisir une section dans la palette l’affiche', async () => {
    await openSection('overview');
    ctrlK();
    const input = $('.adm-pal-input') as HTMLInputElement;
    input.value = 'Journal';
    input.dispatchEvent(new Event('input'));
    ($('.adm-pal-layer [role=dialog]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(adm.__admin.S.sec).toBe('audit');
  });

  it('« Ouvrir la fiche » d’un compte trouvé ouvre le panneau du compte', async () => {
    await openSection('overview');
    ctrlK();
    const input = $('.adm-pal-input') as HTMLInputElement;
    input.value = 'marine';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 260)); // débounce de la recherche (minuterie réelle)
    await settle();
    expect($('.adm-pal-item.is-active .adm-pal-label')!.textContent).toBe('marine');
    ($('.adm-pal-layer [role=dialog]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(callsTo('/admin/accounts/a1')).toHaveLength(1);
    expect($('.adm-layer--drawer')).not.toBeNull();
    ($('.adm-sheet-h [data-adm-close]') as HTMLElement).click();
  });

  it('après être sorti de la console, Ctrl+K n’ouvre plus la palette', async () => {
    await openSection('overview');
    location.hash = '#/';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    ctrlK();
    expect($('.adm-pal-layer')).toBeNull();
  });

  it('quitter la console ferme une palette ouverte', async () => {
    await openSection('overview');
    ctrlK();
    expect($('.adm-pal-layer')).not.toBeNull();
    location.hash = '#/';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect($('.adm-pal-layer')).toBeNull();
  });

  it('Ctrl+K et « / » ne l’ouvrent pas quand un calque (confirmation, fiche) est ouvert', async () => {
    await openSection('overview');
    const layer = document.createElement('div');
    layer.className = 'adm-layer';
    document.body.append(layer);
    ctrlK();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    expect($('.adm-pal-layer')).toBeNull();
    layer.remove();
    ctrlK();
    expect($('.adm-pal-layer')).not.toBeNull();
    ($('.adm-pal-input') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

// ---------- Fonctions pures ----------
describe('fonctions pures du centre de contrôle', () => {
  it('variations : signe typographique, zéro, indisponible ; ton selon le sens de l’indicateur', () => {
    expect(M.fmtDelta(12.34)).toBe('+12 %');
    expect(M.fmtDelta(-2)).toBe('−2 %');
    expect(M.fmtDelta(0.04)).toBe('0 %');
    expect(M.fmtDelta(3.14)).toBe('+3,1 %');
    expect(M.fmtDelta(null)).toBe('');
    expect(M.deltaTone(12, true)).toBe('ok');
    expect(M.deltaTone(12, false)).toBe('bad');
    expect(M.deltaTone(-5, false)).toBe('ok');
    expect(M.deltaTone(undefined, true)).toBe('neutral');
  });

  it('tuiles de santé sans rapport : cinq tuiles « Inconnu »', () => {
    const tiles = M.healthTiles(null);
    expect(tiles.map((t) => t.id)).toEqual(['api', 'accounts', 'kv', 'upstream', 'cron']);
    expect(tiles.every((t) => t.value === '—' && t.statusLabel === 'Inconnu' && t.tone === 'neutral')).toBe(true);
  });

  it('« À traiter » : groupes par sévérité (vides omis, inconnue = information), retrait d’un item', () => {
    const mk = (key: string, severity: string) => ({ key, kind: 'quota', severity, title: key, detail: '', at: null, action: { label: 'x', route: '#/admin/system' } }) as any;
    const groups = M.inboxGroups([mk('a', 'info'), mk('b', 'critical'), mk('c', 'bizarre')]);
    expect(groups.map((g) => g.id)).toEqual(['critical', 'info']);
    expect(groups[1].items.map((i) => i.key)).toEqual(['a', 'c']);
    const inbox = { items: [mk('a', 'info'), mk('b', 'critical')], total: 5 };
    expect(M.inboxWithout(inbox, 'b')).toEqual({ items: [mk('a', 'info')], total: 4 });
    expect(M.inboxWithout(inbox, 'zzz')).toEqual(inbox);
  });

  it('routes d’action : « #/admin/… » vers une section, alias metrics → performance, autre route : null', () => {
    expect(M.routeSection('#/admin/moderation')).toBe('moderation');
    expect(M.routeSection('#/admin/metrics')).toBe('performance');
    expect(M.routeSection('#/admin/party/reports')).toBeNull();
    expect(M.routeSection('')).toBeNull();
  });

  it('flux « En direct » : heure HH:MM, cible facultative, bornage', () => {
    const rows = M.feedRows([{ at: ago(5), kind: 'signup', label: 'inscription' }, { at: 'pas une date', kind: 'audit', label: 'x', target: 'lucas' }], 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'inscription', target: '' });
    expect(M.feedRows(null)).toEqual([]);
    expect(M.feedRows([{ at: 'x', kind: 'audit', label: 'y', target: 'lucas' }])[0].at).toBe('—');
  });

  it('libellés des sections du registre inchangés (Pilotage en tête)', () => {
    expect(sections.SECTIONS.slice(0, 2).map((s: any) => s.label)).toEqual(['Tableau de bord', 'À traiter']);
  });
});
