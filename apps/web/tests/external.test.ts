// Lecteur externe : schémas d'URL, détection de plateforme, options et défaut, lancement, playlist M3U et réglages par appareil.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@capacitor/core')>();
  return { ...mod, Capacitor: { ...mod.Capacitor, isNativePlatform: () => cap.native } };
});

import { isIOS } from '../src/player/appDownload';
import {
  buildM3u, currentPlayer, defaultPlayer, detectPlatform, isExternalChoice, launch, looksUnplayableOnIOS,
  planLaunch, playerOptions, type LaunchPlan, type Platform,
} from '../src/player/external';
import { getExternalPlayer, getPreferredExternal, setExternalPlayer, setPreferredExternal } from '../src/data/prefs';

const URL_TEST = 'https://exemple.test/film.mp4?a=1&b=2 c';
const ENC = encodeURIComponent(URL_TEST);

const NAV = {
  iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 },
  ipadBureau: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 },
  macBureau: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 },
  chromeAndroid: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 },
  windowsChrome: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', platform: 'Win32', maxTouchPoints: 0 },
};

const WEBVIEW = { webview: { postMessage: () => undefined, addEventListener: () => undefined } };

beforeEach(() => { localStorage.clear(); cap.native = false; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); vi.useRealTimers(); });

describe('schémas iOS (planLaunch, plateforme ios)', () => {
  it.each([
    ['vlc', `vlc-x-callback://x-callback-url/stream?url=${ENC}`],
    ['infuse', `infuse://x-callback-url/play?url=${ENC}`],
    ['outplayer', `outplayer://${URL_TEST}`],
    ['nplayer', `nplayer-${URL_TEST}`],
    ['vidhub', `open-vidhub://x-callback-url/open?url=${ENC}`],
    ['senplayer', `SenPlayer://x-callback-url/play?url=${ENC}`],
  ])('%s : schéma du contrat', (id, href) => {
    expect(planLaunch(id, URL_TEST, 'Titre', 'ios')).toEqual({ kind: 'href', href });
  });
});

describe('détection iOS / iPadOS (isIOS)', () => {
  const useNav = (n: { userAgent: string; platform: string; maxTouchPoints: number }) => vi.stubGlobal('navigator', n);

  it('iPhone : iOS', () => {
    useNav(NAV.iphone);
    expect(isIOS()).toBe(true);
  });
  it('iPad qui se dit « Macintosh » avec écran tactile : iOS', () => {
    useNav(NAV.ipadBureau);
    expect(isIOS()).toBe(true);
  });
  it('Mac de bureau sans écran tactile : pas iOS', () => {
    useNav(NAV.macBureau);
    expect(isIOS()).toBe(false);
  });
  it('Chrome Android : pas iOS', () => {
    useNav(NAV.chromeAndroid);
    expect(isIOS()).toBe(false);
  });
});

describe('détection de plateforme (detectPlatform)', () => {
  it('iPhone : ios', () => {
    vi.stubGlobal('navigator', NAV.iphone);
    expect(detectPlatform()).toBe('ios');
  });
  it('iPad « Macintosh » tactile : ios', () => {
    vi.stubGlobal('navigator', NAV.ipadBureau);
    expect(detectPlatform()).toBe('ios');
  });
  it('app Android (Capacitor natif) : android-app', () => {
    cap.native = true;
    vi.stubGlobal('navigator', NAV.chromeAndroid);
    expect(detectPlatform()).toBe('android-app');
  });
  it('coque Windows (window.chrome.webview) : shell, avant l’app Android', () => {
    cap.native = true;
    vi.stubGlobal('chrome', WEBVIEW);
    vi.stubGlobal('navigator', NAV.windowsChrome);
    expect(detectPlatform()).toBe('shell');
  });
  it('Chrome Android hors app : web-android', () => {
    vi.stubGlobal('navigator', NAV.chromeAndroid);
    expect(detectPlatform()).toBe('web-android');
  });
  it('ordinateur : web', () => {
    vi.stubGlobal('navigator', NAV.windowsChrome);
    expect(detectPlatform()).toBe('web');
  });
});

