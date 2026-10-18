import type { Breadcrumb, ErrorEvent, EventHint } from '@sentry/cloudflare';
import { describe, expect, it } from 'vitest';
import {
  beforeBreadcrumbFilter,
  beforeSendFilter,
  beforeSendTransactionFilter,
  isExpectedError,
  scrubHeaders,
  scrubText,
  scrubUrl,
} from '../src/observability/scrub.js';

// Valeurs factices : aucune n'est un vrai identifiant, une vraie configuration ni un vrai lien débridé.
const HOST = 'https://addon.example.test';
const CONFIG = 'Zm9vYmFyYmF6'.repeat(6); // 72 caractères base64url : forme d'une configuration d'addon chiffrée
const SECRET = 'SECRET-FAKE-123';
const DEBRID = 'https://api.alldebrid.example.test/v4/magnet/upload?apikey=' + SECRET;
const MAGNET = 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=film';

function expectNoLeak(serialized: string): void {
  for (const leak of [SECRET, CONFIG, 'alldebrid', 'magnet:', 'user:pass', 'john@example.test', '203.0.113.7', 'profile-fake']) {
    expect(serialized).not.toContain(leak);
  }
}

describe('scrubUrl : origine et chemin seulement', () => {
  it('supprime la chaîne de requête entière', () => {
    expect(scrubUrl(`${HOST}/stream/movie/tt1.json?apikey=${SECRET}&x=1`)).toBe(`${HOST}/stream/movie/tt1.json`);
  });

  it('masque le segment de configuration d\'addon', () => {
    expect(scrubUrl(`${HOST}/${CONFIG}/stream/series/tt1:1:2.json`)).toBe(`${HOST}/[config]/stream/series/tt1:1:2.json`);
  });

  it('garde les segments courts et l\'origine (sans identifiants ni fragment)', () => {
    expect(scrubUrl('https://user:pass@addon.example.test:8443/manifest.json#frag')).toBe('https://addon.example.test:8443/manifest.json');
  });

  it('remplace tout lien de débrideur', () => {
    expect(scrubUrl(DEBRID)).toBe('[debrid-url]');
    expect(scrubUrl('https://api.real-debrid.example.test/rest/1.0/user')).toBe('[debrid-url]');
    expect(scrubUrl('https://api.torbox.example.test/v1/api/user/me')).toBe('[debrid-url]');
    expect(scrubUrl('https://api.premiumize.example.test/account/info')).toBe('[debrid-url]');
  });

  it('remplace un lien magnet', () => {
    expect(scrubUrl(MAGNET)).toBe('[magnet]');
  });

  it('coupe la requête d\'un chemin relatif', () => {
    expect(scrubUrl(`/stream/${CONFIG}/x.json?token=${SECRET}`)).toBe('/stream/[config]/x.json');
  });

  it('refuse les schémas autres que http(s)', () => {
    expect(scrubUrl('ftp://addon.example.test/file')).toBe('[redacted]');
  });
});

describe('scrubText : texte libre', () => {
  it('épure les URL contenues dans un message', () => {
    expect(scrubText(`échec sur ${HOST}/${CONFIG}/manifest.json?apikey=${SECRET}`)).toBe(`échec sur ${HOST}/[config]/manifest.json`);
  });

  it('remplace les clés d\'API et jetons en paramètres', () => {
    expect(scrubText(`apikey=${SECRET} et token=${SECRET}`)).toBe('apikey=[redacted] et token=[redacted]');
    expect(scrubText(`access_token=${SECRET}&x=1`)).toBe('access_token=[redacted]&x=1');
  });

  it('remplace les magnets et les liens débridés', () => {
    expect(scrubText(`ajout ${MAGNET} puis ${DEBRID}`)).toBe('ajout [magnet] puis [debrid-url]');
  });

  it('masque l\'en-tête Bearer', () => {
    expect(scrubText(`Bearer ${SECRET}`)).toBe('Bearer [redacted]');
  });

  it('masque un segment de configuration dans un nom de transaction', () => {
    expect(scrubText(`GET /${CONFIG}/manifest.json`)).toBe('GET /[config]/manifest.json');
  });

  it('laisse intact un texte sans donnée sensible', () => {
    expect(scrubText('Erreur interne TypeError')).toBe('Erreur interne TypeError');
  });
});

