// Interface des téléchargements (ODY-204) : bouton de la fiche (chaque état), pastille d'épisode, écran #/downloads
// (liste, vide, erreur, hors ligne, indisponible), gestes branchés sur le service, abonnement libéré. Service mocké.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const mgr = { pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), remove: vi.fn(() => Promise.resolve()), pauseAll: vi.fn(), resumeAll: vi.fn(), list: vi.fn(() => []) };
  const s = {
    avail: { ok: true } as { ok: boolean; reason?: string },
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
  previewChoices: vi.fn(() => Promise.resolve([])),
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
vi.mock('../src/player/session.js', () => ({ playBest: vi.fn(), closePlayer: vi.fn() }));

type Item = { id: string; metaId: string; title: string; state: string; bytesDone: number; bytesTotal?: number; season?: number; episode?: number; error?: { code: string }; source: { copies: never[] } };
const item = (id: string, state: string, extra: Partial<Item> = {}): Item => ({ id, metaId: id.split(':').slice(0, 2).join(':'), title: 'Titre ' + id, state, bytesDone: 620, bytesTotal: 1000, source: { copies: [] }, ...extra });

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  document.getElementById('detail')!.hidden = false; // jsdom ne donne pas le focus à un élément d'un conteneur masqué
});

beforeEach(() => {
  h.s.avail = { ok: true };
  h.s.items = [];
  h.s.manager = h.mgr;
  h.s.listener = null;
  Object.values(h.mgr).forEach((f) => f.mockClear());
  h.s.unsub.mockClear();
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});

afterEach(async () => {
  const { teardownDownloads } = await import('../src/ui/downloads.js');
  teardownDownloads();
  document.querySelectorAll('.dl-layer').forEach((l) => l.remove());
  vi.useRealTimers();
});

const detail = () => document.getElementById('detail')!;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('bouton large de la fiche', () => {
  const movie = { key: 'movie:1', type: 'movie', id: 1, name: 'Le Phare' };
  const mount = async (it?: Item, off = '') => {
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<div class="f-actions">' + ui.ficheDownloadHTML(movie, null, off) + '</div>';
    h.s.items = it ? [it] : [];
    ui.paintControls(h.s.items);
    return detail().querySelector('[data-dl-ctl]') as HTMLButtonElement;
  };

  it('disponible : « Télécharger », sans raison', async () => {
    const b = await mount();
    expect(b.classList.contains('is-available')).toBe(true);
    expect(b.textContent).toContain('Télécharger');
    expect((detail().querySelector('.dl-why') as HTMLElement).hidden).toBe(true);
  });

  it('en attente, en pause, terminé', async () => {
    expect((await mount(item('movie:1', 'pending'))).textContent).toContain('En attente');
    const p = await mount(item('movie:1', 'paused'));
    expect(p.textContent).toContain('Reprendre · 62 %');
    expect((p.querySelector('.dl-fill') as HTMLElement).style.width).toBe('62%');
    const d = await mount(item('movie:1', 'done'));
    expect(d.classList.contains('is-done')).toBe(true);
    expect(d.textContent).toContain('Téléchargé');
  });

  it('en cours : la progression remplit le bouton, mise à jour en place', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    const b = await mount(item('movie:1', 'running'));
    expect(b.textContent).toContain('62 % · Pause');
    expect((b.querySelector('.dl-fill') as HTMLElement).style.width).toBe('62%');
    ui.paintControls([item('movie:1', 'running', { bytesDone: 800 })]);
    expect(detail().querySelector('[data-dl-ctl]')).toBe(b); // même nœud
    expect((b.querySelector('.dl-fill') as HTMLElement).style.width).toBe('80%');
  });

  it('erreur : « Réessayer » et motif écrit sous le bouton', async () => {
    const b = await mount(item('movie:1', 'error', { error: { code: 'link_expired' } }));
    expect(b.textContent).toContain('Réessayer');
    const why = detail().querySelector('.dl-why') as HTMLElement;
    expect(why.hidden).toBe(false);
    expect(why.textContent).toMatch(/lien a expiré/);
    expect(why.textContent).not.toMatch(/http/);
  });

  it('indisponible : raison de la plateforme, ou du titre (pas encore sorti)', async () => {
    h.s.avail = { ok: false, reason: 'Bientôt disponible sur Windows' };
    const b = await mount();
    expect(b.classList.contains('is-unavailable')).toBe(true);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(detail().querySelector('.dl-why')!.textContent).toBe('Bientôt disponible sur Windows');
    h.s.avail = { ok: true };
    const u = await mount(undefined, 'Pas encore sorti');
    expect(u.classList.contains('is-unavailable')).toBe(true);
    expect(detail().querySelector('.dl-why')!.textContent).toBe('Pas encore sorti');
  });

  it('un clic sur un téléchargement en cours le met en pause', async () => {
    const b = await mount(item('movie:1', 'running'));
    b.click();
    await flush();
    expect(h.mgr.pause).toHaveBeenCalledWith('movie:1');
  });
});