describe('options par plateforme', () => {
  const ids = (p: Platform) => playerOptions(p).map((o) => o.id);

  it('ios : auto, intégré Safari, puis les six schémas', () => {
    expect(ids('ios')).toEqual(['auto', 'builtin', 'vlc', 'infuse', 'outplayer', 'nplayer', 'vidhub', 'senplayer']);
    expect(playerOptions('ios')[0]).toEqual({ id: 'auto', label: 'Intégré, sinon lecteur externe' });
  });
  it('shell : intégré mpv, VLC, lecteur système', () => {
    expect(playerOptions('shell')).toEqual([
      { id: 'builtin', label: 'Intégré (mpv)' },
      { id: 'vlc', label: 'VLC' },
      { id: 'system', label: 'Lecteur par défaut du système' },
    ]);
  });
  it('web-android : intégré, autre application, playlist', () => {
    expect(ids('web-android')).toEqual(['builtin', 'intent', 'm3u']);
  });
  it('web : intégré, playlist', () => {
    expect(ids('web')).toEqual(['builtin', 'm3u']);
  });
  it('android-app sans plugin : « Autre application » désactivée avec son indication', () => {
    const chooser = playerOptions('android-app').find((o) => o.id === 'chooser');
    expect(chooser).toMatchObject({ disabled: true, hint: 'Nécessite la mise à jour de l’app' });
  });
  it('android-app avec le plugin ExternalPlayer : « Autre application » active, sans indication', () => {
    vi.stubGlobal('Capacitor', { isPluginAvailable: (name: string) => name === 'ExternalPlayer' });
    const chooser = playerOptions('android-app').find((o) => o.id === 'chooser');
    expect(chooser?.disabled).toBe(false);
    expect(chooser?.hint).toBeUndefined();
  });
  it('android-app : un plugin qui lève une erreur compte comme absent', () => {
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => { throw new Error('pont absent'); } });
    expect(playerOptions('android-app').find((o) => o.id === 'chooser')?.disabled).toBe(true);
  });
});

describe('défaut et lecteur courant (currentPlayer)', () => {
  it('défaut : auto sur iOS, intégré ailleurs', () => {
    expect(defaultPlayer('ios')).toBe('auto');
    expect(defaultPlayer('shell')).toBe('builtin');
    expect(defaultPlayer('web')).toBe('builtin');
    expect(currentPlayer('ios')).toBe('auto');
    expect(currentPlayer('web-android')).toBe('builtin');
  });
  it('un réglage proposé sur la plateforme est retenu', () => {
    setExternalPlayer('vlc');
    expect(currentPlayer('ios')).toBe('vlc');
  });
  it('valeur invalide pour la plateforme (infuse sur shell) : retombe sur le défaut', () => {
    setExternalPlayer('infuse');
    expect(currentPlayer('shell')).toBe('builtin');
  });
  it('chooser désactivé (sans plugin) : retombe sur le défaut', () => {
    setExternalPlayer('chooser');
    expect(currentPlayer('android-app')).toBe('builtin');
  });
  it('chooser activé (plugin présent) : retenu', () => {
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => true });
    setExternalPlayer('chooser');
    expect(currentPlayer('android-app')).toBe('chooser');
  });
  it('sans plateforme donnée : la plateforme courante', () => {
    vi.stubGlobal('navigator', NAV.iphone);
    expect(currentPlayer()).toBe('auto');
  });
});

describe('choix externe (isExternalChoice)', () => {
  it('intégré et auto ne sont pas externes, les autres le sont', () => {
    expect(isExternalChoice('builtin')).toBe(false);
    expect(isExternalChoice('auto')).toBe(false);
    expect(isExternalChoice('vlc')).toBe(true);
    expect(isExternalChoice('chooser')).toBe(true);
  });
});

describe('playlist M3U (buildM3u)', () => {
  it('une entrée, titre sans retour à la ligne', () => {
    expect(buildM3u('https://exemple.test/a.mp4', 'Film\r\nTitre')).toBe('#EXTM3U\n#EXTINF:-1,Film Titre\nhttps://exemple.test/a.mp4\n');
  });
});

