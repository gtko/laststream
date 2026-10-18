import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { type ErrorBody, loginAs, PASSWORD, request } from './user-harness.js';

interface ProfileBody {
  id: string;
}

interface LibraryBody {
  items: { type: string; tmdbId: number | null; imdbId: string | null; title: string; poster: string | null; addedAt: string }[];
}

interface ProgressBody {
  item: ProgressDto;
}

interface ProgressDto {
  type: string;
  tmdbId: number | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  positionSec: number;
  durationSec: number;
  updatedAt: string;
  finished: boolean;
}

interface ContinueBody {
  items: {
    type: string;
    tmdbId: number | null;
    imdbId: string | null;
    season: number | null;
    episode: number | null;
    positionSec: number;
    durationSec: number | null;
    updatedAt: string;
    suggested: boolean;
  }[];
}

let app: RunningApp;
let token: string;
let profile: string;

beforeEach(async () => {
  app = await startApp({});
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  token = await loginAs(app, 'alice');
  profile = ((await request<ProfileBody>(app, 'POST', '/user/profiles', { token, body: { name: 'Greg' } })).body).id;
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const at = (iso: string): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(iso));
};

async function putTitle(type: string, id: string | number, body: Record<string, unknown>) {
  return request<ErrorBody | undefined>(app, 'PUT', `/user/profiles/${profile}/library/${type}/${id}`, { token, body });
}

async function putProgress(body: Record<string, unknown>) {
  return request<ProgressBody | ErrorBody>(app, 'PUT', `/user/profiles/${profile}/progress`, { token, body });
}

async function continueList(): Promise<ContinueBody['items']> {
  const res = await request<ContinueBody>(app, 'GET', `/user/profiles/${profile}/continue`, { token });
  expect(res.status).toBe(200);
  return res.body.items;
}

describe('bibliothèque', () => {
  it('ajoute un film, le retrouve avec ses identifiants, sans renvoyer de champ interne', async () => {
    const put = await putTitle('movie', 603, { imdbId: 'tt0133093', title: 'Matrix', poster: 'https://img.example/m.jpg' });
    expect(put.status).toBe(204);
    const res = await request<LibraryBody>(app, 'GET', `/user/profiles/${profile}/library`, { token });
    expect(res.body.items).toEqual([
      {
        type: 'movie',
        tmdbId: 603,
        imdbId: 'tt0133093',
        title: 'Matrix',
        poster: 'https://img.example/m.jpg',
        addedAt: expect.any(String),
        visibility: 'private',
      },
    ]);
  });

  it('filtre par type et trie par titre ou par date d ajout (plus récent d abord)', async () => {
    at('2024-01-01T10:00:00.000Z');
    await putTitle('movie', 1, { title: 'Zodiac' });
    at('2024-01-02T10:00:00.000Z');
    await putTitle('series', 2, { title: 'Arrested' });
    at('2024-01-03T10:00:00.000Z');
    await putTitle('movie', 3, { title: 'Alien' });

    const base = `/user/profiles/${profile}/library`;
    const byDate = await request<LibraryBody>(app, 'GET', base, { token });
    expect(byDate.body.items.map((item) => item.title)).toEqual(['Alien', 'Arrested', 'Zodiac']);
    const byTitle = await request<LibraryBody>(app, 'GET', `${base}?sort=title`, { token });
    expect(byTitle.body.items.map((item) => item.title)).toEqual(['Alien', 'Arrested', 'Zodiac']);
    const series = await request<LibraryBody>(app, 'GET', `${base}?type=series`, { token });
    expect(series.body.items.map((item) => item.title)).toEqual(['Arrested']);
    const invalid = await request<ErrorBody>(app, 'GET', `${base}?type=anime`, { token });
    expect(invalid.status).toBe(400);
  });

  it('suppression logique : le titre disparaît, puis reparaît avec une nouvelle date s il est rajouté', async () => {
    at('2024-01-01T10:00:00.000Z');
    await putTitle('movie', 603, { title: 'Matrix' });
    const del = await request(app, 'DELETE', `/user/profiles/${profile}/library/movie/603`, { token });
    expect(del.status).toBe(204);
    const hidden = await request<LibraryBody>(app, 'GET', `/user/profiles/${profile}/library`, { token });
    expect(hidden.body.items).toEqual([]);

    at('2024-02-01T10:00:00.000Z');
    await putTitle('movie', 603, { title: 'Matrix' });
    const back = await request<LibraryBody>(app, 'GET', `/user/profiles/${profile}/library`, { token });
    expect(back.body.items[0]?.addedAt).toBe('2024-02-01T10:00:00.000Z');
  });

  it('un titre rajouté sans identifiant TMDB est référencé par son identifiant IMDb', async () => {
    const put = await putTitle('series', 'tt0944947', { title: 'Game of Thrones' });
    expect(put.status).toBe(204);
    const res = await request<LibraryBody>(app, 'GET', `/user/profiles/${profile}/library`, { token });
    expect(res.body.items[0]).toMatchObject({ type: 'series', tmdbId: null, imdbId: 'tt0944947' });
    const del = await request(app, 'DELETE', `/user/profiles/${profile}/library/series/tt0944947`, { token });
    expect(del.status).toBe(204);
  });

  it('valide le titre, le type, l identifiant et l adresse de l affiche', async () => {
    expect((await putTitle('movie', 603, { title: '' })).status).toBe(400);
    expect((await putTitle('movie', 603, { title: 'X', poster: 'javascript:alert(1)' })).status).toBe(400);
    expect((await putTitle('movie', 603, { title: 'X', imdbId: 'pas-un-id' })).status).toBe(400);
    expect((await putTitle('anime', 603, { title: 'X' })).status).toBe(400);
    expect((await putTitle('movie', 'abc', { title: 'X' })).status).toBe(400);
  });
});

