// « Télécharger la saison » (ODY-234) : bouton de l'en-tête des épisodes, feuille unique avec taille estimée et une seule
// confirmation. Service mocké (planSeasonDownload / requestSeasonDownload).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const s = {
    avail: { ok: true } as { ok: boolean; reason?: string },
    kid: false,
    items: [] as unknown[],
    plan: null as unknown,
    planGate: null as null | Promise<void>,
    space: { used: 1, limit: 10, ratio: 0.1, warn: false, full: false } as unknown,
    requestError: null as null | { code: string },
  };
  return { s };
});

vi.mock('../src/data/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/data/auth')>()), isKidProfile: () => h.s.kid }));
vi.mock('../src/downloads/service', () => ({
  platformAvailability: () => h.s.avail,
  getDownloads: vi.fn(() => Promise.resolve({ list: () => [] })),
  downloadIdFor: (t: { key: string; season?: number; episode?: number }) => (t.season !== undefined && t.episode !== undefined ? `${t.key}:${t.season}:${t.episode}` : t.key),
  listSourceChoices: vi.fn(() => Promise.resolve([])),
  recommendedChoice: () => null,
  requestDownload: vi.fn(() => Promise.resolve({})),
  planSeasonDownload: vi.fn(async (_targets: unknown, opts?: { onProgress?(d: number, t: number): void }) => {
    opts?.onProgress?.(1, 2);
    if (h.s.planGate) await h.s.planGate;
    return h.s.plan;
  }),
  requestSeasonDownload: vi.fn(async () => {
    if (h.s.requestError) throw Object.assign(new Error('x'), h.s.requestError);
    return [];
  }),
  subscribeDownloads: vi.fn((fn: (items: unknown[]) => void) => {
    fn(h.s.items);
    return () => undefined;
  }),
  listDownloads: () => h.s.items,
  getSpace: vi.fn(() => Promise.resolve(h.s.space)),
}));
vi.mock('../src/player/session.js', () => ({ playBest: vi.fn(), closePlayer: vi.fn() }));

const GO = 1024 ** 3;
const show = { key: 'tv:9', type: 'tv', id: 9, name: 'Nuits' };
const eps = [1, 2, 3].map((n) => ({ episode_number: n, air_date: '2020-01-0' + n }));
const entry = (e: number) => ({ target: { key: 'tv:9', type: 'tv', id: '9', name: 'Nuits', season: 2, episode: e }, choice: {} });
const plan = (over: Record<string, unknown> = {}) => ({ entries: [entry(1), entry(2), entry(3)], unavailable: [], totalBytes: 6 * GO, unknownCount: 0, ...over });

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  document.getElementById('detail')!.hidden = false;
});

beforeEach(() => {
  h.s.avail = { ok: true };
  h.s.kid = false;
  h.s.items = [];
  h.s.plan = plan();
  h.s.planGate = null;
  h.s.requestError = null;
  h.s.space = { used: 1, limit: 10, ratio: 0.1, warn: false, full: false };
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});

afterEach(async () => {
  const svc = await import('../src/downloads/service');
  vi.mocked(svc.planSeasonDownload).mockClear();
  vi.mocked(svc.requestSeasonDownload).mockClear();
  document.querySelectorAll('.dl-layer').forEach((l) => l.remove());
});

const detail = () => document.getElementById('detail')!;
const flush = () => new Promise((r) => setTimeout(r, 0));
const sheetText = () => document.querySelector('.dl-sheet')?.textContent ?? '';

/** Monte l'en-tête d'une saison de 3 épisodes diffusés et ouvre la feuille d'un clic. */
async function mountSeason(extraEps: Array<{ episode_number: number; air_date?: string }> = []) {
  const ui = await import('../src/ui/downloadBtn.js');
  detail().innerHTML = '<div class="f-eps-head">' + ui.seasonDownloadHTML() + '</div>';
  const all = [...eps, ...extraEps];
  ui.setSeasonDownload(ui.airedSeasonTargets(show, 2, all, '2024-06-01'));
  return { ui, btn: detail().querySelector('[data-dl-season]') as HTMLButtonElement | null };
}

