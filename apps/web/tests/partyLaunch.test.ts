// Boîte de lancement « Watch party » (Social v3) et messages d'erreur humains de la création de salon.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { UserApiError } from '../src/data/userApi';
import { partyCreateErrorText, PARTY_CREATE_FALLBACK } from '../src/party/createError';

beforeAll(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
});

describe('messages de création de salon', () => {
  it('un texte humain par code, sans suffixe de diagnostic', () => {
    expect(partyCreateErrorText(new UserApiError(403, 'pin_required'))).toMatch(/code de ton profil/);
    expect(partyCreateErrorText(new UserApiError(409, 'too_many_rooms'))).toMatch(/trois salons/);
    expect(partyCreateErrorText(new UserApiError(403, 'kid_profile'))).toMatch(/profil enfant/);
    expect(partyCreateErrorText(new UserApiError(0, 'network'))).toMatch(/^Serveur injoignable/);
    expect(partyCreateErrorText(new UserApiError(429, 'rate_limited'))).toMatch(/Trop de tentatives/);
    expect(partyCreateErrorText(new UserApiError(500, 'http_500'))).toBe(PARTY_CREATE_FALLBACK);
    expect(partyCreateErrorText(new Error('boom'))).toBe(PARTY_CREATE_FALLBACK);
    expect(PARTY_CREATE_FALLBACK).toBe('Création du salon impossible pour le moment.');
  });
});

describe('handlePartyCreateError', () => {
  it('affiche le message et garde le console.error', async () => {
    const { handlePartyCreateError } = await import('../src/ui/partyerrors.js');
    const say = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handlePartyCreateError(new UserApiError(0, 'network'), { say });
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/^Serveur injoignable/));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('boîte de lancement', () => {
  it('carte du titre, segments de visibilité, départ du salon d’attente', async () => {
    const { partyDialogHTML } = await import('../src/ui/partylaunch.js');
    const html = partyDialogHTML(false, true, { name: '<b>Dune</b>', posterPath: '/abc.jpg', type: 'movie' });
    const box = document.createElement('div');
    box.innerHTML = html;
    expect(box.querySelector('.pld-name')!.textContent).toBe('<b>Dune</b>');
    expect(box.querySelector('.pld-name b')).toBeNull();
    expect(box.querySelector('.pld-poster img')!.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w185/abc.jpg');
    expect(box.querySelectorAll('input[name="vis"]').length).toBeGreaterThanOrEqual(1);
    expect(box.querySelector('[data-wp-mode="lobby"]')!.textContent).toContain('Ouvrir le salon d’attente');
    expect(box.querySelector('[data-wp-mode="direct"]')!.textContent).toBe('Lancer tout de suite');
  });
  it('profil enfant ou hors compte : lecture immédiate seulement, privé', async () => {
    const { partyDialogHTML } = await import('../src/ui/partylaunch.js');
    const box = document.createElement('div');
    box.innerHTML = partyDialogHTML(true, false, null);
    expect(box.querySelector('[data-wp-mode="lobby"]')).toBeNull();
    expect(box.querySelector('input[value="public"]')).toBeNull();
    expect(box.querySelector('input[name="friend"]')).toBeNull();
  });
});

describe('création différée (bridge) : rien ne reste armé après un échec', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function setup(err: unknown) {
    const { partyBridge } = await import('../src/party/bridge');
    const a: any = { ready: true };
    partyBridge.leave();
    vi.spyOn(partyBridge, 'available').mockReturnValue(true);
    const create = vi.spyOn(partyBridge, 'create').mockRejectedValue(err);
    partyBridge.adapter = () => a;
    return { partyBridge, a, create };
  }
  it('pin_required annulé : plus de pending ni d’invitations, le viewReady suivant ne crée rien', async () => {
    const { partyBridge, a, create } = await setup(new UserApiError(403, 'pin_required'));
    let cancel = () => {};
    partyBridge.onCreateError = (_e, _r, c) => { cancel = c; };
    partyBridge.pending = { visibility: 'private' };
    partyBridge.pendingInvites = ['p1'];
    partyBridge.viewReady(a);
    await flush();
    expect(partyBridge.pending).toBeNull();
    cancel();
    expect(partyBridge.pendingInvites).toEqual([]);
    partyBridge.viewReady(a);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('retry : réarme seulement si le lecteur est le même, sinon abandonne sans créer', async () => {
    const { partyBridge, a, create } = await setup(new UserApiError(403, 'pin_required'));
    let retry = () => {};
    partyBridge.onCreateError = (_e, r) => { retry = r; };
    partyBridge.pending = { visibility: 'private' };
    partyBridge.pendingInvites = ['p1'];
    partyBridge.viewReady(a);
    await flush();
    partyBridge.adapter = () => ({ ready: true }) as any;
    retry();
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(partyBridge.pendingInvites).toEqual([]);
    expect(partyBridge.pending).toBeNull();
  });
  it('autre erreur : invitations vidées, leave() vide aussi', async () => {
    const { partyBridge, a } = await setup(new UserApiError(0, 'network'));
    partyBridge.onCreateError = null;
    partyBridge.pending = { visibility: 'private' };
    partyBridge.pendingInvites = ['p1'];
    partyBridge.viewReady(a);
    await flush();
    expect(partyBridge.pendingInvites).toEqual([]);
    partyBridge.pendingInvites = ['p2'];
    partyBridge.leave();
    expect(partyBridge.pendingInvites).toEqual([]);
  });
  it('handlePartyCreateError sans nouvel essai appelle cancel', async () => {
    const { handlePartyCreateError } = await import('../src/ui/partyerrors.js');
    const cancel = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handlePartyCreateError(new UserApiError(403, 'pin_required'), { cancel, say: () => undefined });
    expect(cancel).toHaveBeenCalled();
  });
  it('invitations après création : attendues derrière waitForHost', async () => {
    const { partyBridge } = await import('../src/party/bridge');
    await import('../src/ui/partylaunch.js');
    const wait = vi.spyOn(partyBridge, 'waitForHost').mockResolvedValue(false);
    partyBridge.onInvites!({ id: 'r' } as any, ['p1']);
    await flush();
    expect(wait).toHaveBeenCalled();
  });
});