describe('progression', () => {
  it('finie à partir de 90 % : 80 % reste en cours, 92 % est terminée', async () => {
    const half = (await putProgress({ type: 'movie', tmdbId: 603, positionSec: 4000, durationSec: 5000 })).body as ProgressBody;
    expect(half.item.finished).toBe(false);
    const done = (await putProgress({ type: 'movie', tmdbId: 603, positionSec: 4600, durationSec: 5000 })).body as ProgressBody;
    expect(done.item.finished).toBe(true);
  });

  it('série : saison et épisode obligatoires ; identifiant TMDB ou IMDb obligatoire', async () => {
    expect((await putProgress({ type: 'series', tmdbId: 1396, positionSec: 10, durationSec: 100 })).status).toBe(400);
    expect((await putProgress({ type: 'movie', positionSec: 10, durationSec: 100 })).status).toBe(400);
    const ok = await putProgress({ type: 'series', imdbId: 'tt0903747', season: 1, episode: 2, positionSec: 10, durationSec: 100 });
    expect(ok.status).toBe(200);
    expect((ok.body as ProgressBody).item).toMatchObject({ imdbId: 'tt0903747', tmdbId: null, season: 1, episode: 2 });
  });

  it('per-episode : liste par épisode triée, film sans saison ni épisode', async () => {
    await putProgress({ type: 'series', tmdbId: 1396, season: 2, episode: 1, positionSec: 100, durationSec: 100 });
    await putProgress({ type: 'series', tmdbId: 1396, season: 1, episode: 3, positionSec: 50, durationSec: 100 });
    await putProgress({ type: 'movie', tmdbId: 1396, positionSec: 5, durationSec: 100 });
    const res = await request<{ items: ProgressDto[] }>(app, 'GET', `/user/profiles/${profile}/progress/series/1396`, { token });
    expect(res.body.items.map((item) => [item.season, item.episode, item.finished])).toEqual([
      [1, 3, false],
      [2, 1, true],
    ]);
    const movie = await request<{ items: ProgressDto[] }>(app, 'GET', `/user/profiles/${profile}/progress/movie/1396`, { token });
    expect(movie.body.items).toMatchObject([{ type: 'movie', season: null, episode: null, positionSec: 5 }]);
  });

  it('une écriture plus ancienne que la ligne existante est ignorée (pas de retour en arrière)', async () => {
    at('2024-05-01T10:00:00.000Z');
    await putProgress({ type: 'movie', tmdbId: 603, positionSec: 900, durationSec: 1000 });
    at('2024-04-01T10:00:00.000Z');
    const res = await request<{ items: ProgressDto[] }>(app, 'GET', `/user/profiles/${profile}/progress/movie/603`, { token });
    expect(res.body.items[0]?.positionSec).toBe(900);
  });
});