describe('bouton « Télécharger la saison »', () => {
  it('visible, avec une cible par épisode diffusé : les épisodes futurs sont exclus', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    const targets = ui.airedSeasonTargets(show, 2, [...eps, { episode_number: 4, air_date: '2099-01-01' }, { episode_number: 5 }], '2024-06-01');
    expect(targets.map((t: { episode: number }) => t.episode)).toEqual([1, 2, 3, 5]); // sans date : traité comme diffusé
    expect(targets.every((t: { season: number; key: string }) => t.season === 2 && t.key === 'tv:9')).toBe(true);
    const { btn } = await mountSeason([{ episode_number: 4, air_date: '2099-01-01' }]);
    expect(btn).not.toBeNull();
    expect(btn!.hidden).toBe(false);
    expect(btn!.textContent).toContain('Télécharger la saison');
    expect(btn!.disabled).toBe(false);
  });

  it('absent sur un profil enfant et quand la plateforme est indisponible', async () => {
    h.s.kid = true;
    expect((await mountSeason()).btn).toBeNull();
    h.s.kid = false;
    h.s.avail = { ok: false, reason: 'Bientôt disponible sur Windows' };
    expect((await mountSeason()).btn).toBeNull();
  });

  it('masqué quand la saison n’a aucun épisode diffusé', async () => {
    const ui = await import('../src/ui/downloadBtn.js');
    detail().innerHTML = ui.seasonDownloadHTML();
    ui.setSeasonDownload(ui.airedSeasonTargets(show, 2, [{ episode_number: 1, air_date: '2099-01-01' }], '2024-06-01'));
    expect((detail().querySelector('[data-dl-season]') as HTMLElement).hidden).toBe(true);
  });

  it('saison déjà téléchargée ou en file : bouton désactivé, sans ouvrir de feuille', async () => {
    h.s.items = [1, 2, 3].map((n) => ({ id: `tv:9:2:${n}`, metaId: 'tv:9', title: 'Nuits', state: n === 3 ? 'pending' : 'done', bytesDone: 0, source: { copies: [] } }));
    const { btn } = await mountSeason();
    expect(btn!.disabled).toBe(true);
    expect(btn!.textContent).toContain('Saison en file'); // un épisode encore en file : pas « téléchargée »
    btn!.click();
    await flush();
    expect(document.querySelector('.dl-layer')).toBeNull();
  });

  it('un seul épisode manquant : le bouton reste actif', async () => {
    h.s.items = [1, 2].map((n) => ({ id: `tv:9:2:${n}`, metaId: 'tv:9', title: 'Nuits', state: 'done', bytesDone: 0, source: { copies: [] } }));
    const { btn } = await mountSeason();
    expect(btn!.disabled).toBe(false);
    expect(btn!.textContent).toContain('Télécharger la saison');
  });
});

describe('états du bouton selon la liste', () => {
  const mk = (states: string[]) => states.map((st, i) => ({ id: `tv:9:2:${i + 1}`, metaId: 'tv:9', title: 'Nuits', state: st, bytesDone: 0, source: { copies: [] } }));

  it('tous terminés : « Saison téléchargée »', async () => {
    h.s.items = mk(['done', 'done', 'done']);
    const { btn } = await mountSeason();
    expect(btn!.disabled).toBe(true);
    expect(btn!.textContent).toContain('Saison téléchargée');
  });

  it('certains en file ou en cours : « Saison en file », désactivé', async () => {
    h.s.items = mk(['done', 'running', 'pending']);
    const { btn } = await mountSeason();
    expect(btn!.disabled).toBe(true);
    expect(btn!.textContent).toContain('Saison en file');
    expect(btn!.textContent).not.toContain('Saison téléchargée');
  });

  it('un épisode en erreur : bouton actif normal', async () => {
    h.s.items = mk(['done', 'error', 'done']);
    const { btn } = await mountSeason();
    expect(btn!.disabled).toBe(false);
    expect(btn!.textContent).toContain('Télécharger la saison');
  });
});

