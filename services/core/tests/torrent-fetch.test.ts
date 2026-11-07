import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TORRENT_BYTES } from '../src/torrent/bencode.js';
import { TorrentCache, fetchTorrent, scrubUrl } from '../src/torrent/fetch-torrent.js';
import { SourceError, type FetchFn } from '../src/sources/http.js';
import { bint, bdict, bstr, monoTorrent, packTorrent } from './torrent-fixtures.js';

const HASH = '9657bd8853fb7dbe97ee66bd828aa7ec85f26231';
const SECRET = 'PK-SECRET-99887766';
const URL_WITH_KEY = `https://prowlarr.example.com/1/download?apikey=${SECRET}&link=abc`;
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=abc&tr=https%3A%2F%2Ftracker.example%2F${SECRET}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Faux fetch : aucune requête réseau. Chaque appel est enregistré, la réponse vient du gestionnaire. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  });
  return { fetch: mock as unknown as FetchFn, mock };
}

function torrentResponse(body: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/x-bittorrent', ...headers } });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** Erreur levée par la promesse ; échoue si elle se résout. */
async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('aucune erreur levée');
}

describe('fetchTorrent : lecture du .torrent', () => {
  it('renvoie infoHash, fichiers et drapeau privé ; pas d’octets pour un torrent public', async () => {
    const { fetch, mock } = mockFetch(() => torrentResponse(monoTorrent()));

    const result = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'torrent',
      infoHash: HASH,
      files: [{ idx: 0, path: 'abc', size: 3 }],
      private: false,
      bytes: undefined,
    });
  });

  it('torrent privé : les octets exacts sont renvoyés (pour une lecture ultérieure)', async () => {
    const body = monoTorrent({ private: true, announce: `https://t.example/announce?passkey=${SECRET}` });
    const { fetch } = mockFetch(() => torrentResponse(body));

    const result = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() });

    expect(result.kind).toBe('torrent');
    if (result.kind !== 'torrent') return;
    expect(result.private).toBe(true);
    expect(result.bytes?.equals(body)).toBe(true);
  });

  it('content-type tolérant : un contenu valide est accepté quel que soit l’en-tête', async () => {
    const { fetch } = mockFetch(() => torrentResponse(monoTorrent(), { 'content-type': 'text/html; charset=utf-8' }));

    const result = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() });

    expect(result.infoHash).toBe(HASH);
  });

  it('pack : fichiers listés dans l’ordre, idx et taille', async () => {
    const { fetch } = mockFetch(() =>
      torrentResponse(
        packTorrent([
          { path: ['e01.mkv'], length: 10 },
          { path: ['e02.mkv'], length: 20 },
        ]),
      ),
    );

    const result = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() });

    expect(result.kind === 'torrent' ? result.files : []).toEqual([
      { idx: 0, path: 'e01.mkv', size: 10 },
      { idx: 1, path: 'e02.mkv', size: 20 },
    ]);
  });

  it('redirection vers un magnet : {kind magnet, infoHash, magnet}, sans octets, sans suivre la redirection', async () => {
    const { fetch, mock } = mockFetch(() => redirect(MAGNET, 301));

    const result = await fetchTorrent(URL_WITH_KEY, { fetch, cache: new TorrentCache() });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'magnet', infoHash: HASH, magnet: MAGNET });
    expect(result).not.toHaveProperty('bytes');
  });

  it('redirection HTTP suivie puis torrent lu', async () => {
    const { fetch, mock } = mockFetch((url) =>
      url.startsWith('https://indexeur.example.com') ? redirect('https://cdn.example.com/final.torrent') : torrentResponse(monoTorrent()),
    );

    const result = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.infoHash).toBe(HASH);
  });

  it('redirection vers un schéma non http(s) (sans magnet) : refusée, un seul appel', async () => {
    const { fetch, mock } = mockFetch(() => redirect('file:///etc/passwd'));

    const error = await errorOf(fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() }));

    expect(error).toBeInstanceOf(SourceError);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('magnet passé directement : renvoyé sans aucun appel réseau', async () => {
    const { fetch, mock } = mockFetch(() => torrentResponse(monoTorrent()));

    const result = await fetchTorrent(MAGNET, { fetch, cache: new TorrentCache() });

    expect(mock).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'magnet', infoHash: HASH, magnet: MAGNET });
  });

  it('magnet sans infoHash : erreur sûre', async () => {
    const { fetch } = mockFetch(() => redirect('magnet:?dn=sans-hash&tr=x'));

    const error = await errorOf(fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() }));

    expect(error.message).toBe('magnet sans infoHash');
  });

  it('SSRF : en mode public, un hôte IP privé est refusé avant tout envoi', async () => {
    vi.stubEnv('LASTADDON_PUBLIC', '1');
    const { fetch, mock } = mockFetch(() => torrentResponse(monoTorrent()));

    const error = await errorOf(fetchTorrent('http://127.0.0.1/t.torrent', { fetch, cache: new TorrentCache() }));

    expect(error).toBeInstanceOf(SourceError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('plus de 5 Mo annoncés (content-length) : refusé sans lecture du corps', async () => {
    const { fetch } = mockFetch(
      () => new Response(null, { status: 200, headers: { 'content-length': String(MAX_TORRENT_BYTES + 1) } }),
    );

    const error = await errorOf(fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() }));

    expect(error.message).toContain('trop volumineuse');
  });

  it('HTTP 404 : SourceError « HTTP 404 » sans URL', async () => {
    const { fetch } = mockFetch(() => new Response('introuvable', { status: 404 }));

    const error = await errorOf(fetchTorrent(URL_WITH_KEY, { fetch, cache: new TorrentCache() }));

    expect(error.message).toBe('HTTP 404');
  });

  it('délai dépassé : SourceError de délai, la requête est annulée', async () => {
    const { fetch } = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const error = await errorOf(
      fetchTorrent(URL_WITH_KEY, { fetch, timeoutMs: 20, cache: new TorrentCache() }),
    );

    expect(error.message).toBe('délai dépassé (20 ms)');
  });

  it('torrent invalide : erreur de format sûre, sans contenu du fichier', async () => {
    const { fetch } = mockFetch(() => new Response(`<html>passkey=${SECRET}</html>`, { status: 200 }));

    const error = await errorOf(fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() }));

    expect(error.message).toBe('torrent invalide (malformed)');
    expect(error.message).not.toContain(SECRET);
  });
});

