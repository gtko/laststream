// Réglage « Lecteur » par appareil (Réglages > Lecture) : options selon la plateforme, écriture du choix,
// lecteur externe préféré (iPhone et iPad, lecteur « auto »).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@capacitor/core')>();
  return { ...mod, Capacitor: { ...mod.Capacitor, isNativePlatform: () => cap.native } };
});

import { playerOptions } from '../src/player/external';
import { getDesktopEngine, getExternalPlayer, getPreferredExternal } from '../src/data/prefs';
import { recordPlayerCapabilities, resetShell } from '../src/player/shell';

const NAV = {
  iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 },
  windowsChrome: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', platform: 'Win32', maxTouchPoints: 0 },
  chromeAndroid: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 },
};
const WEBVIEW = { webview: { postMessage: () => undefined, addEventListener: () => undefined } };

function mockFetch(url: string): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') return json({ services: {}, languages: { preferred: ['fr'], acceptVostfr: true }, sources: [] });
  return json({ error: 'not_found' }, 404);
}
const fetchMock = vi.fn(async (url: string) => mockFetch(String(url)));

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const playback = () => document.querySelector('#set-p-playback') as HTMLElement;
const player = () => playback().querySelector('select[data-set-pref="external-player"]') as HTMLSelectElement;
const engine = () => playback().querySelector('select[data-set-pref="desktop-engine"]') as HTMLSelectElement | null;
const preferred = () => playback().querySelector('select[data-set-pref="external-preferred"]') as HTMLSelectElement | null;
const pick = (el: HTMLSelectElement, value: string) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
const values = (el: HTMLSelectElement) => Array.from(el.options).map((o) => o.value);
const labels = (el: HTMLSelectElement) => Array.from(el.options).map((o) => o.textContent);
const desc = (el: HTMLElement) => el.closest('.set-row')!.querySelector('.set-row-d')!.textContent;

let openSettings: () => Promise<void>;

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  vi.stubGlobal('fetch', fetchMock);
  window.scrollTo = () => undefined;
  location.hash = '#/settings';
  await import('../src/main.js');
  await settle(900);
  ({ showSettings: openSettings } = await import('../src/ui/settings.js'));
});