describe('scrubHeaders : en-têtes', () => {
  it('supprime authentification, cookies, profil, clés et IP', () => {
    const out = scrubHeaders({
      Authorization: `Bearer ${SECRET}`,
      cookie: `session=${SECRET}`,
      'X-Profile-Id': 'profile-fake',
      'x-api-key': SECRET,
      'x-custom-token': SECRET,
      'CF-Connecting-IP': '203.0.113.7',
      'X-Forwarded-For': '203.0.113.7',
    });
    expect(out).toEqual({});
  });

  it('garde les en-têtes ordinaires en épurant leurs valeurs', () => {
    expect(scrubHeaders({ 'user-agent': 'Stremio/1.0', accept: 'application/json', referer: `${HOST}/${CONFIG}/configure?apikey=${SECRET}` })).toEqual({
      'user-agent': 'Stremio/1.0',
      accept: 'application/json',
      referer: `${HOST}/[config]/configure`,
    });
  });
});

describe('beforeSendFilter : erreurs', () => {
  const hint = (originalException: unknown): EventHint => ({ originalException });

  it('écarte les 4xx applicatifs', () => {
    expect(beforeSendFilter({ type: undefined }, hint(Object.assign(new Error('nope'), { status: 404 })))).toBeNull();
    expect(beforeSendFilter({ type: undefined }, hint({ statusCode: 429 }))).toBeNull();
  });

  it('écarte l\'abandon côté client (AbortError) et server_side_disabled', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const disabled = Object.assign(new Error('AllDebrid désactivé côté serveur'), { name: 'AllDebridError', code: 'server_side_disabled' });
    expect(beforeSendFilter({ type: undefined }, hint(abort))).toBeNull();
    expect(beforeSendFilter({ type: undefined }, hint(disabled))).toBeNull();
  });

  it('écarte un événement dont l\'exception est un AbortError, même sans hint', () => {
    const event: ErrorEvent = { type: undefined, exception: { values: [{ type: 'AbortError', value: 'aborted' }] } };
    expect(beforeSendFilter(event)).toBeNull();
  });

  it('garde les erreurs 500 et les erreurs inattendues', () => {
    expect(beforeSendFilter({ type: undefined }, hint(new Error('boom')))).not.toBeNull();
    expect(beforeSendFilter({ type: undefined }, hint(Object.assign(new Error('x'), { status: 500 })))).not.toBeNull();
    expect(beforeSendFilter({ type: undefined }, hint(undefined))).not.toBeNull();
  });

  it('épure toute la charge utile d\'une erreur et ne mute pas l\'entrée', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: `échec ${HOST}/${CONFIG}/stream?apikey=${SECRET}`,
      transaction: `GET /${CONFIG}/manifest.json`,
      request: {
        method: 'GET',
        url: `${HOST}/${CONFIG}/manifest.json?token=${SECRET}`,
        query_string: `token=${SECRET}`,
        cookies: { session: SECRET },
        data: { body: SECRET },
        env: { SECRET_VALUE: SECRET },
        headers: { authorization: `Bearer ${SECRET}`, 'user-agent': 'Stremio/1.0', 'x-profile-id': 'profile-fake' },
      },
      user: { id: 'u_42', email: 'john@example.test', ip_address: '203.0.113.7', username: 'john' },
      exception: {
        values: [{ type: 'Error', value: `${DEBRID} ${MAGNET}`, stacktrace: { frames: [{ filename: 'x.ts', vars: { config: CONFIG } }] } }],
      },
      breadcrumbs: [
        {
          category: 'fetch',
          message: `GET ${HOST}/${CONFIG}/x?apikey=${SECRET}`,
          data: { url: `${HOST}/${CONFIG}/x?apikey=${SECRET}`, headers: { cookie: SECRET, accept: '*/*' }, request_body: SECRET },
        },
      ],
      extra: { note: `ok apikey=${SECRET}`, nested: { deep: { url: `${HOST}/${CONFIG}/y?token=${SECRET}` } } },
      tags: { route: '/stream' },
    };
    const before = structuredClone(event);

    const out = beforeSendFilter(event) as ErrorEvent;

    expect(out).not.toBeNull();
    expectNoLeak(JSON.stringify(out));
    expect(out.request).toEqual({
      method: 'GET',
      url: `${HOST}/[config]/manifest.json`,
      headers: { 'user-agent': 'Stremio/1.0' },
    });
    expect(out.user).toEqual({ id: 'u_42' });
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ filename: 'x.ts' });
    expect(out.breadcrumbs?.[0]?.data).toEqual({ url: `${HOST}/[config]/x`, headers: { accept: '*/*' } });
    expect(out.tags).toEqual({ route: '/stream' });
    expect(event).toEqual(before);
  });
});