describe('fetchTorrent : aucun secret dans les erreurs', () => {
  it('erreur de transport dont le message contient l’URL avec passkey : rien de secret ne sort', async () => {
    const { fetch } = mockFetch(() => {
      throw new Error(`connect failed ${URL_WITH_KEY}`);
    });

    const error = await errorOf(fetchTorrent(URL_WITH_KEY, { fetch, cache: new TorrentCache() }));

    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it('erreur HTTP sur une URL /download/<token> : le token n’apparaît pas', async () => {
    const tokenUrl = 'https://indexeur.example.com/download/TOKEN-SECRET-4455/file.torrent';
    const { fetch } = mockFetch(() => new Response('x', { status: 500 }));

    const error = await errorOf(fetchTorrent(tokenUrl, { fetch, cache: new TorrentCache() }));

    expect(error.message).not.toContain('TOKEN-SECRET-4455');
  });
});

describe('scrubUrl', () => {
  it('masque passkey=, apikey=, api_key=, token= et les segments /rss/ et /download/', () => {
    const text =
      'a https://t.example/rss/RSSTOK1/x?passkey=PKVAL&a=1 b https://p.example/1/download/DLTOK2?apikey=KEYVAL&api_key=AKVAL&token=TOKVAL c';

    const scrubbed = scrubUrl(text);

    for (const secret of ['RSSTOK1', 'PKVAL', 'DLTOK2', 'KEYVAL', 'AKVAL', 'TOKVAL']) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toContain('a=1');
    expect(scrubbed).toContain('passkey=***');
    expect(scrubbed).toContain('/rss/***');
    expect(scrubbed).toContain('/download/***');
  });

  it('texte sans secret : inchangé', () => {
    expect(scrubUrl('délai dépassé (10000 ms)')).toBe('délai dépassé (10000 ms)');
  });
});

describe('TorrentCache', () => {
  it('cache par guid : un second appel n’envoie aucune requête', async () => {
    const cache = new TorrentCache();
    const { fetch, mock } = mockFetch(() => torrentResponse(monoTorrent()));

    const first = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache, guid: 'g-1' });
    const second = await fetchTorrent('https://autre.example.com/t.torrent', { fetch, cache, guid: 'g-1' });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('sans guid, rien n’est mis en cache', async () => {
    const cache = new TorrentCache();
    const { fetch, mock } = mockFetch(() => torrentResponse(monoTorrent()));

    await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache });
    await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('les octets d’un torrent public ne sont pas gardés, ceux d’un torrent privé le sont', async () => {
    const cache = new TorrentCache();
    const publicBody = monoTorrent();
    const privateBody = monoTorrent({ private: true });
    const { fetch } = mockFetch((url) => torrentResponse(url.includes('priv') ? privateBody : publicBody));

    await fetchTorrent('https://indexeur.example.com/public.torrent', { fetch, cache, guid: 'pub' });
    await fetchTorrent('https://indexeur.example.com/priv.torrent', { fetch, cache, guid: 'priv' });

    const publicHit = cache.get('pub');
    const privateHit = cache.get('priv');
    expect(publicHit?.kind === 'torrent' ? publicHit.bytes : 'absent').toBeUndefined();
    expect(privateHit?.kind === 'torrent' ? privateHit.bytes?.equals(privateBody) : false).toBe(true);
  });

  it('TTL de 6 h : expiration après 6 h, pas avant', async () => {
    let clock = 0;
    const cache = new TorrentCache({ now: () => clock });
    const { fetch, mock } = mockFetch(() => torrentResponse(monoTorrent()));
    const sixHours = 6 * 60 * 60 * 1000;

    await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache, guid: 'g' });
    clock = sixHours - 1;
    await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache, guid: 'g' });
    expect(mock).toHaveBeenCalledTimes(1);

    clock = sixHours + 1;
    await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache, guid: 'g' });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('au plus 200 entrées : la plus ancienne sort en premier', () => {
    const cache = new TorrentCache();
    const value = { kind: 'magnet' as const, infoHash: HASH, magnet: MAGNET };

    for (let i = 0; i <= 200; i += 1) cache.set(`g${i}`, value);

    expect(cache.size).toBe(200);
    expect(cache.get('g0')).toBeUndefined();
    expect(cache.get('g1')).toBeDefined();
    expect(cache.get('g200')).toBeDefined();
  });

  it('une erreur n’est jamais mise en cache', async () => {
    const cache = new TorrentCache();
    let attempt = 0;
    const { fetch, mock } = mockFetch(() => {
      attempt += 1;
      return attempt === 1 ? new Response('x', { status: 503 }) : torrentResponse(monoTorrent());
    });

    await expect(fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache, guid: 'e' })).rejects.toThrow();
    const retry = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache, guid: 'e' });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(retry.infoHash).toBe(HASH);
  });
});

describe('format bencode via fetch', () => {
  it('un corps vide ou un dictionnaire sans info : erreur de format, pas de crash', async () => {
    const { fetch } = mockFetch(() => torrentResponse(bdict(['x', bint(1)])));

    const error = await errorOf(fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() }));

    expect(error.message).toBe('torrent invalide (malformed)');
  });

  it('un nom en chaîne est accepté (bstr)', async () => {
    const body = bdict(['info', bdict(['length', bint(1)], ['name', bstr('ok')])]);
    const { fetch } = mockFetch(() => torrentResponse(body));

    const result = await fetchTorrent('https://indexeur.example.com/t.torrent', { fetch, cache: new TorrentCache() });

    expect(result.kind === 'torrent' ? result.files[0]?.path : undefined).toBe('ok');
  });
});
