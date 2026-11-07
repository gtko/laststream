// Téléchargement web « Sur cet appareil » (LAST-498) : destination, nom de fichier, permission du dossier, écriture en flux,
// blocage CORS (hébergeurs AllDebrid), onglet du navigateur. Aucun réseau : `fetch` et le dossier sont simulés.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadDestination, registerDownloadPlatform, resetDownloadsForTests, resolveDeviceLink, type SourceChoice } from '../src/downloads/service';
import { getWebDestination, setWebDestination } from '../src/downloads/settings';
import { DownloadError, type DownloadStore } from '../src/downloads/types';
import {
  browserDownload, CorsBlockedError, folderPickerSupported, folderWritable, openBrowserTab, safeFileName, writeToFolder, type FolderHandle,
} from '../src/downloads/webSave';
import { HTTP_URL, httpStream, viewOf } from './downloads-fixtures';

/** Dossier en mémoire : fichiers écrits, fichiers supprimés, permission réglable. */
function fakeFolder(opts: { permission?: 'granted' | 'prompt' | 'denied'; grant?: 'granted' | 'denied'; writeFails?: boolean; existing?: string[] } = {}) {
  const files = new Map<string, number[]>((opts.existing ?? []).map((n) => [n, [9, 9]]));
  const removed: string[] = [];
  let asked = 0;
  const folder: FolderHandle = {
    kind: 'directory',
    name: 'Films',
    queryPermission: async () => opts.permission ?? 'granted',
    requestPermission: async () => {
      asked++;
      return opts.grant ?? 'granted';
    },
    getFileHandle: async (name, o) => {
      if (!o?.create && !files.has(name)) throw Object.assign(new Error('absent'), { name: 'NotFoundError' });
      return {
      createWritable: async () => {
        const bytes: number[] = [];
        return {
          write: async (chunk: Uint8Array) => {
            if (opts.writeFails) throw new Error('disque plein');
            bytes.push(...chunk);
          },
          close: async () => {
            files.set(name, bytes);
          },
          abort: async () => undefined,
        };
      },
      };
    },
    removeEntry: async (name) => {
      removed.push(name);
    },
  };
  return { folder, files, removed, asked: () => asked };
}

const bodyOf = (...parts: number[][]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(new Uint8Array(p));
      c.close();
    },
  });

/** `fetch` simulé : réponse donnée, ou TypeError (ce que lève le navigateur quand CORS refuse la lecture). */
const fetchOk = (status = 200, parts: number[][] = [[1, 2, 3], [4, 5]], length?: number): typeof fetch =>
  (async () => new Response(bodyOf(...parts), { status, headers: length ? { 'content-length': String(length) } : {} })) as unknown as typeof fetch;
const fetchCors: typeof fetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;

beforeEach(() => {
  localStorage.clear();
  resetDownloadsForTests();
});

afterEach(() => {
  localStorage.clear();
  resetDownloadsForTests();
  vi.restoreAllMocks();
});

describe('destination web', () => {
  it('« Sur cet appareil » par défaut, « Dans l’app » mémorisé', () => {
    expect(getWebDestination()).toBe('device');
    expect(downloadDestination()).toBe('device');
    setWebDestination('app');
    expect(getWebDestination()).toBe('app');
    expect(downloadDestination()).toBe('app');
    setWebDestination('device');
    expect(localStorage.getItem('laststream.downloads.webDestination')).toBeNull();
  });

  it('une plateforme enregistrée (coque, Android) garde toujours la file de l’app', () => {
    const store = { open: vi.fn(), size: vi.fn(), remove: vi.fn(), usage: vi.fn() } as unknown as DownloadStore;
    registerDownloadPlatform({ store });
    expect(downloadDestination()).toBe('app');
  });
});

describe('resolveDeviceLink', () => {
  const choiceOf = (view = viewOf(httpStream({ filename: 'Dune.2021.mkv', size: 4000 }))): SourceChoice => ({
    key: 'k', group: view.group, quality: view.quality, sourceType: '', codec: '', audio: '', langs: ['fr'], origin: '', sizeBytes: 4000, view,
  });

  it('lien direct d’addon : rendu tel quel, sans recharger les sources ni passer par le serveur', async () => {
    const file = await resolveDeviceLink({ key: 'movie:1', type: 'movie', id: '1', name: 'Dune' }, choiceOf(), new AbortController().signal);
    expect(file).toEqual({ url: HTTP_URL, size: 4000, filename: 'Dune.2021.mkv' });
  });

  it('lien hors politique (réseau local) : refusé', async () => {
    const view = viewOf(httpStream({ url: 'https://192.168.1.10/film.mkv' }));
    await expect(resolveDeviceLink({ key: 'movie:1', type: 'movie', id: '1', name: 'Dune' }, choiceOf(view), new AbortController().signal)).rejects.toBeInstanceOf(DownloadError);
  });
});

describe('safeFileName', () => {
  it('retire séparateurs et caractères interdits, garde l’extension', () => {
    expect(safeFileName('../Dune: Part <Two>?.mkv', 'x')).toBe('Dune Part Two.mkv');
    expect(safeFileName('a/b\\c.mkv', 'x')).toBe('a b c.mkv');
  });

  it('nom vide ou réservé (Windows) : repli sur le titre', () => {
    expect(safeFileName('', 'Dune S1 É2.mkv')).toBe('Dune S1 É2.mkv');
    expect(safeFileName('CON.mkv', 'Dune.mkv')).toBe('Dune.mkv');
    expect(safeFileName(undefined, '')).toBe('video');
  });

  it('nom trop long : coupé à 150 caractères, extension gardée', () => {
    const out = safeFileName('a'.repeat(300) + '.mkv', 'x');
    expect(out.length).toBe(150);
    expect(out.endsWith('.mkv')).toBe(true);
  });
});

