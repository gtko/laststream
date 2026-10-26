import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import worker from '../src/index.js';
import { DebridEgressBlockedError, guardedFetch, isDebridHost, reportBlockedDebrid } from '../src/egress-guard.js';

// Clé fictive : elle ne doit jamais apparaître dans les journaux ni dans l'événement Sentry.
const DEBRID_KEY = 'cle-api-de-test-7f3a9c';
const SENTRY_PUBLIC_KEY = 'cle-publique-de-test';
const SENTRY_DSN = `https://${SENTRY_PUBLIC_KEY}@o0.ingest.sentry.io/4500000000001`;
const SENTRY_ENVELOPE_URL = 'https://o0.ingest.sentry.io/api/4500000000001/envelope/';

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

/** Capture les lignes passées à console.error pendant le test. */
function captureLogs() {
  const lines = [];
  console.error = (...args) => {
    lines.push(args.join(' '));
  };
  return lines;
}

/** Faux contexte d'exécution : waitUntil collecte les promesses pour pouvoir les attendre. */
function fakeCtx() {
  const pending = [];
  return {
    waitUntil: (promise) => {
      pending.push(promise);
    },
    settle: () => Promise.all(pending),
  };
}

/** Remplace le fetch global ; chaque appel est enregistré (entrée, options). */
function fakeGlobalFetch(respond = () => new Response('ok')) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return respond(input, init);
  };
  return calls;
}

/** fetchFn factice passé à guardedFetch : ne doit jamais être appelé pour un hôte debrid. */
function spyFetchFn(respond = () => new Response('ok')) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ input, init });
    return respond(input, init);
  };
  return { fn, calls };
}

/** Décode l'enveloppe Sentry (en-tête, en-tête d'élément, événement). */
function parseEnvelope(body) {
  const [envelopeHeader, itemHeader, event] = body.trimEnd().split('\n');
  return { envelopeHeader: JSON.parse(envelopeHeader), itemHeader: JSON.parse(itemHeader), event: JSON.parse(event) };
}

describe('garde : reconnaissance des hôtes debrid', () => {
  it('reconnaît AllDebrid et debrid.it : casse, point final, crochets, URL ou hôte nu, port, identifiants', () => {
    const hosts = [
      'https://api.alldebrid.com/x',
      'https://foo.alldebrid.com',
      'https://alldebrid.fr',
      'https://alldebrid.co.uk',
      'https://alldebrid.xn--p1ai/x',
      'https://alldebrid.evil.com',
      'https://alldebrid.com.evil.example',
      'https://x.debrid.it/y',
      'HTTPS://API.AllDebrid.COM./v4/user',
      'https://X.DEBRID.IT.',
      'https://alldebrid.com:443/x',
      'https://u:p@alldebrid.com/x',
      'api.alldebrid.com',
      'api.alldebrid.com.',
      '[api.alldebrid.com]',
      '//api.alldebrid.com/x',
      'debrid.it',
    ];
    for (const host of hosts) assert.equal(isDebridHost(host), true, host);
  });

  it('ne confond pas avec des hôtes voisins ni des valeurs vides', () => {
    const hosts = [
      'https://example.com',
      'https://relais.example.org',
      'https://notalldebrid.com',
      'https://debrid.item.example',
      'https://debrid.it.evil.example',
      'https://evil.example/alldebrid.com',
      '',
      null,
      undefined,
      42,
    ];
    for (const host of hosts) assert.equal(isDebridHost(host), false, String(host));
  });
});

