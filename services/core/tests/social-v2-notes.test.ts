import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';
import { request } from './user-harness.js';

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
const edit = (who: Acting, id: string, body: unknown) => as<{ note: NoteBody } & ErrorBodyV2>(app, who, 'PATCH', `/user/social/notes/${id}`, { body });
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

describe('modification (PATCH /user/social/notes/:id)', () => {
  it('auteur seulement : 200 avec la note modifiée ; position, date et identifiant inchangés', async () => {
    const created = await post(cast.alice, episodeNote({ pos: 754, body: 'Quel twist' }));
    const id = created.body.note.id;
    at(5_000);
    const res = await edit(cast.alice, id, { kind: 'text', body: '  Quel dénouement  ' });
    expect(res.status).toBe(200);
    expect(res.body.note).toEqual({ ...created.body.note, body: 'Quel dénouement' });
    expect((await notesOf(cast.bob)).body.notes).toEqual([{ ...created.body.note, body: 'Quel dénouement' }]);
  });

  it('texte vers emoji : le genre suit le contenu ; un emoji composé est accepté', async () => {
    const id = (await post(cast.alice, episodeNote())).body.note.id;
    const res = await edit(cast.alice, id, { kind: 'emoji', body: FAMILY });
    expect(res.status).toBe(200);
    expect(res.body.note).toMatchObject({ id, kind: 'emoji', body: FAMILY, pos: 754 });
  });

  it('un autre profil, un ami ou le foyer : 404 note_not_found et la note reste intacte ; note inconnue : même réponse', async () => {
    const id = (await post(cast.alice, episodeNote({ body: 'original' }))).body.note.id;
    const bobTry = await edit(cast.bob, id, { kind: 'text', body: 'modifiée' });
    expect(bobTry.status).toBe(404);
    expect(bobTry.body.error).toBe('note_not_found');
    const aliceTwin = await edit(cast.alice2, id, { kind: 'text', body: 'modifiée' });
    expect(aliceTwin.status).toBe(404);
    expect(aliceTwin.body.error).toBe('note_not_found');
    const unknown = await edit(cast.alice, '00000000-0000-4000-8000-000000000000', { kind: 'text', body: 'modifiée' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('note_not_found');
    expect((await notesOf(cast.bob)).body.notes.map((n) => n.body)).toEqual(['original']);
  });

  it('corps invalide : 400 invalid_body (emoji attendu, texte vide ou trop long, genre inconnu, clé en trop) ; la note ne change pas', async () => {
    const id = (await post(cast.alice, episodeNote({ body: 'Quel twist' }))).body.note.id;
    for (const body of [
      { kind: 'emoji', body: 'ok' },
      { kind: 'emoji', body: '' },
      { kind: 'text', body: '   ' },
      { kind: 'text', body: 'x'.repeat(141) },
      { kind: 'gif', body: 'x' },
      { kind: 'text', body: 'ok', pos: 3 },
      { kind: 'text' },
    ]) {
      const res = await edit(cast.alice, id, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_body');
    }
    expect((await notesOf(cast.alice)).body.notes.map((n) => n.body)).toEqual(['Quel twist']);
  });

  it('pas de quota : éditer reste permis après 20 publications dans la minute, et la pose reste bloquée', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await post(cast.bob, episodeNote({ body: `n${i}` }))).body.note.id);
    expect((await edit(cast.bob, ids[0] ?? '', { kind: 'text', body: 'corrigée' })).status).toBe(200);
    expect((await post(cast.bob, episodeNote({ body: 'trop' }))).status).toBe(429);
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

  it('modification : note vers les amis et le foyer de l’auteur, comme à la pose ; refus (404) : aucun événement', async () => {
    const id = (await post(cast.alice, episodeNote())).body.note.id;
    emitted.length = 0;
    expect((await edit(cast.bob, id, { kind: 'text', body: 'refusée' })).status).toBe(404);
    expect(emitted).toHaveLength(0);
    expect((await edit(cast.alice, id, { kind: 'text', body: 'Corrigé' })).status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect([...(emitted[0]?.pids ?? [])].sort()).toEqual([cast.bob.pid, cast.alice2.pid].sort());
    expect(emitted[0]?.event).toMatchObject({
      t: 'note',
      media: { type: 'series', tmdbId: 1399, season: 2, episode: 4 },
      note: { id, body: 'Corrigé', author: { pid: cast.alice.pid } },
    });
  });

  it('suppression : note_removed (titre et identifiant) vers les amis et le foyer ; refus (404) : aucun événement', async () => {
    const id = (await post(cast.alice, episodeNote())).body.note.id;
    emitted.length = 0;
    expect((await remove(cast.bob, id)).status).toBe(404);
    expect(emitted).toHaveLength(0);
    expect((await remove(cast.alice, id)).status).toBe(204);
    expect(emitted).toHaveLength(1);
    expect([...(emitted[0]?.pids ?? [])].sort()).toEqual([cast.bob.pid, cast.alice2.pid].sort());
    expect(emitted[0]?.event).toEqual({ t: 'note_removed', media: { type: 'series', tmdbId: 1399, season: 2, episode: 4 }, id });
  });

  it('suppression : media d’un film, ou d’une série sans précision, sans saison ni épisode', async () => {
    const movieId = (await post(cast.bob, { type: 'movie', tmdbId: 438631, season: 1, pos: 5, kind: 'emoji', body: EMOJI })).body.note.id;
    emitted.length = 0;
    expect((await remove(cast.bob, movieId)).status).toBe(204);
    expect(emitted[0]?.event).toEqual({ t: 'note_removed', media: { type: 'movie', tmdbId: 438631 }, id: movieId });

    const seriesId = (await post(cast.bob, { type: 'series', tmdbId: 1399, pos: 1, kind: 'text', body: 'sans précision' })).body.note.id;
    emitted.length = 0;
    expect((await remove(cast.bob, seriesId)).status).toBe(204);
    expect(emitted[0]?.event).toEqual({ t: 'note_removed', media: { type: 'series', tmdbId: 1399 }, id: seriesId });
  });
});

/** Note telle qu'un autre profil la lit : titre, et `hidden` quand l'anti-spoiler la masque. */
interface FriendNoteBody extends NoteBody {
  media: { type: 'movie' | 'series'; tmdbId: number; season?: number; episode?: number };
  hidden?: true;
}

const friendNotes = (who: Acting, pid: string, query = '') =>
  as<{ notes: FriendNoteBody[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/friends/${pid}/notes${query}`);
const setPrefs = (who: Acting, body: Record<string, unknown>) => as<ErrorBodyV2>(app, who, 'PUT', '/user/social/prefs', { body });
const spoilersOff = (who: Acting) => setPrefs(who, { antiSpoiler: false });
const writeProgress = (who: Acting, body: Record<string, unknown>) => request(app, 'PUT', `/user/profiles/${who.profile}/progress`, { token: who.token, body });
/** Progression sur S2E4 de « Game of Thrones » (la note de `episodeNote` est à 754 s). */
const EPISODE_PROGRESS = { type: 'series', tmdbId: 1399, season: 2, episode: 4, durationSec: 3600 };
/** Date de création de la note la plus ancienne d'une page (curseur `before`). */
const oldest = (notes: FriendNoteBody[]): number => notes[notes.length - 1]?.createdAt ?? 0;

describe('notes d’un ami (GET /user/social/friends/:pid/notes)', () => {
  it('un ami voit les notes d’un ami, du plus récent au plus ancien, avec leur titre', async () => {
    await spoilersOff(cast.alice);
    at(1_000);
    await post(cast.bob, episodeNote({ pos: 10, body: 'premier' }));
    at(2_000);
    await post(cast.bob, { type: 'movie', tmdbId: 438631, pos: 5, kind: 'emoji', body: EMOJI });
    at(3_000);
    await post(cast.bob, episodeNote({ pos: 20, body: 'dernier' }));

    const res = await friendNotes(cast.alice, cast.bob.pid);
    expect(res.status).toBe(200);
    expect(res.body.notes.map((n) => n.body)).toEqual(['dernier', EMOJI, 'premier']);
    expect(res.body.notes[0]).toMatchObject({
      kind: 'text',
      pos: 20,
      createdAt: START + 3_000,
      author: { pid: cast.bob.pid, handle: { name: 'bob' } },
      media: { type: 'series', tmdbId: 1399, season: 2, episode: 4 },
    });
    expect(res.body.notes[1]?.media).toEqual({ type: 'movie', tmdbId: 438631 });
    expect(res.body.notes.some((n) => n.hidden === true)).toBe(false);
  });

  it('même instant : la note écrite en dernier passe en premier', async () => {
    await spoilersOff(cast.alice);
    at(5_000);
    await post(cast.bob, episodeNote({ body: 'écrite d’abord' }));
    await post(cast.bob, episodeNote({ body: 'écrite ensuite' }));
    const res = await friendNotes(cast.alice, cast.bob.pid);
    expect(res.body.notes.map((n) => n.body)).toEqual(['écrite ensuite', 'écrite d’abord']);
  });

  it('pagination : ?limit= (1 à 50, 30 par défaut) et ?before= (createdAt exclu) ; valeurs incorrectes refusées', async () => {
    await spoilersOff(cast.alice);
    // 31 notes de bob, réparties sur deux minutes pour rester sous le quota de 20 par minute.
    for (let i = 0; i < 31; i++) {
      at(i < 20 ? 1_000 + i : 61_000 + i);
      await post(cast.bob, episodeNote({ body: `n${i}` }));
    }
    const first = await friendNotes(cast.alice, cast.bob.pid, '?limit=2');
    expect(first.body.notes.map((n) => n.body)).toEqual(['n30', 'n29']);
    const second = await friendNotes(cast.alice, cast.bob.pid, `?limit=2&before=${oldest(first.body.notes)}`);
    expect(second.body.notes.map((n) => n.body)).toEqual(['n28', 'n27']);

    const page = await friendNotes(cast.alice, cast.bob.pid);
    expect(page.body.notes).toHaveLength(30);
    expect(page.body.notes.map((n) => n.body)).not.toContain('n0');
    expect((await friendNotes(cast.alice, cast.bob.pid, '?limit=50')).body.notes).toHaveLength(31);
    for (const query of ['?limit=0', '?limit=51', '?limit=abc', '?before=-1', '?before=x', '?extra=1']) {
      const res = await friendNotes(cast.alice, cast.bob.pid, query);
      expect(res.status, query).toBe(400);
      expect(res.body.error, query).toBe('invalid_body');
    }
  });

  it('lien absent, pid inconnu ou mal formé : 404 friend_not_found', async () => {
    await post(cast.bob, episodeNote());
    const stranger = await friendNotes(cast.carol, cast.bob.pid);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error).toBe('friend_not_found');
    for (const pid of ['nope', 'AAAAAAAAAAAAAAAA']) {
      const res = await friendNotes(cast.alice, pid);
      expect(res.status, pid).toBe(404);
      expect(res.body.error, pid).toBe('friend_not_found');
    }
  });

  it('profil bloqué, dans un sens comme dans l’autre : 404 friend_not_found, aucune note ne sort', async () => {
    await spoilersOff(cast.alice);
    await spoilersOff(cast.bob);
    await post(cast.bob, episodeNote({ body: 'de bob' }));
    await post(cast.alice, episodeNote({ body: 'd’alice' }));
    expect((await friendNotes(cast.alice, cast.bob.pid)).status).toBe(200);

    expect((await as(app, cast.alice, 'POST', `/user/social/blocks/${cast.bob.pid}`)).status).toBe(204);
    for (const [who, other] of [
      [cast.alice, cast.bob],
      [cast.bob, cast.alice],
    ] as const) {
      const res = await friendNotes(who, other.pid);
      expect(res.status, `${who.name} lit ${other.name}`).toBe(404);
      expect(res.body.error).toBe('friend_not_found');
    }
  });

  it('bloqué par l’ami (sens inverse) : 404 friend_not_found', async () => {
    await post(cast.alice, episodeNote());
    expect((await as(app, cast.bob, 'POST', `/user/social/blocks/${cast.alice.pid}`)).status).toBe(204);
    const res = await friendNotes(cast.alice, cast.bob.pid);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('friend_not_found');
    expect((await friendNotes(cast.bob, cast.alice.pid)).status).toBe(404);
  });

  it('profil enfant : en cible (son identifiant de profil) 404 friend_not_found, en lecteur 403 kid_profile', async () => {
    const target = await friendNotes(cast.alice, cast.kid.profile);
    expect(target.status).toBe(404);
    expect(target.body.error).toBe('friend_not_found');
    const viewer = await friendNotes(cast.kid, cast.bob.pid);
    expect(viewer.status).toBe(403);
    expect(viewer.body.error).toBe('kid_profile');
  });

  it('série sans saison ni épisode précisés : media sans saison ni épisode (comme les événements de note)', async () => {
    await spoilersOff(cast.alice);
    await post(cast.bob, { type: 'series', tmdbId: 1399, pos: 12, kind: 'text', body: 'série entière' });
    await post(cast.bob, { type: 'series', tmdbId: 1399, season: 2, pos: 12, kind: 'text', body: 'saison' });
    const notes = (await friendNotes(cast.alice, cast.bob.pid)).body.notes;
    expect(notes.map((n) => n.media)).toEqual([
      { type: 'series', tmdbId: 1399, season: 2 },
      { type: 'series', tmdbId: 1399 },
    ]);
  });

  it('historique masqué (historyVisible faux) : 403 hidden pour un ami ; le foyer et soi-même les voient', async () => {
    await spoilersOff(cast.alice2);
    at(1_000);
    await post(cast.alice, episodeNote({ body: 'foyer' }));
    await setPrefs(cast.alice, { historyVisible: false });

    const friend = await friendNotes(cast.bob, cast.alice.pid);
    expect(friend.status).toBe(403);
    expect(friend.body.error).toBe('hidden');
    expect((await friendNotes(cast.alice2, cast.alice.pid)).body.notes.map((n) => n.body)).toEqual(['foyer']);
    expect((await friendNotes(cast.alice, cast.alice.pid)).body.notes.map((n) => n.body)).toEqual(['foyer']);
  });
});

describe('anti-spoiler sur les notes d’un ami', () => {
  const postBobNote = async (over: Record<string, unknown> = {}) => (await post(cast.bob, episodeNote({ body: 'Quel twist', ...over }))).body.note.id;
  const bobNotesSeenByAlice = async () => (await friendNotes(cast.alice, cast.bob.pid)).body.notes;

  it('sans progression sur le titre : hidden et corps vide (le contenu ne sort pas)', async () => {
    at(1_000);
    const id = await postBobNote();
    const res = await friendNotes(cast.alice, cast.bob.pid);
    expect(res.body.notes).toEqual([expect.objectContaining({ id, body: '', hidden: true, pos: 754, kind: 'text' })]);
    expect(JSON.stringify(res.body)).not.toContain('Quel twist');
  });

  it('progression insuffisante : visible à partir de pos − 1 ; une autre saison ou un autre épisode ne compte pas', async () => {
    at(1_000);
    await postBobNote();
    await writeProgress(cast.alice, { ...EPISODE_PROGRESS, positionSec: 752 });
    expect(await bobNotesSeenByAlice()).toEqual([expect.objectContaining({ body: '', hidden: true })]);
    await writeProgress(cast.alice, { ...EPISODE_PROGRESS, episode: 5, positionSec: 3000 });
    expect(await bobNotesSeenByAlice()).toEqual([expect.objectContaining({ body: '', hidden: true })]);
    await writeProgress(cast.alice, { ...EPISODE_PROGRESS, positionSec: 753 });
    const seen = (await bobNotesSeenByAlice())[0];
    expect(seen?.body).toBe('Quel twist');
    expect(seen).not.toHaveProperty('hidden');
  });

  it('titre terminé : visible même si la position du lecteur est sous celle de la note', async () => {
    at(1_000);
    await postBobNote();
    await writeProgress(cast.alice, { ...EPISODE_PROGRESS, positionSec: 450, durationSec: 500 });
    expect((await bobNotesSeenByAlice())[0]?.body).toBe('Quel twist');
  });

  it('film : même règle sur la progression du film', async () => {
    at(1_000);
    await post(cast.bob, { type: 'movie', tmdbId: 438631, pos: 60, kind: 'text', body: 'Dune' });
    const movieNotes = async () => (await friendNotes(cast.alice, cast.bob.pid)).body.notes;
    expect(await movieNotes()).toEqual([expect.objectContaining({ body: '', hidden: true })]);
    await writeProgress(cast.alice, { type: 'movie', tmdbId: 438631, positionSec: 58, durationSec: 7200 });
    expect(await movieNotes()).toEqual([expect.objectContaining({ body: '', hidden: true })]);
    await writeProgress(cast.alice, { type: 'movie', tmdbId: 438631, positionSec: 59, durationSec: 7200 });
    expect((await movieNotes())[0]?.body).toBe('Dune');
  });

  it('anti-spoiler désactivé : visible ; mes notes jamais masquées ; le foyer subit la règle', async () => {
    at(1_000);
    await postBobNote();
    await setPrefs(cast.alice, { antiSpoiler: false });
    expect((await bobNotesSeenByAlice())[0]?.body).toBe('Quel twist');
    await setPrefs(cast.alice, { antiSpoiler: true });

    await post(cast.alice, episodeNote({ body: 'mienne' }));
    const mine = (await friendNotes(cast.alice, cast.alice.pid)).body.notes;
    expect(mine).toEqual([expect.objectContaining({ body: 'mienne' })]);
    expect(mine[0]).not.toHaveProperty('hidden');

    const household = (await friendNotes(cast.alice2, cast.alice.pid)).body.notes;
    expect(household[0]).toMatchObject({ body: '', hidden: true });
  });
});
