import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ResolvedLink, type ResolveFn, resolveWithFailover } from '../src/play/failover.js';
import type { PlayCopy } from '../src/play/token.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const TORRENT_A: PlayCopy = { infoHash: HASH_A, fileIdx: 0 };
const TORRENT_B: PlayCopy = { infoHash: HASH_B, fileIdx: 0 };
const URL_DOWN: PlayCopy = { url: 'https://down.example/a.mkv' };
const URL_DOWN_OTHER: PlayCopy = { url: 'https://down.example/c.mkv' };
const URL_OK: PlayCopy = { url: 'https://ok.example/b.mkv' };
const LINK: ResolvedLink = { url: 'https://cdn.example/ok.mkv', filename: 'ok.mkv', size: 42 };

afterEach(() => {
  vi.useRealTimers();
});

/** Erreur portant un code, comme celles des résolveurs réels. */
function coded(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

/** Clé d'une copie dans les tables de réponses : son URL, sinon son hash. */
function keyOf(copy: PlayCopy): string {
  return copy.url ?? copy.infoHash ?? '';
}

/** Résolveur à table : une réponse (lien ou erreur) par clé. Les appels sont journalisés. */
function resolverWith(table: Record<string, ResolvedLink | Error>): { resolve: ResolveFn; calls: string[] } {
  const calls: string[] = [];
  const resolve: ResolveFn = async (copy) => {
    const key = keyOf(copy);
    calls.push(key);
    const outcome = table[key];
    if (outcome === undefined) throw coded('unknown');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { resolve, calls };
}

const noHostDown = {
  isHostDown: (): boolean => false,
  markHostDown: (): void => undefined,
};

describe('resolveWithFailover', () => {
  it('réussit sur la deuxième copie après un not_cached sur la première', async () => {
    const { resolve, calls } = resolverWith({ [HASH_A]: coded('not_cached'), [HASH_B]: LINK });
    const result = await resolveWithFailover({ copies: [TORRENT_A, TORRENT_B], resolve, ...noHostDown });
    expect(result).toEqual({
      ok: true,
      link: LINK,
      attempts: [
        { index: 0, outcome: 'not_cached' },
        { index: 1, outcome: 'ok' },
      ],
    });
    expect(calls).toEqual([HASH_A, HASH_B]);
  });

  it('renvoie la dernière erreur propre aux copies quand toutes échouent', async () => {
    const { resolve } = resolverWith({ [HASH_A]: coded('dead_link'), [HASH_B]: coded('file_not_found') });
    const result = await resolveWithFailover({ copies: [TORRENT_A, TORRENT_B], resolve, ...noHostDown });
    expect(result).toEqual({
      ok: false,
      reason: 'file_not_found',
      attempts: [
        { index: 0, outcome: 'dead_link' },
        { index: 1, outcome: 'file_not_found' },
      ],
    });
  });

  it('renvoie no_copy sans tentative quand la liste est vide', async () => {
    const { resolve, calls } = resolverWith({});
    const result = await resolveWithFailover({ copies: [], resolve, ...noHostDown });
    expect(result).toEqual({ ok: false, reason: 'no_copy', attempts: [] });
    expect(calls).toEqual([]);
  });

  it('s arrête au dépassement du budget total (horloge factice)', async () => {
    let clock = 0;
    const calls: string[] = [];
    const resolve: ResolveFn = async (copy) => {
      calls.push(keyOf(copy));
      clock += calls.length === 1 ? 7000 : 6000;
      throw coded('not_cached');
    };
    const third: PlayCopy = { infoHash: 'c'.repeat(40) };
    const result = await resolveWithFailover({
      copies: [TORRENT_A, TORRENT_B, third],
      resolve,
      budgetMs: 12_000,
      now: () => clock,
      ...noHostDown,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'timeout',
      attempts: [
        { index: 0, outcome: 'not_cached' },
        { index: 1, outcome: 'not_cached' },
      ],
    });
    expect(calls).toEqual([HASH_A, HASH_B]);
  });

  it('borne chaque tentative par le temps restant du budget (timers factices)', async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const hangs: ResolveFn = (_copy, signal) => {
      seenSignal = signal;
      return new Promise<ResolvedLink>(() => undefined);
    };
    const pending = resolveWithFailover({
      copies: [TORRENT_A, TORRENT_B],
      resolve: hangs,
      budgetMs: 1000,
      now: () => 0,
      ...noHostDown,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: 'timeout', attempts: [{ index: 0, outcome: 'timeout' }] });
    expect(seenSignal?.aborted).toBe(true);
  });

  it.each(['invalid_key', 'subscription_expired', 'quota'] as const)(
    's arrête immédiatement sur l erreur globale %s',
    async (code) => {
      const { resolve, calls } = resolverWith({ [HASH_A]: coded(code), [HASH_B]: LINK });
      const result = await resolveWithFailover({ copies: [TORRENT_A, TORRENT_B], resolve, ...noHostDown });
      expect(result).toEqual({ ok: false, reason: code, attempts: [{ index: 0, outcome: code }] });
      expect(calls).toEqual([HASH_A]);
    },
  );

  it('passe à la copie suivante sur une erreur non codée ou inconnue', async () => {
    const { resolve } = resolverWith({ [HASH_A]: new Error('boom'), [HASH_B]: LINK });
    const result = await resolveWithFailover({ copies: [TORRENT_A, TORRENT_B], resolve, ...noHostDown });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      attempts: [
        { index: 0, outcome: 'unknown' },
        { index: 1, outcome: 'ok' },
      ],
    });
  });

  it('saute les copies dont l hôte est marqué down, sans les résoudre', async () => {
    const { resolve, calls } = resolverWith({ [keyOf(URL_DOWN)]: LINK, [keyOf(URL_OK)]: LINK });
    const result = await resolveWithFailover({
      copies: [URL_DOWN, URL_OK],
      resolve,
      isHostDown: (host) => host === 'down.example',
      markHostDown: () => undefined,
    });
    expect(result).toMatchObject({
      ok: true,
      attempts: [
        { index: 0, outcome: 'host_down' },
        { index: 1, outcome: 'ok' },
      ],
    });
    expect(calls).toEqual([keyOf(URL_OK)]);
  });

  it('marque l hôte down sur host_unavailable et saute ses autres copies', async () => {
    const down = new Set<string>();
    const { resolve, calls } = resolverWith({
      [keyOf(URL_DOWN)]: coded('host_unavailable'),
      [keyOf(URL_DOWN_OTHER)]: LINK,
      [keyOf(URL_OK)]: LINK,
    });
    const result = await resolveWithFailover({
      copies: [URL_DOWN, URL_DOWN_OTHER, URL_OK],
      resolve,
      isHostDown: (host) => down.has(host),
      markHostDown: (host) => down.add(host),
    });
    expect(down).toEqual(new Set(['down.example']));
    expect(result).toMatchObject({
      ok: true,
      attempts: [
        { index: 0, outcome: 'host_unavailable' },
        { index: 1, outcome: 'host_down' },
        { index: 2, outcome: 'ok' },
      ],
    });
    expect(calls).toEqual([keyOf(URL_DOWN), keyOf(URL_OK)]);
  });

  it('considère une copie torrent comme hôte alldebrid et renvoie host_unavailable si ce service est down', async () => {
    const { resolve, calls } = resolverWith({ [HASH_A]: LINK });
    const result = await resolveWithFailover({
      copies: [TORRENT_A],
      resolve,
      isHostDown: (host) => host === 'alldebrid',
      markHostDown: () => undefined,
    });
    expect(result).toEqual({ ok: false, reason: 'host_unavailable', attempts: [{ index: 0, outcome: 'host_down' }] });
    expect(calls).toEqual([]);
  });

  it('renvoie aborted quand l appelant annule pendant la tentative', async () => {
    const controller = new AbortController();
    const hangs: ResolveFn = () => new Promise<ResolvedLink>(() => undefined);
    const pending = resolveWithFailover({
      copies: [TORRENT_A, TORRENT_B],
      resolve: hangs,
      budgetMs: 60_000,
      now: () => 0,
      signal: controller.signal,
      ...noHostDown,
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'aborted', attempts: [{ index: 0, outcome: 'aborted' }] });
  });

  it('ne lance aucune tentative si l appelant a déjà annulé', async () => {
    const { resolve, calls } = resolverWith({ [HASH_A]: LINK });
    const controller = new AbortController();
    controller.abort();
    const result = await resolveWithFailover({
      copies: [TORRENT_A],
      resolve,
      signal: controller.signal,
      ...noHostDown,
    });
    expect(result).toEqual({ ok: false, reason: 'aborted', attempts: [] });
    expect(calls).toEqual([]);
  });
});
