import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAddonCatalog, type AddonCatalogEntry } from '../src/data/addonCatalog';
import { isInAddonLibrary } from '../src/data/addonUserStore';
import { fetchAddonMeta, loadAddonSources } from '../src/sources/addonSources';
import type { SourceView } from '../src/sources/info';
import { openSourcePicker } from '../src/sources/picker.js';
import { playBest, playSource } from '../src/player/session.js';
import { addonPreviewKey } from '../src/ui/addonRows.js';
import { addonSlug } from '../src/ui/addonRoutes.js';
import { showAddonFiche } from '../src/ui/addonFiche.js';

vi.mock('../src/sources/addonSources', () => ({ fetchAddonMeta: vi.fn(), loadAddonSources: vi.fn() }));
vi.mock('../src/sources/picker.js', () => ({ openSourcePicker: vi.fn(async () => undefined) }));
vi.mock('../src/player/session.js', () => ({ playBest: vi.fn(async () => undefined), playSource: vi.fn(async () => undefined) }));

const KEY = 'https://addon.example.test/cfg-abc';
const ENTRY: AddonCatalogEntry = {
  manifestUrl: `${KEY}/manifest.json`,
  name: 'Addon test',
  home: false,
  catalogs: [],
  idPrefixes: [],
  types: ['movie', 'series'],
  resources: { meta: true, stream: true },
  at: 1_700_000_000_000,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: HTMLElement;

/** Aperçu gardé par une rangée d'accueil ou un catalogue, comme `rememberMetaPreview`. */
function seedPreview(type: string, id: string, preview: Record<string, unknown>) {
  sessionStorage.setItem(addonPreviewKey(addonSlug(KEY), type, id), JSON.stringify(preview));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  root = document.createElement('div');
  document.body.replaceChildren(root);
  setAddonCatalog(KEY, ENTRY);
  vi.mocked(fetchAddonMeta).mockResolvedValue({});
  vi.mocked(loadAddonSources).mockResolvedValue([]);
});

