// Coquille de la console d'administration : registre des sections (5 espaces, 15 entrées), navigation et compteurs,
// pastille d'état du serveur, puce d'élévation avec compte à rebours (minuteries factices).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';

let auth: any;
let sections: any;
let shell: any;
let adm: any;
let api: any;

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
/** Laisse aboutir les promesses (réponses fetch) sans dépendre des minuteries factices. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  sections = await import('../src/ui/admin/sections.js');
  shell = await import('../src/ui/admin/shell.js');
  adm = await import('../src/ui/admin.js');
  api = await import('../src/data/adminApi');
  ({ auth } = await import('../src/data/auth'));
});

/** Propriétaire sur un profil adulte, en session serveur : la console est accessible. */
function asOwner() {
  auth.status = 'ready';
  auth.isOwner = true;
  auth.profile = { id: 'p1', name: 'Greg', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true };
  location.hash = '#/admin';
}

/** Réponses par défaut de la console ; `extra` remplace une route (chemin → fabrique de réponse). */
function stub(extra: Record<string, () => Response> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(String(url));
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (extra[u.pathname]) return extra[u.pathname]();
    const grp = { requests: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, p50: 0, p95: 0, avgMs: 0 };
    if (u.pathname === '/admin/accounts') return j({ accounts: [], nextCursor: null, total: 0, counts: { all: 0, online: 0, inactive30: 0, suspended: 0, noInvites: 0 } });
    if (u.pathname === '/admin/metrics') return j({ range: '24h', from: 0, to: 86400, stepSec: 300, totals: grp, groups: {}, series: [], upstreams: [], alldebrid: {}, caches: [], errors: [] });
    if (u.pathname === '/admin/party/rooms') return j({ rooms: [] });
    if (u.pathname === '/admin/party/reports') return j({ reports: [] });
    if (u.pathname === '/admin/settings') return j({ inviteDefaultQuota: 4, invitesOpen: true, maintenance: { enabled: false, message: '' } });
    return new Response('{}', { status: 404 });
  }));
}

describe('registre des sections', () => {
  it('5 espaces, 15 entrées, identifiants uniques, chaque entrée rattachée à un espace connu', () => {
    expect(sections.GROUPS.map((g: any) => g.label)).toEqual(['Pilotage', 'Utilisateurs', 'Plateforme', 'Communauté', 'Système']);
    expect(sections.SECTIONS).toHaveLength(15);
    const ids = sections.SECTIONS.map((s: any) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of sections.SECTIONS) {
      expect(sections.GROUPS.map((g: any) => g.id)).toContain(s.group);
      expect(typeof s.render).toBe('function');
    }
  });

  it('libellés dans l’ordre de la navigation, espace par espace', () => {
    expect(sections.SECTIONS.map((s: any) => s.label)).toEqual([
      'Tableau de bord', 'À traiter',
      'Comptes', 'Invitations', 'En ligne',
      'Sources et addons', 'Performance', 'Caches et stockage', 'Tâches planifiées', 'Clés des services',
      'Watch parties', 'Modération',
      'Réglages', 'Annonces', 'Journal d’audit',
    ]);
  });
});

describe('navigation groupée', () => {
  const render = (S: any) => { const w = document.createElement('div'); w.innerHTML = shell.navHTML(S); return w; };

  it('5 groupes, 15 entrées, une seule entrée courante (aria-current)', () => {
    const w = render({ sec: 'accounts', badges: { todo: null, online: null, reports: null } });
    expect(w.querySelectorAll('.adm-navg')).toHaveLength(5);
    expect(w.querySelectorAll('[data-adm-sec]')).toHaveLength(15);
    const current = w.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('data-adm-sec')).toBe('accounts');
  });

  it('compteurs : valeur affichée au-dessus de zéro ; masqué quand la valeur vaut 0 ou est inconnue', () => {
    const w = render({ sec: 'overview', badges: { todo: 3, online: null, reports: 0 } });
    const badge = (k: string) => w.querySelector('[data-adm-badge="' + k + '"]') as HTMLElement;
    expect(badge('todo').hidden).toBe(false);
    expect(badge('todo').textContent).toBe('3');
    expect(badge('reports').hidden).toBe(true);
    expect(badge('reports').textContent).toBe('');
    expect(badge('online').hidden).toBe(true);
  });
});

