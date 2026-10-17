import { describe, expect, it } from 'vitest';
import { enrichHosterLinks } from '../src/engine/hosters-step.js';
import type { Candidate } from '../src/engine/types.js';
import { HostHealth } from '../src/play/hosts.js';
import { AllDebridClient } from '../src/sources/alldebrid.js';
import { HosterClient } from '../src/sources/hosters.js';
import { cand } from './engine-fixtures.js';

const API_KEY = 'AD-TEST-KEY-STEP';
const LIVE = 'https://1fichier.com/live1';
const DEAD = 'https://1fichier.com/dead1';
const UPTO = 'https://uptobox.com/abcdefghijkl';
const DIRECT_HTTP = 'https://example.com/video.mp4';

interface Call {
  path: string;
  form: URLSearchParams;
}

type Reply = { status?: number; body: unknown } | 'never';

/** fetch simulé : hôtes, puis infos par lien (`infos` : lien → données, ou 'dead'). */
function fakeAllDebrid(opts: {
  infos?: Record<string, Record<string, unknown> | 'dead'>;
  infosReply?: () => Reply;
  hostsFail?: boolean;
}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    calls.push({ path: url.pathname, form });
    if (url.pathname === '/v4/user/hosts') {
      if (opts.hostsFail === true) throw new TypeError('fetch failed');
      return json({ status: 'success', data: { hosts: [{ name: '1fichier', domains: ['1fichier.com'], regexps: [] }, { name: 'Uptobox', domains: ['uptobox.com'], regexps: [] }] } });
    }
    if (url.pathname === '/v4/link/infos') {
      if (opts.infosReply !== undefined) {
        const reply = opts.infosReply();
        if (reply === 'never') return new Promise<Response>(() => undefined);
        return json(reply.body, reply.status);
      }
      const infos = form.getAll('link[]').map((link) => {
        const entry = opts.infos?.[link];
        if (entry === undefined) return { link, filename: 'inconnu.mkv' };
        if (entry === 'dead') return { link, error: { code: 'LINK_DOWN', message: 'down' } };
        return { link, ...entry };
      });
      return json({ status: 'success', data: { infos } });
    }
    return json({ status: 'error', error: { code: 'unexpected', message: 'unexpected' } }, 400);
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(opts: Parameters<typeof fakeAllDebrid>[0] = {}): { client: HosterClient; calls: Call[] } {
  const fake = fakeAllDebrid(opts);
  const api = new AllDebridClient(API_KEY, { fetch: fake.fetch });
  return { client: new HosterClient(api), calls: fake.calls };
}

function hosterCand(url: string, overrides: { title?: string } = {}): Candidate {
  return cand({ raw: { url, title: overrides.title ?? 'Film.2024.1080p.WEB-DL' } });
}

function infosCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.path === '/v4/link/infos');
}

describe('enrichHosterLinks', () => {
  it('sans candidat à URL : aucun appel réseau, liste inchangée', async () => {
    const { client, calls } = setup();
    const input = [cand({ parsed: { infoHash: undefined } })];
    const result = await enrichHosterLinks(input, { client });
    expect(result).toBe(input);
    expect(calls).toHaveLength(0);
  });

  it('lien vivant : vérifié, hébergeur et métadonnées, sans muter le candidat reçu', async () => {
    const { client } = setup({ infos: { [LIVE]: { filename: 'film.mkv', size: 999, hostDomain: '1fichier.com' } } });
    const input = [hosterCand(LIVE)];
    const [out] = await enrichHosterLinks(input, { client });
    expect(out).toMatchObject({
      directVerified: true,
      hoster: '1fichier',
      raw: { url: LIVE, filename: 'film.mkv', sizeBytes: 999 },
      parsed: { sizeBytes: 999 },
    });
    expect(input[0]?.directVerified).toBeUndefined();
    expect(input[0]?.hoster).toBeUndefined();
    expect(input[0]?.raw.filename).toBeUndefined();
  });

  it('conserve le nom de fichier et la taille déjà renseignés', async () => {
    const { client } = setup({ infos: { [LIVE]: { filename: 'autre.mkv', size: 5 } } });
    const input = [cand({ raw: { url: LIVE, filename: 'deja.mkv', sizeBytes: 42 }, parsed: { sizeBytes: 42 } })];
    const [out] = await enrichHosterLinks(input, { client });
    expect(out?.raw.filename).toBe('deja.mkv');
    expect(out?.raw.sizeBytes).toBe(42);
    expect(out?.parsed.sizeBytes).toBe(42);
  });

  it('lien mort : retiré ; ordre des autres candidats conservé ; direct non listé intact', async () => {
    const { client } = setup({ infos: { [LIVE]: {}, [DEAD]: 'dead' } });
    const direct = cand({ raw: { url: DIRECT_HTTP, title: 'Direct' } });
    const input = [hosterCand(DEAD), direct, hosterCand(LIVE), hosterCand(UPTO)];
    const result = await enrichHosterLinks(input, { client });
    expect(result.map((item) => item.raw.url)).toEqual([DIRECT_HTTP, LIVE, UPTO]);
    expect(result[0]).toBe(direct);
    expect(result[0]?.directVerified).toBeUndefined();
    expect(result[1]?.directVerified).toBe(true);
    expect(result[1]?.hoster).toBe('1fichier');
    expect(result[2]?.hoster).toBe('Uptobox');
  });

  it('hôte marqué en panne : candidat écarté sans contrôle de ses liens', async () => {
    const { client, calls } = setup({ infos: { [UPTO]: {} } });
    const health = new HostHealth({ now: () => 0 });
    health.markDown('1fichier.com');
    const result = await enrichHosterLinks([hosterCand(LIVE), hosterCand(UPTO)], { client, hostHealth: health });
    expect(result.map((item) => item.raw.url)).toEqual([UPTO]);
    const checked = infosCalls(calls).flatMap((call) => call.form.getAll('link[]'));
    expect(checked).toEqual([UPTO]);
  });

  it('topN : seuls les N premiers liens d’hébergeur sont contrôlés, les autres restent inchangés', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://1fichier.com/item${i}`);
    const { client, calls } = setup();
    const result = await enrichHosterLinks(urls.map((url) => hosterCand(url)), { client, topN: 3 });
    expect(infosCalls(calls).flatMap((call) => call.form.getAll('link[]'))).toEqual(urls.slice(0, 3));
    expect(result).toHaveLength(10);
    expect(result.slice(0, 3).every((item) => item.directVerified === true)).toBe(true);
    expect(result.slice(3).every((item) => item.directVerified === undefined)).toBe(true);
  });

  it('catalogue injoignable : liste reçue inchangée, sans exception', async () => {
    const { client } = setup({ hostsFail: true });
    const input = [hosterCand(LIVE)];
    const result = await enrichHosterLinks(input, { client });
    expect(result).toBe(input);
  });

  it('lot de contrôle en erreur : candidats inchangés, sans exception', async () => {
    const { client } = setup({ infosReply: () => ({ status: 500, body: {} }) });
    const input = [hosterCand(LIVE), hosterCand(DEAD)];
    const result = await enrichHosterLinks(input, { client });
    expect(result).toEqual(input);
    expect(result.every((item) => item.directVerified === undefined)).toBe(true);
  });

  it('budget dépassé : liste reçue inchangée dans le délai', async () => {
    const { client } = setup({ infosReply: () => 'never' });
    const input = [hosterCand(LIVE)];
    const started = Date.now();
    const result = await enrichHosterLinks(input, { client, budgetMs: 30 });
    expect(result).toBe(input);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
