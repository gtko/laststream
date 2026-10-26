import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { reportBlockedDebrid, reportUnhandledError } from '../src/egress-guard.js';

const SENTRY_PUBLIC_KEY = 'cle-publique-de-test';
const SENTRY_DSN = `https://${SENTRY_PUBLIC_KEY}@o0.ingest.sentry.io/4500000000001`;
const SENTRY_ENVELOPE_URL = 'https://o0.ingest.sentry.io/api/4500000000001/envelope/';
// Jeton fictif : il ne doit jamais apparaître dans les journaux ni dans l'événement Sentry.
const TOKEN = 'jeton-de-test-42b8';
const ANDROID = '/app/android/laststream-1700000000.apk';

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

/** Faux contexte d'exécution : waitUntil collecte les promesses (pending) pour pouvoir les attendre. */
function fakeCtx() {
  const pending = [];
  return {
    pending,
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

/** Décode l'enveloppe Sentry (en-tête, en-tête d'élément, événement). */
function parseEnvelope(body) {
  const [envelopeHeader, itemHeader, event] = body.trimEnd().split('\n');
  return { envelopeHeader: JSON.parse(envelopeHeader), itemHeader: JSON.parse(itemHeader), event: JSON.parse(event) };
}

/** Binding R2 en panne : toute lecture lève une exception non gérée par le handler. */
const brokenR2 = (message = `R2 indisponible : https://bucket.example/x?token=${TOKEN}`) => ({
  get: async () => {
    throw new Error(message);
  },
});

/** Requête vers un fichier R2 dont la lecture échoue. */
const failingRequest = () => new Request(`https://laststream.example${ANDROID}`, { headers: { 'cf-ray': 'ray-test-1' } });

describe('exception non gérée : 500 JSON et rapport Sentry', () => {
  it('exception du handler : 500 {error:"internal"}, événement Sentry envoyé via waitUntil, sans URL ni jeton', async () => {
    const logs = captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    const res = await worker.fetch(failingRequest(), { APP_FILES: brokenR2(), SENTRY_DSN }, ctx);

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { error: 'internal' });

    assert.equal(ctx.pending.length, 1, 'envoi enregistré via ctx.waitUntil');
    await ctx.settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].input, SENTRY_ENVELOPE_URL);
    assert.equal(sent[0].init.method, 'POST');
    assert.equal(sent[0].init.headers['x-sentry-auth'], `Sentry sentry_version=7, sentry_key=${SENTRY_PUBLIC_KEY}`);

    const body = sent[0].init.body;
    const { event } = parseEnvelope(body);
    assert.equal(event.level, 'error');
    assert.equal(event.exception.values[0].type, 'Error');
    assert.equal(event.exception.values[0].value, 'R2 indisponible : [url]');
    assert.deepEqual(event.tags, { platform: 'edge', release: 'unknown', trigger: 'unhandled', request_id: 'ray-test-1' });

    assert.equal(body.includes(TOKEN), false, 'jeton dans l’enveloppe');
    assert.equal(body.includes('bucket.example'), false, 'URL complète dans l’enveloppe');
    assert.equal(body.includes(SENTRY_PUBLIC_KEY), false, 'clé publique Sentry dans le corps');

    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), { level: 'error', event: 'unhandled_exception', errorName: 'Error', requestId: 'ray-test-1' });
    assert.equal(logs[0].includes(TOKEN), false, 'jeton dans le journal');
  });

  it('sans SENTRY_DSN : 500 identique, aucun appel réseau, journal seulement', async () => {
    const logs = captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    const res = await worker.fetch(failingRequest(), { APP_FILES: brokenR2() }, ctx);

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal' });
    await ctx.settle();
    assert.equal(sent.length, 0, 'aucun envoi sans DSN');
    assert.equal(logs.length, 1);
  });

  it('échec de l’envoi Sentry : la réponse 500 est quand même rendue, rien n’est levé', async () => {
    captureLogs();
    const ctx = fakeCtx();
    globalThis.fetch = async () => {
      throw new TypeError('sentry injoignable');
    };
    const res = await worker.fetch(failingRequest(), { APP_FILES: brokenR2(), SENTRY_DSN }, ctx);

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal' });
    await assert.doesNotReject(ctx.settle());
  });

  it('exception non Error (chaîne levée) : 500 et événement de type Error', async () => {
    captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    const res = await worker.fetch(failingRequest(), { APP_FILES: { get: async () => Promise.reject('texte brut') }, SENTRY_DSN }, ctx);

    assert.equal(res.status, 500);
    await ctx.settle();
    assert.equal(sent.length, 1);
    const { event } = parseEnvelope(sent[0].init.body);
    assert.equal(event.exception.values[0].type, 'Error');
    assert.equal(event.exception.values[0].value, 'texte brut');
  });

  it('message d’erreur très long : tronqué à 200 caractères dans l’événement', async () => {
    captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    await worker.fetch(failingRequest(), { APP_FILES: brokenR2('x'.repeat(1000)), SENTRY_DSN }, ctx);
    await ctx.settle();
    const { event } = parseEnvelope(sent[0].init.body);
    assert.equal(event.exception.values[0].value.length, 200);
  });
});