describe('continuer à regarder', () => {
  it('film en cours inclus, film terminé exclu, série terminée : épisode suivant proposé', async () => {
    at('2024-03-01T10:00:00.000Z');
    await putProgress({ type: 'movie', tmdbId: 603, positionSec: 300, durationSec: 1000 });
    at('2024-03-02T10:00:00.000Z');
    await putProgress({ type: 'movie', tmdbId: 27205, positionSec: 990, durationSec: 1000 });
    at('2024-03-03T10:00:00.000Z');
    await putProgress({ type: 'series', tmdbId: 1396, season: 1, episode: 3, positionSec: 2000, durationSec: 2000 });

    const items = await continueList();
    expect(items).toEqual([
      expect.objectContaining({ type: 'series', tmdbId: 1396, season: 1, episode: 4, positionSec: 0, durationSec: null, suggested: true }),
      expect.objectContaining({ type: 'movie', tmdbId: 603, positionSec: 300, durationSec: 1000, suggested: false }),
    ]);
  });

  it('série : une seule entrée par titre, la plus récente ; reprise de l épisode en cours', async () => {
    at('2024-03-01T10:00:00.000Z');
    await putProgress({ type: 'series', tmdbId: 1396, season: 1, episode: 1, positionSec: 100, durationSec: 100 });
    at('2024-03-02T10:00:00.000Z');
    await putProgress({ type: 'series', tmdbId: 1396, season: 1, episode: 2, positionSec: 40, durationSec: 100 });
    const items = await continueList();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ season: 1, episode: 2, positionSec: 40, suggested: false });
  });

  it('après un épisode terminé, reprend le suivant déjà commencé plutôt que d en proposer un nouveau', async () => {
    at('2024-03-01T10:00:00.000Z');
    await putProgress({ type: 'series', tmdbId: 1396, season: 1, episode: 2, positionSec: 30, durationSec: 100 });
    at('2024-03-02T10:00:00.000Z');
    await putProgress({ type: 'series', tmdbId: 1396, season: 1, episode: 1, positionSec: 100, durationSec: 100 });
    const items = await continueList();
    expect(items).toEqual([expect.objectContaining({ season: 1, episode: 2, positionSec: 30, suggested: false })]);
  });

  it('triée par date de mise à jour décroissante et limitée à 30 éléments', async () => {
    for (let index = 0; index < 35; index += 1) {
      at(new Date(Date.UTC(2024, 0, 1) + index * 3_600_000).toISOString());
      await putProgress({ type: 'movie', tmdbId: 1000 + index, positionSec: 10, durationSec: 100 });
    }
    const items = await continueList();
    expect(items).toHaveLength(30);
    expect(items[0]?.tmdbId).toBe(1034);
    expect(items[29]?.tmdbId).toBe(1005);
  });

  it('progression isolée par profil', async () => {
    await putProgress({ type: 'movie', tmdbId: 603, positionSec: 10, durationSec: 100 });
    const other = (await request<ProfileBody>(app, 'POST', '/user/profiles', { token, body: { name: 'Autre' } })).body;
    const res = await request<ContinueBody>(app, 'GET', `/user/profiles/${other.id}/continue`, { token });
    expect(res.body.items).toEqual([]);
  });
});
