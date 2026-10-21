// importFromStremio : un échec de relecture de la bibliothèque (réseau) ne doit pas masquer un import réussi côté serveur.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/data/userApi';
import { ServerUserStore } from '../src/data/serverUserStore';
import { auth, chooseProfile, importFromStremio, signIn, signOut } from '../src/data/auth';

vi.mock('../src/data/userApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/userApi')>();
  return { ...real, login: vi.fn(), me: vi.fn(), listProfiles: vi.fn(), importStremio: vi.fn() };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await signOut(true);
});

describe('importFromStremio', () => {
  it('renvoie la réponse de l’import même si la relecture de la bibliothèque échoue', async () => {
    vi.mocked(api.login).mockResolvedValue({ token: 't', expiresAt: Date.now() + 3_600_000 } as never);
    vi.mocked(api.me).mockResolvedValue({ account: { id: 'acc', username: 'alice' } } as never);
    vi.mocked(api.listProfiles).mockResolvedValue({ profiles: [{ id: 'p1', name: 'Alice', avatarColor: '#fff', isKid: false, hasPin: false, isMainProfile: true }] } as never);
    vi.mocked(api.importStremio).mockResolvedValue({ imported: 7 });
    const hydrate = vi.spyOn(ServerUserStore.prototype, 'hydrate').mockResolvedValue(undefined);
    await signIn('alice', 'pw');
    if (!auth.profile) await chooseProfile('p1');
    expect(auth.profile?.id).toBe('p1');
    hydrate.mockRejectedValue(new api.UserApiError(0, 'network'));
    await expect(importFromStremio('a@b.ch', 'pw', '')).resolves.toEqual({ imported: 7 });
    expect(hydrate).toHaveBeenCalled();
  });
});
