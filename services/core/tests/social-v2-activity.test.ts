import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActivityItem, heatmapBuckets, isActivityRating, progressActivityKinds, utcDay } from '../src/user/social-v2-activity.js';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { liveFrame } from '../src/user/social-v2-live.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';
import { request } from './user-harness.js';

interface ActivityBody {
  id: string;
  pid: string;
  handle: { name: string; tag: string; full: string };
  avatarColor: string;
  kind: string;
  media: { type: string; tmdbId: number; title: string; poster?: string; season?: number; episode?: number };
  rating?: number;
  at: number;
}

interface NoteBody {
  id: string;
  author: { pid: string; handle: { name: string; tag: string; full: string }; avatarColor: string };
  pos: number;
  kind: 'text' | 'emoji';
  body: string;
  createdAt: number;
}

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const NOW = '2026-05-01T10:00:00.000Z';
const START = Date.parse(NOW);
const MINUTE = 60_000;
const DAY = 86_400_000;
const SMILE = '\u{1F600}';

/** Événements émis pendant le test (gestionnaire injecté dans l'application). */
const emitted: Emitted[] = [];

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  emitted.length = 0;
  app = await startApp({
    extra: {
      socialEvents: (pids, event) => {
        emitted.push({ pids: [...pids], event });
      },
    },
  });
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
  emitted.length = 0;
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Place l'horloge à `ms` après le début du scénario. */
const at = (ms: number): void => {
  vi.setSystemTime(new Date(START + ms));
};

const movieProgress = (who: Acting, tmdbId: number, positionSec: number, durationSec = 7200) =>
  request(app, 'PUT', `/user/profiles/${who.profile}/progress`, {
    token: who.token,
    body: { type: 'movie', tmdbId, positionSec, durationSec },
  });

const episodeProgress = (who: Acting, tmdbId: number, season: number, episode: number, positionSec: number) =>
  request(app, 'PUT', `/user/profiles/${who.profile}/progress`, {
    token: who.token,
    body: { type: 'series', tmdbId, season, episode, positionSec, durationSec: 3000 },
  });

const feed = (who: Acting, query = '') => as<{ items: ActivityBody[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/activity${query}`);
const kindsOf = async (who: Acting): Promise<string[]> => (await feed(who)).body.items.map((item) => item.kind);

const note = (who: Acting, over: Record<string, unknown>) =>
  as<{ note: NoteBody } & ErrorBodyV2>(app, who, 'POST', '/user/social/notes', {
    body: { type: 'movie', tmdbId: 603, pos: 10, kind: 'text', body: 'Note', ...over },
  });
const heatmap = (who: Acting, query: string) => as<{ buckets: number[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/notes/heatmap${query}`);

interface MissedBody extends ErrorBodyV2 {
  messages: number;
  byFriend: Array<{ pid: string; handle: { full: string }; count: number }>;
  notes: NoteBody[];
}
const missed = (who: Acting, query: string) => as<MissedBody>(app, who, 'GET', `/user/social/missed${query}`);
const say = (from: Persona, to: Persona, body: string) => as(app, from, 'POST', `/user/social/messages/${to.pid}`, { body: { body } });

describe('débuts et fins de lecture (PUT /user/profiles/:id/progress)', () => {
  it('un premier relevé crée « started », visible par l’ami ; les relevés suivants du même titre et du même jour n’en créent pas', async () => {
    at(0);
    expect((await movieProgress(cast.alice, 603, 100)).status).toBe(200);
    at(MINUTE);
    expect((await movieProgress(cast.alice, 603, 200)).status).toBe(200);

    const items = (await feed(cast.bob)).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ pid: cast.alice.pid, kind: 'started', media: { type: 'movie', tmdbId: 603 } });
    // Friends-only diffusion : rien en temps réel tant que les préférences S2 (friendStarts) ne sont pas branchées.
    expect(emitted.some((event) => event.event.t === 'activity')).toBe(false);
  });

  it('dédoublonnage par titre et par jour : fin une fois, épisodes du même jour fondus, nouveau jour = nouvel événement', async () => {
    at(0);
    await episodeProgress(cast.alice, 1399, 1, 1, 300);
    at(MINUTE);
    await episodeProgress(cast.alice, 1399, 1, 2, 300);
    at(2 * MINUTE);
    await episodeProgress(cast.alice, 1399, 1, 1, 2900);
    at(3 * MINUTE);
    await episodeProgress(cast.alice, 1399, 1, 2, 2950);
    expect(await kindsOf(cast.bob)).toEqual(['finished', 'started']);

    at(DAY + MINUTE);
    await episodeProgress(cast.alice, 1399, 1, 3, 300);
    expect(await kindsOf(cast.bob)).toEqual(['started', 'finished', 'started']);
  });

  it('un profil enfant écrit sa progression sans produire d’activité', async () => {
    at(0);
    expect((await movieProgress(cast.kid, 603, 100)).status).toBe(200);
    expect((await feed(cast.bob)).body.items).toEqual([]);
  });

  it('notes : une seule entrée « noted » par titre et par jour', async () => {
    at(0);
    expect((await note(cast.alice, { pos: 10, body: 'un' })).status).toBe(201);
    at(MINUTE);
    await note(cast.alice, { pos: 20, body: 'deux' });
    expect(await kindsOf(cast.bob)).toEqual(['noted']);

    at(DAY + MINUTE);
    await note(cast.alice, { pos: 30, body: 'trois' });
    expect(await kindsOf(cast.bob)).toEqual(['noted', 'noted']);
  });
});