describe('fiche d’addon : film', () => {
  it('titre, année, synopsis, Lecture, Sources et lien TMDB ; aucune adresse d’addon dans la page', async () => {
    seedPreview('movie', 'tt1', { id: 'tt1', name: 'Aperçu', type: 'movie' });
    vi.mocked(fetchAddonMeta).mockResolvedValue({
      meta: { id: 'tt1', name: 'Film complet', description: 'Un synopsis', releaseInfo: '2010', genres: ['Thriller', 'Drame'], runtime: '120 min', background: 'https://img.example.test/bg.jpg', moviedb_id: 603 },
    });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt1' });
    await vi.waitFor(() => expect(root.querySelector('#f-title')?.textContent).toBe('Film complet'));
    expect(root.querySelector('.f-ov')?.textContent).toBe('Un synopsis');
    expect(root.textContent).toContain('2010');
    expect(root.querySelector('[data-play]')).not.toBeNull();
    expect(root.querySelector('[data-sources]')).not.toBeNull();
    expect(root.querySelector('a[href="#/movie/603"]')).not.toBeNull();
    expect(root.innerHTML).not.toContain('cfg-abc');
    expect(root.innerHTML).not.toContain('addon.example');
  });

  it('Lecture lance playBest avec une demande d’addon (sans identifiant TMDB ou IMDb)', async () => {
    vi.mocked(fetchAddonMeta).mockResolvedValue({ meta: { id: 'tt1', name: 'Film' } });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt1' });
    await vi.waitFor(() => expect(root.querySelector('[data-play]')).not.toBeNull());
    (root.querySelector('[data-play]') as HTMLButtonElement).click();
    expect(playBest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'movie', id: 'tt1', name: 'Film', key: 'addon:movie:tt1', season: null, episode: null,
        addon: expect.objectContaining({ key: KEY, base: KEY, type: 'movie', id: 'tt1', title: 'Film' }),
      }),
      expect.anything(),
    );
    const request = vi.mocked(playBest).mock.calls[0][0] as Record<string, unknown>;
    expect(request).not.toHaveProperty('imdb');
    expect(request).not.toHaveProperty('streamId');
  });

  it('Sources : sans source, message discret et aucun sélecteur ; jamais « Aucun identifiant IMDb »', async () => {
    vi.mocked(fetchAddonMeta).mockResolvedValue({ meta: { id: 'tt1', name: 'Film' } });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt1' });
    await vi.waitFor(() => expect(root.querySelector('[data-sources]')).not.toBeNull());
    (root.querySelector('[data-sources]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.querySelector('#af-msg')?.textContent).toBe('Aucune source trouvée sur cet addon'));
    expect(openSourcePicker).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain('Aucun identifiant IMDb');
  });

  it('Sources : avec des sources, le sélecteur reçoit ces sources et ne cherche rien de plus', async () => {
    const view = { index: 0, label: 'Source 1080p' } as unknown as SourceView;
    vi.mocked(fetchAddonMeta).mockResolvedValue({ meta: { id: 'tt1', name: 'Film' } });
    vi.mocked(loadAddonSources).mockResolvedValue([view]);
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt1' });
    await vi.waitFor(() => expect(root.querySelector('[data-sources]')).not.toBeNull());
    (root.querySelector('[data-sources]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(openSourcePicker).toHaveBeenCalledTimes(1));
    expect(loadAddonSources).toHaveBeenCalledWith(ENTRY, 'movie', 'tt1');
    expect(openSourcePicker).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'movie', id: 'tt1' }),
      expect.anything(),
      expect.objectContaining({ views: [view] }),
    );
  });

  it('bibliothèque : ajout puis retrait, reflété dans le bouton et dans le stockage des addons', async () => {
    vi.mocked(fetchAddonMeta).mockResolvedValue({ meta: { id: 'tt1', name: 'Film' } });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt1' });
    await vi.waitFor(() => expect(root.querySelector('[data-lib]')).not.toBeNull());
    const lib = () => root.querySelector('[data-lib]') as HTMLButtonElement;
    expect(lib().getAttribute('aria-pressed')).toBe('false');
    lib().click();
    expect(lib().getAttribute('aria-pressed')).toBe('true');
    expect(isInAddonLibrary('addon:movie:tt1')).toBe(true);
    lib().click();
    expect(lib().getAttribute('aria-pressed')).toBe('false');
    expect(isInAddonLibrary('addon:movie:tt1')).toBe(false);
  });

  it('addon sans flux (resources.stream false) : ni Lecture ni Sources', async () => {
    setAddonCatalog(KEY, { ...ENTRY, resources: { meta: true, stream: false } });
    vi.mocked(fetchAddonMeta).mockResolvedValue({ meta: { id: 'tt1', name: 'Film' } });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt1' });
    await vi.waitFor(() => expect(root.querySelector('#f-title')?.textContent).toBe('Film'));
    expect(root.querySelector('[data-play]')).toBeNull();
    expect(root.querySelector('[data-sources]')).toBeNull();
  });
});

describe('fiche d’addon : série', () => {
  const SERIES_META = {
    meta: {
      id: 'fk:1',
      name: 'Anime',
      videos: [
        { id: 'fk:1:1:1', season: 1, episode: 1, title: 'Début' },
        { id: 'fk:1:1:2', season: 1, episode: 2 },
        { id: 'fk:1:2:1', season: 2, episode: 1 },
      ],
    },
  };

  it('une liste par saison ; Lire lance l’épisode avec son identifiant de flux et la liste de l’addon', async () => {
    vi.mocked(fetchAddonMeta).mockResolvedValue(SERIES_META);
    showAddonFiche(root, { addonKey: KEY, type: 'anime', id: 'fk:1' });
    await vi.waitFor(() => expect(root.querySelectorAll('#af-eplist .ep')).toHaveLength(2));
    expect(root.querySelector('[data-play]')).toBeNull();
    const select = root.querySelector('#af-season') as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    expect(root.querySelectorAll('#af-eplist .ep')).toHaveLength(1);
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    (root.querySelector('[data-ep="1:2"]') as HTMLButtonElement).click();
    expect(playBest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tv', id: 'fk:1', season: 1, episode: 2, streamId: 'fk:1:1:2', key: 'addon:anime:fk:1',
        addon: expect.objectContaining({ key: KEY, base: KEY, type: 'anime', id: 'fk:1', videos: expect.any(Array) }),
      }),
      expect.anything(),
    );
  });

  it('série sans épisode numéroté : message « Aucun épisode disponible sur cet addon », sans liste d’épisodes', async () => {
    vi.mocked(fetchAddonMeta).mockResolvedValue({ meta: { id: 'fk:2', name: 'Spéciaux', videos: [{ id: 'fk:2:x', title: 'Spécial' }] } });
    showAddonFiche(root, { addonKey: KEY, type: 'anime', id: 'fk:2' });
    await vi.waitFor(() => expect(root.textContent).toContain('Aucun épisode disponible sur cet addon'));
    expect(root.querySelector('#af-eplist')).toBeNull();
  });

  it('addon sans flux : les épisodes restent listés, sans bouton Lire', async () => {
    setAddonCatalog(KEY, { ...ENTRY, resources: { meta: true, stream: false } });
    vi.mocked(fetchAddonMeta).mockResolvedValue(SERIES_META);
    showAddonFiche(root, { addonKey: KEY, type: 'anime', id: 'fk:1' });
    await vi.waitFor(() => expect(root.querySelectorAll('#af-eplist .ep')).toHaveLength(2));
    expect(root.querySelector('[data-ep]')).toBeNull();
  });
});