describe('guardedFetch : refus avant envoi', () => {
  it('hôte debrid : fetchFn jamais appelé, DebridEgressBlockedError avec code et hôte', async () => {
    const cases = [
      ['https://api.alldebrid.com/x', 'api.alldebrid.com'],
      ['https://foo.alldebrid.com', 'foo.alldebrid.com'],
      ['https://alldebrid.fr', 'alldebrid.fr'],
      ['https://x.debrid.it/y', 'x.debrid.it'],
      ['https://alldebrid.co.uk/x', 'alldebrid.co.uk'],
      ['https://API.AllDebrid.COM./v4/user', 'api.alldebrid.com'],
      ['HTTPS://API.AllDebrid.COM./v4/user', 'api.alldebrid.com'],
    ];
    const logs = captureLogs();
    const spy = spyFetchFn();
    for (const [target, host] of cases) {
      await assert.rejects(guardedFetch(spy.fn, target, { trigger: 'sortie', env: {}, requestId: 'r1' }), (error) => {
        assert.ok(error instanceof DebridEgressBlockedError);
        assert.equal(error.name, 'DebridEgressBlockedError');
        assert.equal(error.code, 'server_side_disabled');
        assert.equal(error.host, host);
        return true;
      });
    }
    assert.equal(spy.calls.length, 0);
    assert.equal(logs.length, cases.length);
  });

  it('Request debrid : refusée sur l’URL de la requête, fetchFn jamais appelé', async () => {
    const spy = spyFetchFn();
    await assert.rejects(guardedFetch(spy.fn, new Request(`https://api.alldebrid.com/v4/user?apikey=${DEBRID_KEY}`), { trigger: 't', env: {}, requestId: 'r' }), DebridEgressBlockedError);
    assert.equal(spy.calls.length, 0);
  });

  it('hôte légitime : fetchFn appelé avec la cible et les options inchangées', async () => {
    const spy = spyFetchFn();
    const init = { method: 'GET', redirect: 'manual' };
    const response = await guardedFetch(spy.fn, 'https://relais.example.org/torrents?a=1', { init, trigger: 't', env: {}, requestId: 'r' });
    assert.equal(response.status, 200);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].input, 'https://relais.example.org/torrents?a=1');
    assert.equal(spy.calls[0].init, init);
  });

  it('hôtes voisins légitimes : jamais bloqués', async () => {
    for (const target of ['https://example.com/', 'https://notalldebrid.com/', 'https://debrid.item.example/', 'https://relais.example.org/x']) {
      const spy = spyFetchFn();
      assert.equal((await guardedFetch(spy.fn, target, { trigger: 't', env: {}, requestId: 'r' })).status, 200, target);
      assert.equal(spy.calls.length, 1, target);
    }
  });

  it('erreur réseau ordinaire : propagée telle quelle, pas un blocage', async () => {
    const spy = spyFetchFn(() => {
      throw new TypeError('connexion refusée');
    });
    await assert.rejects(guardedFetch(spy.fn, 'https://relais.example.org/', { trigger: 't', env: {}, requestId: 'r' }), (error) => {
      assert.ok(!(error instanceof DebridEgressBlockedError));
      assert.equal(error.message, 'connexion refusée');
      return true;
    });
  });
});

describe('guardedFetch : redirections', () => {
  it('redirection absolue vers un hôte debrid : non suivie, erreur de blocage avec l’hôte', async () => {
    const logs = captureLogs();
    const spy = spyFetchFn(() => new Response(null, { status: 302, headers: { location: `https://api.alldebrid.com/v4/user?apikey=${DEBRID_KEY}` } }));
    await assert.rejects(guardedFetch(spy.fn, 'https://relais.example.org/a', { trigger: 'sortie', env: {}, requestId: 'r' }), (error) => {
      assert.ok(error instanceof DebridEgressBlockedError);
      assert.equal(error.host, 'api.alldebrid.com');
      return true;
    });
    assert.equal(spy.calls.length, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes(DEBRID_KEY), false);
  });

  it('redirection protocole-relative vers debrid.it : refusée', async () => {
    const spy = spyFetchFn(() => new Response(null, { status: 307, headers: { location: '//x.debrid.it/y' } }));
    await assert.rejects(guardedFetch(spy.fn, 'https://relais.example.org/a', { trigger: 't', env: {}, requestId: 'r' }), (error) => {
      assert.equal(error.host, 'x.debrid.it');
      return true;
    });
  });

  it('redirection relative sur le même hôte : réponse renvoyée telle quelle', async () => {
    const spy = spyFetchFn(() => new Response(null, { status: 301, headers: { location: '/nouveau' } }));
    const response = await guardedFetch(spy.fn, 'https://relais.example.org/a', { trigger: 't', env: {}, requestId: 'r' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), '/nouveau');
  });
});

