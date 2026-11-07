// Fiche série : pastille « Filler » / « Récap » sur les épisodes d'anime (données lastAddon, LAST-506).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { EPS, api } = vi.hoisted(() => ({
  EPS: [1, 2, 3].map((e) => ({ episode_number: e, name: 'É' + e, air_date: '2020-01-01', still_path: null, runtime: 24, overview: '' })),
  api: vi.fn(),
}));

vi.mock('hls.js', () => ({ default: class { static isSupported = () => false; } }));
vi.mock('../src/ui/seasons.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/seasons.js')>()),
  seasonEpisodes: async () => ({ poster_path: null, episodes: EPS }),
}));
vi.mock('../src/data/lt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/lt')>()),
  api: (route: string, ...rest: unknown[]) => (route.endsWith('/fillers') ? api(route, ...rest) : Promise.reject(new Error('hors test'))),
}));

let loadSeason: (m: unknown, n: number, token: number) => Promise<void>;
let state: typeof import('../src/ui/state.js').state;
let nextId = 100;
const show = () => ({ key: 'tv:' + nextId, id: nextId++, type: 'tv', name: 'Anime test', backdropPath: '', posterPath: '', seasons: [], lastAired: null });
const li = (n: number, e: number) => document.querySelector<HTMLElement>('#f-eplist .ep[data-ep="' + n + ':' + e + '"]')!;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  document.getElementById('detail')!.innerHTML = '<ul id="f-eplist"></ul>';
  ({ loadSeason } = await import('../src/ui/ficheSections.js'));
  ({ state } = await import('../src/ui/state.js'));
});

beforeEach(() => {
  localStorage.clear();
  api.mockReset();
  document.getElementById('f-eplist')!.innerHTML = '';
});

describe('fiche série : épisodes filler et récap', () => {
  it('pastille sur les épisodes concernés de la saison affichée, et seulement eux', async () => {
    api.mockResolvedValue({ fillers: [{ season: 1, episode: 2, kind: 'filler' }, { season: 1, episode: 3, kind: 'recap' }, { season: 2, episode: 1, kind: 'filler' }] });
    await loadSeason(show(), 1, state.token);
    await flush();
    expect(li(1, 1).querySelector('.ep-filler')).toBeNull();
    expect(li(1, 2).querySelector('.ep-meta .ep-filler')?.textContent).toBe('Filler');
    expect(li(1, 3).querySelector('.ep-meta .ep-filler')?.textContent).toBe('Récap');
    expect(li(1, 2).querySelector('[data-play]')!.getAttribute('aria-label')).toMatch(/, épisode filler$/);
    expect(li(1, 3).querySelector('[data-play]')!.getAttribute('aria-label')).toMatch(/, récap$/);
  });

  it('autre saison de la même série : pas de nouvel appel', async () => {
    api.mockResolvedValue({ fillers: [{ season: 2, episode: 1, kind: 'filler' }] });
    const m = show();
    await loadSeason(m, 1, state.token);
    await loadSeason(m, 2, state.token);
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(li(2, 1).querySelector('.ep-filler')?.textContent).toBe('Filler');
  });

  it('la saison s’affiche sans attendre la réponse ; en erreur, aucune pastille', async () => {
    let fail!: (e: Error) => void;
    api.mockReturnValue(new Promise((_, rej) => { fail = rej; }));
    await loadSeason(show(), 1, state.token);
    expect(document.querySelectorAll('#f-eplist .ep')).toHaveLength(3);
    fail(new Error('réseau'));
    await flush();
    expect(document.querySelector('#f-eplist .ep-filler')).toBeNull();
  });

  it('lastAddon non configuré (api lève tout de suite) : la saison s’affiche quand même', async () => {
    api.mockImplementation(() => { throw new Error('lastAddon n’est pas configuré.'); });
    await loadSeason(show(), 1, state.token);
    await flush();
    expect(document.querySelectorAll('#f-eplist .ep')).toHaveLength(3);
    expect(document.querySelector('#f-eplist .ep-filler')).toBeNull();
  });
});