describe('pastille ronde d’un épisode', () => {
  const show = { key: 'tv:9', type: 'tv', id: 9, name: 'Nuits' };
  it('anneau de progression, et le clic ne remonte pas jusqu’à la lecture (data-play)', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<ol><li class="ep" data-ep="2:3"><button class="ep-main" data-play>Lire</button>' + ui.episodeDownloadHTML(show, 2, 3, 'La clé') + '</li></ol>';
    h.s.items = [item('tv:9:2:3', 'running', { season: 2, episode: 3 })];
    ui.paintControls(h.s.items);
    const pill = detail().querySelector('.dl-ep') as HTMLButtonElement;
    expect(pill.closest('.ep-main')).toBeNull();
    expect(pill.getAttribute('aria-label')).toBe('En cours, 62 %, mettre en pause : S2 É3 La clé');
    const off = Number(pill.querySelector('.dl-ring-p')!.getAttribute('stroke-dashoffset'));
    expect(off).toBeCloseTo(ui.RING * 0.38, 1);
    const onDoc = vi.fn();
    document.addEventListener('click', onDoc);
    pill.click();
    document.removeEventListener('click', onDoc);
    await flush();
    expect(onDoc).not.toHaveBeenCalled();
    expect(h.mgr.pause).toHaveBeenCalledWith('tv:9:2:3');
  });

  it('épisode terminé : feuille « Lire hors ligne » / « Supprimer »', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<ol><li class="ep">' + ui.episodeDownloadHTML(show, 1, 1, '') + '</li></ol>';
    h.s.items = [item('tv:9:1:1', 'done', { season: 1, episode: 1 })];
    ui.paintControls(h.s.items);
    const pill = detail().querySelector('.dl-ep') as HTMLButtonElement;
    pill.click();
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.textContent).toContain('Lire hors ligne');
    const { playBest } = await import('../src/player/session.js');
    (sheet.querySelector('[data-dl-play]') as HTMLButtonElement).click();
    expect(playBest).toHaveBeenCalledWith(expect.objectContaining({ type: 'tv', id: '9', season: 1, episode: 1, key: 'tv:9' }), pill);
    expect(document.querySelector('.dl-layer')).toBeNull();
  });

  it('Échap ferme la feuille et rend le focus au bouton', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<button id="opener">x</button>';
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
    ui.openSheet({ title: 'Test', opener, render: (b: HTMLElement) => { b.innerHTML = '<button>Un</button>'; } });
    expect(document.activeElement!.textContent).toBe('Un');
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.dl-layer')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('feuille de choix : groupe 2160p affiché « 4K », langues en français, « multi » lisible', async () => {
    const svc = await import('../src/downloads/service');
    vi.mocked(svc.previewChoices).mockResolvedValueOnce([
      { quality: '2160p', langs: ['fr', 'multi'], sizeBytes: 2 * 1024 ** 3 },
      { quality: '1080p', langs: ['fr'], sizeBytes: 1024 ** 3 },
    ] as never);
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<button id="opener">x</button>';
    const opener = document.getElementById('opener') as HTMLButtonElement;
    void ui.startDownload({ key: 'movie:1', type: 'movie', id: '1', name: 'Le Phare' }, opener);
    await flush();
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    expect(sheet.querySelector('[data-dl-q="2160p"] .dl-opt-l')!.textContent).toBe('4K');
    expect(sheet.querySelector('[data-dl-q="1080p"] .dl-opt-l')!.textContent).toBe('1080p');
    const langs = Array.from(sheet.querySelectorAll('[data-dl-l] .dl-opt-l')).map((n) => n.textContent);
    expect(langs).toEqual(['Audio français', 'Multi-audio']);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.dl-layer')).toBeNull();
  });
});

