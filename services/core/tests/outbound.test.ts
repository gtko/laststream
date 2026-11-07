import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOutboundUrl, fetchText, MAX_BODY_BYTES, MAX_REDIRECTS, type FetchFn } from '../src/sources/http.js';
import { isNonPublicAddress } from '../src/sources/ip.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Faux fetch : enregistre chaque appel et répond via le gestionnaire. */
function scriptedFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return { fetch: mock as unknown as FetchFn, mock };
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function ok(body = '{"ok":true}'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('isNonPublicAddress : IPv4', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.5',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('%s est refusée', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1'])(
    '%s est publique',
    (ip) => {
      expect(isNonPublicAddress(ip)).toBe(false);
    },
  );
});

describe('isNonPublicAddress : IPv6', () => {
  it.each([
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fe80::1%eth0',
    'fd00::1',
    'FC00::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    'not-an-ip',
  ])('%s est refusée', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('%s est publique', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(false);
  });
});

describe('checkOutboundUrl', () => {
  it('refuse les schémas autres que http et https, sans écho de l URL', async () => {
    await expect(checkOutboundUrl('file:///etc/passwd', false)).rejects.toThrow('schéma non autorisé');
    await expect(checkOutboundUrl('ftp://example.com/x', true)).rejects.toThrow('schéma non autorisé');
    await expect(checkOutboundUrl('pas une url', false)).rejects.toThrow('URL invalide');
  });

  it('hors mode public, une IP privée littérale reste acceptée (usage local)', async () => {
    await expect(checkOutboundUrl('http://127.0.0.1:7001/manifest.json', false)).resolves.toBeInstanceOf(URL);
  });

  it('mode public : IP littérale privée refusée sans DNS', async () => {
    const lookup = vi.fn(async () => ['8.8.8.8']);
    await expect(checkOutboundUrl('http://10.0.0.5/x', true, lookup)).rejects.toThrow('adresse non publique');
    await expect(checkOutboundUrl('http://[::1]/x', true, lookup)).rejects.toThrow('adresse non publique');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('mode public : nom résolu vers une adresse privée refusé (DNS interne)', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34', '192.168.0.10']);
    await expect(checkOutboundUrl('https://rebind.example.test/x', true, lookup)).rejects.toThrow(
      'adresse non publique',
    );
  });

  it('mode public : nom résolu vers une adresse publique accepté', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34']);
    await expect(checkOutboundUrl('https://up.example.test/x', true, lookup)).resolves.toBeInstanceOf(URL);
    expect(lookup).toHaveBeenCalledWith('up.example.test');
  });

  it('mode public : échec de résolution ou aucune adresse refusé', async () => {
    const failing = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND up.example.test');
    };
    await expect(checkOutboundUrl('https://up.example.test/', true, failing)).rejects.toThrow('hôte non résolu');
    await expect(checkOutboundUrl('https://up.example.test/', true, async () => [])).rejects.toThrow(
      'adresse non publique',
    );
  });
});

describe('fetchText : redirections', () => {
  it('demande fetch avec redirect manual', async () => {
    const { fetch, mock } = scriptedFetch(async () => ok());
    await fetchText(fetch, 'https://up.example.com/manifest.json');
    expect(mock.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it(`suit jusqu'à ${MAX_REDIRECTS} redirections`, async () => {
    const script = [redirect('https://b.example.com/'), redirect('https://c.example.com/'), redirect('https://d.example.com/')];
    const { fetch, mock } = scriptedFetch(async () => script.shift() ?? ok('{"done":1}'));
    const res = await fetchText(fetch, 'https://start.example.com/');
    expect(res.text).toBe('{"done":1}');
    expect(mock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('refuse une quatrième redirection', async () => {
    let hop = 0;
    const { fetch, mock } = scriptedFetch(async () => redirect(`https://h${++hop}.example.com/`));
    await expect(fetchText(fetch, 'https://start.example.com/')).rejects.toThrow('trop de redirections');
    expect(mock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('mode public : une redirection vers une IP privée est refusée (chaque saut revalidé)', async () => {
    vi.stubEnv('LASTADDON_PUBLIC', '1');
    const { fetch, mock } = scriptedFetch(async () => redirect('http://10.0.0.5/admin'));
    await expect(fetchText(fetch, 'http://93.184.216.34/start')).rejects.toThrow('adresse non publique');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('redirection vers un schéma non http(s) refusée', async () => {
    const { fetch } = scriptedFetch(async () => redirect('file:///etc/passwd'));
    await expect(fetchText(fetch, 'https://start.example.com/')).rejects.toThrow('schéma non autorisé');
  });

  it('Location invalide : erreur sûre sans URL', async () => {
    const { fetch } = scriptedFetch(async () => redirect('http://[bad'));
    await expect(fetchText(fetch, 'https://start.example.com/')).rejects.toThrow('redirection invalide');
  });

  it('redirection sans en-tête Location : renvoyée telle quelle, non ok', async () => {
    const { fetch } = scriptedFetch(async () => new Response(null, { status: 304 }));
    const res = await fetchText(fetch, 'https://start.example.com/');
    expect(res).toMatchObject({ status: 304, ok: false, text: '' });
  });
});

describe('fetchText : taille du corps', () => {
  it('MAX_BODY_BYTES vaut 2 Mo', () => {
    expect(MAX_BODY_BYTES).toBe(2 * 1024 * 1024);
  });

  it('corps de taille normale lu entièrement', async () => {
    const { fetch } = scriptedFetch(async () => ok('x'.repeat(1024)));
    const res = await fetchText(fetch, 'https://up.example.com/');
    expect(res.text).toHaveLength(1024);
  });

  it('Content-Length au-delà de la limite : refusé avant lecture', async () => {
    const { fetch } = scriptedFetch(
      async () => new Response('x', { status: 200, headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
    );
    await expect(fetchText(fetch, 'https://up.example.com/')).rejects.toThrow('réponse trop volumineuse');
  });

  it('flux sans Content-Length dépassant la limite : interrompu', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const { fetch } = scriptedFetch(async () => new Response(stream, { status: 200 }));
    await expect(fetchText(fetch, 'https://up.example.com/')).rejects.toThrow('réponse trop volumineuse');
  });
});
