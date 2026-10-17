import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, postJson, startApp, type RunningApp, tokenFor, fullToken } from './lt-harness.js';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

/** Réponse simulée d'OpenRouter, pilotée par test. Reçoit le corps de la requête. */
let reply: (payload: { model: string; messages: { role: string; content: string }[]; response_format?: unknown }) => unknown = () => '';
let status = 200;

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  upstream = mockUpstream({
    [OPENROUTER]: (call) => {
      if (status !== 200) return json({ error: 'boom' }, status);
      const payload = JSON.parse(call.body) as Parameters<typeof reply>[0];
      const content = reply(payload);
      return json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
    },
    'https://api.themoviedb.org/3/search/movie': (call) => {
      const query = call.url.searchParams.get('query');
      if (query === 'Dune') return json({ results: [{ id: 438631, title: 'Dune', poster_path: '/dune.jpg' }] });
      return json({ results: [] });
    },
    'https://api.themoviedb.org/3/search/tv': (call) => {
      if (call.url.searchParams.get('query') === 'Severance') {
        // Pas d'affiche : repli sur le premier résultat.
        return json({ results: [{ id: 95396, name: 'Severance', poster_path: null }] });
      }
      return json({ results: [] });
    },
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  status = 200;
  reply = () => '';
});

const post = (path: string, body: unknown, token = fullToken()): Promise<Response> =>
  fetch(`${app.baseUrl}/${token}/lt/${path}`, postJson(body));

const recommendReply = (items: unknown[]) => () => ({ items });

describe('lt/recommend', () => {
  it('propose des titres puis les résout via TMDB (media_type, raison, affiche)', async () => {
    reply = recommendReply([
      { title: 'Dune', year: 2021, type: 'movie', reason_fr: 'Épique et visuel' },
      { title: 'Severance', year: 2022, type: 'tv', reason_fr: 'Mystère au bureau' },
      { title: 'Titre introuvable', year: 1990, type: 'movie', reason_fr: 'Rien' },
    ]);
    const res = await post('recommend', { history: [{ title: 'Blade Runner', year: 1982, type: 'movie' }], liked: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items.map((i) => [i.id, i.media_type, i.reason_fr])).toEqual([
      [438631, 'movie', 'Épique et visuel'],
      [95396, 'tv', 'Mystère au bureau'],
    ]);
    expect(body.items[0]?.poster_path).toBe('/dune.jpg');
  });

  it('envoie le modèle configuré, le format JSON et l historique à OpenRouter', async () => {
    reply = recommendReply([]);
    await post('recommend', { history: [{ title: 'Blade Runner', year: 1982, type: 'movie' }], liked: [{ title: 'Dune', type: 'movie' }] });
    const call = upstream.callsTo(OPENROUTER).at(-1);
    const payload = JSON.parse(call?.body ?? '{}') as { model: string; response_format: unknown; messages: { content: string }[] };
    expect(payload.model).toBe('test/model');
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.messages[1]?.content).toContain('Blade Runner (1982) [movie]');
    expect(payload.messages[1]?.content).toContain('Titres aimés : Dune [movie]');
    expect(call?.headers.authorization).toBe(`Bearer ${KEYS.openrouterApiKey}`);
  });

  it('dédoublonne les titres résolus vers le même résultat', async () => {
    reply = recommendReply([
      { title: 'Dune', year: 2021, type: 'movie', reason_fr: 'Un' },
      { title: 'Dune', year: 2021, type: 'movie', reason_fr: 'Deux' },
    ]);
    const body = (await (await post('recommend', { history: [], liked: [] })).json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('sans clé TMDB : 404 service_not_configured (tmdb), sans appel amont', async () => {
    const before = upstream.calls.length;
    const res = await post('recommend', { history: [] }, tokenFor({ openrouterApiKey: KEYS.openrouterApiKey }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'service_not_configured', service: 'tmdb' });
    expect(upstream.calls.length).toBe(before);
  });

  it('réponse IA sans JSON exploitable : 502 ai_bad_format', async () => {
    reply = () => 'Désolé, je ne peux pas.';
    const res = await post('recommend', { history: [], liked: [{ title: 'Autre chose' }] });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'ai_bad_format' });
  });

  it('erreur OpenRouter : 502 upstream_<statut>, sans clé dans la réponse', async () => {
    status = 500;
    const res = await post('recommend', { history: [{ title: 'Inédit', type: 'movie' }] });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'upstream_500' });
    expect(text).not.toContain(KEYS.openrouterApiKey);
  });
});

describe('lt/why', () => {
  it('renvoie un texte court sans markdown', async () => {
    reply = () => '**Un film** culte, _à voir_ absolument.';
    const res = await post('why', { title: 'Dune', year: 2021, overview: 'Un jeune homme…', genres: ['Science-fiction'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Un film culte, à voir absolument.' });
    const payload = JSON.parse(upstream.callsTo(OPENROUTER).at(-1)?.body ?? '{}') as { model: string; max_tokens: number; messages: { content: string }[] };
    expect(payload.model).toBe('test/model');
    expect(payload.max_tokens).toBe(220);
    expect(payload.messages[1]?.content).toContain('Titre : Dune (2021)');
    expect(payload.messages[1]?.content).toContain('Genres : Science-fiction');
  });

  it('met en cache : une seule requête OpenRouter pour deux appels identiques', async () => {
    reply = () => 'Texte mis en cache.';
    const body = { title: 'Cache Me', year: 2001 };
    await post('why', body);
    await post('why', body);
    expect(upstream.callsTo(OPENROUTER).filter((c) => c.body.includes('Cache Me')).length).toBe(1);
  });

  it('titre vide : 400 bad_request, sans appel amont', async () => {
    const before = upstream.calls.length;
    const res = await post('why', { title: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
    expect(upstream.calls.length).toBe(before);
  });

  it('réponse vide d OpenRouter : 502 ai_bad_format', async () => {
    reply = () => '';
    const res = await post('why', { title: 'Vide ' + Math.random() });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'ai_bad_format' });
  });

  it('modèle par défaut quand openrouterModel est absent', async () => {
    reply = () => 'Ok.';
    await post('why', { title: 'Modèle par défaut ' + Math.random() }, tokenFor({ openrouterApiKey: KEYS.openrouterApiKey }));
    const payload = JSON.parse(upstream.callsTo(OPENROUTER).at(-1)?.body ?? '{}') as { model: string };
    expect(payload.model).toBe('openai/gpt-4o-mini');
  });
});

describe('lt/person-why', () => {
  it('renvoie un résumé de carrière à partir des titres connus', async () => {
    reply = () => 'Une carrière *marquante* dans le cinéma d’auteur.';
    const res = await post('person-why', { name: 'Denis Villeneuve', knownFor: ['Dune', 'Arrival'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Une carrière marquante dans le cinéma d’auteur.' });
    const payload = JSON.parse(upstream.callsTo(OPENROUTER).at(-1)?.body ?? '{}') as { messages: { content: string }[] };
    expect(payload.messages[1]?.content).toBe('Personne : Denis Villeneuve\nTitres connus : Dune, Arrival');
  });

  it('nom vide : 400 bad_request', async () => {
    const res = await post('person-why', { name: '' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });
});
