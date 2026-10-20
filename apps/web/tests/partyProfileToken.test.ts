import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/data/config', async (orig) => ({ ...(await orig<Record<string, unknown>>()), requireBase: () => 'https://srv.test' }));

import { saveProfileToken, setActiveProfile, setSession } from '../src/data/session';
import { createParty, joinParty, createPartyInviteLink } from '../src/data/socialApi';

describe('salons : jeton de profil (profil protégé par PIN)', () => {
  beforeEach(() => {
    const later = new Date(Date.now() + 864e5).toISOString();
    setSession('tok', later, 'a');
    setActiveProfile('p1');
    saveProfileToken('p1', { token: 'pin-ok', expiresAt: later } as never);
  });

  it('création, entrée et lien d’invitation joignent X-Profile-Token', async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ room: { id: 'r' }, ticket: 't', token: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await createParty({ profileId: 'p1', visibility: 'private', title: 'Dune', media: { type: 'movie', tmdbId: 1 } } as never);
    await joinParty('r', 'p1');
    await createPartyInviteLink('r', 'p1');
    expect(seen.map((h) => h['x-profile-token'])).toEqual(['pin-ok', 'pin-ok', 'pin-ok']);
  });
});
