import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { type ErrorBody, loginAs, PASSWORD, request, createProfileVia } from './user-harness.js';

interface UnlockBody {
  token: string;
}

interface MovieBody {
  movie: boolean;
}

interface EpisodesBody {
  episodes: { season: number; episode: number; finished: boolean; positionSec: number; durationSec: number }[];
}

interface ProgressBody {
  items: { type: string; season: number | null; episode: number | null; finished: boolean; positionSec: number }[];
}

interface ContinueBody {
  items: { type: string; tmdbId: number | null; season: number | null; episode: number | null; positionSec: number; suggested: boolean }[];
}

interface FollowsBody {
  items: { type: string; tmdbId: number | null; imdbId: string | null; title: string; poster: string | null; followedAt: string; notify: boolean }[];
}

interface RatingsBody {
  items: { type: string; tmdbId: number | null; title: string | null; rating: number; ratedAt: string }[];
}

let app: RunningApp;
let token: string;
let profile: string;

/** Application neuve, compte « alice » connecté et un profil libre. */
async function boot(userRateLimits?: Partial<{ read: number; write: number; sensitive: number; loginPerUsername: number; authPerIp: number }>): Promise<void> {
  app = await startApp({ userRateLimits });
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  token = await loginAs(app, 'alice');
  profile = (await createProfileVia(app, token, { name: 'Greg' })).body.id;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const at = (iso: string): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(iso));
};

const base = (): string => `/user/profiles/${profile}`;

async function putWatched(body: Record<string, unknown>) {
  return request<ErrorBody | undefined>(app, 'PUT', `${base()}/watched`, { token, body });
}

async function getWatched<T>(type: string, tmdbId: number) {
  return request<T>(app, 'GET', `${base()}/watched/${type}/${tmdbId}`, { token });
}

async function putProgress(body: Record<string, unknown>) {
  return request(app, 'PUT', `${base()}/progress`, { token, body });
}

async function continueList(): Promise<ContinueBody['items']> {
  const res = await request<ContinueBody>(app, 'GET', `${base()}/continue`, { token });
  expect(res.status).toBe(200);
  return res.body.items;
}

/** Épisodes `from` à `to` de la saison `season`, au format attendu par l'API. */
const episodes = (season: number, from: number, to: number): { season: number; episode: number }[] =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ season, episode: from + index }));

describe('vu : film', () => {
  it('marquer vu : {movie:true}, hors de « continuer » ; démarquer : {movie:false}, sans progression restante', async () => {
    expect((await putWatched({ type: 'movie', tmdbId: 603, watched: true })).status).toBe(204);
    expect((await getWatched<MovieBody>('movie', 603)).body).toEqual({ movie: true });
    expect(await continueList()).toEqual([]);

    expect((await putWatched({ type: 'movie', tmdbId: 603, watched: false })).status).toBe(204);
    expect((await getWatched<MovieBody>('movie', 603)).body).toEqual({ movie: false });
    const progress = await request<ProgressBody>(app, 'GET', `${base()}/progress/movie/603`, { token });
    expect(progress.body.items).toEqual([]);
  });

  it('film en cours marqué vu : position ramenée à la durée connue', async () => {
    await putProgress({ type: 'movie', tmdbId: 603, positionSec: 300, durationSec: 1000 });
    await putWatched({ type: 'movie', tmdbId: 603, watched: true });
    const progress = await request<ProgressBody>(app, 'GET', `${base()}/progress/movie/603`, { token });
    expect(progress.body.items).toEqual([expect.objectContaining({ finished: true, positionSec: 1000 })]);
  });
});