describe('écran #/downloads', () => {
  const open = async () => {
    const { showDownloads } = await import('../src/ui/downloads.js');
    await showDownloads();
    await flush();
  };

  it('liste : sections, barre role=progressbar avec aria-valuenow/min/max, mise à jour en place', async () => {
    h.s.items = [item('movie:1', 'running'), item('movie:2', 'done'), item('tv:3:1:2', 'pending', { season: 1, episode: 2 })];
    await open();
    expect(detail().querySelectorAll('[data-dl-row]')).toHaveLength(3);
    expect(detail().textContent).toContain('En cours');
    expect(detail().textContent).toContain('Terminés');
    const bar = detail().querySelector('[data-dl-row="movie:1"] [role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('62');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    const row = detail().querySelector('[data-dl-row="movie:1"]');
    h.s.listener!([item('movie:1', 'running', { bytesDone: 900 }), item('movie:2', 'done'), item('tv:3:1:2', 'pending', { season: 1, episode: 2 })]);
    expect(detail().querySelector('[data-dl-row="movie:1"]')).toBe(row); // pas de redessin
    expect(bar.getAttribute('aria-valuenow')).toBe('90');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('90%');
    const space = detail().querySelector('[data-dl-space-bar]') as HTMLElement;
    expect(space.getAttribute('role')).toBe('progressbar');
    expect(space.getAttribute('aria-valuenow')).toBe('10');
  });

  it('pause, reprise, réessayer et lecture appellent le service', async () => {
    h.s.items = [item('movie:1', 'running'), item('movie:2', 'paused'), item('movie:3', 'error', { error: { code: 'network' } }), item('movie:4', 'done')];
    await open();
    (detail().querySelector('[data-dl-row="movie:1"] [data-dl-act="pause"]') as HTMLElement).click();
    (detail().querySelector('[data-dl-row="movie:2"] [data-dl-act="resume"]') as HTMLElement).click();
    (detail().querySelector('[data-dl-act="retry-all"]') as HTMLElement).click();
    await flush();
    expect(h.mgr.pause).toHaveBeenCalledWith('movie:1');
    expect(h.mgr.resume).toHaveBeenCalledWith('movie:2');
    expect(h.mgr.retry).toHaveBeenCalledWith('movie:3');
    expect(detail().textContent).toContain('1 téléchargement a échoué');
    const { playBest } = await import('../src/player/session.js');
    (detail().querySelector('[data-dl-row="movie:4"] [data-dl-act="play"]') as HTMLElement).click();
    expect(playBest).toHaveBeenCalledWith(expect.objectContaining({ type: 'movie', id: '4', key: 'movie:4' }), expect.anything());
  });

  it('suppression confirmée, effective après 6 s ; « Annuler » la rétablit', async () => {
    h.s.items = [item('movie:1', 'done'), item('movie:2', 'done')];
    await open();
    vi.useFakeTimers();
    (detail().querySelector('[data-dl-row="movie:1"] [data-dl-act="more"]') as HTMLElement).click();
    (document.querySelector('[data-dl-del]') as HTMLElement).click();
    expect(document.querySelector('.dl-sheet')!.textContent).toContain('Supprimer « Titre movie:1 » ?');
    (document.querySelector('[data-dl-yes]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.mgr.remove).not.toHaveBeenCalled(); // jamais en un geste
    expect(detail().querySelector('[data-dl-row="movie:1"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.mgr.remove).toHaveBeenCalledWith('movie:1');

    (detail().querySelector('[data-dl-row="movie:2"] [data-dl-act="more"]') as HTMLElement).click();
    (document.querySelector('[data-dl-del]') as HTMLElement).click();
    (document.querySelector('[data-dl-yes]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    (document.querySelector('#toast .toast-action') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.mgr.remove).not.toHaveBeenCalledWith('movie:2');
    expect(detail().querySelector('[data-dl-row="movie:2"]')).not.toBeNull();
  });

  it('vide : « Rien de téléchargé »', async () => {
    await open();
    expect(detail().textContent).toContain('Rien de téléchargé');
    expect(detail().querySelector('a[href="#/"]')).not.toBeNull();
  });

  it('erreur : le gestionnaire ne se charge pas', async () => {
    h.s.manager = null;
    await open();
    expect(detail().querySelector('[role="alert"]')!.textContent).toContain('n’ont pas pu être chargés');
    expect(detail().querySelector('[data-dl-act="reload"]')).not.toBeNull();
  });

  it('indisponible : raison affichée, pas d’abonnement', async () => {
    h.s.avail = { ok: false, reason: 'Bientôt disponible sur Windows' };
    await open();
    expect(detail().textContent).toContain('Bientôt disponible sur Windows');
    expect(h.s.listener).toBeNull();
  });

  it('hors ligne : bandeau, titres non téléchargés grisés ; retour en ligne', async () => {
    h.s.items = [item('movie:1', 'paused'), item('movie:2', 'done')];
    await open();
    expect(detail().querySelector('[data-dl-offline]')).toBeNull();
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
    expect(detail().querySelector('[data-dl-offline]')!.textContent).toContain('Hors connexion');
    expect(detail().querySelector('[data-dl-row="movie:1"]')!.classList.contains('is-na')).toBe(true);
    expect(detail().querySelector('[data-dl-row="movie:2"]')!.classList.contains('is-na')).toBe(false);
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
    expect(detail().querySelector('[data-dl-offline]')).toBeNull();
  });

  it('teardownDownloads libère l’abonnement et les écouteurs réseau', async () => {
    h.s.items = [item('movie:1', 'running')];
    await open();
    const { teardownDownloads } = await import('../src/ui/downloads.js');
    teardownDownloads();
    expect(h.s.unsub).toHaveBeenCalled();
    const html = detail().innerHTML;
    window.dispatchEvent(new Event('offline'));
    expect(detail().innerHTML).toBe(html);
  });
});

describe('route', () => {
  it('#/downloads est une route (profil adulte)', async () => {
    const { parseRoute } = await import('../src/ui/router.js');
    location.hash = '#/downloads';
    expect(parseRoute()).toEqual({ kind: 'downloads' });
    location.hash = '';
  });
});
