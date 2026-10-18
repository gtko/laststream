// Accueil à chaud : « Reprendre la lecture » et « Ma bibliothèque » se redessinent sans rechargement quand les données
// changent (progression, fin de lecture, vu, masqué, bibliothèque, synchro distante). Jsdom, aucun réseau réel.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const player = vi.hoisted(() => ({ open: false }));
vi.mock('hls.js', () => ({ default: class { static isSupported = () => false; } }));
vi.mock('../src/player/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/player/session.js')>()),
  isPlayerOpen: () => player.open,
}));

const T0 = Date.parse('2026-10-19T10:00:00Z');
const BASE = 'http://localhost:7000';

let userStore: typeof import('../src/data/userStore').userStore;
let events: typeof import('../src/data/events');
let state: typeof import('../src/ui/state.js').state;
let home: typeof import('../src/ui/home.js');
let hideTitle: typeof import('../src/data/homeFilters').hideTitle;
let resetFiltersCache: typeof import('../src/data/homeFilters').resetFiltersCache;
let clock = T0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not_found' }, 404)));
  ({ userStore } = await import('../src/data/userStore'));
  events = await import('../src/data/events');
  ({ state } = await import('../src/ui/state.js'));
  home = await import('../src/ui/home.js');
  ({ hideTitle, resetFiltersCache } = await import('../src/data/homeFilters'));
});