describe('vu : série', () => {
  it('saison entière en une écriture : les épisodes listés sont vus, les autres ne le sont pas', async () => {
    const res = await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 10), watched: true });
    expect(res.status).toBe(204);
    const body = (await getWatched<EpisodesBody>('series', 1396)).body;
    expect(body.episodes).toHaveLength(10);
    expect(body.episodes.every((episode) => episode.finished && episode.season === 1)).toBe(true);
    expect(body.episodes.some((episode) => episode.episode === 11)).toBe(false);
  });

  it('décocher retire les vus, mais ne touche pas une lecture en cours', async () => {
    await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 3), watched: true });
    await putProgress({ type: 'series', tmdbId: 1396, season: 1, episode: 4, positionSec: 40, durationSec: 100 });
    const res = await putWatched({ type: 'series', tmdbId: 1396, episodes: [{ season: 1, episode: 1 }, { season: 1, episode: 4 }], watched: false });
    expect(res.status).toBe(204);
    const body = (await getWatched<EpisodesBody>('series', 1396)).body;
    expect(body.episodes.map((episode) => [episode.episode, episode.finished])).toEqual([
      [2, true],
      [3, true],
      [4, false],
    ]);
    expect(body.episodes.find((episode) => episode.episode === 4)?.positionSec).toBe(40);
  });

  it('idempotent : répéter une écriture ne duplique rien et ne change rien', async () => {
    const list = episodes(1, 1, 3);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await putWatched({ type: 'series', tmdbId: 1396, episodes: list, watched: true })).status).toBe(204);
    }
    expect((await getWatched<EpisodesBody>('series', 1396)).body.episodes).toHaveLength(3);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await putWatched({ type: 'series', tmdbId: 1396, episodes: list, watched: false })).status).toBe(204);
    }
    expect((await getWatched<EpisodesBody>('series', 1396)).body.episodes).toEqual([]);
  });

  it('saison 0 (spéciaux) : écrite seulement si elle est listée explicitement', async () => {
    await putWatched({ type: 'series', tmdbId: 1396, episodes: [{ season: 1, episode: 1 }], watched: true });
    expect((await getWatched<EpisodesBody>('series', 1396)).body.episodes.map((e) => [e.season, e.episode])).toEqual([[1, 1]]);
    await putWatched({ type: 'series', tmdbId: 1396, episodes: [{ season: 0, episode: 1 }], watched: true });
    expect((await getWatched<EpisodesBody>('series', 1396)).body.episodes.map((e) => [e.season, e.episode])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
});

describe('continuer à regarder et vus', () => {
  it('après un épisode vu, le suivant non vu est proposé ; les épisodes déjà vus sont sautés', async () => {
    at('2024-03-01T10:00:00.000Z');
    await putWatched({ type: 'series', tmdbId: 1396, episodes: [{ season: 1, episode: 2 }], watched: true });
    at('2024-03-02T10:00:00.000Z');
    await putWatched({ type: 'series', tmdbId: 1396, episodes: [{ season: 1, episode: 1 }], watched: true });
    expect(await continueList()).toEqual([expect.objectContaining({ type: 'series', season: 1, episode: 3, suggested: true })]);
  });

  it('décocher le dernier épisode vu le redonne à regarder', async () => {
    at('2024-03-01T10:00:00.000Z');
    await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 4), watched: true });
    expect(await continueList()).toEqual([expect.objectContaining({ season: 1, episode: 5, suggested: true })]);
    at('2024-03-02T10:00:00.000Z');
    await putWatched({ type: 'series', tmdbId: 1396, episodes: [{ season: 1, episode: 4 }], watched: false });
    expect(await continueList()).toEqual([expect.objectContaining({ season: 1, episode: 4, suggested: true })]);
  });
});

describe('vu : validation et limites', () => {
  it('corps invalide : identifiant absent, type inconnu, épisodes absents ou vides, watched manquant', async () => {
    expect((await putWatched({ type: 'movie', watched: true })).status).toBe(400);
    expect((await putWatched({ type: 'anime', tmdbId: 1, watched: true })).status).toBe(400);
    expect((await putWatched({ type: 'series', tmdbId: 1396, watched: true })).status).toBe(400);
    expect((await putWatched({ type: 'series', tmdbId: 1396, episodes: [], watched: true })).status).toBe(400);
    expect((await putWatched({ type: 'movie', tmdbId: 603 })).status).toBe(400);
    expect((await getWatched<ErrorBody>('anime', 603)).status).toBe(400);
  });

  it('2000 épisodes acceptés ; 2001 refusés (400, chemins seulement)', async () => {
    expect((await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 2000), watched: true })).status).toBe(204);
    const res = await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 2001), watched: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_body', issues: ['episodes:too_big'] });
  });

  it('limite d écriture : au-delà du plafond, 429 rate_limited (même compteur que les autres écritures)', async () => {
    await app.close();
    await boot({ write: 3 });
    // Une écriture de profil a déjà été comptée par boot(). Deux écritures passent, la troisième est refusée.
    const put = () => putWatched({ type: 'movie', tmdbId: 603, watched: true });
    expect((await put()).status).toBe(204);
    expect((await put()).status).toBe(204);
    const limited = await put();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
  });
});