beforeEach(() => {
  for (const k of ['laststream.externalPlayer', 'laststream.preferredExternal', 'laststream.desktopEngine']) localStorage.removeItem(k);
  resetShell();
  cap.native = false;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

/** Rend la page Réglages avec la plateforme simulée par les globaux déjà stubés. */
async function open() {
  await openSettings();
  await settle();
}

describe('select « Lecteur » par appareil', () => {
  it('Windows de bureau (web) : Intégré et playlist .m3u, pas de lecteur externe préféré', async () => {
    vi.stubGlobal('navigator', NAV.windowsChrome);
    await open();
    expect(values(player())).toEqual(playerOptions('web').map((o) => o.id));
    expect(labels(player())).toEqual(['Intégré', 'Télécharger une playlist (.m3u)']);
    expect(player().value).toBe('builtin');
    expect(desc(player())).toBe('Le lecteur intégré lit la plupart des formats ; la playlist .m3u s’ouvre dans ton lecteur habituel.');
    expect(preferred()).toBeNull();
  });

  it('iPhone : options de playerOptions, « auto » par défaut, description iOS', async () => {
    vi.stubGlobal('navigator', NAV.iphone);
    await open();
    expect(values(player())).toEqual(playerOptions('ios').map((o) => o.id));
    expect(player().value).toBe('auto');
    expect(desc(player())).toBe('Les liens débridés en MKV ne se lisent pas dans Safari : ouvre-les dans une app comme VLC ou Infuse.');
  });

  it('coque Windows : Intégré (mpv), VLC et lecteur par défaut du système', async () => {
    vi.stubGlobal('chrome', WEBVIEW);
    await open();
    expect(values(player())).toEqual(playerOptions('shell').map((o) => o.id));
    expect(labels(player())).toEqual(['Intégré (mpv)', 'VLC', 'Lecteur par défaut du système']);
    expect(player().value).toBe('builtin');
    expect(desc(player())).toBe('Le lecteur intégré lit tout ; VLC ou ton lecteur par défaut s’ouvrent à côté de Laststream.');
    expect(preferred()).toBeNull();
  });

  it('app Android sans le plugin : « Autre application… » grisé, avec son motif', async () => {
    cap.native = true;
    vi.stubGlobal('navigator', NAV.chromeAndroid);
    await open();
    const chooser = Array.from(player().options).find((o) => o.value === 'chooser')!;
    expect(chooser.disabled).toBe(true);
    expect(chooser.textContent).toBe('Autre application… (Nécessite la mise à jour de l’app)');
    expect(player().value).toBe('builtin');
    expect(desc(player())).toBe('Le lecteur intégré (libVLC) lit tout.');
    expect(preferred()).toBeNull();
  });

  it('app Android avec le plugin : « Autre application… » utilisable, sans motif', async () => {
    cap.native = true;
    vi.stubGlobal('navigator', NAV.chromeAndroid);
    vi.stubGlobal('Capacitor', { isPluginAvailable: (name: string) => name === 'ExternalPlayer' });
    await open();
    const chooser = Array.from(player().options).find((o) => o.value === 'chooser')!;
    expect(chooser.disabled).toBe(false);
    expect(chooser.textContent).toBe('Autre application…');
  });

  it('écrit le choix sur cet appareil (laststream.externalPlayer)', async () => {
    vi.stubGlobal('navigator', NAV.windowsChrome);
    await open();
    pick(player(), 'm3u');
    expect(localStorage.getItem('laststream.externalPlayer')).toBe('m3u');
    expect(getExternalPlayer()).toBe('m3u');
    expect(player().value).toBe('m3u');
  });

  it('ignore une valeur qui n’est pas une option de cette plateforme', async () => {
    vi.stubGlobal('navigator', NAV.windowsChrome);
    await open();
    pick(player(), 'vlc'); // « vlc » n’existe pas sur le web : le champ n’a plus de valeur
    expect(localStorage.getItem('laststream.externalPlayer')).toBeNull();
  });

  it('ignore une option grisée (plugin absent)', async () => {
    cap.native = true;
    vi.stubGlobal('navigator', NAV.chromeAndroid);
    await open();
    pick(player(), 'chooser');
    expect(localStorage.getItem('laststream.externalPlayer')).toBeNull();
  });
});

describe('lecteur externe préféré (iPhone et iPad, « auto »)', () => {
  it('iPhone en « auto » : les schémas des apps, VLC par défaut, avec sa description', async () => {
    vi.stubGlobal('navigator', NAV.iphone);
    await open();
    expect(preferred()).not.toBeNull();
    expect(values(preferred()!)).toEqual(['vlc', 'infuse', 'outplayer', 'nplayer', 'vidhub', 'senplayer']);
    expect(preferred()!.value).toBe('vlc');
    expect(desc(preferred()!)).toBe('Utilisé quand une source ne peut pas être lue dans Safari.');
  });

  it('n’existe que sur iPhone en « auto » : il apparaît et disparaît avec le select principal', async () => {
    vi.stubGlobal('navigator', NAV.iphone);
    await open();
    pick(player(), 'vlc');
    expect(localStorage.getItem('laststream.externalPlayer')).toBe('vlc');
    expect(preferred()).toBeNull();
    pick(player(), 'builtin');
    expect(preferred()).toBeNull();
    pick(player(), 'auto');
    expect(preferred()).not.toBeNull();
    expect(preferred()!.value).toBe('vlc');
  });

  it('n’existe pas sur un autre appareil, même avec « auto » enregistré', async () => {
    localStorage.setItem('laststream.externalPlayer', 'auto');
    vi.stubGlobal('navigator', NAV.windowsChrome);
    await open();
    expect(preferred()).toBeNull();
  });

  it('s’enregistre (laststream.preferredExternal) ; une valeur hors schémas est ignorée', async () => {
    vi.stubGlobal('navigator', NAV.iphone);
    await open();
    pick(preferred()!, 'infuse');
    expect(localStorage.getItem('laststream.preferredExternal')).toBe('infuse');
    expect(getPreferredExternal()).toBe('infuse');
    pick(preferred()!, 'builtin'); // « intégré » n’est pas un lecteur externe
    expect(localStorage.getItem('laststream.preferredExternal')).toBe('infuse');
  });
});

describe('moteur de lecture de la coque (mpv, VLC intégré)', () => {
  it('pas de carte quand la coque n’annonce pas libVLC (ancienne coque : mpv seul)', async () => {
    vi.stubGlobal('chrome', WEBVIEW);
    await open();
    expect(engine()).toBeNull();
    recordPlayerCapabilities({ backends: ['mpv'] });
    await open();
    expect(engine()).toBeNull();
  });

  it('coque avec libVLC : Automatique par défaut, puis le choix est mémorisé', async () => {
    vi.stubGlobal('chrome', WEBVIEW);
    recordPlayerCapabilities({ backends: ['mpv', 'libvlc'] });
    await open();
    await vi.waitFor(() => expect(engine()).not.toBeNull());
    expect(labels(engine()!)).toEqual(['Automatique', 'mpv', 'VLC intégré']);
    expect(engine()!.value).toBe('auto');
    expect(desc(engine()!)).toContain('Automatique : mpv, puis VLC si la vidéo ne démarre pas.');
    pick(engine()!, 'libvlc');
    expect(localStorage.getItem('laststream.desktopEngine')).toBe('libvlc');
    expect(getDesktopEngine()).toBe('libvlc');
    await open();
    await vi.waitFor(() => expect(engine()!.value).toBe('libvlc'));
    pick(engine()!, 'inconnu');
    expect(getDesktopEngine()).toBe('libvlc');
  });

  it('pas de carte hors coque, même si une coque avait annoncé libVLC', async () => {
    recordPlayerCapabilities({ backends: ['mpv', 'libvlc'] });
    vi.stubGlobal('navigator', NAV.windowsChrome);
    await open();
    await vi.waitFor(() => expect(player()).not.toBeNull());
    expect(engine()).toBeNull();
  });
});
