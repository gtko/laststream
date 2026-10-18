import { afterEach, describe, expect, it } from 'vitest';
import { IssuedUrls } from '../src/play/issued.js';
import { signRangeToken, verifyRangeToken } from '../src/lt/thumbs/range-token.js';
import { fullToken, postJson, startApp, tokenFor, type RunningApp } from './lt-harness.js';

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

  const config = fullToken();
  const post = (body: unknown) => fetch(`${app!.baseUrl}/${config}/lt/range-source`, postJson(body));

  it('désactivé sans secret : capacité absente et 501', async () => {
    app = await startApp({});
    const health = (await (await fetch(`${app.baseUrl}/${fullToken()}/lt/health`)).json()) as { capabilities: { rangeThumbs: boolean } };
    expect(health.capabilities.rangeThumbs).toBe(false);
    expect((await post({ url: URL_OK })).status).toBe(501);
  });

  it('émet un jeton pour un lien émis, refuse le reste', async () => {
    const issued = new IssuedUrls();
    await issued.note(URL_OK);
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

    expect((await post({ url: 'https://exemple.org/film.mkv' })).status).toBe(400); // autre domaine, jamais émis
    expect((await post({ url: 'http://127.0.0.1:11470/a' })).status).toBe(400); // local : pas de relais
    expect((await post({ url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('signe un lien débridé direct d’un domaine autorisé même s’il n’a pas été émis, et refuse le reste', async () => {
    app = await startApp({ thumbs: { ffmpeg: null, issued: new IssuedUrls() }, rangeProxy: { secret: SECRET, base: 'https://edge.example' } });
    for (const url of ['https://inconnu.debrid.it/dl/x.mkv', 'https://s12.alldebrid.com/dl/y.mp4?token=a']) {
      const res = await post({ url });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; token: string };
      expect(body.url).toBe(url);
      expect(await verifyRangeToken(SECRET, url, body.token)).toBe(true);
    }
    const refused = [
      'https://debrid.it/x', // domaine nu : le joker ne le couvre pas
      'https://debrid.it.evil.example/x', // domaine imité
      'https://evil-debrid.it/x',
      'https://a.debrid.it:8443/x', // port autre que 443
      'https://u:p@a.debrid.it/x', // identifiants
      'http://a.debrid.it/x', // pas https
      'https://203.0.113.9/x', // adresse IP
      'https://exemple.org/film.mkv',
    ];
    for (const url of refused) expect((await post({ url })).status, url).toBe(400);
  });

  it('limite le débit des liens débridés directs par configuration (429), sans toucher aux liens émis', async () => {
    const issued = new IssuedUrls();
    await issued.note(URL_OK);
    app = await startApp({ thumbs: { ffmpeg: null, issued }, rangeProxy: { secret: SECRET, base: 'https://edge.example' } });
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await post({ url: `https://a.debrid.it/dl/${i}.mkv` })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // Un lien émis par /play n'est pas concerné ; une autre configuration non plus.
    expect((await post({ url: URL_OK })).status).toBe(200);
    const other = await fetch(`${app.baseUrl}/${tokenFor({ tmdbToken: "autre-config" })}/lt/range-source`, postJson({ url: 'https://a.debrid.it/dl/z.mkv' }));
    expect(other.status).toBe(200);
  });
});