describe('profil protégé par PIN', () => {
  it('vus, suivis, notes et masquage exigent le jeton de profil (403 pin_required sans lui)', async () => {
    const protectedId = (await createProfileVia(app, token, { name: 'Protégé', pin: '1111' })).body.id;
    const unlock = await request<UnlockBody>(app, 'POST', `/user/profiles/${protectedId}/unlock`, { token, body: { pin: '1111' } });
    const pinToken = unlock.body.token;
    const path = `/user/profiles/${protectedId}`;
    const writes = [
      { method: 'PUT', url: `${path}/watched`, body: { type: 'movie', tmdbId: 603, watched: true } },
      { method: 'GET', url: `${path}/watched/movie/603`, body: undefined },
      { method: 'GET', url: `${path}/follows`, body: undefined },
      { method: 'PUT', url: `${path}/follows/movie/603`, body: { title: 'Matrix' } },
      { method: 'PUT', url: `${path}/ratings/movie/603`, body: { rating: 4 } },
      { method: 'GET', url: `${path}/ratings`, body: undefined },
      { method: 'DELETE', url: `${path}/continue/movie/603`, body: undefined },
    ];
    for (const call of writes) {
      const denied = await request<ErrorBody>(app, call.method, call.url, { token, body: call.body });
      expect(denied.status, call.url).toBe(403);
      expect(denied.body, call.url).toEqual({ error: 'pin_required' });
      const allowed = await request(app, call.method, call.url, { token, body: call.body, headers: { 'x-profile-token': pinToken } });
      expect(allowed.status, call.url).not.toBe(403);
    }
  });
});

describe('continuer : masquer un titre', () => {
  it('DELETE : le titre disparaît de « continuer » sans effacer la progression ni les vus', async () => {
    at('2024-03-01T10:00:00.000Z');
    await putProgress({ type: 'movie', tmdbId: 603, positionSec: 300, durationSec: 1000 });
    expect(await continueList()).toHaveLength(1);
    at('2024-03-02T10:00:00.000Z');
    expect((await request(app, 'DELETE', `${base()}/continue/movie/603`, { token })).status).toBe(204);
    expect(await continueList()).toEqual([]);
    const progress = await request<ProgressBody>(app, 'GET', `${base()}/progress/movie/603`, { token });
    expect(progress.body.items).toEqual([expect.objectContaining({ positionSec: 300, finished: false })]);
  });

  it('réapparaît dès qu une progression plus récente que le masquage est enregistrée', async () => {
    at('2024-03-01T10:00:00.000Z');
    await putProgress({ type: 'movie', tmdbId: 603, positionSec: 300, durationSec: 1000 });
    at('2024-03-02T10:00:00.000Z');
    await request(app, 'DELETE', `${base()}/continue/movie/603`, { token });
    at('2024-03-03T10:00:00.000Z');
    await putProgress({ type: 'movie', tmdbId: 603, positionSec: 320, durationSec: 1000 });
    expect(await continueList()).toEqual([expect.objectContaining({ tmdbId: 603, positionSec: 320 })]);
  });
});

