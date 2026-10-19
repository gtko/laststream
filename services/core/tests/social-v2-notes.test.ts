import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

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
const EPISODE_QUERY = '?type=series&tmdbId=1399&season=2&episode=4';
const EMOJI = '\u{1F600}';
/** Séquence ZWJ (famille) : un seul graphème. */
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
/** Drapeau (indicateurs régionaux CH) : un seul graphème. */
const FLAG_CH = '\u{1F1E8}\u{1F1ED}';

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

const post = (who: Acting, body: unknown) => as<{ note: NoteBody } & ErrorBodyV2>(app, who, 'POST', '/user/social/notes', { body });
const notesOf = (who: Acting, query = EPISODE_QUERY) => as<{ notes: NoteBody[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/notes${query}`);
const remove = (who: Acting, id: string) => as<ErrorBodyV2>(app, who, 'DELETE', `/user/social/notes/${id}`);
const episodeNote = (over: Record<string, unknown> = {}) => ({
  type: 'series',
  tmdbId: 1399,
  season: 2,
  episode: 4,
  pos: 754,
  kind: 'text',
  body: 'Quel twist',
  ...over,
});

describe('publication (POST /user/social/notes)', () => {
  it('texte : 201 avec la note, espaces de bord retirés ; auteur sans identifiant interne', async () => {
    const res = await post(cast.alice, episodeNote({ body: '  Quel twist  ' }));
    expect(res.status).toBe(201);
    expect(res.body.note).toMatchObject({
      kind: 'text',
      body: 'Quel twist',
      pos: 754,
      createdAt: START,
      author: { pid: cast.alice.pid, handle: { name: 'alice' } },
    });
    expect(res.body.note.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(res.body)).not.toContain(cast.alice.profile);
  });

  it('texte : 140 caractères au plus, sans contrôle ; vide ou trop long refusé', async () => {
    expect((await post(cast.alice, episodeNote({ body: 'x'.repeat(140) }))).status).toBe(201);
    for (const body of ['', '   ', 'x'.repeat(141), 'a\nb', '\u{1F600}'.repeat(141)]) {
      const res = await post(cast.alice, episodeNote({ body }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_body');
    }
  });

  it('emoji : exactement un emoji, séquences composées et drapeaux compris', async () => {
    for (const body of [EMOJI, FAMILY, FLAG_CH]) {
      const res = await post(cast.alice, episodeNote({ kind: 'emoji', body }));
      expect(res.status).toBe(201);
      expect(res.body.note).toMatchObject({ kind: 'emoji', body });
    }
    for (const body of ['', 'ok', '1', 'é', `${EMOJI}${EMOJI}`, `${EMOJI} salut`]) {
      const res = await post(cast.alice, episodeNote({ kind: 'emoji', body }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_body');
    }
  });

  it('validation : type, position, genre et clés inconnues ; film : saison et épisode ignorés', async () => {
    expect((await post(cast.alice, episodeNote({ kind: 'gif' }))).body.error).toBe('invalid_body');
    expect((await post(cast.alice, episodeNote({ pos: -1 }))).body.error).toBe('invalid_body');
    expect((await post(cast.alice, episodeNote({ tmdbId: 0 }))).body.error).toBe('invalid_body');
    expect((await post(cast.alice, episodeNote({ extra: true }))).body.error).toBe('invalid_body');
    expect((await post(cast.alice, { type: 'series', tmdbId: 1399, pos: 1, kind: 'text' })).body.error).toBe('invalid_body');

    const movie = await post(cast.alice, { type: 'movie', tmdbId: 438631, season: 3, episode: 2, pos: 10, kind: 'text', body: 'Dune' });
    expect(movie.status).toBe(201);
    const found = await notesOf(cast.alice, '?type=movie&tmdbId=438631&season=9');
    expect(found.body.notes.map((n) => n.body)).toEqual(['Dune']);
  });

  it('limite : 20 notes par minute et par auteur ; 429 avec Retry-After, puis de nouveau permis une minute plus tard', async () => {
    for (let i = 0; i < 20; i++) expect((await post(cast.bob, episodeNote({ body: `n${i}` }))).status).toBe(201);
    const blocked = await post(cast.bob, episodeNote({ body: 'trop' }));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect((await post(cast.alice, episodeNote({ body: 'autre auteur' }))).status).toBe(201);
    at(60_000);
    expect((await post(cast.bob, episodeNote({ body: 'une minute plus tard' }))).status).toBe(201);
  });

  it('suppression puis repost : le quota compte les créations, pas les notes présentes ; 429', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await post(cast.bob, episodeNote({ body: `n${i}` }))).body.note.id);
    for (const id of ids) expect((await remove(cast.bob, id)).status).toBe(204);
    const blocked = await post(cast.bob, episodeNote({ body: 'après suppression' }));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(blocked.headers.get('retry-after')).toBe('60');
    at(60_000);
    expect((await post(cast.bob, episodeNote({ body: 'une minute plus tard' }))).status).toBe(201);
  });

  it('profil enfant : aucune route de notes (403 kid_profile)', async () => {
    expect((await post(cast.kid, episodeNote())).body.error).toBe('kid_profile');
    expect((await notesOf(cast.kid)).body.error).toBe('kid_profile');
  });
});

describe('lecture (GET /user/social/notes)', () => {
  it('mes notes, celles des amis et du foyer ; jamais celles d’un profil non lié', async () => {
    at(1_000);
    await post(cast.alice, episodeNote({ pos: 300, body: 'alice' }));
    await post(cast.bob, episodeNote({ pos: 100, body: 'bob' }));
    await post(cast.alice2, episodeNote({ pos: 200, body: 'foyer' }));
    await post(cast.carol, episodeNote({ pos: 150, body: 'carol' }));

    const alice = await notesOf(cast.alice);
    expect(alice.status).toBe(200);
    expect(alice.body.notes.map((n) => n.body)).toEqual(['bob', 'foyer', 'alice']);
    expect(alice.body.notes.map((n) => n.author.pid)).toEqual([cast.bob.pid, cast.alice2.pid, cast.alice.pid]);
    expect((await notesOf(cast.bob)).body.notes.map((n) => n.body)).toEqual(['bob', 'alice']);
    expect((await notesOf(cast.carol)).body.notes.map((n) => n.body)).toEqual(['carol']);
  });

  it('un seul épisode : les notes d’un autre épisode ou d’une autre série ne sont pas renvoyées', async () => {
    await post(cast.bob, episodeNote({ episode: 5, body: 'autre épisode' }));
    await post(cast.bob, episodeNote({ tmdbId: 1396, body: 'autre série' }));
    await post(cast.bob, episodeNote({ body: 'cet épisode' }));
    expect((await notesOf(cast.alice)).body.notes.map((n) => n.body)).toEqual(['cet épisode']);
    expect((await notesOf(cast.alice, '?type=series&tmdbId=1399&season=2&episode=5')).body.notes.map((n) => n.body)).toEqual([
      'autre épisode',
    ]);
  });

  it('requête : type et tmdbId requis, saison et épisode bornés ; clés inconnues et valeurs répétées refusées', async () => {
    for (const query of [
      '',
      '?type=anime&tmdbId=1399',
      '?type=series',
      '?type=series&tmdbId=0',
      '?type=series&tmdbId=abc',
      '?type=series&tmdbId=1399&season=-1',
      '?type=series&tmdbId=1399&episode=1&episode=2',
      '?type=series&tmdbId=1399&extra=1',
    ]) {
      const res = await notesOf(cast.alice, query);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_body');
    }
  });
});

describe('suppression (DELETE /user/social/notes/:id)', () => {
  it('auteur seulement : 204 ; un autre profil, même du foyer, reçoit 404 et la note reste', async () => {
    const created = await post(cast.alice, episodeNote({ body: 'à supprimer' }));
    const id = created.body.note.id;
    expect((await remove(cast.bob, id)).body.error).toBe('note_not_found');
    expect((await remove(cast.alice2, id)).body.error).toBe('note_not_found');
    expect((await notesOf(cast.bob)).body.notes.map((n) => n.id)).toContain(id);

    expect((await remove(cast.alice, id)).status).toBe(204);
    expect((await notesOf(cast.alice)).body.notes).toEqual([]);
    expect((await remove(cast.alice, id)).body.error).toBe('note_not_found');
  });
});

describe('événements temps réel (gestionnaire injecté)', () => {
  it('note : vers les amis et le foyer de l’auteur, pas vers les autres', async () => {
    await post(cast.alice, episodeNote());
    expect(emitted).toHaveLength(1);
    expect([...(emitted[0]?.pids ?? [])].sort()).toEqual([cast.bob.pid, cast.alice2.pid].sort());
    expect(emitted[0]?.event).toMatchObject({
      t: 'note',
      media: { type: 'series', tmdbId: 1399, season: 2, episode: 4 },
      note: { body: 'Quel twist', author: { pid: cast.alice.pid } },
    });
  });

  it('film : media sans saison ni épisode', async () => {
    await post(cast.bob, { type: 'movie', tmdbId: 438631, season: 1, pos: 5, kind: 'emoji', body: EMOJI });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.alice.pid]);
    const media = (emitted[0]?.event as { media?: unknown } | undefined)?.media;
    expect(media).toEqual({ type: 'movie', tmdbId: 438631 });
  });

  it('refus (429) : aucun événement', async () => {
    for (let i = 0; i < 20; i++) await post(cast.bob, episodeNote({ body: `n${i}` }));
    emitted.length = 0;
    expect((await post(cast.bob, episodeNote({ body: 'refusée' }))).status).toBe(429);
    expect(emitted).toHaveLength(0);
  });
});
