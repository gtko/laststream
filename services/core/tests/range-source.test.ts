import { afterEach, describe, expect, it } from 'vitest';
import { IssuedUrls } from '../src/play/issued.js';
import { signRangeToken, verifyRangeToken } from '../src/lt/thumbs/range-token.js';
import { fullToken, postJson, startApp, type RunningApp } from './lt-harness.js';

const SECRET = 'secret-de-test-pour-le-relais-de-plages';
const URL_OK = 'https://abc.debrid.it/dl/film.mkv';

describe('jeton du relais de plages', () => {
  it('signe, vérifie, expire, et refuse une autre URL ou un autre secret', async () => {
    const now = 1_800_000_000_000;
    const { token, exp } = await signRangeToken(SECRET, URL_OK, now);
    expect(exp).toBe(1_800_000_000 + 6 * 3600);
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyRangeToken(SECRET, URL_OK, token, now + 1000)).toBe(true);
    expect(await verifyRangeToken(SECRET, URL_OK, token, now + 6 * 3600 * 1000 + 2000)).toBe(false);
    expect(await verifyRangeToken(SECRET, URL_OK + '2', token, now)).toBe(false);
    expect(await verifyRangeToken('autre', URL_OK, token, now)).toBe(false);
    expect(await verifyRangeToken(SECRET, URL_OK, 'x.y', now)).toBe(false);
    await expect(signRangeToken('', URL_OK)).rejects.toThrow();
  });
});

describe('POST /lt/range-source', () => {
  let app: RunningApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const post = (body: unknown) => fetch(`${app!.baseUrl}/${fullToken()}/lt/range-source`, postJson(body));

  it('désactivé sans secret : capacité absente et 501', async () => {
    app = await startApp({});
    const health = (await (await fetch(`${app.baseUrl}/${fullToken()}/lt/health`)).json()) as { capabilities: { rangeThumbs: boolean } };
    expect(health.capabilities.rangeThumbs).toBe(false);
    expect((await post({ url: URL_OK })).status).toBe(501);
  });

  it('émet un jeton pour un lien émis, refuse le reste', async () => {
    const issued = new IssuedUrls();
    issued.note(URL_OK);
    app = await startApp({ thumbs: { ffmpeg: null, issued }, rangeProxy: { secret: SECRET, base: 'https://edge.example' } });
    const health = (await (await fetch(`${app.baseUrl}/${fullToken()}/lt/health`)).json()) as { capabilities: { rangeThumbs: boolean } };
    expect(health.capabilities.rangeThumbs).toBe(true);

    const ok = await post({ url: URL_OK });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { url: string; token: string; exp: number; base: string };
    expect(body.url).toBe(URL_OK);
    expect(body.base).toBe('https://edge.example');
    expect(await verifyRangeToken(SECRET, URL_OK, body.token)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);

    expect((await post({ url: 'https://inconnu.debrid.it/x' })).status).toBe(400); // jamais émis
    expect((await post({ url: 'http://127.0.0.1:11470/a' })).status).toBe(400); // local : pas de relais
    expect((await post({ url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });
});