describe('permission du dossier', () => {
  it('déjà accordée : aucune demande', async () => {
    const f = fakeFolder();
    expect(await folderWritable(f.folder, true)).toBe(true);
    expect(f.asked()).toBe(0);
  });

  it('à redemander : demandée seulement avec `ask`', async () => {
    const f = fakeFolder({ permission: 'prompt' });
    expect(await folderWritable(f.folder, false)).toBe(false);
    expect(f.asked()).toBe(0);
    expect(await folderWritable(f.folder, true)).toBe(true);
    expect(f.asked()).toBe(1);
  });

  it('refusée : faux', async () => {
    const f = fakeFolder({ permission: 'prompt', grant: 'denied' });
    expect(await folderWritable(f.folder, true)).toBe(false);
  });
});

describe('writeToFolder', () => {
  it('écrit le fichier en flux et annonce l’avancement', async () => {
    const f = fakeFolder();
    const progress: Array<[number, number | null]> = [];
    const n = await writeToFolder(f.folder, 'Dune.mkv', HTTP_URL, { fetchImpl: fetchOk(200, [[1, 2, 3], [4, 5]], 5), onProgress: (d, t) => progress.push([d, t]) });
    expect(n).toEqual({ name: 'Dune.mkv', bytes: 5 });
    expect(f.files.get('Dune.mkv')).toEqual([1, 2, 3, 4, 5]);
    expect(progress).toEqual([[3, 5], [5, 5]]);
  });

  it('CORS refusé (AllDebrid) : CorsBlockedError, aucun fichier créé', async () => {
    const f = fakeFolder();
    await expect(writeToFolder(f.folder, 'Dune.mkv', HTTP_URL, { fetchImpl: fetchCors })).rejects.toBeInstanceOf(CorsBlockedError);
    expect(f.files.size).toBe(0);
  });

  it('lien refusé (403) : link_expired', async () => {
    const f = fakeFolder();
    await expect(writeToFolder(f.folder, 'Dune.mkv', HTTP_URL, { fetchImpl: fetchOk(403) })).rejects.toMatchObject({ code: 'link_expired' });
  });

  it('écriture refusée : store_failed, fichier partiel supprimé', async () => {
    const f = fakeFolder({ writeFails: true });
    await expect(writeToFolder(f.folder, 'Dune.mkv', HTTP_URL, { fetchImpl: fetchOk() })).rejects.toMatchObject({ code: 'store_failed' });
    expect(f.removed).toEqual(['Dune.mkv']);
  });

  it('nom déjà pris : nouveau nom, le fichier existant n’est pas écrasé', async () => {
    const f = fakeFolder({ existing: ['Dune.mkv', 'Dune (2).mkv'] });
    const n = await writeToFolder(f.folder, 'Dune.mkv', HTTP_URL, { fetchImpl: fetchOk() });
    expect(n.name).toBe('Dune (3).mkv');
    expect(f.files.get('Dune.mkv')).toEqual([9, 9]);
  });

  it('échec en cours : seul le fichier créé est supprimé, l’existant est conservé', async () => {
    const f = fakeFolder({ existing: ['Dune.mkv'], writeFails: true });
    await expect(writeToFolder(f.folder, 'Dune.mkv', HTTP_URL, { fetchImpl: fetchOk() })).rejects.toMatchObject({ code: 'store_failed' });
    expect(f.removed).toEqual(['Dune (2).mkv']);
    expect(f.files.get('Dune.mkv')).toEqual([9, 9]);
  });

  it('les requêtes partent sans cookie ni référent', async () => {
    const f = fakeFolder();
    const spy = vi.fn(fetchOk());
    await writeToFolder(f.folder, 'Dune.mkv', HTTP_URL, { fetchImpl: spy as unknown as typeof fetch });
    expect(spy.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });
});

describe('téléchargement du navigateur', () => {
  it('sans File System Access (jsdom, Firefox, Safari) : pas de choix de dossier', () => {
    expect(folderPickerSupported()).toBe(false);
  });

  it('onglet d’attente bloqué : null', () => {
    expect(openBrowserTab(() => null)).toBeNull();
  });

  it('onglet d’attente ouvert puis dirigé vers le lien, sans lien vers la page', () => {
    const replace = vi.fn();
    const win = { document: document.implementation.createHTMLDocument(''), location: { replace }, opener: {}, close: vi.fn() } as unknown as Window;
    const tab = openBrowserTab(() => win);
    expect(tab).not.toBeNull();
    expect((win as unknown as { opener: unknown }).opener).toBeNull();
    tab!.go(HTTP_URL);
    expect(replace).toHaveBeenCalledWith(HTTP_URL);
  });

  it('lien de repli : attribut download, nouvel onglet, sans référent, retiré après le clic', () => {
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this);
    });
    browserDownload(HTTP_URL, 'Dune.mkv');
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('Dune.mkv');
    expect(clicks[0].rel).toBe('noopener noreferrer');
    expect(clicks[0].target).toBe('_blank');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
