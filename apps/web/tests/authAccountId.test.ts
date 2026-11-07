// Identifiant de compte (supervision Sentry) : une réponse de GET /me arrivée après un changement de session est ignorée.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/data/userApi';
import { auth, signIn, signOut } from '../src/data/auth';

vi.mock('../src/data/userApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/userApi')>();
  return { ...real, login: vi.fn(), me: vi.fn() };
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  await signOut(true);
  vi.mocked(api.me).mockReset();
  vi.mocked(api.login).mockReset();
});

/** GET /me en attente : la résolution est pilotée par le test. */
function pendingMe(): (account: { id: string; username: string }) => void {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.me).mockImplementation(() => new Promise((r) => { resolve = r; }) as never);
  return (account) => resolve({ account });
}

describe('accountId : réponse de GET /me', () => {
  it('garde l’identifiant quand l’utilisateur connecté est toujours le même', async () => {
    const answer = pendingMe();
    vi.mocked(api.login).mockResolvedValue({ token: 't', expiresAt: Date.now() + 3_600_000 } as never);
    await signIn('Alice', 'pw').catch(() => undefined);
    answer({ id: 'acc-alice', username: 'alice' });
    await flush();
    expect(auth.accountId).toBe('acc-alice');
  });

  it('déconnexion avant la réponse : le compte précédent n’est pas écrit', async () => {
    const answer = pendingMe();
    vi.mocked(api.login).mockResolvedValue({ token: 't', expiresAt: Date.now() + 3_600_000 } as never);
    await signIn('Alice', 'pw').catch(() => undefined);
    await signOut(true);
    answer({ id: 'acc-alice', username: 'alice' });
    await flush();
    expect(auth.accountId).toBe('');
  });

  it('autre utilisateur connecté entre-temps : l’identifiant de l’ancien compte n’est pas écrit', async () => {
    const answer = pendingMe();
    vi.mocked(api.login).mockResolvedValue({ token: 't', expiresAt: Date.now() + 3_600_000 } as never);
    await signIn('Alice', 'pw').catch(() => undefined);
    vi.mocked(api.me).mockImplementation(() => new Promise(() => undefined) as never);
    await signIn('Bob', 'pw').catch(() => undefined);
    answer({ id: 'acc-alice', username: 'alice' });
    await flush();
    expect(auth.accountId).not.toBe('acc-alice');
  });
});
