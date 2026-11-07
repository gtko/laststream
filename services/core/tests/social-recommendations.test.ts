import type { HomeRecommendationsResponse } from '@laststream/protocol/social';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

/**
 * Coups de cœur des amis (LAST-191, lot 2) : PUT et DELETE /user/social/recommendations, GET /user/social/home/recommendations.
 * Chaque règle a une assertion « absent » et un témoin « présent ». Le garde-fou est celui de l'accueil, sans l'exclusion des
 * amis invisibles (un coup de cœur est un geste volontaire).
 */

const NOW_MS = Date.parse('2026-05-01T10:00:00.000Z');
const HOUR = 60 * 60_000;

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  app = await startApp({});
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Coup de cœur valide (Matrix), surchargeable. */
const DEFAULT_BODY: Record<string, unknown> = { type: 'movie', tmdbId: 603, title: 'Matrix', word: 'Un classique' };

const recommend = (who: Acting, overrides: Record<string, unknown> = {}) =>
  as(app, who, 'PUT', '/user/social/recommendations', { body: { ...DEFAULT_BODY, ...overrides } });

/** Écrit un coup de cœur à l'instant `ms` ; l'horloge revient à NOW ensuite. */
async function recommendAt(who: Acting, ms: number, overrides: Record<string, unknown>): Promise<void> {
  vi.setSystemTime(ms);
  const res = await recommend(who, overrides);
  vi.setSystemTime(NOW_MS);
  expect(res.status).toBe(204);
}

const listOf = (who: Acting, query = '') =>
  as<HomeRecommendationsResponse & ErrorBodyV2>(app, who, 'GET', `/user/social/home/recommendations${query}`);

/** Pids des coups de cœur vus par `who` (la réponse doit être 200). */
async function seenBy(who: Acting, query = ''): Promise<string[]> {
  const res = await listOf(who, query);
  expect(res.status).toBe(200);
  return res.body.items.map((item) => item.friend.pid);
}

describe('témoin : un ami accepté qui recommande', () => {
  it('apparaît avec son mot, son titre et son genre', async () => {
    expect((await recommend(cast.bob)).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    const { body } = await listOf(cast.alice);
    expect(body.items[0]).toMatchObject({
      friend: { pid: cast.bob.pid, handle: { full: cast.bob.full } },
      media: { type: 'movie', tmdbId: 603, title: 'Matrix' },
      word: 'Un classique',
    });
  });
});

describe('blocage, dans les deux sens', () => {
  it('un ami que je bloque disparaît', async () => {
    await recommend(cast.bob);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    expect((await as(app, cast.alice, 'POST', `/user/social/blocks/${cast.bob.pid}`)).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([]);
  });

  it('un profil qui m a bloqué disparaît', async () => {
    await recommend(cast.bob);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    expect((await as(app, cast.bob, 'POST', `/user/social/blocks/${cast.alice.pid}`)).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([]);
  });
});

describe('non-amis et demande en attente', () => {
  it('carol, sans lien puis en demande en attente, est absente ; une fois acceptée, présente', async () => {
    await recommendAt(cast.bob, NOW_MS - HOUR, {});
    await recommend(cast.carol, { tmdbId: 680, title: 'Alien', word: 'Culte' });
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);

    expect((await as(app, cast.alice, 'POST', '/user/social/requests', { body: { handle: cast.carol.full } })).status).toBe(201);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);

    expect((await as(app, cast.carol, 'POST', `/user/social/requests/${cast.alice.pid}/accept`)).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual([cast.carol.pid, cast.bob.pid]);
  });
});

describe('foyer exclu', () => {
  it('un autre profil du même compte n est jamais listé, moi non plus', async () => {
    await recommendAt(cast.bob, NOW_MS - HOUR, {});
    await recommend(cast.alice2, { tmdbId: 680, title: 'Alien', word: 'Foyer' });
    await recommend(cast.alice, { type: 'series', tmdbId: 1399, title: 'Serie', word: 'Mienne' });
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
  });
});

describe('profil enfant', () => {
  it('un profil enfant : 403 en lecture, en écriture et en suppression ; mes amis ne changent pas', async () => {
    await recommend(cast.bob);
    const read = await as<ErrorBodyV2>(app, cast.kid, 'GET', '/user/social/home/recommendations');
    expect(read.status).toBe(403);
    expect(read.body.error).toBe('kid_profile');

    const write = await as<ErrorBodyV2>(app, cast.kid, 'PUT', '/user/social/recommendations', { body: DEFAULT_BODY });
    expect(write.status).toBe(403);
    expect(write.body.error).toBe('kid_profile');

    const remove = await as<ErrorBodyV2>(app, cast.kid, 'DELETE', '/user/social/recommendations/movie/603');
    expect(remove.status).toBe(403);
    expect(remove.body.error).toBe('kid_profile');

    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
  });
});

describe('ami invisible reste visible', () => {
  it('un ami en statut invisible garde son coup de cœur ; passer en « away » ne change rien', async () => {
    await recommend(cast.bob);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    expect((await as(app, cast.bob, 'PUT', '/user/social/status', { body: { status: 'invisible' } })).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    await as(app, cast.bob, 'PUT', '/user/social/status', { body: { status: 'away' } });
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
  });
});

describe('réglages du lecteur : sourdine et masquage', () => {
  it('sourdine posée par moi : absent ; levée : présent', async () => {
    await recommend(cast.bob);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    expect((await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { muted: true } })).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual([]);
    await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { muted: false } });
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
  });

  it('masquage d activité posé par moi : absent ; levé : présent', async () => {
    await recommend(cast.bob);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    expect((await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { hideActivity: true } })).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual([]);
    await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { hideActivity: false } });
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
  });
});