describe('pastille d’état', () => {
  const label = (st: string | null) => { const w = document.createElement('div'); w.innerHTML = shell.statusHTML(st); return w; };

  it('libellés français selon l’état ; valeur inconnue ou vérification en cours', () => {
    expect(label('ok').textContent).toBe('Opérationnel');
    expect(label('degraded').textContent).toBe('Dégradé');
    expect(label('down').textContent).toBe('En panne');
    expect(label('unknown').textContent).toBe('Inconnu');
    expect(label('n’importe quoi').textContent).toBe('Inconnu');
    expect(label(null).textContent).toBe('Vérification…');
    expect(label('degraded').querySelector('[data-adm-status]')!.classList.contains('is-warn')).toBe(true);
  });

  it('dans la page : état reçu du serveur, puis « Inconnu » quand la requête échoue', async () => {
    asOwner();
    stub({ '/admin/status': () => new Response(JSON.stringify({ status: 'degraded', services: [] }), { status: 200 }) });
    adm.__admin.S.sec = 'overview';
    adm.showAdmin();
    await settle();
    const st = document.querySelector('[data-adm-status]') as HTMLElement;
    expect(st.textContent).toBe('Dégradé');
    expect(st.classList.contains('is-warn')).toBe(true);

    stub({ '/admin/status': () => new Response('{}', { status: 500 }) });
    await adm.__admin.refreshShell();
    await settle();
    expect(document.querySelector('[data-adm-status]')!.textContent).toBe('Inconnu');
  });
});

describe('compteurs et navigation dans la page', () => {
  it('à traiter, en ligne et signalements affichent les valeurs reçues ; une erreur masque le compteur', async () => {
    asOwner();
    stub({
      '/admin/inbox': () => new Response(JSON.stringify({ items: [], total: 4 }), { status: 200 }),
      '/admin/live': () => new Response(JSON.stringify({ online: 2, watching: 0, parties: 0, feed: [] }), { status: 200 }),
      '/admin/party/reports': () => new Response(JSON.stringify({ reports: [{}, {}, {}] }), { status: 200 }),
    });
    adm.__admin.S.sec = 'overview';
    adm.showAdmin();
    await settle();
    const badge = (k: string) => document.querySelector('[data-adm-badge="' + k + '"]') as HTMLElement;
    expect(badge('todo').textContent).toBe('4');
    expect(badge('todo').hidden).toBe(false);
    expect(badge('online').textContent).toBe('2');
    expect(badge('reports').textContent).toBe('3');

    stub({ '/admin/inbox': () => new Response('{}', { status: 500 }) });
    await adm.__admin.refreshShell();
    await settle();
    expect(badge('todo').hidden).toBe(true);
  });

  it('cliquer une entrée affiche sa section, marque l’entrée courante et déplace le focus sur son titre', async () => {
    asOwner();
    stub();
    adm.__admin.S.sec = 'overview';
    adm.showAdmin();
    await settle();
    (document.querySelector('[data-adm-sec="accounts"]') as HTMLElement).click();
    await settle();
    const current = document.querySelectorAll('[aria-current="page"][data-adm-sec]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('data-adm-sec')).toBe('accounts');
    expect(document.querySelector('#adm-h')!.textContent).toBe('Comptes');
  });
});

describe('puce d’élévation : compte à rebours', () => {
  const box = () => document.querySelector('[data-adm-elev]') as HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    api.clearElevation();
    asOwner();
    stub({
      '/admin/elevate': () => new Response(JSON.stringify({ token: 'T1', expiresAt: new Date(Date.now() + 600_000).toISOString() }), { status: 200 }),
    });
    adm.__admin.S.sec = 'overview';
    adm.showAdmin();
  });

  afterEach(() => {
    adm.__admin.stopTick();
    api.clearElevation();
    vi.useRealTimers();
  });

  it('sans élévation : bouton « Activer le mode élevé »', () => {
    expect(box().dataset.state).toBe('off');
    expect(box().querySelector('[data-adm-elevate]')!.textContent).toBe('Activer le mode élevé');
  });

  it('après élévation : 10:00, décompte d’une seconde à la fois, puis retour au bouton à l’expiration', async () => {
    api.setElevationPrompt(async () => 'pw');
    await api.obtainElevation();
    adm.__admin.syncElevation();
    expect(box().dataset.state).toBe('on');
    expect(box().textContent).toBe('Mode élevé · 10:00');
    vi.advanceTimersByTime(1000);
    expect(box().textContent).toBe('Mode élevé · 09:59');
    vi.advanceTimersByTime(593_000);
    expect(box().textContent).toBe('Mode élevé · 00:06');
    vi.advanceTimersByTime(1000);
    expect(box().dataset.state).toBe('off');
    expect(box().querySelector('[data-adm-elevate]')!.textContent).toBe('Activer le mode élevé');
  });

  it('un clic sur le bouton demande le mot de passe puis affiche le compte à rebours', async () => {
    api.setElevationPrompt(async () => 'pw');
    (box().querySelector('[data-adm-elevate]') as HTMLElement).click();
    await settle();
    expect(box().dataset.state).toBe('on');
    expect(box().textContent).toBe('Mode élevé · 10:00');
  });
});
