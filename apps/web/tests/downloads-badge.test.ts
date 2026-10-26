// Pastille des téléchargements en cours (ODY-234) : abonnement permanent hors routeur, repeinture seulement si le compte change,
// rien en profil enfant ni sans téléchargements sur la plateforme. Service mocké.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const mgr = { pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), remove: vi.fn(() => Promise.resolve()), pauseAll: vi.fn(), resumeAll: vi.fn(), list: vi.fn(() => []) };
  const s = {
    avail: { ok: true } as { ok: boolean; reason?: string },
    kid: false,
    items: [] as unknown[],
    listener: null as null | ((items: unknown[]) => void),
    unsub: vi.fn(),
    manager: mgr as unknown,
    space: { used: 1, limit: 10, ratio: 0.1, warn: false, full: false } as unknown,
  };
  return { mgr, s };
});

vi.mock('../src/downloads/service', () => ({
  platformAvailability: () => h.s.avail,
  getDownloads: vi.fn(() => Promise.resolve(h.s.manager)),
  downloadIdFor: (t: { key: string; season?: number; episode?: number }) => (t.season !== undefined && t.episode !== undefined ? `${t.key}:${t.season}:${t.episode}` : t.key),
  listSourceChoices: vi.fn(() => Promise.resolve([])),
  recommendedChoice: (choices: Array<{ sizeBytes: number }>, free: number | null) => choices.find((c) => free === null || c.sizeBytes <= free) ?? null,
  requestDownload: vi.fn(() => Promise.resolve({})),
  subscribeDownloads: vi.fn((fn: (items: unknown[]) => void) => {
    h.s.listener = fn;
    fn(h.s.items);
    return h.s.unsub;
  }),
  listDownloads: () => h.s.items,
  getSpace: vi.fn(() => Promise.resolve(h.s.space)),
  persistStorage: vi.fn(() => Promise.resolve(true)),
  purgeAll: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/data/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/data/auth')>()), isKidProfile: () => h.s.kid }));
vi.mock('../src/player/sessionLoader.js', () => ({ playBest: vi.fn(), closePlayer: vi.fn() }));

type Item = { id: string; metaId: string; title: string; state: string; bytesDone: number; bytesTotal?: number; season?: number; episode?: number; error?: { code: string }; source: { copies: never[] } };
const item = (id: string, state: string, extra: Partial<Item> = {}): Item => ({ id, metaId: id.split(':').slice(0, 2).join(':'), title: 'Titre ' + id, state, bytesDone: 620, bytesTotal: 1000, source: { copies: [] }, ...extra });

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  document.getElementById('detail')!.hidden = false;
});

beforeEach(() => {
  h.s.avail = { ok: true };
  h.s.kid = false;
  h.s.items = [];
  h.s.manager = h.mgr;
  h.s.space = { used: 1, limit: 10, ratio: 0.1, warn: false, full: false };
  h.s.listener = null;
  Object.values(h.mgr).forEach((f) => f.mockClear());
  h.s.unsub.mockClear();
  // Module neuf à chaque test : le drapeau « démarré » du module de la pastille ne fuit pas d'un test à l'autre.
  vi.resetModules();
  document.body.insertAdjacentHTML('beforeend', '<div id="probe"></div>');
});

afterEach(async () => {
  const { teardownDownloads } = await import('../src/ui/downloads.js');
  teardownDownloads();
  document.querySelectorAll('.dl-layer').forEach((l) => l.remove());
  document.getElementById('probe')?.remove();
  vi.useRealTimers();
});

const load = async () => ({
  watch: await import('../src/ui/dlBadgeWatch.js'),
  ui: await import('../src/ui/downloadBtn.js'),
  svc: await import('../src/downloads/service'),
});

/** Accueil simulé : barre du haut et onglet mobile, rendus comme le fait topnav.js / home.js. */
const renderHome = (ui: typeof import('../src/ui/downloadBtn.js')) => {
  document.getElementById('probe')!.innerHTML = '<header>' + ui.downloadsNavHTML() + '</header><nav>' + ui.downloadsTabBadgeHTML() + '</nav>';
};
const badges = () => Array.from(document.querySelectorAll<HTMLElement>('[data-dl-badge]'));
const navLink = () => document.querySelector('[data-dl-nav]') as HTMLElement;

describe('pastille à jour hors de #/downloads', () => {
  it('suit le gestionnaire après que le routeur a libéré la visite (teardownDownloads) : abonnement permanent', async () => {
    const { watch, ui } = await load();
    h.s.items = [item('movie:1', 'running')];
    renderHome(ui);
    watch.startDlBadgeWatch();
    const { teardownDownloads } = await import('../src/ui/downloads.js');
    teardownDownloads(); // ce que fait router.js à chaque changement de route
    expect(h.s.unsub).not.toHaveBeenCalled();
    h.s.listener!([item('movie:1', 'running'), item('movie:2', 'running')]);
    expect(badges().map((b) => b.textContent)).toEqual(['2', '2']);
    expect(badges().every((b) => !b.hidden)).toBe(true);
  });

  it('au démarrage, peint le compte courant ; aria-label à jour ; masquée à 0 ; 99+ au-delà de 99', async () => {
    const { watch, ui } = await load();
    renderHome(ui); // rendu sans téléchargement : pastille masquée
    expect(badges().every((b) => b.hidden)).toBe(true);
    h.s.items = [item('movie:1', 'running')];
    watch.startDlBadgeWatch(); // le gestionnaire annonce son état courant à l'abonnement
    expect(badges().every((b) => !b.hidden && b.textContent === '1')).toBe(true);
    expect(navLink().getAttribute('aria-label')).toBe('Téléchargements, 1 en cours');
    h.s.listener!([item('movie:1', 'pending'), item('movie:2', 'paused'), item('movie:3', 'done')]);
    expect(navLink().getAttribute('aria-label')).toBe('Téléchargements, 1 en cours');
    h.s.listener!(Array.from({ length: 120 }, (_, i) => item('movie:' + i, 'running')));
    expect(badges().every((b) => b.textContent === '99+')).toBe(true);
    h.s.listener!([item('movie:1', 'done')]);
    expect(badges().every((b) => b.hidden)).toBe(true);
    expect(navLink().getAttribute('aria-label')).toBe('Téléchargements');
  });

  it('compte inchangé : aucune réécriture du DOM ; compte changé : écriture (témoin)', async () => {
    const { watch, ui } = await load();
    h.s.items = [item('movie:1', 'running')];
    renderHome(ui);
    watch.startDlBadgeWatch();
    const obs = new MutationObserver(() => undefined);
    obs.observe(document.getElementById('probe')!, { subtree: true, childList: true, attributes: true, characterData: true });
    h.s.listener!([item('movie:1', 'running', { bytesDone: 900 })]); // même compte, progression différente
    expect(obs.takeRecords()).toHaveLength(0);
    h.s.listener!([item('movie:1', 'running'), item('movie:2', 'running')]); // témoin : le compte change, le DOM est écrit
    expect(obs.takeRecords().length).toBeGreaterThan(0);
    obs.disconnect();
  });

  it('profil enfant : aucun abonnement, aucune pastille peinte', async () => {
    h.s.kid = true;
    const { watch, svc } = await load();
    watch.startDlBadgeWatch();
    expect(svc.subscribeDownloads).not.toHaveBeenCalled();
    expect(h.s.listener).toBeNull();
  });

  it('téléchargements indisponibles sur la plateforme : aucun abonnement', async () => {
    h.s.avail = { ok: false, reason: 'Bientôt disponible sur Windows' };
    const { watch, svc } = await load();
    watch.startDlBadgeWatch();
    expect(svc.subscribeDownloads).not.toHaveBeenCalled();
    expect(h.s.listener).toBeNull();
  });

  it('idempotent : un seul abonnement même appelé plusieurs fois', async () => {
    const { watch, svc } = await load();
    watch.startDlBadgeWatch();
    watch.startDlBadgeWatch();
    expect(svc.subscribeDownloads).toHaveBeenCalledTimes(1);
  });
});
