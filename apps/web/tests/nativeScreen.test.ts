import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({ getOutput: vi.fn() }));
const cap = vi.hoisted(() => ({ native: true, available: true }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => cap.native, isPluginAvailable: () => cap.available },
  registerPlugin: () => plugin,
}));

import { nativeScreenShortSide, refreshNativeScreen, resetNativeScreen, shortSideOf } from '../src/sources/nativeScreen';
import { capHeightOf, screenShortSide } from '../src/sources/resolutionCap';

const stubScreen = (width: number, height: number, ratio: number): void => {
  vi.stubGlobal('screen', { width, height });
  vi.stubGlobal('devicePixelRatio', ratio);
};

beforeEach(() => { cap.native = true; cap.available = true; plugin.getOutput.mockReset(); resetNativeScreen(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('résolution réelle de la sortie (ODY-251)', () => {
  it('côté court d’une réponse du plugin, ou null si elle est inutilisable', () => {
    expect(shortSideOf({ width: 3840, height: 2160 })).toBe(2160);
    expect(shortSideOf({ width: 1440, height: 3120 })).toBe(1440);
    expect(shortSideOf({ width: 0, height: 2160 })).toBeNull();
    expect(shortSideOf({ width: 'x', height: 2160 })).toBeNull();
    expect(shortSideOf(null)).toBeNull();
  });

  it('TV 4K dont la WebView déclare 1920×1080 : le plafond automatique passe de 1080p à 2160p', async () => {
    stubScreen(1920, 1080, 1);
    expect(capHeightOf('auto', screenShortSide())).toBe(1080);
    plugin.getOutput.mockResolvedValue({ width: 3840, height: 2160 });
    await refreshNativeScreen();
    expect(nativeScreenShortSide()).toBe(2160);
    expect(screenShortSide()).toBe(2160);
    expect(capHeightOf('auto', screenShortSide())).toBe(2160);
  });

  it('plugin absent (navigateur, ancien APK) : la valeur de la WebView reste utilisée', async () => {
    cap.available = false;
    stubScreen(2560, 1440, 1);
    await refreshNativeScreen();
    expect(plugin.getOutput).not.toHaveBeenCalled();
    expect(nativeScreenShortSide()).toBeNull();
    expect(screenShortSide()).toBe(1440);
  });

  it('erreur du plugin ou réponse illisible : la dernière valeur lue est conservée', async () => {
    plugin.getOutput.mockResolvedValueOnce({ width: 3840, height: 2160 });
    await refreshNativeScreen();
    plugin.getOutput.mockRejectedValueOnce(new Error('no_size'));
    await refreshNativeScreen();
    expect(nativeScreenShortSide()).toBe(2160);
    plugin.getOutput.mockResolvedValueOnce({ width: 0, height: 0 });
    await refreshNativeScreen();
    expect(nativeScreenShortSide()).toBe(2160);
  });

  it('la sortie relue après un changement de mode HDMI remplace l’ancienne', async () => {
    plugin.getOutput.mockResolvedValueOnce({ width: 3840, height: 2160 });
    await refreshNativeScreen();
    plugin.getOutput.mockResolvedValueOnce({ width: 1920, height: 1080 });
    await refreshNativeScreen();
    expect(screenShortSide()).toBe(1080);
  });
});