describe('feuille de confirmation', () => {
  const open = async () => {
    const { btn } = await mountSeason();
    btn!.click();
    await flush();
    await flush();
  };

  it('une seule feuille : « 3 épisodes · ~6 Go » ; confirmer appelle requestSeasonDownload une fois, avec le plan', async () => {
    const svc = await import('../src/downloads/service');
    await open();
    expect(document.querySelectorAll('.dl-sheet')).toHaveLength(1);
    expect(sheetText()).toContain('3 épisodes · ~6 Go');
    expect(vi.mocked(svc.planSeasonDownload)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(svc.requestSeasonDownload)).not.toHaveBeenCalled();
    const go = document.querySelector('[data-dl-go]') as HTMLButtonElement;
    expect(go.textContent).toContain('Télécharger · 6 Go');
    go.click();
    go.click(); // double clic : toujours une seule mise en file
    await flush();
    expect(vi.mocked(svc.requestSeasonDownload)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(svc.requestSeasonDownload)).toHaveBeenCalledWith(h.s.plan);
    expect(document.querySelector('.dl-layer')).toBeNull();
  });

  it('Annuler : rien n’est mis en file', async () => {
    const svc = await import('../src/downloads/service');
    await open();
    (document.querySelector('.dl-sheet-acts [data-dl-close]') as HTMLButtonElement).click();
    await flush();
    expect(vi.mocked(svc.requestSeasonDownload)).not.toHaveBeenCalled();
    expect(document.querySelector('.dl-layer')).toBeNull();
  });

  it('taille partielle : « au moins X Go » ; épisodes indisponibles signalés', async () => {
    h.s.plan = plan({ unknownCount: 1, unavailable: [entry(4).target, entry(5).target], entries: [entry(1), entry(2), entry(3)] });
    await open();
    expect(sheetText()).toContain('3 épisodes · au moins 6 Go');
    expect(sheetText()).toContain('2 épisodes indisponibles');
  });

  it('aucune source ou taille nulle : message, pas de bouton de confirmation, rien en file', async () => {
    const svc = await import('../src/downloads/service');
    h.s.plan = plan({ entries: [], totalBytes: 0, unavailable: [entry(1).target] });
    await open();
    expect(sheetText()).toContain('Aucune source');
    expect(document.querySelector('[data-dl-go]')).toBeNull();
    document.querySelectorAll('.dl-layer').forEach((l) => l.remove());
    h.s.plan = plan({ totalBytes: 0, unknownCount: 3 });
    await open();
    expect(document.querySelector('[data-dl-go]')).toBeNull();
    expect(vi.mocked(svc.requestSeasonDownload)).not.toHaveBeenCalled();
  });

  it('fermer pendant la préparation : abandon silencieux, aucune mise en file', async () => {
    const svc = await import('../src/downloads/service');
    let release!: () => void;
    h.s.planGate = new Promise<void>((r) => { release = r; });
    const { btn } = await mountSeason();
    btn!.click();
    await flush();
    expect(sheetText()).toContain('Recherche des sources… 1 / 2');
    expect(document.querySelector('[role=progressbar]')).not.toBeNull();
    (document.querySelector('.dl-sheet-acts [data-dl-close]') as HTMLButtonElement).click();
    release();
    await flush();
    await flush();
    expect(document.querySelector('.dl-layer')).toBeNull();
    expect(vi.mocked(svc.requestSeasonDownload)).not.toHaveBeenCalled();
  });

  it('double clic sur « Télécharger la saison » : un seul plan', async () => {
    const svc = await import('../src/downloads/service');
    h.s.planGate = new Promise<void>(() => undefined);
    const { btn } = await mountSeason();
    btn!.click();
    btn!.click();
    await flush();
    expect(vi.mocked(svc.planSeasonDownload)).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.dl-sheet')).toHaveLength(1);
  });

  it('progression : Annuler garde le même nœud, texte et barre mis à jour en place', async () => {
    const svc = await import('../src/downloads/service');
    h.s.planGate = new Promise<void>(() => undefined);
    const { btn } = await mountSeason();
    btn!.click();
    await flush();
    const cancel = document.querySelector('.dl-sheet-acts [data-dl-close]');
    expect(cancel).not.toBeNull();
    const opts = vi.mocked(svc.planSeasonDownload).mock.calls[0][1] as { onProgress(d: number, t: number): void };
    opts.onProgress(2, 2);
    expect(document.querySelector('.dl-sheet-acts [data-dl-close]')).toBe(cancel);
    expect(document.querySelector('.dl-sheet-load')?.textContent).toContain('2 / 2');
    const bar = document.querySelector('[role=progressbar]') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('fermer la feuille pendant la préparation : le signal est annulé', async () => {
    const svc = await import('../src/downloads/service');
    h.s.planGate = new Promise<void>(() => undefined);
    const { btn } = await mountSeason();
    btn!.click();
    await flush();
    const opts = vi.mocked(svc.planSeasonDownload).mock.calls[0][1] as { signal: AbortSignal };
    expect(opts.signal.aborted).toBe(false);
    (document.querySelector('.dl-sheet-acts [data-dl-close]') as HTMLButtonElement).click();
    await flush();
    expect(opts.signal.aborted).toBe(true);
  });

  it('plafond : « N épisodes au-delà de la limite de 50 », distinct des indisponibles', async () => {
    h.s.plan = plan({ unavailable: [entry(4).target, entry(5).target, entry(6).target], capped: 2 });
    await open();
    expect(sheetText()).toContain('1 épisode indisponible (aucune source)');
    expect(sheetText()).toContain('2 épisodes au-delà de la limite de 50');
  });

  it('plan caduc (mise en file vide) : toast « Opération annulée, réessaie »', async () => {
    await open();
    (document.querySelector('[data-dl-go]') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(document.body.textContent).toContain('Opération annulée, réessaie');
  });

  it('quota dépassé : feuille « Espace plein »', async () => {
    h.s.requestError = { code: 'quota_exceeded' };
    await open();
    (document.querySelector('[data-dl-go]') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(sheetText()).toContain('Espace plein');
  });

  it('espace déjà plein : « Espace plein » sans préparer la saison', async () => {
    const svc = await import('../src/downloads/service');
    h.s.space = { used: 10, limit: 10, ratio: 1, warn: true, full: true };
    await open();
    expect(sheetText()).toContain('Espace plein');
    expect(vi.mocked(svc.planSeasonDownload)).not.toHaveBeenCalled();
  });
});