describe('validation', () => {
  it('genre, identifiant TMDB, titre, affiche ou clé inconnue : 400 ; le même coup de cœur corrigé : 204', async () => {
    const bad = [{ type: 'film' }, { tmdbId: 0 }, { tmdbId: -3 }, { tmdbId: 1.5 }, { tmdbId: '603' }, { title: '' }, { title: 'x'.repeat(201) }, { poster: 42 }, { extra: true }];
    for (const overrides of bad) {
      expect((await recommend(cast.bob, overrides)).status).toBe(400);
    }
    expect(await seenBy(cast.alice)).toEqual([]);
    expect((await recommend(cast.bob)).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
  });

  it('mot vide, blanc ou de plus de 140 caractères : 400 ; 140 caractères après rognage des espaces : 204', async () => {
    for (const word of ['', '   ', 'x'.repeat(141), `${'x'.repeat(141)}  `]) {
      expect((await recommend(cast.bob, { word })).status).toBe(400);
    }
    expect(await seenBy(cast.alice)).toEqual([]);
    expect((await recommend(cast.bob, { word: `   ${'x'.repeat(140)}   ` })).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    const { body } = await listOf(cast.alice);
    expect(body.items[0]?.word).toHaveLength(140);
  });

  it('paramètres de suppression invalides : 400 ; un titre valide : 204', async () => {
    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/film/603')).status).toBe(400);
    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/movie/0')).status).toBe(400);
    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/movie/abc')).status).toBe(400);
    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/movie/603')).status).toBe(204);
  });
});

describe('suppression', () => {
  it('retire mon coup de cœur, sans effet sur celui d un autre profil ; idempotente', async () => {
    await recommend(cast.bob);
    expect((await as(app, cast.alice, 'DELETE', '/user/social/recommendations/movie/603')).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);

    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/movie/603')).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([]);
    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/movie/603')).status).toBe(204);
  });
});

describe('upsert', () => {
  it('un second coup de cœur sur le même titre remplace le mot : une seule entrée, datée du nouveau', async () => {
    await recommendAt(cast.bob, NOW_MS - HOUR, { word: 'Premier mot' });
    expect((await listOf(cast.alice)).body.items[0]?.word).toBe('Premier mot');

    await recommend(cast.bob, { word: 'Second mot' });
    const { body } = await listOf(cast.alice);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ word: 'Second mot', createdAt: NOW_MS });
  });
});

describe('affiche', () => {
  it('un chemin TMDB est gardé ; une autre adresse est retirée sans erreur', async () => {
    await recommend(cast.bob, { poster: '/abc123.jpg' });
    expect((await listOf(cast.alice)).body.items[0]?.media.poster).toBe('/abc123.jpg');

    expect((await recommend(cast.bob, { poster: 'https://evil.example/x.jpg' })).status).toBe(204);
    const media = (await listOf(cast.alice)).body.items[0]?.media;
    expect(media).toBeDefined();
    expect(media).not.toHaveProperty('poster');
  });
});