describe('flux d’activité (GET /user/social/activity)', () => {
  it('pagination : 30 par page par défaut, la suite par « before » sans doublon ; bornes de limit', async () => {
    for (let i = 0; i < 35; i++) {
      at(i * 1000);
      await movieProgress(cast.alice, 1000 + i, 10, 100);
    }
    const first = await feed(cast.bob);
    expect(first.body.items).toHaveLength(30);
    const last = first.body.items[29];
    expect(last).toBeDefined();
    const second = await feed(cast.bob, `?before=${last?.at ?? 0}`);
    expect(second.body.items).toHaveLength(5);
    const ids = [...first.body.items, ...second.body.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(35);
    expect(first.body.items[0]?.at ?? 0).toBeGreaterThan(last?.at ?? 0);

    expect((await feed(cast.bob, '?limit=50')).body.items).toHaveLength(35);
    expect((await feed(cast.bob, '?limit=0')).status).toBe(400);
    expect((await feed(cast.bob, '?limit=51')).status).toBe(400);
  });

  it('droits : pas de mes événements, ni de ceux d’un non-ami ; l’ami et le foyer voient les miens, pas ceux d’un ami étranger au foyer', async () => {
    at(0);
    await movieProgress(cast.alice, 603, 100);
    await movieProgress(cast.bob, 680, 100);
    // Alice (amie de Bob) voit Bob, jamais elle-même. Carol (aucun lien) ne voit rien.
    expect((await feed(cast.alice)).body.items).toEqual([expect.objectContaining({ pid: cast.bob.pid })]);
    expect((await feed(cast.carol)).body.items).toEqual([]);
    // Bob voit Alice, pas lui-même. Alice Deux (foyer d'Alice) voit Alice, pas Bob (qui n'est pas du foyer).
    expect((await feed(cast.bob)).body.items).toEqual([expect.objectContaining({ pid: cast.alice.pid })]);
    expect((await feed(cast.alice2)).body.items).toEqual([expect.objectContaining({ pid: cast.alice.pid })]);
  });

  it('statut invisible : mes événements ne sont vus ni des amis ni du foyer', async () => {
    at(0);
    await movieProgress(cast.alice, 603, 100);
    expect(await kindsOf(cast.bob)).toEqual(['started']);
    await as(app, cast.alice, 'PUT', '/user/social/status', { body: { status: 'invisible' } });
    expect((await feed(cast.bob)).body.items).toEqual([]);
    expect((await feed(cast.alice2)).body.items).toEqual([]);
  });

  it('profil enfant : 403 kid_profile', async () => {
    const res = await feed(cast.kid);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('kid_profile');
  });
});

describe('carte de chaleur (GET /user/social/notes/heatmap)', () => {
  it('compte les notes de moi, des amis et du foyer par tranche de ma durée ; une note d’un inconnu n’entre pas', async () => {
    at(0);
    await movieProgress(cast.alice, 603, 10, 1000);
    await note(cast.alice, { pos: 50 });
    await note(cast.bob, { pos: 550, kind: 'emoji', body: SMILE });
    await note(cast.alice, { pos: 999 });
    await note(cast.bob, { pos: 1000, kind: 'emoji', body: SMILE });
    await note(cast.alice2, { pos: 710 });
    await note(cast.carol, { pos: 300 });

    const mine = await heatmap(cast.alice, '?type=movie&tmdbId=603&buckets=10');
    expect(mine.status).toBe(200);
    expect(mine.body.buckets).toEqual([1, 0, 0, 0, 0, 1, 0, 1, 0, 2]);

    // Bob n'a pas de progression : la durée vient de la plus grande position visible (1000), sans la note du foyer d'Alice.
    const theirs = await heatmap(cast.bob, '?type=movie&tmdbId=603&buckets=10');
    expect(theirs.body.buckets).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 2]);
  });

  it('défaut 60 tranches ; bornes 1 à 200', async () => {
    expect((await heatmap(cast.bob, '?type=movie&tmdbId=603')).body.buckets).toHaveLength(60);
    expect((await heatmap(cast.bob, '?type=movie&tmdbId=603&buckets=200')).body.buckets).toHaveLength(200);
    expect((await heatmap(cast.bob, '?type=movie&tmdbId=603&buckets=0')).status).toBe(400);
    expect((await heatmap(cast.bob, '?type=movie&tmdbId=603&buckets=201')).status).toBe(400);
  });
});