describe('beforeSendTransactionFilter : traces', () => {
  it('épure le nom de transaction, la requête et les URL des spans (appels sortants compris)', () => {
    const event = {
      type: 'transaction' as const,
      transaction: `GET /${CONFIG}/stream/movie/tt1.json`,
      request: { url: `${HOST}/${CONFIG}/manifest.json?apikey=${SECRET}` },
      spans: [
        {
          span_id: '1',
          trace_id: '2',
          start_timestamp: 0,
          status: 'ok' as const,
          description: `GET https://api.tmdb.example.test/3/find?api_key=${SECRET}`,
          data: {
            url: `https://api.tmdb.example.test/3/find?api_key=${SECRET}`,
            'http.query': `?api_key=${SECRET}`,
            'http.request.header.authorization': `Bearer ${SECRET}`,
            'http.request.header.x-profile-id': 'profile-fake',
            'http.request.header.accept': 'application/json',
          },
        },
      ],
    };

    const out = beforeSendTransactionFilter(structuredClone(event));

    expectNoLeak(JSON.stringify(out));
    expect(out.transaction).toBe('GET /[config]/stream/movie/tt1.json');
    expect(out.request).toEqual({ url: `${HOST}/[config]/manifest.json` });
    expect(out.spans?.[0]).toMatchObject({
      description: 'GET https://api.tmdb.example.test/3/find',
      data: { url: 'https://api.tmdb.example.test/3/find' },
    });
    expect(out.spans?.[0]?.data).not.toHaveProperty('http.query');
    expect(out.spans?.[0]?.data).not.toHaveProperty('http.request.header.authorization');
    expect(out.spans?.[0]?.data).not.toHaveProperty('http.request.header.x-profile-id');
    expect(out.spans?.[0]?.data).toHaveProperty('http.request.header.accept', 'application/json');
  });
});

describe('beforeBreadcrumbFilter : fil d\'Ariane', () => {
  it('retire corps, cookies et chaînes de requête, réduit les URL', () => {
    const breadcrumb: Breadcrumb = {
      category: 'http',
      message: `appel ${HOST}/${CONFIG}/x?apikey=${SECRET}`,
      data: {
        url: `${HOST}/${CONFIG}/x?token=${SECRET}`,
        method: 'GET',
        status_code: 200,
        query: `token=${SECRET}`,
        response_body: SECRET,
        headers: { Authorization: `Bearer ${SECRET}`, accept: 'application/json' },
      },
    };

    const out = beforeBreadcrumbFilter(breadcrumb);

    expectNoLeak(JSON.stringify(out));
    expect(out.message).toBe(`appel ${HOST}/[config]/x`);
    expect(out.data).toEqual({ url: `${HOST}/[config]/x`, method: 'GET', status_code: 200, headers: { accept: 'application/json' } });
  });
});

describe('isExpectedError', () => {
  it('reconnaît les erreurs attendues et seulement celles-là', () => {
    expect(isExpectedError(Object.assign(new Error('x'), { status: 403 }))).toBe(true);
    expect(isExpectedError({ name: 'AbortError' })).toBe(true);
    expect(isExpectedError({ code: 'server_side_disabled' })).toBe(true);
    expect(isExpectedError(new Error('inattendue'))).toBe(false);
    expect(isExpectedError(Object.assign(new Error('x'), { status: 503 }))).toBe(false);
    expect(isExpectedError('chaîne')).toBe(false);
    expect(isExpectedError(undefined)).toBe(false);
  });
});