describe('guardedFetch : redirections en mode manual et follow', () => {
  it('302 vers un débrideur, redirect manual : rendu tel quel, sans erreur, sans rapport ni Sentry', async () => {
    const logs = captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    const spy = spyFetchFn(() => new Response(null, { status: 302, headers: { location: 'https://x.debrid.it/y' } }));
    const response = await guardedFetch(spy.fn, 'https://relais.example.org/a', {
      init: { method: 'GET', redirect: 'manual' },
      trigger: 'sortie',
      env: { SENTRY_DSN },
      ctx,
      requestId: 'r',
    });
    await ctx.settle();
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://x.debrid.it/y');
    assert.equal(spy.calls.length, 1);
    assert.equal(logs.length, 0);
    assert.equal(sent.length, 0);
  });

  it('Request en mode manual (redirect de la requête) : rendu tel quel', async () => {
    const logs = captureLogs();
    const spy = spyFetchFn(() => new Response(null, { status: 301, headers: { location: 'https://api.alldebrid.com/v4/user' } }));
    const response = await guardedFetch(spy.fn, new Request('https://relais.example.org/a', { redirect: 'manual' }), { trigger: 't', env: {}, requestId: 'r' });
    assert.equal(response.status, 301);
    assert.equal(logs.length, 0);
  });

  it('mode follow explicite : 302 vers un débrideur refusé avec l’hôte', async () => {
    captureLogs();
    const spy = spyFetchFn(() => new Response(null, { status: 302, headers: { location: 'https://x.debrid.it/y' } }));
    await assert.rejects(guardedFetch(spy.fn, 'https://relais.example.org/a', { init: { redirect: 'follow' }, trigger: 't', env: {}, requestId: 'r' }), (error) => {
      assert.ok(error instanceof DebridEgressBlockedError);
      assert.equal(error.host, 'x.debrid.it');
      return true;
    });
  });
});

