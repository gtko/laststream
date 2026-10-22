// « Proposer une watch party » (ODY-173) : fenêtre de création avec recherche d'un film ou d'une série.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmdb = vi.fn();
vi.mock('../src/data/lt', () => ({ tmdb: (...a: unknown[]) => tmdb(...a) }));
vi.mock('../src/ui/partyfriends.js', () => ({
  sortedFriends: () => [{ pid: 'f1', handle: { name: 'Léa', full: 'Léa#1' } }, { pid: 'f2', handle: { name: 'Hugo', full: 'Hugo#2' } }],
}));

const tick = (ms = 320) => new Promise((r) => setTimeout(r, ms));
const q = (sel: string) => document.querySelector(sel) as HTMLElement;

const SEARCH = {
  results: [
    { media_type: 'person', id: 1, name: 'Une personne' },
    { media_type: 'movie', id: 693134, title: 'Dune : deuxième partie', release_date: '2024-02-28', poster_path: '/abc.jpg' },
    { media_type: 'tv', id: 90, name: 'Dune : Prophecy', first_air_date: '2024-11-17', poster_path: null },
  ],
};

beforeEach(() => {
  document.body.innerHTML = '';
  tmdb.mockReset();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('modèle', () => {
  it('titleRows garde films et séries, sans personnes', async () => {
    const { titleRows } = await import('../src/ui/partyCreate.js');
    const rows = titleRows(SEARCH.results);
    expect(rows.map((r) => [r.type, r.id, r.name, r.year])).toEqual([['movie', 693134, 'Dune : deuxième partie', '2024'], ['tv', 90, 'Dune : Prophecy', '2024']]);
    expect(titleRows(undefined)).toEqual([]);
  });
  it('seasonChoices ignore les épisodes spéciaux', async () => {
    const { seasonChoices } = await import('../src/ui/partyCreate.js');
    expect(seasonChoices({ seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 2, episode_count: 8 }, { season_number: 1, episode_count: 10 }] }))
      .toEqual([{ n: 1, episodes: 10 }, { n: 2, episodes: 8 }]);
    expect(seasonChoices(null)).toEqual([]);
  });
  it('requestOfPick : une série porte saison et épisode, un film non', async () => {
    const { requestOfPick } = await import('../src/ui/partyCreate.js');
    expect(requestOfPick({ type: 'tv', id: 90, name: 'X' }, 2, 5)).toEqual({ type: 'tv', id: '90', name: 'X', season: 2, episode: 5, key: 'tv:90' });
    expect(requestOfPick({ type: 'movie', id: 7, name: 'Y' })).toEqual({ type: 'movie', id: '7', name: 'Y', season: null, episode: null, key: 'movie:7' });
  });
  it('inviteNote', async () => {
    const { inviteNote } = await import('../src/ui/partyCreate.js');
    expect(inviteNote([])).toMatch(/Aucun ami/);
    expect(inviteNote(['Léa#1'])).toBe('Léa#1 sera invité(e) dans le salon d’attente.');
    expect(inviteNote(['a', 'b'])).toMatch(/^2 amis/);
  });
});

