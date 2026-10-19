import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllDebridClient } from '../src/sources/alldebrid.js';

// Mode serveur AllDebrid explicitement activé (opt-in) : le client est appelé depuis le serveur.
beforeEach(() => vi.stubEnv('LASTADDON_DEBRID_SERVER_SIDE', '1'));
afterEach(() => vi.unstubAllEnvs());

/**
 * Choix du fichier d'un pack par épisode (saison, épisode) : fichiers factices, AllDebrid simulé, aucun réseau.
 * Le fichier débloqué est celui dont le lien (`l`) est passé à /v4/link/unlock.
 */
const API_KEY = 'AD-TEST-KEY-PACK-EPISODE';
const HASH = '4'.repeat(40);
const noSleep = async (): Promise<void> => {};

/** Pack multi-saisons : fichiers aux noms variés, dont des épisodes voisins (S04E40, S14E04, S01E04…). */
const BREAKING_BAD_COMPLETE = [
  { n: 'Breaking.Bad.S01E04.1080p.mkv', s: 900, l: 's01e04' },
  { n: 'Breaking.Bad.S04E04.1080p.mkv', s: 800, l: 's04e04' },
  { n: 'Breaking.Bad.S04E05.1080p.mkv', s: 950, l: 's04e05' },
  { n: 'Breaking.Bad.S04E40.1080p.mkv', s: 990, l: 's04e40' },
  { n: 'Breaking.Bad.S14E04.1080p.mkv', s: 980, l: 's14e04' },
  { n: 'Breaking.Bad.S04.sample.mkv', s: 10, l: 'sample' },
  { n: 'Breaking.Bad.S04E04.nfo', s: 1, l: 'nfo' },
];

/** Dossier de saison, nommé en 4x04 (format NxNN) : l'épisode 4 de la saison 4 doit être choisi. */
const NXNN_PACK = [
  { n: 'Season 4/Breaking.Bad.4x03.mkv', s: 700, l: 'x03' },
  { n: 'Season 4/Breaking.Bad.4x04.mkv', s: 600, l: 'x04' },
  { n: 'Season 4/Breaking.Bad.4x14.mkv', s: 900, l: 'x14' },
];

interface Call {
  path: string;
  form: URLSearchParams;
}

/** AllDebrid simulé : upload prêt, liste de fichiers donnée, déblocage renvoyant un lien d'après le fichier demandé. */
function clientFor(files: { n: string; s: number; l: string }[]) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    calls.push({ path: url.pathname, form });
    const data: Record<string, unknown> = (() => {
      switch (url.pathname) {
        case '/v4/magnet/upload':
          return { magnets: [{ magnet: `magnet:?xt=urn:btih:${HASH}`, hash: HASH, name: 'x', size: 1, ready: true, id: 7 }] };
        case '/v4.1/magnet/status':
          return { magnets: { id: 7, statusCode: 4 } };
        case '/v4/magnet/files':
          return { magnets: [{ id: 7, files }] };
        case '/v4/link/unlock':
          return { link: `https://dl.example/${form.get('link')}`, filename: 'f.mkv', filesize: 1 };
        default:
          return { message: 'ok' };
      }
    })();
    return new Response(JSON.stringify({ status: 'success', data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new AllDebridClient(API_KEY, { fetch: fetchImpl as unknown as typeof fetch });
  return {
    client,
    unlocked: () => calls.find((call) => call.path === '/v4/link/unlock')?.form.get('link') ?? null,
  };
}

describe('AllDebridClient.resolve : choix du fichier dans un pack, par épisode', () => {
  it('pack multi-saisons : S04E04 choisi parmi S04E05, S04E40, S14E04, S01E04 (et l’échantillon)', async () => {
    const { client, unlocked } = clientFor(BREAKING_BAD_COMPLETE);
    await client.resolve(HASH, undefined, { season: 4, episode: 4, sleep: noSleep });
    expect(unlocked()).toBe('s04e04');
  });

  it('format NxNN dans un dossier de saison : 4x04 choisi, pas 4x14 ni 4x03', async () => {
    const { client, unlocked } = clientFor(NXNN_PACK);
    await client.resolve(HASH, undefined, { season: 4, episode: 4, sleep: noSleep });
    expect(unlocked()).toBe('x04');
  });

  it('nom de fichier attendu (copie d’un pack déjà lu) : prime sur l’épisode demandé', async () => {
    const { client, unlocked } = clientFor(BREAKING_BAD_COMPLETE);
    await client.resolve(HASH, undefined, {
      season: 4,
      episode: 4,
      filename: 'Breaking.Bad.S04E05.1080p.mkv',
      sleep: noSleep,
    });
    expect(unlocked()).toBe('s04e05');
  });

  it('épisode absent d’un pack de plusieurs vidéos : erreur no_file, jamais un autre épisode', async () => {
    const { client, unlocked } = clientFor(BREAKING_BAD_COMPLETE);
    await expect(client.resolve(HASH, undefined, { season: 4, episode: 9, sleep: noSleep })).rejects.toMatchObject({
      code: 'no_file',
    });
    expect(unlocked()).toBeNull();
  });

  it('une seule vidéo dans le torrent : repli sur ce fichier même si son nom ne porte pas l’épisode', async () => {
    const { client, unlocked } = clientFor([
      { n: 'Film.Unique.1080p.mkv', s: 5000, l: 'single' },
      { n: 'Film.Unique.nfo', s: 1, l: 'nfo' },
    ]);
    await client.resolve(HASH, undefined, { season: 4, episode: 4, sleep: noSleep });
    expect(unlocked()).toBe('single');
  });
});
