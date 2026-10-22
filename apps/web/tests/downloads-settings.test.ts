// Réglages des téléchargements (ODY-204) : défauts, persistance sous un préfixe, tolérance aux pannes de stockage,
// limite poussée au gestionnaire lié, Wi-Fi seulement (connexion mobile).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMIT_CHOICES, bindDownloadLimit, getDownloadSettings, isCellular, setDownloadSettings } from '../src/downloads/settings';

const GB = 1024 ** 3;

afterEach(() => {
  localStorage.clear();
  bindDownloadLimit(null);
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'connection');
});

describe('réglages', () => {
  it('défauts : limite de 20 Go, Wi-Fi seulement désactivé, question non posée', () => {
    expect(getDownloadSettings()).toEqual({ limitBytes: 20 * GB, wifiOnly: false, asked: false });
  });

  it('limites proposées : 5, 10, 20, 50 Go puis sans limite', () => {
    expect(LIMIT_CHOICES).toEqual([5 * GB, 10 * GB, 20 * GB, 50 * GB, null]);
  });

  it('persiste les valeurs, toutes sous le préfixe laststream.downloads.', () => {
    setDownloadSettings({ limitBytes: null, wifiOnly: true, quality: '1080p', langs: ['fr'], asked: true });
    expect(getDownloadSettings()).toEqual({ limitBytes: null, wifiOnly: true, quality: '1080p', langs: ['fr'], asked: true });
    const keys = Object.keys(localStorage);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('laststream.downloads.'))).toBe(true);
  });

  it('une qualité et des langues vides oublient le choix mémorisé', () => {
    setDownloadSettings({ quality: '1080p', langs: ['fr'] });
    setDownloadSettings({ quality: '', langs: [] });
    const s = getDownloadSettings();
    expect(s.quality).toBeUndefined();
    expect(s.langs).toBeUndefined();
  });

  it('la limite est poussée au gestionnaire lié, et seulement quand il existe', () => {
    const sink = vi.fn();
    setDownloadSettings({ limitBytes: 5 * GB });
    expect(sink).not.toHaveBeenCalled();
    bindDownloadLimit(sink);
    setDownloadSettings({ limitBytes: 5 * GB });
    expect(sink).toHaveBeenCalledWith(5 * GB);
    expect(getDownloadSettings().limitBytes).toBe(5 * GB);
  });

  it('un stockage refusé donne les valeurs par défaut, sans rien lever', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('refusé'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('refusé'); });
    expect(() => setDownloadSettings({ wifiOnly: true })).not.toThrow();
    expect(getDownloadSettings()).toEqual({ limitBytes: 20 * GB, wifiOnly: false, asked: false });
  });
});

describe('connexion mobile', () => {
  it('faux sans information sur la connexion', () => {
    expect(isCellular()).toBe(false);
  });

  it('vrai sur une connexion de type cellulaire', () => {
    Object.defineProperty(navigator, 'connection', { value: { type: 'cellular' }, configurable: true });
    expect(isCellular()).toBe(true);
  });
});
