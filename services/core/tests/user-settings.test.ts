import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { type ErrorBody, loginAs, PASSWORD, request, createProfileVia } from './user-harness.js';

interface SettingsBody {
  settings: Record<string, unknown>;
}

let app: RunningApp;
let token: string;
let profile: string;

beforeEach(async () => {
  app = await startApp({});
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  token = await loginAs(app, 'alice');
  profile = (await createProfileVia(app, token, { name: 'Greg' })).body.id;
});

afterEach(async () => {
  await app.close();
});

const settingsPath = (id: string = profile) => `/user/profiles/${id}/settings`;

describe('réglages par profil', () => {
  it('vide au départ, puis fusion : les clés envoyées remplacent, les autres restent', async () => {
    const empty = await request<SettingsBody>(app, 'GET', settingsPath(), { token });
    expect(empty.body.settings).toEqual({});

    await request(app, 'PUT', settingsPath(), { token, body: { theme: 'dark', subtitles: { lang: 'fr' } } });
    const merged = await request<SettingsBody>(app, 'PUT', settingsPath(), { token, body: { theme: 'light', autoplay: true } });
    expect(merged.body.settings).toEqual({ theme: 'light', subtitles: { lang: 'fr' }, autoplay: true });
  });

  it('une valeur null supprime la clé', async () => {
    await request(app, 'PUT', settingsPath(), { token, body: { theme: 'dark', autoplay: true } });
    const res = await request<SettingsBody>(app, 'PUT', settingsPath(), { token, body: { theme: null } });
    expect(res.body.settings).toEqual({ autoplay: true });
  });

  it('réglages isolés entre profils', async () => {
    const other = (await createProfileVia(app, token, { name: 'Autre' })).body.id;
    await request(app, 'PUT', settingsPath(), { token, body: { theme: 'dark' } });
    const res = await request<SettingsBody>(app, 'GET', settingsPath(other), { token });
    expect(res.body.settings).toEqual({});
  });

  it('refuse un corps non objet, une clé mal formée, une valeur trop grosse', async () => {
    const array = await request<ErrorBody>(app, 'PUT', settingsPath(), { token, body: [1, 2] });
    expect(array.status).toBe(400);
    const badKey = await request<ErrorBody>(app, 'PUT', settingsPath(), { token, body: { '1 mauvais': true } });
    expect(badKey.status).toBe(400);
    expect(badKey.body.issues).toEqual(['cle:invalide']);
    const huge = await request<ErrorBody>(app, 'PUT', settingsPath(), { token, body: { big: 'x'.repeat(5000) } });
    expect(huge.status).toBe(400);
    expect(huge.body.issues).toEqual(['valeur:trop_grande']);
  });
});
