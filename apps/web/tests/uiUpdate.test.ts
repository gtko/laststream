// Mise à jour de l'interface (ODY-249) : détection du build déployé (silencieuse en cas d'échec), snooze 6 h, bannière masquée
// pendant la lecture / le plein écran, application (caches vidés, route conservée) et préférences locales.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyUpdate, currentBuild, fetchDeployedBuild, hasNewBuild, isSnoozed, readSnooze, reloadUrl, shouldShowBanner, SNOOZE_MS,
  snoozeBuild, stripReloadParam,
} from '../src/data/uiUpdate';
import { getUiUpdateAuto, getUiUpdateNotify, setUiUpdateAuto, setUiUpdateNotify } from '../src/data/prefs';
import { initUiUpdateBanner } from '../src/ui/update-banner.js';

const json = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
  (async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body })) as unknown as typeof fetch;

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); document.body.innerHTML = ''; });

describe('build déployé', () => {
  it('lit {build} et interroge /version.json sans cache', async () => {
    const f = vi.fn(json({ build: 'abc-1' }));
    expect(await fetchDeployedBuild(f as unknown as typeof fetch)).toBe('abc-1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/version\.json\?t=\d+$/);
    expect(init.cache).toBe('no-store');
  });
  it('échec réseau, statut 500, JSON invalide ou repli SPA : null sans bruit', async () => {
    expect(await fetchDeployedBuild((async () => { throw new Error('réseau'); }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchDeployedBuild(json({ build: 'x' }, { ok: false, status: 500 }))).toBeNull();
    expect(await fetchDeployedBuild((async () => ({ ok: true, json: async () => { throw new SyntaxError('<!doctype'); } })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchDeployedBuild(json({ build: 42 }))).toBeNull();
    expect(await fetchDeployedBuild(json('texte'))).toBeNull();
    expect(await fetchDeployedBuild(json(null))).toBeNull();
  });
  it('en test le build embarqué est dev', () => expect(currentBuild()).toBe('dev'));
});

describe('nouveau build, snooze et affichage', () => {
  it('même build = rien ; build différent = nouveau ; dev ne déclenche jamais', () => {
    expect(hasNewBuild('a-1', 'a-1')).toBe(false);
    expect(hasNewBuild('a-1', 'b-2')).toBe(true);
    expect(hasNewBuild('a-1', null)).toBe(false);
    expect(hasNewBuild('dev', 'b-2')).toBe(false);
  });
  it('« Plus tard » masque 6 h ce build, puis réaffiche ; un build plus récent réaffiche aussitôt', () => {
    snoozeBuild('b-2', 1000);
    const sn = readSnooze();
    expect(sn).toEqual({ build: 'b-2', until: 1000 + SNOOZE_MS });
    expect(shouldShowBanner('a-1', 'b-2', true, sn, 2000)).toBe(false);
    expect(isSnoozed(sn, 'b-2', 1000 + SNOOZE_MS - 1)).toBe(true);
    expect(shouldShowBanner('a-1', 'b-2', true, sn, 1000 + SNOOZE_MS)).toBe(true);
    expect(shouldShowBanner('a-1', 'c-3', true, sn, 2000)).toBe(true);
  });
  it('notification désactivée = pas de bannière ; identique = pas de bannière', () => {
    expect(shouldShowBanner('a-1', 'b-2', false, null, 0)).toBe(false);
    expect(shouldShowBanner('a-1', 'a-1', true, null, 0)).toBe(false);
    expect(shouldShowBanner('a-1', 'b-2', true, null, 0)).toBe(true);
  });
  it('snooze illisible toléré', () => {
    localStorage.setItem('laststream.uiupdate.snooze', '{pas du json');
    expect(readSnooze()).toBeNull();
  });
});

describe('application de la mise à jour', () => {
  it('reloadUrl conserve chemin, requête et route #/… et remplace _ls', () => {
    expect(reloadUrl('https://x.test/app/?a=1#/movie/tt1', 77)).toBe('https://x.test/app/?a=1&_ls=77#/movie/tt1');
    expect(reloadUrl('https://x.test/?_ls=1#/settings', 78)).toBe('https://x.test/?_ls=78#/settings');
  });
  it('vide les caches, désinscrit les service workers puis recharge la même route', async () => {
    const del = vi.fn(async () => true);
    const unreg = vi.fn(async () => true);
    const replace = vi.fn();
    await applyUpdate({
      caches: { keys: async () => ['a', 'b'], delete: del } as never,
      serviceWorker: { getRegistrations: async () => [{ unregister: unreg }] } as never,
      replace, href: 'https://x.test/?z=2#/series', now: 5,
    });
    expect(del).toHaveBeenCalledTimes(2);
    expect(unreg).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('https://x.test/?z=2&_ls=5#/series');
  });
  it('recharge malgré des erreurs de cache et de service worker', async () => {
    const replace = vi.fn();
    await applyUpdate({
      caches: { keys: async () => { throw new Error('refusé'); }, delete: async () => true } as never,
      serviceWorker: { getRegistrations: async () => { throw new Error('refusé'); } } as never,
      replace, href: 'https://x.test/#/', now: 1,
    });
    expect(replace).toHaveBeenCalledWith('https://x.test/?_ls=1#/');
  });
  it('au démarrage, _ls est retiré de l’adresse en gardant le reste', () => {
    const replaceState = vi.fn();
    stripReloadParam({ href: 'https://x.test/p?a=1&_ls=9#/library' }, { replaceState, state: null });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/p?a=1#/library');
    replaceState.mockClear();
    stripReloadParam({ href: 'https://x.test/p#/library' }, { replaceState, state: null });
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('préférences', () => {
  it('défauts : prévenir activé, automatique désactivé', () => {
    expect(getUiUpdateNotify()).toBe(true);
    expect(getUiUpdateAuto()).toBe(false);
    setUiUpdateNotify(false);
    setUiUpdateAuto(true);
    expect(getUiUpdateNotify()).toBe(false);
    expect(getUiUpdateAuto()).toBe(true);
  });
});

describe('bannière', () => {
  let t = 1_000_000;
  let busy = false;
  const apply = vi.fn();
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
  const banner = () => document.querySelector<HTMLElement>('.uiupd-banner');
  const visible = () => !!banner() && !banner()!.hidden;
  const start = (fetchBuild: () => Promise<string | null>, over: Record<string, unknown> = {}) =>
    initUiUpdateBanner({ active: true, current: 'a-1', fetchBuild, apply, isBusy: () => busy, now: () => t, firstDelay: 0, confirm: () => true, ...over });

  beforeEach(() => { vi.useFakeTimers(); t = 1_000_000; busy = false; apply.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('build identique ou réseau en échec : aucune bannière', async () => {
    start(async () => 'a-1');
    await settle();
    expect(banner()).toBeNull();
    start(async () => null);
    await settle();
    expect(banner()).toBeNull();
  });
  it('inactif (Android natif ou dev) : rien', async () => {
    expect(start(async () => 'b-2', { active: false })).toBeNull();
    await settle();
    expect(banner()).toBeNull();
  });
  it('build différent : bannière accessible en bas, le bouton applique la mise à jour', async () => {
    start(async () => 'b-2');
    await settle();
    expect(banner()!.getAttribute('role')).toBe('status');
    expect(banner()!.textContent).toContain('Une nouvelle version est disponible');
    banner()!.querySelector<HTMLButtonElement>('.upd-go')!.click();
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('notification désactivée : pas de bannière', async () => {
    setUiUpdateNotify(false);
    start(async () => 'b-2');
    await settle();
    expect(banner()).toBeNull();
  });
  it('« Plus tard » retire la bannière et la masque 6 h', async () => {
    const i = start(async () => 'b-2')!;
    await settle();
    banner()!.querySelector<HTMLButtonElement>('.upd-later')!.click();
    expect(banner()).toBeNull();
    t += 60_000;
    await i.check();
    expect(banner()).toBeNull();
    t += SNOOZE_MS;
    await i.check();
    expect(visible()).toBe(true);
  });
  it('masquée pendant la lecture ou le plein écran, réapparaît ensuite', async () => {
    start(async () => 'b-2');
    await settle();
    expect(visible()).toBe(true);
    busy = true;
    await vi.advanceTimersByTimeAsync(2100);
    expect(visible()).toBe(false);
    busy = false;
    await vi.advanceTimersByTimeAsync(2100);
    expect(visible()).toBe(true);
    busy = true;
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(visible()).toBe(false);
  });
  it('détection réelle : lecteur TV (#player) ou lecteur principal ouvert', async () => {
    document.body.innerHTML = '<div id="player"></div>';
    let open = false;
    const i = start(async () => 'b-2', { isBusy: undefined, isPlayerOpen: () => open })!;
    await settle();
    expect(visible()).toBe(false);
    document.getElementById('player')!.hidden = true;
    i.refresh();
    expect(visible()).toBe(true);
    open = true;
    i.refresh();
    expect(visible()).toBe(false);
  });
  it('clic pendant une lecture : confirmation, refus = rien', async () => {
    const confirm = vi.fn(() => false);
    start(async () => 'b-2', { confirm });
    await settle();
    busy = true;
    banner()!.querySelector<HTMLButtonElement>('.upd-go')!.click();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('La lecture sera interrompue'));
    expect(apply).not.toHaveBeenCalled();
  });
  it('mise à jour automatique : seulement après 5 min d’inactivité, hors lecture', async () => {
    setUiUpdateAuto(true);
    start(async () => 'b-2');
    await settle();
    t += 4 * 60_000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(apply).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    t += 4 * 60_000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(apply).not.toHaveBeenCalled();
    busy = true;
    t += 2 * 60_000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(apply).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(2100);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('automatique désactivé : jamais d’application seule', async () => {
    start(async () => 'b-2');
    await settle();
    t += 60 * 60_000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(apply).not.toHaveBeenCalled();
  });
  it('anti-boucle : l’auto note le build visé ; si le rechargement ne l’apporte pas, plus jamais seule', async () => {
    setUiUpdateAuto(true);
    start(async () => 'b-2');
    await settle();
    t += 6 * 60_000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('laststream.uiupdate.tried')).toBe('b-2');
    // « rechargement » : toujours l'ancien build a-1, le marqueur existe
    document.body.innerHTML = '';
    const report = vi.fn();
    start(async () => 'b-2', { report });
    await settle();
    expect(report).toHaveBeenCalledWith('uiupdate_auto_failed');
    t += 30 * 60_000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(visible()).toBe(true); // bandeau manuel toujours là
  });
  it('anti-boucle : marqueur effacé quand le build visé est atteint', async () => {
    sessionStorage.setItem('laststream.uiupdate.tried', 'b-2');
    const report = vi.fn();
    start(async () => 'b-2', { current: 'b-2', report });
    await settle();
    expect(sessionStorage.getItem('laststream.uiupdate.tried')).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });
  it('aucune requête quand prévenir et auto sont désactivés', async () => {
    setUiUpdateNotify(false);
    const f = vi.fn(async () => 'b-2');
    start(f);
    await settle();
    expect(f).not.toHaveBeenCalled();
  });
  it('pas de sondage de 2 s sans bannière ni auto', async () => {
    setUiUpdateNotify(false);
    setUiUpdateAuto(true);
    const i = start(async () => 'b-2')!;
    await settle();
    setUiUpdateAuto(false);
    i.refresh();
    expect(vi.getTimerCount()).toBe(1); // seul le contrôle périodique de 10 min reste
  });
});
