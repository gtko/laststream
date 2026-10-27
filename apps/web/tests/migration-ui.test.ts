// Carte « Importer depuis une autre app » : avertissement Stremio avant la saisie, fichier lu sans réseau, aperçu, import, rapport.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmdbMock = vi.fn();
vi.mock('../src/data/lt', async (orig) => ({ ...(await orig<Record<string, unknown>>()), tmdb: (...a: unknown[]) => tmdbMock(...a) }));

let detail: HTMLElement;
let renderCard: () => string;
let BETA_URL: string;
const q = <T extends Element = HTMLElement>(s: string) => detail.querySelector(s) as T;
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const click = (sel: string) => q<HTMLElement>(sel).click();

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal"><div class="modal"></div></div><div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  detail = document.getElementById('detail') as HTMLElement;
  const mod = await import('../src/ui/migration.js');
  renderCard = mod.migrationCard;
  BETA_URL = mod.BETA_URL;
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ls_migration_open', '1');
  tmdbMock.mockReset();
  detail.innerHTML = renderCard();
  const back = detail.querySelector<HTMLElement>('[data-mg-back], [data-mg-new]');
  if (back) { back.click(); }
});

describe('carte de migration', () => {
  it('propose les cinq sources et le programme bêta', () => {
    expect([...detail.querySelectorAll('[data-mg-src]')].map((b) => (b as HTMLElement).dataset.mgSrc)).toEqual(['stremio', 'stremio-file', 'nuvio', 'simkl', 'plex']);
    expect(q<HTMLAnchorElement>('.mg-beta a').href).toBe(BETA_URL);
  });

  it('Stremio : l’avertissement passe avant tout champ d’identifiant', () => {
    click('[data-mg-src="stremio"]');
    expect(q('input[type=password]')).toBeNull();
    expect(q('.mg-warn').textContent).toMatch(/ne modifie jamais ton compte Stremio/);
    expect(q('.mg-warn').textContent).toMatch(/Ni Laststream ni ton serveur ne les reçoivent/);
    click('[data-mg-ack]');
    expect(q('input[type=password]')).not.toBeNull();
    expect(q<HTMLInputElement>('input[name=addons]').checked).toBe(false); // étape addons désactivée par défaut
  });

  it('fichier Stremio : aperçu à cocher, import, rapport avec raisons', async () => {
    tmdbMock.mockImplementation(async (path: string) => (path === 'find/tt0133093'
      ? { movie_results: [{ id: 603, title: 'Matrix', poster_path: '/m.jpg', release_date: '1999-03-31' }] }
      : { movie_results: [], tv_results: [] }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    click('[data-mg-src="stremio-file"]');
    const input = q<HTMLInputElement>('input[type=file]');
    const lib = (id: string, type = 'movie') => ({ _id: id, name: id, type, removed: false, temp: false, _mtime: '2024-01-01T00:00:00Z', state: { timesWatched: 0, flaggedWatched: 0, timeOffset: 0, duration: 0 } });
    const file = new File([JSON.stringify({ library: [lib('tt0133093'), lib('tt9999999'), lib('ch1', 'tv')], addons: [{ transportUrl: 'https://a.test/manifest.json', manifest: { name: 'A' } }] })], 'export.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file] });
    q<HTMLFormElement>('#mg-file').requestSubmit();
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled(); // lecture du fichier : aucun envoi réseau
    expect(q('#mg-in').dataset.phase).toBe('preview');
    const cats = [...detail.querySelectorAll<HTMLInputElement>('[data-mg-cat]')];
    expect(cats.map((c) => [c.dataset.mgCat, c.checked])).toEqual([['library', true], ['watchlist', true]]);
    expect(q('[data-mg-run]').textContent).toBe('Importer 4 éléments');
    expect(q<HTMLInputElement>('[data-mg-addons-on]').checked).toBe(false);
    // Décocher « À voir » : la liste n'est pas importée.
    cats[1].click();
    expect(q('[data-mg-run]').textContent).toBe('Importer 2 éléments');
    click('[data-mg-run]');
    await settle(20);
    expect(q('#mg-in').dataset.phase).toBe('report');
    expect(q('.mg-stat[data-k="ok"] b').textContent).toBe('1');
    expect(q('.mg-stat[data-k="failed"] b').textContent).toBe('1');
    expect(q('.mg-stat[data-k="skipped"] b').textContent).toBe('1');
    expect(q('.mg-details').textContent).toMatch(/Introuvable sur TMDB \(IMDb tt9999999\)/);
    expect(q('.mg-details').textContent).toMatch(/Chaîne TV/);
    const { userStore } = await import('../src/data/userStore');
    expect(userStore.inLibrary('movie:603')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // Le rapport reste disponible après un nouveau rendu de la page.
    detail.innerHTML = renderCard();
    expect(q('#mg-sum').textContent).toMatch(/Dernier import : Stremio \(fichier\)/);
  });

  it('fichier illisible : message clair, on reste sur le formulaire', async () => {
    click('[data-mg-src="nuvio"]');
    const input = q<HTMLInputElement>('input[type=file]');
    Object.defineProperty(input, 'files', { value: [new File(['pas du json'], 'x.json')] });
    q<HTMLFormElement>('#mg-file').requestSubmit();
    await settle();
    expect(q('#mg-in').dataset.phase).toBe('file');
    expect(q('#mg-alert').textContent).toMatch(/JSON lisible/);
  });
});