beforeEach(() => {
  localStorage.clear();
  resetFiltersCache();
  clock = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  player.open = false;
  state.inDetail = false;
  state.status = 'ready';
  const app = document.getElementById('app')!;
  app.hidden = false;
  app.innerHTML = '<div id="cont-slot"></div><div id="lib-slot"></div>';
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Écrit une progression comme le lecteur le fait (horodatée à `clock`). */
function save(key: string, position: number, duration: number, ep?: { season: number; episode: number }) {
  const [type, id] = key.split(':');
  userStore.setProgress({ key, type: type as 'movie' | 'tv', id: Number(id), title: 'Titre ' + id, poster: '/p.jpg', backdrop: '/b.jpg', position, duration, ...ep });
}
const card = (key: string) => document.querySelector<HTMLElement>('#cont-slot .cont-card[data-resume="' + key + '"]');
const order = () => Array.from(document.querySelectorAll<HTMLElement>('#cont-slot .cont-card')).map((c) => c.dataset.resume);
const left = (key: string) => card(key)!.querySelector('.cont-left')!.textContent ?? '';

describe('accueil à chaud : Reprendre la lecture', () => {
  it('progression écrite : la carte se met à jour, les autres ne sont pas refaites, récent d’abord', () => {
    clock = T0 + 1000; save('movie:550', 600, 6000);
    clock = T0 + 2000; save('movie:551', 1200, 6000);
    home.renderContinue();
    expect(order()).toEqual(['movie:551', 'movie:550']);
    expect(left('movie:551')).toContain('20:00 · 20 %');
    const untouched = card('movie:551');

    clock = T0 + 3000; save('movie:550', 3000, 6000); // lecture de 550 : 50 %, elle passe en tête
    expect(order()).toEqual(['movie:550', 'movie:551']);
    expect(left('movie:550')).toContain('50:00 · 50 %');
    expect(card('movie:550')!.querySelector<HTMLElement>('.progress span')!.getAttribute('style')).toContain('50%');
    expect(card('movie:551')).toBe(untouched); // carte inchangée : même élément, pas de rechargement
  });

  it('fin de lecture : un film terminé sort de la rangée, un épisode terminé propose le suivant', () => {
    clock = T0 + 1000; save('movie:552', 3000, 6000);
    clock = T0 + 2000; save('tv:1399', 1200, 2400, { season: 1, episode: 3 });
    home.renderContinue();
    expect(card('movie:552')).not.toBeNull();
    expect(card('tv:1399')!.querySelector('.cont-code')!.textContent).toBe('S1 · É3');

    clock = T0 + 3000; save('movie:552', 5900, 6000); // 98 % : vu
    expect(card('movie:552')).toBeNull();

    clock = T0 + 4000; save('tv:1399', 2390, 2400, { season: 1, episode: 3 }); // épisode fini
    expect(card('tv:1399')!.dataset.next).toBe('after');
    expect(card('tv:1399')!.querySelector('.cont-code')!.textContent).toMatch(/^À suivre : S1 · É3/);
  });

  it('marquer vu : le titre sort de la rangée, et y revient s’il est marqué non vu', async () => {
    clock = T0 + 1000; save('movie:551', 1200, 6000);
    home.renderContinue();
    expect(card('movie:551')).not.toBeNull();

    await userStore.setWatched('movie:551', null, true);
    expect(card('movie:551')).toBeNull();

    await userStore.setWatched('movie:551', null, false);
    expect(card('movie:551')).not.toBeNull();
  });

  it('ne plus proposer : le titre masqué sort de la rangée sans rechargement', () => {
    clock = T0 + 1000; save('movie:553', 1200, 6000);
    home.renderContinue();
    expect(card('movie:553')).not.toBeNull();
    expect(hideTitle({ key: 'movie:553', title: 'Titre 553', poster: '/p.jpg' })).toBe(true);
    expect(card('movie:553')).toBeNull();
  });

  it('lecteur ouvert : pas de redessin pendant la lecture, mise à jour à la fermeture', () => {
    clock = T0 + 1000; save('movie:551', 1200, 6000);
    home.renderContinue();
    expect(left('movie:551')).toContain('20:00 · 20 %');

    player.open = true;
    clock = T0 + 2000; save('movie:551', 3000, 6000); // sauvegarde périodique pendant la lecture
    expect(left('movie:551')).toContain('20:00 · 20 %');

    player.open = false;
    events.emitDataEvent({ kind: 'player' }); // le lecteur se ferme
    expect(left('movie:551')).toContain('50:00 · 50 %');
  });

  it('focus et position horizontale conservés quand la rangée se réordonne', () => {
    clock = T0 + 1000; save('movie:550', 600, 6000);
    clock = T0 + 2000; save('movie:551', 1200, 6000);
    home.renderContinue();
    const rowEl = document.querySelector<HTMLElement>('#cont-slot .row')!;
    rowEl.scrollLeft = 120;
    card('movie:551')!.focus();
    expect(document.activeElement).toBe(card('movie:551'));

    clock = T0 + 3000; save('movie:550', 3000, 6000); // 550 passe devant 551
    expect(order()).toEqual(['movie:550', 'movie:551']);
    expect(document.activeElement).toBe(card('movie:551'));
    expect(document.querySelector<HTMLElement>('#cont-slot .row')!.scrollLeft).toBe(120);
  });

  it('synchro distante : une progression venue d’un autre appareil apparaît dès l’événement', () => {
    clock = T0 + 1000; save('movie:551', 1200, 6000);
    home.renderContinue();
    expect(left('movie:551')).toContain('20:00 · 20 %');
    const raw = JSON.parse(localStorage.getItem('laststream.progress')!);
    raw['movie:551'].position = 4200; // l'autre appareil a poursuivi la lecture
    localStorage.setItem('laststream.progress', JSON.stringify(raw));
    events.emitDataEvent({ kind: 'remote' });
    expect(left('movie:551')).toContain('1:10:00 · 70 %');
  });
});

describe('accueil à chaud : Ma bibliothèque', () => {
  it('ajout puis retrait dans « Ma bibliothèque » sans rechargement', () => {
    const lib = () => document.querySelector('#lib-slot [data-tile="movie:550"]');
    expect(lib()).toBeNull();
    userStore.toggleLibrary({ id: 550, type: 'movie', title: 'Fight Club', poster: '/p.jpg', year: '1999' });
    expect(lib()).not.toBeNull();
    userStore.toggleLibrary({ id: 550, type: 'movie', title: 'Fight Club', poster: '/p.jpg', year: '1999' });
    expect(lib()).toBeNull();
  });
});

describe('synchro avec le compte (ServerUserStore.refresh)', () => {
  beforeEach(async () => {
    const { SETTINGS_STORAGE_KEY, reloadSettings } = await import('../src/data/config');
    const { reloadSession, setSession } = await import('../src/data/session');
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'x' }));
    reloadSettings();
    reloadSession();
    setSession('T'.repeat(30), new Date(T0 + 1e9).toISOString(), 'greg');
  });

  const remoteFetch = (continueItems: unknown[], gate?: Promise<void>) => vi.fn(async (url: string) => {
    const u = new URL(url);
    if (/\/continue$/.test(u.pathname)) {
      if (gate) await gate;
      return json({ items: continueItems });
    }
    if (/\/library$/.test(u.pathname)) return json({ items: [] });
    const m = /\/lt\/tmdb\/(movie|tv)\/(\d+)$/.exec(u.pathname);
    if (m) return json({ id: Number(m[2]), title: 'Titre ' + m[2], name: 'Titre ' + m[2], poster_path: '/p.jpg', backdrop_path: '/b.jpg' });
    return json({ error: 'not_found' }, 404);
  });

  it('relit la progression du compte et prévient l’accueil ; un épisode terminé propose le suivant', async () => {
    const at = new Date(T0).toISOString();
    vi.stubGlobal('fetch', remoteFetch([
      { type: 'movie', tmdbId: 551, positionSec: 4200, durationSec: 6000, updatedAt: at },
      { type: 'series', tmdbId: 1399, season: 1, episode: 3, positionSec: 2390, durationSec: 2400, updatedAt: at },
    ]));
    const { ServerUserStore } = await import('../src/data/serverUserStore');
    const s = new ServerUserStore([{ id: 'p', name: 'Greg' }], { id: 'p', name: 'Greg' });
    const seen: string[] = [];
    const off = events.onDataEvent((e) => seen.push(e.kind));
    expect(await s.refresh()).toBe(true);
    off();
    expect(seen).toEqual(['remote']);
    expect(s.continueWatching().map((x) => [x.key, x.position, !!x.finished])).toEqual([['movie:551', 4200, false], ['tv:1399', 2390, true]]);
  });

  it('une écriture locale pendant la relecture l’emporte : le résultat est jeté', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', remoteFetch([], gate));
    const { ServerUserStore } = await import('../src/data/serverUserStore');
    const s = new ServerUserStore([{ id: 'p', name: 'Greg' }], { id: 'p', name: 'Greg' });
    const pending = s.refresh();
    s.setProgress({ key: 'movie:9', type: 'movie', id: 9, title: 'Local', poster: '', position: 600, duration: 6000 });
    const seen: string[] = [];
    const off = events.onDataEvent((e) => seen.push(e.kind));
    release();
    expect(await pending).toBe(false);
    off();
    expect(seen).not.toContain('remote');
    expect(s.continueWatching().map((x) => x.key)).toEqual(['movie:9']);
  });
});