describe('fenêtre', () => {
  it('cherche, choisit un film et crée le salon en y invitant l’ami', async () => {
    tmdb.mockResolvedValue(SEARCH);
    const { openPartyCreate } = await import('../src/ui/partyCreate.js');
    const create = vi.fn(async () => undefined);
    openPartyCreate('f1', create);
    expect(q('.cvd-title').textContent).toBe('Proposer une watch party');
    const ok = document.querySelector('.cvd-foot .is-accent') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    expect(q('.cvd-body').textContent).toContain('Léa#1 sera invité(e)');
    const input = q('.cvd input[type="search"]') as HTMLInputElement;
    input.value = 'dune';
    input.dispatchEvent(new Event('input'));
    await tick();
    expect(tmdb).toHaveBeenCalledWith('search/multi', { query: 'dune', include_adult: 'false' });
    const rows = document.querySelectorAll('.wpc-r');
    expect(rows.length).toBe(2);
    (rows[0] as HTMLElement).click();
    expect(ok.disabled).toBe(false);
    expect(q('.wpc-eps').hidden).toBe(true);
    ok.click();
    await tick(10);
    expect(create).toHaveBeenCalledWith({ type: 'movie', id: '693134', name: 'Dune : deuxième partie', season: null, episode: null, key: 'movie:693134' }, '/abc.jpg', 'private', expect.anything(), ['f1']);
    expect(document.querySelector('.cvd')).toBeNull();
  });

  it('série : saison et épisode choisis partent dans la requête', async () => {
    tmdb.mockImplementation(async (p: string) => (p === 'search/multi' ? SEARCH : { seasons: [{ season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 6 }] }));
    const { openPartyCreate } = await import('../src/ui/partyCreate.js');
    const create = vi.fn(async () => undefined);
    openPartyCreate('f1', create);
    const input = q('.cvd input[type="search"]') as HTMLInputElement;
    input.value = 'dune';
    input.dispatchEvent(new Event('input'));
    await tick();
    (document.querySelectorAll('.wpc-r')[1] as HTMLElement).click();
    await tick(10);
    const [season, episode] = [...document.querySelectorAll('.wpc-eps select')] as HTMLSelectElement[];
    expect(season.options.length).toBe(2);
    season.value = '2';
    season.dispatchEvent(new Event('change'));
    expect(episode.options.length).toBe(6);
    episode.value = '4';
    episode.dispatchEvent(new Event('change'));
    (document.querySelector('.cvd-foot .is-accent') as HTMLButtonElement).click();
    await tick(10);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'tv', id: '90', season: 2, episode: 4 }), null, 'private', expect.anything(), ['f1']);
  });

  it('clic sur une série avant la fin du délai de recherche : les saisons sont quand même chargées, Public est transmis', async () => {
    tmdb.mockImplementation(async (p: string) => (p === 'search/multi' ? SEARCH : { seasons: [{ season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 6 }] }));
    const { openPartyCreate } = await import('../src/ui/partyCreate.js');
    const create = vi.fn(async () => undefined);
    openPartyCreate('f1', create);
    const input = q('.cvd input[type="search"]') as HTMLInputElement;
    input.value = 'dune';
    input.dispatchEvent(new Event('input'));
    await tick();
    input.value = 'dune p';
    input.dispatchEvent(new Event('input'));
    (document.querySelectorAll('.wpc-r')[1] as HTMLElement).click();
    await tick();
    const [season] = [...document.querySelectorAll('.wpc-eps select')] as HTMLSelectElement[];
    expect(season.options.length).toBe(2);
    expect(tmdb.mock.calls.filter((c) => c[0] === 'search/multi').length).toBe(1);
    // Un seul des deux blocs reste dans le DOM (piège de focus).
    expect(document.querySelector('.wpc-search')).toBeNull();
    const pub = document.querySelector('input[value="public"]') as HTMLInputElement | null;
    if (pub) { pub.checked = true; pub.dispatchEvent(new Event('change')); }
    (document.querySelector('.cvd-foot .is-accent') as HTMLButtonElement).click();
    await tick(10);
    expect(create).toHaveBeenCalledWith(expect.anything(), null, pub ? 'public' : 'private', expect.anything(), ['f1']);
  });

  it('un second ami ajouté pendant que la fenêtre est ouverte rejoint les invités', async () => {
    const { openPartyCreate } = await import('../src/ui/partyCreate.js');
    openPartyCreate('f1', vi.fn());
    openPartyCreate('f2', vi.fn());
    expect(document.querySelectorAll('.cvd').length).toBe(1);
    expect(q('.cvd-body').textContent).toContain('2 amis seront invités');
  });

  it('recherche en échec : message, aucun résultat', async () => {
    tmdb.mockRejectedValue(new Error('x'));
    const { openPartyCreate } = await import('../src/ui/partyCreate.js');
    openPartyCreate('f1', vi.fn());
    const input = q('.cvd input[type="search"]') as HTMLInputElement;
    input.value = 'dune';
    input.dispatchEvent(new Event('input'));
    await tick();
    expect(q('.wpc-status').textContent).toMatch(/indisponible/);
    expect(document.querySelectorAll('.wpc-r').length).toBe(0);
  });
});