describe('fiche d’addon : repli sur l’aperçu', () => {
  it('fiche absente : la page reprend l’aperçu, sans message d’erreur', async () => {
    seedPreview('movie', 'tt2', { id: 'tt2', name: 'Aperçu seul', type: 'movie', description: 'Court', releaseInfo: '2001' });
    vi.mocked(fetchAddonMeta).mockResolvedValue({ error: 'http' });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt2' });
    expect(root.querySelector('#f-title')?.textContent).toBe('Aperçu seul');
    await flush();
    expect(root.querySelector('#f-title')?.textContent).toBe('Aperçu seul');
    expect(root.querySelector('.f-ov')?.textContent).toBe('Court');
    expect(root.textContent).not.toContain('pas pu être chargée');
    expect(root.querySelector('[data-play]')).not.toBeNull();
  });

  it('aperçu illisible : la fiche complète s’affiche quand même', async () => {
    sessionStorage.setItem(addonPreviewKey(addonSlug(KEY), 'movie', 'tt3'), '{pas du json');
    vi.mocked(fetchAddonMeta).mockResolvedValue({ meta: { id: 'tt3', name: 'Complet' } });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt3' });
    await vi.waitFor(() => expect(root.querySelector('#f-title')?.textContent).toBe('Complet'));
  });

  it('aperçu d’un autre addon, même type et même identifiant : non repris', async () => {
    const OTHER = 'https://other.example.test/cfg-xyz';
    setAddonCatalog(OTHER, { ...ENTRY, manifestUrl: `${OTHER}/manifest.json` });
    sessionStorage.setItem(addonPreviewKey(addonSlug(OTHER), 'movie', 'tt4'), JSON.stringify({ id: 'tt4', name: 'Aperçu autre addon', type: 'movie' }));
    vi.mocked(fetchAddonMeta).mockResolvedValue({ error: 'http' });
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt4' });
    await vi.waitFor(() => expect(root.textContent).toContain('Cette fiche n’a pas pu être chargée'));
    expect(root.textContent).not.toContain('Aperçu autre addon');
  });

  it('ni aperçu ni fiche : « n’a pas pu être chargée », sans mention d’IMDb', async () => {
    showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt9' });
    await vi.waitFor(() => expect(root.textContent).toContain('Cette fiche n’a pas pu être chargée'));
    expect(root.textContent).not.toContain('IMDb');
  });
});

describe('fiche d’addon : cas limites', () => {
  it('addon retiré du registre : message « plus activé », aucun appel réseau', () => {
    showAddonFiche(root, { addonKey: 'https://gone.example.test/x', type: 'movie', id: 'tt1' });
    expect(root.textContent).toContain('Ce catalogue n’est plus activé');
    expect(root.querySelector('a[href="#/settings"]')).not.toBeNull();
    expect(fetchAddonMeta).not.toHaveBeenCalled();
  });

  it('après destroy, une réponse tardive ne réécrit pas la page', async () => {
    let release!: () => void;
    const late = new Promise<Awaited<ReturnType<typeof fetchAddonMeta>>>((resolve) => {
      release = () => resolve({ meta: { id: 'tt1', name: 'Tardif' } });
    });
    vi.mocked(fetchAddonMeta).mockReturnValue(late);
    const page = showAddonFiche(root, { addonKey: KEY, type: 'movie', id: 'tt1' });
    page.destroy();
    release();
    await flush();
    expect(root.textContent).not.toContain('Tardif');
  });
});