describe('pagination et tri', () => {
  it('du plus récent au plus ancien ; next seulement si la page est pleine ; before est strict', async () => {
    await befriend(app, cast.alice, cast.carol);
    await recommendAt(cast.bob, NOW_MS - 3 * HOUR, { tmdbId: 603, title: 'Matrix', word: 'a' });
    await recommendAt(cast.bob, NOW_MS - 2 * HOUR, { tmdbId: 680, title: 'Alien', word: 'b' });
    await recommendAt(cast.carol, NOW_MS - HOUR, { type: 'series', tmdbId: 1399, title: 'Serie', word: 'c' });

    const first = await listOf(cast.alice, '?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((item) => item.media.tmdbId)).toEqual([1399, 680]);
    expect(first.body.next).toBe(NOW_MS - 2 * HOUR);

    const second = await listOf(cast.alice, `?limit=2&before=${NOW_MS - 2 * HOUR}`);
    expect(second.body.items.map((item) => item.media.tmdbId)).toEqual([603]);
    expect(second.body).not.toHaveProperty('next');

    const all = await listOf(cast.alice);
    expect(all.body.items).toHaveLength(3);
    expect(all.body).not.toHaveProperty('next');
  });

  it('limit hors de 1 à 50 et before mal formé : 400 ; limit=50 : 200', async () => {
    expect((await listOf(cast.alice, '?limit=0')).status).toBe(400);
    expect((await listOf(cast.alice, '?limit=51')).status).toBe(400);
    expect((await listOf(cast.alice, '?before=abc')).status).toBe(400);
    expect((await listOf(cast.alice, '?limit=50')).status).toBe(200);
  });
});

describe('forme de l entrée', () => {
  it('friend ne porte que pid, handle, couleur et surnom posé par moi ; media porte titre, genre et affiche, sans saison', async () => {
    await recommend(cast.bob, { poster: '/abc123.jpg' });
    await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { nickname: 'Bobby' } });
    const item = (await listOf(cast.alice)).body.items[0];
    expect(Object.keys(item ?? {}).sort()).toEqual(['createdAt', 'friend', 'media', 'word']);
    expect(Object.keys(item?.friend ?? {}).sort()).toEqual(['avatarColor', 'handle', 'nickname', 'pid']);
    expect(Object.keys(item?.media ?? {}).sort()).toEqual(['poster', 'title', 'tmdbId', 'type']);
    expect(item).toMatchObject({ friend: { nickname: 'Bobby' } });
  });
});

describe('bornes et profil devenu enfant', () => {
  it('tmdbId : 999 999 999 accepté en PUT puis retiré en DELETE ; 1 000 000 000 refusé partout', async () => {
    expect((await recommend(cast.bob, { tmdbId: 999_999_999 })).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/movie/999999999')).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual([]);
    expect((await recommend(cast.bob, { tmdbId: 1_000_000_000 })).status).toBe(400);
    expect((await as(app, cast.bob, 'DELETE', '/user/social/recommendations/movie/1000000000')).status).toBe(400);
  });

  it('un adulte qui a un coup de cœur et devient enfant : 200 (pas de 500) ; son coup de cœur disparaît pour ses amis', async () => {
    await as(app, cast.alice2, 'PUT', '/user/social/status', { body: { status: 'online' } });
    expect((await recommend(cast.alice2)).status).toBe(204);
    const toKid = await as(app, cast.alice, 'PATCH', `/user/profiles/${cast.alice2.profile}`, { body: { isKid: true } });
    expect(toKid.status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual([]);
  });

  it('choix produit : historyVisible faux et activityVisibility « nobody » chez l ami laissent ses coups de cœur visibles', async () => {
    await recommend(cast.bob);
    expect((await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { historyVisible: false, activityVisibility: 'nobody' } })).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual([cast.bob.pid]);
  });
});

describe('plafond', () => {
  it('au-delà de 500 coups de cœur : 429 recommendation_limit_reached pour une nouvelle clé ; remplacer une clé existante : 204', async () => {
    for (let id = 1; id <= 500; id++) expect((await recommend(cast.bob, { tmdbId: id })).status).toBe(204);
    const over = await as<ErrorBodyV2>(app, cast.bob, 'PUT', '/user/social/recommendations', { body: { ...DEFAULT_BODY, tmdbId: 501 } });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('recommendation_limit_reached');
    expect((await recommend(cast.bob, { tmdbId: 7, word: 'Remplacé' })).status).toBe(204);
  }, 60_000);
});