describe('tags release et platform sur les événements', () => {
  const releaseFor = async (env) => {
    captureLogs();
    const ctx = fakeCtx();
    const sent = fakeGlobalFetch();
    await worker.fetch(failingRequest(), { APP_FILES: brokenR2(), SENTRY_DSN, ...env }, ctx);
    await ctx.settle();
    return parseEnvelope(sent[0].init.body).event.tags;
  };

  it('release : variable RELEASE en priorité', async () => {
    assert.deepEqual(await releaseFor({ RELEASE: 'v1.2.3' }), { platform: 'edge', release: 'v1.2.3', trigger: 'unhandled', request_id: 'ray-test-1' });
  });

  it('release : sinon l’identifiant de version CF_VERSION_METADATA', async () => {
    const tags = await releaseFor({ CF_VERSION_METADATA: { id: 'abc-123', tag: '', timestamp: '' } });
    assert.equal(tags.release, 'abc-123');
    assert.equal(tags.platform, 'edge');
  });

  it('release : valeurs vides ou absentes → « unknown »', async () => {
    assert.equal((await releaseFor({ RELEASE: '   ', CF_VERSION_METADATA: { id: '' } })).release, 'unknown');
    assert.equal((await releaseFor({})).release, 'unknown');
  });
});

describe('release au premier niveau de l’événement Sentry', () => {
  it('exception non gérée : release aussi au premier niveau, comme le tag', async () => {
    captureLogs();
    const sent = fakeGlobalFetch();
    await reportUnhandledError(new Error('panne'), { SENTRY_DSN, RELEASE: 'v1.2.3' }, fakeCtx(), 'ray-test-3');
    const { event } = parseEnvelope(sent[0].init.body);
    assert.equal(event.release, 'v1.2.3');
    assert.equal(event.tags.release, 'v1.2.3');
  });

  it('blocage débrideur : release au premier niveau tirée de CF_VERSION_METADATA', async () => {
    captureLogs();
    const sent = fakeGlobalFetch();
    await reportBlockedDebrid(
      { host: 'alldebrid.example', trigger: 'test', requestId: 'ray-test-4' },
      { SENTRY_DSN, CF_VERSION_METADATA: { id: 'abc-123', tag: '', timestamp: '' } },
      fakeCtx(),
    );
    const { event } = parseEnvelope(sent[0].init.body);
    assert.equal(event.release, 'abc-123');
    assert.equal(event.tags.release, 'abc-123');
  });

  it('sans version connue : release « unknown » au premier niveau', async () => {
    captureLogs();
    const sent = fakeGlobalFetch();
    await reportUnhandledError(new Error('panne'), { SENTRY_DSN }, fakeCtx(), 'ray-test-5');
    assert.equal(parseEnvelope(sent[0].init.body).event.release, 'unknown');
  });
});

describe('masquage des secrets dans le message envoyé à Sentry', () => {
  /** Valeur d'exception envoyée à Sentry pour un message d'erreur donné. */
  const sentValue = async (message) => {
    captureLogs();
    const sent = fakeGlobalFetch();
    await reportUnhandledError(new Error(message), { SENTRY_DSN }, fakeCtx(), 'ray-test-6');
    assert.equal(sent.length, 1);
    return parseEnvelope(sent[0].init.body).event.exception.values[0].value;
  };

  it('access_token=… : valeur masquée', async () => {
    assert.equal(await sentValue('appel access_token=sk-live-AAA111 refusé'), 'appel access_token=[masqué] refusé');
  });

  it('api_key=… : valeur masquée', async () => {
    assert.equal(await sentValue('api_key=ZZZ999-secret'), 'api_key=[masqué]');
  });

  it('refresh_token=… : valeur masquée', async () => {
    assert.equal(await sentValue('renouvellement refresh_token=rt-000-xyz'), 'renouvellement refresh_token=[masqué]');
  });

  it('Bearer … : jeton masqué, mot Bearer conservé', async () => {
    assert.equal(await sentValue('en-tête Bearer ya29.A0AfB_xyz'), 'en-tête Bearer [masqué]');
  });

  it('token: … (deux-points) : valeur masquée', async () => {
    assert.equal(await sentValue('jeton token: sEcReT9 invalide'), 'jeton token: [masqué] invalide');
  });

  it('texte sans secret : inchangé', async () => {
    assert.equal(await sentValue('Délai dépassé après 3 essais (code 503)'), 'Délai dépassé après 3 essais (code 503)');
  });
});

describe('configuration Wrangler', () => {
  it('wrangler.jsonc déclare le binding CF_VERSION_METADATA (release réelle au lieu de « unknown »)', () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    // Le fichier porte des commentaires « // » en début de ligne, hors JSON strict.
    const text = readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.deepEqual(JSON.parse(text).version_metadata, { binding: 'CF_VERSION_METADATA' });
  });
});
