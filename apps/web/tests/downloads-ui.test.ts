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
  downloadDestination: () => 'app',
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
vi.mock('../src/player/sessionLoader.js', () => ({ playBest: vi.fn(), closePlayer: vi.fn() }));

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
  h.s.space = { used: 1, limit: 10, ratio: 0.1, warn: false, full: false };
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

describe('menu « … » de la fiche : actions du téléchargement (LAST-500)', () => {
  const film = { key: 'movie:1', type: 'movie', id: 1, name: 'Film' };
  const ids = async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    return ui.ficheDownloadMenuItems(film, null, document.body).map((x: { id: string; group: string }) => x.id + '/' + x.group);
  };

  it('rien sans téléchargement', async () => {
    expect(await ids()).toEqual([]);
  });

  it('en cours : pause et annulation ; en pause : reprise ; terminé : suppression', async () => {
    h.s.items = [item('movie:1', 'running')];
    expect(await ids()).toEqual(['dl-pause/dl', 'dl-remove/dl']);
    h.s.items = [item('movie:1', 'paused')];
    expect(await ids()).toEqual(['dl-resume/dl', 'dl-remove/dl']);
    h.s.items = [item('movie:1', 'error')];
    expect(await ids()).toEqual(['dl-retry/dl', 'dl-remove/dl']);
    h.s.items = [item('movie:1', 'done')];
    const ui = await import('../src/ui/downloadBtn.js');
    expect(ui.ficheDownloadMenuItems(film, null, document.body).map((x: { label: string }) => x.label)).toEqual(['Supprimer le téléchargement']);
  });
});

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
    expect(p.textContent).toContain('En pause');
    expect(p.querySelector('.dl-sub')!.textContent).toBe('62 %');
    expect((p.querySelector('.dl-fill') as HTMLElement).style.width).toBe('62%');
    const d = await mount(item('movie:1', 'done'));
    expect(d.classList.contains('is-done')).toBe(true);
    expect(d.textContent).toContain('Téléchargé');
  });

  it('en cours : la progression remplit le bouton, mise à jour en place', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    const b = await mount(item('movie:1', 'running'));
    expect(b.textContent).toContain('Téléchargement');
    expect(b.querySelector('.dl-sub')!.textContent).toBe('62 %');
    expect((b.querySelector('.dl-fill') as HTMLElement).style.width).toBe('62%');
    ui.paintControls([item('movie:1', 'running', { bytesDone: 800 })]);
    expect(detail().querySelector('[data-dl-ctl]')).toBe(b); // même nœud
    expect((b.querySelector('.dl-fill') as HTMLElement).style.width).toBe('80%');
  });

  it('erreur : « Réessayer » et motif écrit sous le bouton', async () => {
    const b = await mount(item('movie:1', 'error', { error: { code: 'link_expired' } }));
    expect(b.textContent).toContain('Échec · Réessayer');
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
    const { playBest } = await import('../src/player/sessionLoader.js');
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

  const GB = 1024 ** 3;
  const choice = (key: string, group: string, quality: string, sizeBytes: number, extra: Record<string, unknown> = {}) => ({
    key, group, quality, sourceType: 'WEB-DL', codec: '', audio: 'AAC 5.1', langs: ['fr'], origin: 'Torrentio', sizeBytes, view: { index: Number(key) }, ...extra,
  });
  const target = { key: 'movie:1', type: 'movie', id: '1', name: 'Le Phare' };
  const openChoices = async (choices: unknown[], space: unknown = { used: 0, limit: null, ratio: 0, warn: false, full: false }) => {
    const svc = await import('../src/downloads/service');
    h.s.space = space;
    vi.mocked(svc.listSourceChoices).mockResolvedValueOnce(choices as never);
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<button id="opener">x</button>';
    const opener = document.getElementById('opener') as HTMLButtonElement;
    const done = ui.startDownload(target, opener);
    return { svc, ui, opener, done };
  };
  const escape = () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  it('feuille : la recherche est visible tout de suite, avec « Annuler », même quand la question est déjà posée', async () => {
    const svc = await import('../src/downloads/service');
    vi.mocked(svc.requestDownload).mockClear();
    let release: (v: never) => void = () => undefined;
    vi.mocked(svc.listSourceChoices).mockReturnValueOnce(new Promise((r) => { release = r as never; }));
    const { setDownloadSettings } = await import('../src/downloads/settings');
    setDownloadSettings({ asked: true });
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<button id="opener">x</button>';
    void ui.startDownload(target, document.getElementById('opener') as HTMLElement);
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    expect(sheet.querySelector('[role="status"]')!.textContent).toContain('Recherche des sources…');
    const cancel = Array.from(sheet.querySelectorAll('button')).find((b) => b.textContent === 'Annuler')!;
    cancel.click();
    expect(document.querySelector('.dl-layer')).toBeNull();
    release([] as never); // résultat tardif après annulation : rien ne se dessine
    await flush();
    expect(document.querySelector('.dl-sheet')).toBeNull();
    expect(svc.requestDownload).not.toHaveBeenCalled();
  });

  it('feuille : sources par résolution (4K, 1080p…), taille, langue, origine ; recommandée présélectionnée', async () => {
    const { done } = await openChoices([
      choice('0', '2160p', '4K', 20 * GB),
      choice('1', '1080p', '1080p', 4 * GB, { langs: ['fr'], origin: 'Lumio' }),
      choice('2', '1080p', '1080p', 3 * GB, { langs: ['multi'] }),
    ]);
    await flush();
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    expect(Array.from(sheet.querySelectorAll('.dl-sheet-h')).map((n) => n.textContent)).toEqual(['4K', '1080p']);
    const first = sheet.querySelector('[data-dl-src="0"]')!;
    expect(first.textContent).toContain('20 Go');
    expect(first.textContent).toContain('Recommandé');
    expect(first.getAttribute('aria-checked')).toBe('true');
    const second = sheet.querySelector('[data-dl-src="1"]')!;
    expect(second.textContent).toContain('Audio français');
    expect(second.textContent).toContain('via Lumio');
    expect(sheet.querySelector('[data-dl-src="2"]')!.textContent).toContain('Multi-audio');
    escape();
    await done;
    expect(document.querySelector('.dl-layer')).toBeNull();
  });

  it('feuille : une source plus grosse que l’espace libre est grisée avec le motif et jamais présélectionnée', async () => {
    const { done } = await openChoices([
      choice('0', '2160p', '4K', 20 * GB),
      choice('1', '1080p', '1080p', 4 * GB),
    ], { used: 5 * GB, limit: 10 * GB, ratio: 0.5, warn: false, full: false });
    await flush();
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    const big = sheet.querySelector('[data-dl-src="0"]') as HTMLButtonElement;
    expect(big.disabled).toBe(true);
    expect(big.textContent).toContain('Trop grand pour ton espace libre');
    expect(big.getAttribute('aria-checked')).toBe('false');
    expect(sheet.querySelector('[data-dl-src="1"]')!.getAttribute('aria-checked')).toBe('true');
    expect(sheet.textContent).toContain('Espace libre : 5 Go');
    escape();
    await done;
  });

  it('feuille : choisir une source puis « Télécharger » lance cette source, sans refaire de recherche', async () => {
    const svc = await import('../src/downloads/service');
    vi.mocked(svc.requestDownload).mockClear();
    vi.mocked(svc.listSourceChoices).mockClear();
    const { done } = await openChoices([choice('0', '1080p', '1080p', 4 * GB), choice('1', '720p', '720p', GB)]);
    await flush();
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    (sheet.querySelector('[data-dl-src="1"]') as HTMLElement).click();
    expect(sheet.querySelector('[data-dl-go-l]')!.textContent).toBe('Télécharger · 1 Go');
    (sheet.querySelector('[data-dl-go]') as HTMLElement).click();
    await done;
    expect(svc.requestDownload).toHaveBeenCalledTimes(1);
    const [, arg] = vi.mocked(svc.requestDownload).mock.calls[0] as unknown as [unknown, { source: { key: string } }];
    expect(arg.source.key).toBe('1');
    expect(svc.listSourceChoices).toHaveBeenCalledTimes(1);
  });

  it('feuille : au-delà de trois sources par résolution, « Voir N autres » déplie ; aucune source : message', async () => {
    const many = ['0', '1', '2', '3', '4'].map((k, i) => choice(k, '1080p', '1080p', (i + 1) * GB));
    const { done } = await openChoices(many);
    await flush();
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    expect(sheet.querySelectorAll('[data-dl-src]:not([hidden])')).toHaveLength(3);
    (sheet.querySelector('[data-dl-more]') as HTMLElement).click();
    expect(document.activeElement).toBe(sheet.querySelector('[data-dl-src="3"]'));
    expect(sheet.querySelectorAll('[data-dl-src]:not([hidden])')).toHaveLength(5);
    escape();
    await done;
    const second = await openChoices([]);
    await flush();
    await flush();
    expect(document.querySelector('.dl-sheet [role="alert"]')!.textContent!.length).toBeGreaterThan(5);
    escape();
    await second.done;
  });

  it('source en échec : « Choisir une autre source » liste les autres, puis remplace le téléchargement en erreur', async () => {
    const svc = await import('../src/downloads/service');
    vi.mocked(svc.requestDownload).mockClear();
    const ui = await import('../src/ui/downloadBtn.js');
    const match = { filename: 'a.mkv', size: GB };
    const failed = { ...item('movie:1', 'error', { error: { code: 'resolve_failed' } }), source: { copies: [], ref: { type: 'movie', id: '1', name: 'Le Phare', key: 'movie:1', match } } };
    h.s.space = { used: 0, limit: null, ratio: 0, warn: false, full: false };
    vi.mocked(svc.listSourceChoices).mockResolvedValueOnce([choice('1', '720p', '720p', GB)] as never);
    detail().innerHTML = '<button id="opener">x</button>';
    ui.openErrorSheet(failed, document.getElementById('opener'), () => undefined);
    (document.querySelector('[data-dl-other]') as HTMLElement).click();
    await flush();
    await flush();
    expect(svc.listSourceChoices).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'movie:1' }), { exclude: match });
    (document.querySelector('[data-dl-go]') as HTMLElement).click();
    await flush();
    await flush();
    await vi.waitFor(() => expect(h.mgr.remove).toHaveBeenCalledWith('movie:1'));
    await vi.waitFor(() => expect(svc.requestDownload).toHaveBeenCalledTimes(1));
  });

  /** Feuille progressive : `got.update` joue les réponses des addons, `finish` la fin de la recherche. */
  const openProgressive = async (pump: () => Promise<unknown> = flush, space: unknown = { used: 0, limit: null, ratio: 0, warn: false, full: false }) => {
    const svc = await import('../src/downloads/service');
    h.s.space = space;
    const got: { update?: (c: unknown[], pending: boolean) => void; signal?: AbortSignal } = {};
    let finish: (v: unknown[]) => void = () => undefined;
    vi.mocked(svc.listSourceChoices).mockImplementationOnce((_t, opts) => {
      got.update = opts?.onUpdate as never;
      got.signal = opts?.signal;
      return new Promise((r) => { finish = r as never; }) as never;
    });
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<button id="opener">x</button>';
    const done = ui.startDownload(target, document.getElementById('opener') as HTMLElement);
    await pump();
    return { got, finish: (v: unknown[]) => finish(v), done };
  };

  it('feuille progressive : la première source s’affiche avant la fin de la recherche, puis la liste se complète sur place', async () => {
    const { got, finish, done } = await openProgressive();
    const c0 = choice('0', '1080p', '1080p', 4 * GB);
    const c1 = choice('1', '720p', '720p', GB);
    const c4k = choice('2', '2160p', '4K', 20 * GB);
    got.update!([c0], true);
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    const row0 = sheet.querySelector('[data-dl-src="0"]');
    expect(row0).not.toBeNull();
    expect(sheet.querySelector('[role="status"]')!.textContent).toContain('recherche en cours');
    expect((sheet.querySelector('[data-dl-go]') as HTMLButtonElement).disabled).toBe(false);
    got.update!([c0, c1], true);
    await flush();
    expect(sheet.querySelector('[data-dl-src="0"]')).toBe(row0); // même ligne : rien n’est redessiné
    expect(sheet.querySelector('[data-dl-src="1"]')).not.toBeNull();
    got.update!([c4k, c0, c1], true);
    await flush();
    expect(Array.from(sheet.querySelectorAll('.dl-sheet-h')).map((n) => n.textContent)).toEqual(['4K', '1080p', '720p']);
    expect(sheet.querySelector('[data-dl-src="0"]')).toBe(row0);
    expect(sheet.querySelector('[data-dl-src="2"]')!.getAttribute('aria-checked')).toBe('true'); // la meilleure reste présélectionnée
    finish([c4k, c0, c1]);
    await flush();
    expect(sheet.querySelector('[role="status"]')!.textContent).toContain('à toi de choisir');
    expect((sheet.querySelector('[data-dl-slow]') as HTMLElement).hidden).toBe(true);
    escape();
    await done;
  });

  it('feuille progressive : la ligne choisie disparaît à la liste finale, la sélection repart de la recommandation', async () => {
    const { got, finish, done } = await openProgressive();
    const c0 = choice('0', '1080p', '1080p', 4 * GB);
    const c1 = choice('1', '720p', '720p', GB);
    got.update!([c0, c1], true);
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    (sheet.querySelector('[data-dl-src="1"]') as HTMLElement).click(); // choix explicite de la ligne 720p
    expect(sheet.querySelector('[data-dl-src="1"]')!.getAttribute('aria-checked')).toBe('true');
    got.update!([c0], false); // la liste finale n'a plus cette ligne
    await flush();
    expect(sheet.querySelector('[data-dl-src="1"]')).toBeNull();
    expect(sheet.querySelector('[data-dl-src="0"]')!.getAttribute('aria-checked')).toBe('true');
    expect((sheet.querySelector('[data-dl-go]') as HTMLButtonElement).disabled).toBe(false);
    finish([c0]);
    await flush();
    escape();
    await done;
  });

  it('feuille progressive : une ligne déjà affichée reprend son libellé et son état « trop grand » sur le même élément (ODY-260)', async () => {
    const { got, finish, done } = await openProgressive(flush, { used: 0, limit: 2 * GB, ratio: 0, warn: false, full: false });
    const c1 = choice('1', '720p', '720p', GB);
    got.update!([choice('0', '1080p', '1080p', 0), c1], true); // taille encore inconnue : la source 0 est présélectionnée
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    const row0 = sheet.querySelector('[data-dl-src="0"]') as HTMLButtonElement;
    expect(row0.getAttribute('aria-checked')).toBe('true');
    // Nouvelle réponse du même addon : même clé, mais libellé changé et taille (4 Go) au-dessus de l'espace libre (2 Go).
    got.update!([choice('0', '1080p', '1080p', 4 * GB, { sourceType: 'REMUX' }), c1], true);
    await flush();
    expect(sheet.querySelector('[data-dl-src="0"]')).toBe(row0); // même élément : rien n’est redessiné
    expect(row0.querySelector('.dl-opt-l')!.textContent).toContain('REMUX');
    expect(row0.classList.contains('is-off')).toBe(true);
    expect(row0.disabled).toBe(true);
    expect(row0.querySelector('.dl-opt-s')!.textContent).toContain('Trop grand');
    expect(row0.querySelector('.dl-opt-v')!.textContent).toBe('4 Go');
    expect(sheet.querySelector('[data-dl-src="1"]')!.getAttribute('aria-checked')).toBe('true'); // la recommandation passe à la source qui tient
    finish([choice('0', '1080p', '1080p', 4 * GB, { sourceType: 'REMUX' }), c1]);
    await flush();
    escape();
    await done;
  });

  it('feuille progressive : une sélection explicite disparue passe à la recommandation, et un mot discret le dit (ODY-260)', async () => {
    const { got, finish, done } = await openProgressive();
    const c0 = choice('0', '1080p', '1080p', 4 * GB);
    const c1 = choice('1', '720p', '720p', GB);
    got.update!([c0, c1], true);
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    const notice = sheet.querySelector('[data-dl-notice]') as HTMLElement;
    expect(notice.hidden).toBe(true);
    (sheet.querySelector('[data-dl-src="1"]') as HTMLElement).click(); // choix explicite de la 720p
    got.update!([c0], false); // la liste finale n'a plus la 720p
    await flush();
    expect(sheet.querySelector('[data-dl-src="0"]')!.getAttribute('aria-checked')).toBe('true');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('présélectionnée');
    (sheet.querySelector('[data-dl-src="0"]') as HTMLElement).click(); // un nouveau choix explicite efface le mot
    expect(notice.hidden).toBe(true);
    finish([c0]);
    await flush();
    escape();
    await done;
  });

  it('feuille progressive : un choix explicite devenu trop grand (taille connue après fusion) est abandonné, la recommandée reprend la main (ODY-260)', async () => {
    const { got, finish, done } = await openProgressive(flush, { used: 0, limit: 2 * GB, ratio: 0, warn: false, full: false });
    const c0 = choice('0', '1080p', '1080p', 0); // taille inconnue : recommandée présélectionnée
    got.update!([c0, choice('1', '720p', '720p', GB)], true);
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    const row1 = sheet.querySelector('[data-dl-src="1"]') as HTMLButtonElement;
    const go = sheet.querySelector('[data-dl-go]') as HTMLButtonElement;
    const notice = sheet.querySelector('[data-dl-notice]') as HTMLElement;
    row1.click(); // choix explicite de la 720p, qui tient dans l'espace libre
    row1.focus({ preventScroll: true });
    expect(row1.getAttribute('aria-checked')).toBe('true');
    // Nouvelle réponse : la 720p annonce 3 Go, au-dessus de l'espace libre (2 Go).
    got.update!([c0, choice('1', '720p', '720p', 3 * GB)], true);
    await flush();
    expect(row1.disabled).toBe(true);
    expect(row1.getAttribute('aria-checked')).toBe('false');
    expect(sheet.querySelector('[data-dl-src="0"]')!.getAttribute('aria-checked')).toBe('true');
    expect(notice.hidden).toBe(false);
    expect(go.disabled).toBe(false);
    expect(document.activeElement).toBe(go);
    finish([c0, choice('1', '720p', '720p', 3 * GB)]);
    await flush();
    escape();
    await done;
  });

  it('feuille progressive : sans source qui tienne, la ligne choisie devenue trop grande rend le focus à « Annuler » (ODY-260)', async () => {
    const { got, finish, done } = await openProgressive(flush, { used: 0, limit: 2 * GB, ratio: 0, warn: false, full: false });
    got.update!([choice('0', '1080p', '1080p', GB)], true);
    await flush();
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    const row0 = sheet.querySelector('[data-dl-src="0"]') as HTMLButtonElement;
    const go = sheet.querySelector('[data-dl-go]') as HTMLButtonElement;
    row0.click(); // choix explicite de la seule source
    row0.focus({ preventScroll: true });
    got.update!([choice('0', '1080p', '1080p', 3 * GB)], true); // elle annonce 3 Go : plus rien ne tient
    await flush();
    expect(row0.disabled).toBe(true);
    expect(row0.getAttribute('aria-checked')).toBe('false');
    expect(go.disabled).toBe(true);
    expect(document.activeElement).toBe(sheet.querySelector('[data-dl-autofocus]'));
    finish([choice('0', '1080p', '1080p', 3 * GB)]);
    await flush();
    escape();
    await done;
  });

  it('feuille progressive : fermer pendant la recherche annule le suivi ; une réponse tardive ne s’affiche pas', async () => {
    const { got, done } = await openProgressive();
    got.update!([choice('0', '1080p', '1080p', GB)], true);
    await flush();
    expect(got.signal!.aborted).toBe(false);
    escape();
    expect(got.signal!.aborted).toBe(true);
    got.update!([choice('0', '1080p', '1080p', GB), choice('1', '720p', '720p', GB)], false);
    await flush();
    expect(document.querySelector('.dl-sheet')).toBeNull();
    await done;
  });

  it('feuille progressive : après 6 s sans fin, « Certaines sources répondent lentement » ; la fin de la recherche le retire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pump = () => vi.advanceTimersByTimeAsync(0);
    const { got, finish, done } = await openProgressive(pump);
    got.update!([choice('0', '1080p', '1080p', GB)], true);
    await pump();
    const slow = document.querySelector('[data-dl-slow]') as HTMLElement;
    expect(slow.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(slow.hidden).toBe(false);
    expect(slow.textContent).toContain('répondent lentement');
    finish([choice('0', '1080p', '1080p', GB)]);
    await pump();
    expect(slow.hidden).toBe(true);
    escape();
    await done;
  });

  it('feuille progressive : la note « lentement » est dans la zone role=status (annoncée par les lecteurs d’écran)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pump = () => vi.advanceTimersByTimeAsync(0);
    const { got, finish, done } = await openProgressive(pump);
    got.update!([choice('0', '1080p', '1080p', GB)], true);
    await pump();
    await vi.advanceTimersByTimeAsync(6000);
    const sheet = document.querySelector('.dl-sheet') as HTMLElement;
    const slow = sheet.querySelector('[data-dl-slow]') as HTMLElement;
    expect(slow.hidden).toBe(false);
    expect(sheet.querySelector('[role="status"]')!.contains(slow)).toBe(true);
    finish([choice('0', '1080p', '1080p', GB)]);
    await pump();
    escape();
    await done;
  });

  it('feuille progressive : fermée avant les 6 s, le délai « lentement » ne s’affiche plus', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pump = () => vi.advanceTimersByTimeAsync(0);
    const { got, done } = await openProgressive(pump);
    got.update!([choice('0', '1080p', '1080p', GB)], true);
    await pump();
    const slow = document.querySelector('[data-dl-slow]') as HTMLElement;
    escape();
    await done;
    await vi.advanceTimersByTimeAsync(6000);
    expect(slow.hidden).toBe(true);
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
    const { playBest } = await import('../src/player/sessionLoader.js');
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

describe('retour immédiat au clic (ODY-238)', () => {
  // Les valeurs « une fois » laissées par un autre test ne doivent pas fuir ici.
  beforeEach(async () => {
    const svc = await import('../src/downloads/service');
    (await import('../src/ui/busy.js')).resetBusy(); // verrous runOnce laissés par un test précédent
    vi.mocked(svc.getSpace).mockReset().mockImplementation(() => Promise.resolve(h.s.space) as never);
    vi.mocked(svc.listSourceChoices).mockReset().mockImplementation(() => Promise.resolve([]) as never);
    vi.mocked(svc.requestDownload).mockReset().mockImplementation(() => Promise.resolve({}) as never);
    // Un « hashchange » laissé par un test précédent (lien « Gérer l’espace ») fermerait la feuille ouverte ici.
    await new Promise((r) => setTimeout(r, 20));
  });
  const movie = { key: 'movie:1', type: 'movie', id: 1, name: 'Le Phare' };
  const mount = async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = '<div class="f-actions">' + ui.ficheDownloadHTML(movie, null, '') + '</div>';
    ui.paintControls([]);
    return { ui, btn: detail().querySelector('[data-dl-ctl]') as HTMLButtonElement };
  };

  it('le bouton passe en « Recherche… » (aria-busy) synchroniquement, avant même la mesure de l’espace', async () => {
    const svc = await import('../src/downloads/service');
    let release: (v: unknown) => void = () => undefined;
    vi.mocked(svc.getSpace).mockReturnValueOnce(new Promise((r) => { release = r; }) as never);
    vi.mocked(svc.listSourceChoices).mockReturnValueOnce(new Promise(() => undefined) as never);
    const { btn } = await mount();
    btn.click();
    expect(btn.classList.contains('is-busy')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.textContent).toContain('Recherche…');
    release({ used: 0, limit: null, ratio: 0, warn: false, full: false });
    await flush();
    await flush();
    // La feuille « Recherche des sources… » a pris le relais : le bouton redevient normal derrière elle.
    expect(document.querySelector('.dl-sheet [role="status"]')!.textContent).toContain('Recherche des sources…');
    expect(btn.dataset.dlBusy).toBeUndefined();
    expect(btn.textContent).toContain('Télécharger');
  });

  it('un second clic pendant la préparation ne relance rien', async () => {
    const svc = await import('../src/downloads/service');
    vi.mocked(svc.getSpace).mockReturnValueOnce(new Promise(() => undefined) as never);
    const { btn } = await mount();
    btn.click();
    btn.click();
    await flush();
    expect(svc.getSpace).toHaveBeenCalledTimes(1);
  });

  it('un repeint pendant l’attente garde le libellé « Recherche… »', async () => {
    const svc = await import('../src/downloads/service');
    vi.mocked(svc.getSpace).mockReturnValueOnce(new Promise(() => undefined) as never);
    const { ui, btn } = await mount();
    btn.click();
    ui.paintControls([]);
    expect(btn.textContent).toContain('Recherche…');
  });

  it('confirmer une source affiche tout de suite « Téléchargement lancé » avec un lien vers la file', async () => {
    const svc = await import('../src/downloads/service');
    h.s.space = { used: 0, limit: null, ratio: 0, warn: false, full: false };
    let done: (v?: unknown) => void = () => undefined;
    vi.mocked(svc.requestDownload).mockReturnValueOnce(new Promise((r) => { done = r; }) as never);
    vi.mocked(svc.listSourceChoices).mockResolvedValueOnce([
      { key: '0', group: '1080p', quality: '1080p', sourceType: 'WEB-DL', codec: '', audio: 'AAC', langs: ['fr'], origin: 'X', sizeBytes: 1000, view: { index: 0 } },
    ] as never);
    const { btn } = await mount();
    btn.click();
    await flush();
    await flush();
    (document.querySelector('[data-dl-go]') as HTMLButtonElement).click();
    await flush();
    const toastEl = document.getElementById('toast')!;
    expect(toastEl.classList.contains('is-on')).toBe(true);
    expect(toastEl.textContent).toContain('Téléchargement lancé · Le Phare');
    expect(toastEl.querySelector('.toast-action')!.textContent).toBe('Voir');
    done();
    await flush();
    expect(btn.dataset.dlBusy).toBeUndefined();
  });
});