describe('résumé manqué (GET /user/social/missed)', () => {
  it('messages des amis et du foyer depuis since (exclu), notes des autres sur le titre ; mes notes et celles des inconnus exclues', async () => {
    at(1000);
    await say(cast.alice, cast.bob, 'un');
    at(1200);
    await note(cast.alice, { pos: 10, body: 'avant' });
    at(1800);
    await note(cast.alice, { pos: 20, body: 'apres' });
    at(1900);
    await note(cast.bob, { pos: 30, body: 'bob' });
    at(1950);
    await note(cast.carol, { pos: 40, body: 'carol' });
    at(2000);
    await say(cast.alice, cast.bob, 'deux');
    at(2100);
    await note(cast.alice2, { pos: 50, body: 'foyer' });

    const since = (ms: number) => `?since=${START + ms}&type=movie&tmdbId=603`;
    const bob = await missed(cast.bob, since(1500));
    expect(bob.status).toBe(200);
    expect(bob.body.messages).toBe(1);
    expect(bob.body.byFriend).toEqual([{ pid: cast.alice.pid, handle: expect.objectContaining({ full: cast.alice.full }), count: 1 }]);
    expect(bob.body.notes.map((n) => n.body)).toEqual(['apres']);

    // Exclusif : un message ou une note à l'instant « since » n'est pas compté.
    const edge = await missed(cast.bob, since(2000));
    expect(edge.body.messages).toBe(0);
    expect(edge.body.byFriend).toEqual([]);
    expect(edge.body.notes).toEqual([]);

    // Alice voit les notes de son ami et de son foyer, pas les siennes.
    const alice = await missed(cast.alice, since(1500));
    expect(alice.body.notes.map((n) => n.body)).toEqual(['bob', 'foyer']);
  });

  it('sans titre : notes vides ; titre incomplet ou since absent : 400', async () => {
    at(1000);
    await say(cast.alice, cast.bob, 'un');
    const res = await missed(cast.bob, `?since=${START + 500}`);
    expect(res.body.messages).toBe(1);
    expect(res.body.notes).toEqual([]);
    expect((await missed(cast.bob, `?since=${START + 500}&type=movie`)).status).toBe(400);
    expect((await missed(cast.bob, '?type=movie&tmdbId=603')).status).toBe(400);
  });
});

describe('règles pures', () => {
  it('progressActivityKinds : débuts (position positive depuis rien) et fins (ligne devenue terminée)', () => {
    expect(progressActivityKinds(undefined, { positionSec: 0, finished: false })).toEqual([]);
    expect(progressActivityKinds(undefined, { positionSec: 10, finished: false })).toEqual(['started']);
    expect(progressActivityKinds(undefined, { positionSec: 10, finished: true })).toEqual(['started', 'finished']);
    expect(progressActivityKinds({ positionSec: 0, finished: false }, { positionSec: 5, finished: false })).toEqual(['started']);
    expect(progressActivityKinds({ positionSec: 10, finished: false }, { positionSec: 95, finished: true })).toEqual(['finished']);
    expect(progressActivityKinds({ positionSec: 95, finished: true }, { positionSec: 96, finished: true })).toEqual([]);
  });

  it('heatmapBuckets : tranches égales ; au-delà de la durée, dernière tranche ; sans durée, première', () => {
    expect(heatmapBuckets([0, 999, 1000, 2000], 1000, 4)).toEqual([1, 0, 0, 3]);
    expect(heatmapBuckets([5, 7], 0, 3)).toEqual([2, 0, 0]);
    expect(heatmapBuckets([], 1000, 2)).toEqual([0, 0]);
  });

  it('utcDay et isActivityRating : jour UTC, notes par demi-étoiles de 0,5 à 5', () => {
    expect(utcDay(START)).toBe('2026-05-01');
    expect([0.5, 4.5, 5].every((value) => isActivityRating(value))).toBe(true);
    expect([0, 0.3, 4.25, 5.5].some((value) => isActivityRating(value))).toBe(false);
  });

  it('trame temps réel « activity » : seuls les champs du contrat', () => {
    const item: ActivityItem = {
      id: 'a1',
      pid: cast.alice.pid,
      handle: { name: 'alice', tag: 'A7K2', full: 'alice#A7K2' },
      avatarColor: '#ff5a36',
      kind: 'started',
      media: { type: 'movie', tmdbId: 603, title: 'Matrix' },
      at: START,
    };
    expect(liveFrame({ t: 'activity', item })).toEqual({ t: 'activity', item });
  });
});