describe('suivis', () => {
  it('suivre un titre et une personne, lister, ne plus suivre une personne', async () => {
    const series = await request(app, 'PUT', `${base()}/follows/series/1396`, {
      token,
      body: { title: 'Breaking Bad', imdbId: 'tt0903747', poster: 'https://img.example/p.jpg', notify: true },
    });
    expect(series.status).toBe(204);
    expect((await request(app, 'PUT', `${base()}/follows/person/1`, { token, body: { title: 'Denis Villeneuve' } })).status).toBe(204);

    const list = await request<FollowsBody>(app, 'GET', `${base()}/follows`, { token });
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.find((item) => item.type === 'series')).toMatchObject({
      tmdbId: 1396,
      imdbId: 'tt0903747',
      title: 'Breaking Bad',
      poster: 'https://img.example/p.jpg',
      notify: true,
    });
    expect(list.body.items.find((item) => item.type === 'person')).toMatchObject({ tmdbId: 1, notify: false });

    expect((await request(app, 'DELETE', `${base()}/follows/person/1`, { token })).status).toBe(204);
    const after = await request<FollowsBody>(app, 'GET', `${base()}/follows`, { token });
    expect(after.body.items.map((item) => item.type)).toEqual(['series']);
  });

  it('idempotent : une seconde écriture met à jour sans dupliquer et garde la date d origine', async () => {
    at('2024-04-01T10:00:00.000Z');
    await request(app, 'PUT', `${base()}/follows/movie/603`, { token, body: { title: 'Matrix' } });
    at('2024-04-05T10:00:00.000Z');
    await request(app, 'PUT', `${base()}/follows/movie/603`, { token, body: { title: 'The Matrix', notify: true } });
    const list = await request<FollowsBody>(app, 'GET', `${base()}/follows`, { token });
    expect(list.body.items).toEqual([
      expect.objectContaining({ title: 'The Matrix', notify: true, followedAt: '2024-04-01T10:00:00.000Z' }),
    ]);
    expect((await request(app, 'DELETE', `${base()}/follows/movie/603`, { token })).status).toBe(204);
    expect((await request(app, 'DELETE', `${base()}/follows/movie/603`, { token })).status).toBe(204);
  });

  it('validation : titre requis, type connu, affiche http(s) seulement', async () => {
    expect((await request(app, 'PUT', `${base()}/follows/movie/603`, { token, body: {} })).status).toBe(400);
    expect((await request(app, 'PUT', `${base()}/follows/movie/603`, { token, body: { title: '' } })).status).toBe(400);
    expect((await request(app, 'PUT', `${base()}/follows/movie/603`, { token, body: { title: 'X', poster: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await request(app, 'PUT', `${base()}/follows/anime/603`, { token, body: { title: 'X' } })).status).toBe(400);
  });
});

describe('notes sur 5', () => {
  it('noter par demi-étoiles, remplacer (le titre connu est conservé), filtrer par type, retirer', async () => {
    expect((await request(app, 'PUT', `${base()}/ratings/movie/603`, { token, body: { rating: 4.5, title: 'Matrix' } })).status).toBe(204);
    expect((await request(app, 'PUT', `${base()}/ratings/movie/603`, { token, body: { rating: 3 } })).status).toBe(204);
    expect((await request(app, 'PUT', `${base()}/ratings/series/1396`, { token, body: { rating: 0 } })).status).toBe(204);

    const all = await request<RatingsBody>(app, 'GET', `${base()}/ratings`, { token });
    expect(all.body.items.map((item) => [item.type, item.tmdbId, item.rating, item.title])).toEqual(
      expect.arrayContaining([
        ['movie', 603, 3, 'Matrix'],
        ['series', 1396, 0, null],
      ]),
    );
    const movies = await request<RatingsBody>(app, 'GET', `${base()}/ratings?type=movie`, { token });
    expect(movies.body.items).toHaveLength(1);

    expect((await request(app, 'DELETE', `${base()}/ratings/movie/603`, { token })).status).toBe(204);
    expect((await request<RatingsBody>(app, 'GET', `${base()}/ratings`, { token })).body.items).toHaveLength(1);
  });

  it('valeurs refusées : hors 0 à 5, pas un demi-point, chaîne, type inconnu', async () => {
    for (const rating of [5.5, -0.5, 4.25, '4', null]) {
      const res = await request(app, 'PUT', `${base()}/ratings/movie/603`, { token, body: { rating } });
      expect(res.status, String(rating)).toBe(400);
    }
    expect((await request(app, 'GET', `${base()}/ratings?type=anime`, { token })).status).toBe(400);
    expect((await request(app, 'PUT', `${base()}/ratings/anime/603`, { token, body: { rating: 4 } })).status).toBe(400);
  });
});