describe('rapport de blocage : journal et Sentry', () => {
  it('journal : une ligne JSON {level, event, host, trigger, requestId}, sans URL, chemin ni clé', async () => {
    const logs = captureLogs();
    await assert.rejects(guardedFetch(spyFetchFn().fn, `https://api.alldebrid.com/v4/user?apikey=${DEBRID_KEY}`, { trigger: 'sortie', env: {}, requestId: 'req-1' }), DebridEgressBlockedError);
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), {
      level: 'error',
      event: 'server_side_debrid_call_blocked',
      host: 'api.alldebrid.com',
      trigger: 'sortie',
      requestId: 'req-1',
    });
    assert.equal(logs[0].includes(DEBRID_KEY), false);
    assert.equal(logs[0].includes('/v4/user'), false);
  });

  it('Sentry : enveloppe POST sur l’endpoint du DSN, événement error, tags, sans chemin, requête ni clé', async () => {
    captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    const env = { SENTRY_DSN: SENTRY_DSN };
    await assert.rejects(
      guardedFetch(spyFetchFn().fn, `https://api.alldebrid.com/v4/user?apikey=${DEBRID_KEY}`, { trigger: 'sortie', env, ctx, requestId: 'req-test-1' }),
      DebridEgressBlockedError,
    );
    await ctx.settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].input, SENTRY_ENVELOPE_URL);
    assert.equal(sent[0].init.method, 'POST');
    assert.equal(sent[0].init.headers['x-sentry-auth'], `Sentry sentry_version=7, sentry_key=${SENTRY_PUBLIC_KEY}`);

    const body = sent[0].init.body;
    const { envelopeHeader, itemHeader, event } = parseEnvelope(body);
    assert.match(envelopeHeader.event_id, /^[0-9a-f]{32}$/);
    assert.equal(itemHeader.type, 'event');
    assert.equal(event.event_id, envelopeHeader.event_id);
    assert.equal(event.level, 'error');
    assert.equal(event.message, 'server_side_debrid_call_blocked');
    assert.deepEqual(event.fingerprint, ['server_side_debrid_call']);
    assert.deepEqual(event.tags, { platform: 'edge', release: 'unknown', blocked_host: 'api.alldebrid.com', trigger: 'sortie', request_id: 'req-test-1' });
    assert.equal(event.environment, 'production');
    assert.equal(event.platform, 'javascript');
    assert.equal(event.server_name, 'laststream-edge');

    assert.equal(body.includes(DEBRID_KEY), false, 'clé d’API dans l’enveloppe');
    assert.equal(body.includes('apikey'), false, 'requête dans l’enveloppe');
    assert.equal(body.includes('/v4/user'), false, 'chemin dans l’enveloppe');
    assert.equal(body.includes('https://api.alldebrid.com'), false, 'URL complète dans l’enveloppe');
    assert.equal(body.includes(SENTRY_PUBLIC_KEY), false, 'clé publique Sentry dans le corps');
  });

  it('sans SENTRY_DSN : aucun envoi réseau, journal seulement', async () => {
    captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    await assert.rejects(guardedFetch(spyFetchFn().fn, 'https://api.alldebrid.com/x', { trigger: 't', env: {}, ctx, requestId: 'r' }), DebridEgressBlockedError);
    await ctx.settle();
    assert.equal(sent.length, 0);
  });

  it('DSN invalide (http, sans clé, sans identifiant de projet) : aucun envoi, aucune exception', async () => {
    captureLogs();
    const sent = fakeGlobalFetch();
    for (const dsn of ['http://cle@o0.ingest.sentry.io/1', 'https://o0.ingest.sentry.io/1', `https://${SENTRY_PUBLIC_KEY}@o0.ingest.sentry.io/abc`, 'pas une url']) {
      await assert.doesNotReject(reportBlockedDebrid({ host: 'api.alldebrid.com', trigger: 't', requestId: 'r' }, { SENTRY_DSN: dsn }, undefined), dsn);
    }
    assert.equal(sent.length, 0);
  });

  it('échec de l’envoi Sentry : jamais levé, le blocage reste une DebridEgressBlockedError', async () => {
    captureLogs();
    globalThis.fetch = async () => {
      throw new TypeError('sentry injoignable');
    };
    await assert.doesNotReject(reportBlockedDebrid({ host: 'api.alldebrid.com', trigger: 't', requestId: 'r' }, { SENTRY_DSN: SENTRY_DSN }, undefined));
    await assert.rejects(guardedFetch(spyFetchFn().fn, 'https://api.alldebrid.com/x', { trigger: 't', env: { SENTRY_DSN: SENTRY_DSN }, requestId: 'r' }), DebridEgressBlockedError);
  });
});

describe('intégration Worker : aucun appel vers un débrideur depuis le Worker', () => {
  it('core répond 302 vers un débrideur : rendu tel quel au client, rien n’est suivi ni signalé', async () => {
    const logs = captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    const core = { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://x.debrid.it/dl/abc' } }) };
    const res = await worker.fetch(new Request('https://laststream.example/torrents'), { RETRY_DELAY_MS: 1, CORE: core, SENTRY_DSN }, ctx);
    await ctx.settle();
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://x.debrid.it/dl/abc');
    assert.deepEqual(sent, []);
    assert.equal(logs.length, 0);
  });
});

describe('garde de dépôt : le code serveur ne nomme jamais le débrideur', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const listJs = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listJs(path);
      return entry.name.endsWith('.js') ? [path] : [];
    });

  it('aucun fichier de src/ hors egress-guard.js ne contient alldebrid ni debrid.it (commentaires compris)', () => {
    const files = listJs(srcDir);
    assert.ok(files.some((f) => f.endsWith('index.js')), 'src/index.js trouvé');
    assert.ok(files.some((f) => f.endsWith('egress-guard.js')), 'src/egress-guard.js trouvé');
    for (const file of files) {
      if (file.endsWith('egress-guard.js')) continue;
      assert.doesNotMatch(readFileSync(file, 'utf8'), /alldebrid|debrid\.it/i, relative(srcDir, file));
    }
  });
});
