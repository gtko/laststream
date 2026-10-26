import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Régression ODY-235 : les Workers interdisent toute génération aléatoire en portée globale
 * (erreur Cloudflare 10021, invisible au `--dry-run`). Le module Molotov ne doit donc rien tirer à l'import.
 */
const randomUUID = vi.hoisted(() => vi.fn());

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  randomUUID.mockImplementation(() => actual.randomUUID());
  return { ...actual, randomUUID };
});

describe('molotov : portée globale', () => {
  beforeEach(() => {
    randomUUID.mockClear();
    vi.resetModules();
  });

  it("ne génère aucun identifiant à l'import du module", async () => {
    await import('../src/user/molotov.js');
    expect(randomUUID).not.toHaveBeenCalled();
  });

  it('génère les identifiants au premier appel puis les garde stables', async () => {
    const { clientHeaders } = await import('../src/user/molotov.js');
    const first = clientHeaders();
    const second = clientHeaders();
    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(first['x-device-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(first['x-session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(first['x-device-id']).not.toBe(first['x-session-id']);
    expect(first['x-ad-id']).toBe(first['x-device-id']);
    expect(second).toEqual(first);
    expect(first['x-application-id']).toBe('molotov');
  });
});
