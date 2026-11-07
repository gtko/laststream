// Diagnostic « torrents seulement » : classification de la réponse de test, empreinte et horodatage quotidien.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkKey, classifyStreams, isDue, readCheck, writeCheck } from '../src/data/addonSafety';

const DAY = 24 * 60 * 60 * 1000;

describe('classification de la réponse de test', () => {
  const origin = 'https://addon.example';

  it('infoHash seul : torrents seulement, aucune source lisible', () => {
    expect(classifyStreams([{ infoHash: 'a'.repeat(40) }], origin)).toBe('torrents');
  });

  it('un lien lisible (absolu, ou relatif à l’addon) l’emporte sur les infoHash', () => {
    expect(classifyStreams([{ infoHash: 'a'.repeat(40) }, { url: 'https://foo.real-debrid.com/d/x' }], origin)).toBe('readable');
    expect(classifyStreams([{ url: 'https://addon.example/resolve/x' }], origin)).toBe('readable');
    expect(classifyStreams([{ url: 'https://cdn.example/a.mp4' }], origin)).toBe('readable');
    expect(classifyStreams([{ url: '/resolve/x' }], origin)).toBe('readable');
  });

  it('magnet, lien vide ou aucun flux : inconnu', () => {
    expect(classifyStreams([{ url: 'magnet:?xt=urn:btih:abc' }], origin)).toBe('unknown');
    expect(classifyStreams([{ url: '  ' }], origin)).toBe('unknown');
    expect(classifyStreams([], origin)).toBe('unknown');
    expect(classifyStreams(null, origin)).toBe('unknown');
  });
});

describe('diagnostic quotidien', () => {
  beforeEach(() => localStorage.clear());

  it('empreinte stable, sans l’adresse en clair (une clé peut y figurer)', () => {
    const url = 'https://torrentio.example/realdebrid=RDKEY1234567890/manifest.json';
    const key = checkKey(url);
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(key).toBe(checkKey(url));
    expect(key).not.toContain('RDKEY');
    expect(checkKey(url + '?lang=fr')).not.toBe(key);
  });

  it('à refaire : jamais fait, plus de 24 h, ou horloge revenue en arrière ; sinon non', () => {
    const now = 1_000_000_000_000;
    expect(isDue(null, now)).toBe(true);
    expect(isDue({ at: now - 1000, verdict: 'torrents' }, now)).toBe(false);
    expect(isDue({ at: now - DAY, verdict: 'torrents' }, now)).toBe(true);
    expect(isDue({ at: now + DAY, verdict: 'torrents' }, now)).toBe(true);
  });

  it('le diagnostic est écrit dans le stockage local et relu après rechargement du module', async () => {
    const key = checkKey('https://persist.example/manifest.json');
    expect(readCheck(key)).toBeNull();
    writeCheck(key, { at: 123, verdict: 'torrents' });
    expect(JSON.parse(localStorage.getItem('laststream.srcCheck.' + key)!)).toEqual({ at: 123, verdict: 'torrents' });
    vi.resetModules(); // nouvelle page : la mémoire est vide, seul le stockage local reste
    const fresh = await import('../src/data/addonSafety');
    expect(fresh.readCheck(key)).toEqual({ at: 123, verdict: 'torrents' });
  });

  it('valeur locale corrompue ou verdict inconnu : ignorés', async () => {
    const key = checkKey('https://corrupt.example/manifest.json');
    localStorage.setItem('laststream.srcCheck.' + key, '{pas du json');
    vi.resetModules();
    const fresh = await import('../src/data/addonSafety');
    expect(fresh.readCheck(key)).toBeNull();
    localStorage.setItem('laststream.srcCheck.' + key, JSON.stringify({ at: 5, verdict: 'self' }));
    vi.resetModules();
    expect((await import('../src/data/addonSafety')).readCheck(key)).toBeNull();
  });
});