describe('plan de lancement (planLaunch)', () => {
  it('intent : garde https', () => {
    const plan = planLaunch('intent', 'https://exemple.test/a.mp4?x=1', 'Mon film', 'web-android');
    expect(plan).toEqual({
      kind: 'href',
      href: 'intent://exemple.test/a.mp4?x=1#Intent;scheme=https;type=video/*;S.title=Mon%20film;end',
    });
  });
  it('intent : garde http', () => {
    const plan = planLaunch('intent', 'http://exemple.test/a.mp4', 'T', 'web-android');
    expect(plan).toEqual({ kind: 'href', href: 'intent://exemple.test/a.mp4#Intent;scheme=http;type=video/*;S.title=T;end' });
  });
  it('coque, VLC : vlc:// suivi de l’URL', () => {
    expect(planLaunch('vlc', URL_TEST, 'T', 'shell')).toEqual({ kind: 'shell', method: 'play-external', params: `vlc://${URL_TEST}` });
  });
  it('coque, lecteur système : data URI de la playlist', () => {
    const plan = planLaunch('system', URL_TEST, 'Mon film', 'shell');
    expect(plan.kind).toBe('shell');
    if (plan.kind !== 'shell') return;
    expect(plan.method).toBe('play-external');
    const prefix = 'data:application/octet-stream;charset=utf-8;base64,';
    expect(plan.params.startsWith(prefix)).toBe(true);
    const bytes = Uint8Array.from(atob(plan.params.slice(prefix.length)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(buildM3u(URL_TEST, 'Mon film'));
  });
  it('playlist : contenu M3U et nom de fichier assaini', () => {
    expect(planLaunch('m3u', URL_TEST, 'Film: saison/1', 'web')).toEqual({
      kind: 'm3u', content: buildM3u(URL_TEST, 'Film: saison/1'), filename: 'Film saison 1.m3u',
    });
  });
  it('nom de fichier vide : repli sur « lecture »', () => {
    expect(planLaunch('m3u', URL_TEST, '  ', 'web')).toMatchObject({ kind: 'm3u', filename: 'lecture.m3u' });
  });
  it('sélecteur Android : plugin avec l’URL et le titre', () => {
    expect(planLaunch('chooser', URL_TEST, 'T', 'android-app')).toEqual({ kind: 'plugin', url: URL_TEST, title: 'T' });
  });
  it('option hors plateforme : non prise en charge', () => {
    expect(planLaunch('vlc', URL_TEST, 'T', 'web')).toEqual({ kind: 'unsupported' });
    expect(planLaunch('auto', URL_TEST, 'T', 'ios')).toEqual({ kind: 'unsupported' });
    expect(planLaunch('intent', URL_TEST, 'T', 'ios')).toEqual({ kind: 'unsupported' });
  });
});

describe('lancement (launch)', () => {
  it('playlist : lien download cliqué puis URL révoquée', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const seen: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      seen.push({ download: this.download, href: this.href });
    });
    const plan: LaunchPlan = { kind: 'm3u', content: '#EXTM3U\n', filename: 'Film.m3u' };
    expect(launch(plan)).toBe(true);
    expect(seen).toEqual([{ download: 'Film.m3u', href: 'blob:test' }]);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(document.querySelector('a[download]')).toBeNull();
    delete (URL as Partial<typeof URL>).createObjectURL;
    delete (URL as Partial<typeof URL>).revokeObjectURL;
  });
  it('plugin présent : ouvert avec l’URL et le titre', () => {
    const open = vi.fn(() => Promise.resolve());
    vi.stubGlobal('Capacitor', { Plugins: { ExternalPlayer: { open } } });
    expect(launch({ kind: 'plugin', url: URL_TEST, title: 'T' })).toBe(true);
    expect(open).toHaveBeenCalledWith({ url: URL_TEST, title: 'T' });
  });
  it('plugin absent : rien n’est tenté', () => {
    vi.stubGlobal('Capacitor', { Plugins: {} });
    expect(launch({ kind: 'plugin', url: URL_TEST, title: 'T' })).toBe(false);
  });
  it('coque demandée hors coque : rien n’est tenté', () => {
    expect(launch({ kind: 'shell', method: 'play-external', params: `vlc://${URL_TEST}` })).toBe(false);
  });
  it('plan non pris en charge : false', () => {
    expect(launch({ kind: 'unsupported' })).toBe(false);
  });
});

describe('format non lisible sur iOS (looksUnplayableOnIOS)', () => {
  it.each(['film.mkv', 'film.avi', 'film.wmv', 'film.flv', 'film.ts', 'film.m2ts'])('%s dans le chemin : vrai', (file) => {
    expect(looksUnplayableOnIOS(`https://exemple.test/${file}`, 'x')).toBe(true);
  });
  it('mkv dans le chemin, avec une query : vrai', () => {
    expect(looksUnplayableOnIOS('https://exemple.test/film.mkv?token=abc', 'film')).toBe(true);
  });
  it('mkv seulement dans la query : faux', () => {
    expect(looksUnplayableOnIOS('https://exemple.test/film.mp4?name=x.mkv', 'film')).toBe(false);
  });
  it('mp4 : faux', () => {
    expect(looksUnplayableOnIOS('https://exemple.test/film.mp4', 'Film.mp4')).toBe(false);
  });
  it('nom contenant « MKV » comme mot : vrai', () => {
    expect(looksUnplayableOnIOS('https://exemple.test/a.mp4', 'Film 2010 x264 MKV')).toBe(true);
  });
  it('« mkv » dans un mot plus long : faux', () => {
    expect(looksUnplayableOnIOS('https://exemple.test/a.mp4', 'mkvtoolnix')).toBe(false);
  });
});

describe('réglages du lecteur externe, par appareil', () => {
  it('lecteur externe : vide tant qu’il n’est pas réglé, aller-retour sous laststream.externalPlayer', () => {
    expect(getExternalPlayer()).toBe('');
    setExternalPlayer('infuse');
    expect(localStorage.getItem('laststream.externalPlayer')).toBe('infuse');
    expect(getExternalPlayer()).toBe('infuse');
  });
  it('lecteur préféré : VLC par défaut, aller-retour sous laststream.preferredExternal', () => {
    expect(getPreferredExternal()).toBe('vlc');
    setPreferredExternal('nplayer');
    expect(localStorage.getItem('laststream.preferredExternal')).toBe('nplayer');
    expect(getPreferredExternal()).toBe('nplayer');
  });
  it('stockage refusé : valeurs par défaut, sans erreur', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => setExternalPlayer('vlc')).not.toThrow();
    expect(() => setPreferredExternal('infuse')).not.toThrow();
    expect(getExternalPlayer()).toBe('');
    expect(getPreferredExternal()).toBe('vlc');
  });
});
