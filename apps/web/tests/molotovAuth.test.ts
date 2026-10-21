import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginMolotovAuth, googleAuthUrl, MOLOTOV_CLIENT_ID_KEY, MolotovAuthError, molotovGoogleClientId, requestGoogleIdToken,
  setMolotovGoogleClientId,
} from '../src/data/molotovAuth';

/* Connexion Google du client Molotov : URL d'autorisation, échange par postMessage (popup), fenêtre bloquée.
 * Aucun vrai client id n'est nécessaire : le réglage utilisateur suffit. */

const CLIENT_ID = '123.apps.googleusercontent.test';

beforeEach(() => {
  localStorage.clear();
  setMolotovGoogleClientId(CLIENT_ID);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('client id Google', () => {
  it('le réglage utilisateur prime sur la variable de build', () => {
    expect(molotovGoogleClientId()).toBe(CLIENT_ID);
  });

  it('un réglage vide retire la surcharge', () => {
    setMolotovGoogleClientId('');
    expect(molotovGoogleClientId()).not.toBe(CLIENT_ID);
    expect(localStorage.getItem(MOLOTOV_CLIENT_ID_KEY)).toBeNull();
  });

  it('URL d’autorisation : implicit flow, page de retour de l’app, état', () => {
    const url = new URL(googleAuthUrl(CLIENT_ID, 'state-1'));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('id_token token');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('redirect_uri')).toBe(location.origin + '/oauth/google.html');
  });
});

describe('popup Google', () => {
  it('renvoie l’id_token reçu par postMessage', async () => {
    let opened = '';
    const popup = { closed: false };
    vi.spyOn(window, 'open').mockImplementation(((url: string) => { opened = url; return popup; }) as unknown as typeof window.open);
    const pending = requestGoogleIdToken();
    const state = new URL(opened).searchParams.get('state') ?? '';
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      source: popup as unknown as MessageEventSource,
      data: { type: 'laststream:molotov-google', idToken: 'google-id-token', state },
    }));
    await expect(pending).resolves.toBe('google-id-token');
  });

  it('un message d’une autre fenêtre est ignoré', async () => {
    let opened = '';
    const popup = { closed: false };
    vi.spyOn(window, 'open').mockImplementation(((url: string) => { opened = url; return popup; }) as unknown as typeof window.open);
    const pending = requestGoogleIdToken(2000);
    const state = new URL(opened).searchParams.get('state') ?? '';
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      source: { closed: false } as unknown as MessageEventSource,
      data: { type: 'laststream:molotov-google', idToken: 'jeton-volé', state },
    }));
    await expect(pending).rejects.toThrow(MolotovAuthError);
  });

  it('une fenêtre bloquée est signalée (repli sur un onglet)', () => {
    vi.spyOn(window, 'open').mockImplementation((() => null) as unknown as typeof window.open);
    expect(() => requestGoogleIdToken()).toThrow(MolotovAuthError);
    try {
      requestGoogleIdToken();
    } catch (err) {
      expect((err as MolotovAuthError).code).toBe('popup_blocked');
    }
  });

  it('sans client id configuré : message explicite, aucune exception opaque', () => {
    setMolotovGoogleClientId('');
    localStorage.clear();
    expect(() => beginMolotovAuth()).toThrow(MolotovAuthError);
    try {
      beginMolotovAuth();
    } catch (err) {
      expect((err as MolotovAuthError).code).toBe('no_client_id');
      expect((err as MolotovAuthError).message).toContain('VITE_MOLOTOV_GOOGLE_CLIENT_ID');
    }
  });

  it('un message d’une autre origine est ignoré', async () => {
    const popup = { closed: false };
    vi.spyOn(window, 'open').mockImplementation((() => popup) as unknown as typeof window.open);
    const pending = requestGoogleIdToken(1500);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://piege.example',
      data: { type: 'laststream:molotov-google', idToken: 'volé' },
    }));
    await expect(pending).rejects.toThrow(/expirée|fermée/);
  });
});
