// Mes invitations (Réglages) : un lien révoqué par l'administrateur affiche le motif et n'offre ni lien, ni copie, ni partage, ni régénération.
// La régénération refusée (409 invite_revoked) affiche un message clair et recharge la liste.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as socialApi from '../src/data/socialApi';
import { UserApiError } from '../src/data/userApi';

vi.mock('../src/data/socialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/socialApi')>()),
  getInvites: vi.fn(),
  revokeInvite: vi.fn(),
  markInviteSent: vi.fn(),
  setInviteQuota: vi.fn(),
}));

let inv: typeof import('../src/ui/invites.js');

const BASE = { id: 'i1', code: 'abc123', createdAt: '2026-10-01T10:00:00.000Z', sentAt: null, usedAt: null, revokedAt: null, message: null, picks: [], expiresAt: null, number: 1001, invitee: null };
const toastText = () => document.getElementById('toast')!.textContent ?? '';

beforeAll(async () => {
  // dom.js attend ces éléments à l'import (détail, modale, toast).
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="modal"><div class="modal"></div></div>' +
    '<div id="modal-body"></div><button id="modal-close"></button><div id="toast"></div>';
  inv = await import('../src/ui/invites.js');
});

beforeEach(() => {
  vi.mocked(socialApi.getInvites).mockReset();
  vi.mocked(socialApi.revokeInvite).mockReset();
});

// Actions d'un billet : copier, partager, annuler, composeur (mot). Un billet révoqué n'en offre aucune.
const ACTIONS = ['data-tk-copy', 'data-tk-share', 'data-tk-revoke', 'id="tk-msg"'];
const bodyOf = (invite: Record<string, unknown>) => inv.invitesBodyHTML({ quota: 4, invites: [invite] } as never);

describe('billets révoqués par l’administrateur', () => {
  it('révoqué : motif affiché, aucune action ni composeur', () => {
    const html = bodyOf({ ...BASE, state: 'free', revokedAt: '2026-10-19T08:00:00.000Z' });
    expect(html).toContain('Révoqué par l’administrateur');
    for (const marker of ACTIONS) expect(html).not.toContain(marker);
  });

  it('envoyé puis révoqué : pas d’annulation ni de copie non plus', () => {
    const html = bodyOf({ ...BASE, state: 'sent', revokedAt: '2026-10-19T08:00:00.000Z' });
    expect(html).toContain('Révoqué par l’administrateur');
    expect(html).not.toContain('Annuler le billet');
    expect(html).not.toContain('data-tk-copy');
  });

  it('état « revoked » : même rendu que la révocation par date', () => {
    const html = bodyOf({ ...BASE, state: 'revoked', revokedAt: null });
    expect(html).toContain('Révoqué');
    expect(html).toContain('Révoqué par l’administrateur');
    for (const marker of ACTIONS) expect(html).not.toContain(marker);
  });

  it('révoqué : billet non cliquable (aria-disabled), aucun panneau à l’activation', async () => {
    vi.mocked(socialApi.getInvites).mockResolvedValue({ quota: 1, invites: [{ ...BASE, state: 'free', revokedAt: '2026-10-19T08:00:00.000Z' }] } as never);
    document.getElementById('detail')!.innerHTML = inv.invitesCard();
    await inv.refreshInvites();
    const t = document.querySelector<HTMLElement>('#detail .tk-ticket')!;
    expect(t.getAttribute('aria-disabled')).toBe('true');
    expect(t.hasAttribute('aria-pressed')).toBe(false);
    expect(t.className).toContain('tk-is-revoked');
    t.click();
    expect(document.querySelector('#detail [data-tk-pane]')).toBeNull();
  });

  it('non révoqué (revokedAt absent ou null) : composeur, copie, partage et annulation comme avant, une fois le billet choisi', async () => {
    for (const extra of [{}, { revokedAt: null }]) {
      vi.mocked(socialApi.getInvites).mockResolvedValue({ quota: 1, invites: [{ ...BASE, state: 'free', ...extra }] } as never);
      document.getElementById('detail')!.innerHTML = inv.invitesCard();
      await inv.refreshInvites();
      expect(document.getElementById('detail')!.innerHTML).not.toContain('id="tk-msg"');
      document.querySelector<HTMLElement>('#detail [data-tk-sel="i1"]')!.click();
      const html = document.getElementById('detail')!.innerHTML;
      expect(html).not.toContain('Révoqué par l’administrateur');
      for (const marker of ['data-tk-copy', 'data-tk-share', 'id="tk-msg"']) expect(html).toContain(marker);
    }
  });

  it('régénération refusée (409 invite_revoked) : message en français, liste rechargée', async () => {
    vi.mocked(socialApi.getInvites).mockResolvedValue({ quota: 2, invites: [{ ...BASE, state: 'free' }] } as never);
    vi.mocked(socialApi.revokeInvite).mockRejectedValue(new UserApiError(409, 'invite_revoked'));
    await inv.refreshInvites();
    const ok = await inv.revokeOne('i1');
    expect(ok).toBe(false);
    expect(socialApi.revokeInvite).toHaveBeenCalledWith('i1');
    expect(toastText()).toContain('révoqué par l’administrateur');
    expect(socialApi.getInvites).toHaveBeenCalledTimes(2);
  });
});
