import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bannerModel, CHECK_INTERVAL_MS, isDismissed, isNewer, parseManifest, shouldCheck, sizeLabel,
} from '../src/data/appUpdate';
import { PUBLIC_BASE } from '../src/data/config';

const SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('comparaison de versions', () => {
  it('seul un versionCode strictement supérieur est une mise à jour', () => {
    expect(isNewer(2026101802, 2026101801)).toBe(true);
    expect(isNewer(2026101801, 2026101801)).toBe(false);
    expect(isNewer(2026101701, 2026101801)).toBe(false);
    expect(isNewer(NaN, 1)).toBe(false);
  });

  it('contrôle au lancement puis au plus toutes les 24 h', () => {
    const now = 1_800_000_000_000;
    expect(shouldCheck(null, now)).toBe(true);
    expect(shouldCheck(now - 1000, now)).toBe(false);
    expect(shouldCheck(now - CHECK_INTERVAL_MS, now)).toBe(true);
    expect(shouldCheck(now + 5000, now)).toBe(true); // horloge reculée : on revérifie
  });

  it('une version écartée ne revient pas, la suivante oui', () => {
    expect(isDismissed(null, 5)).toBe(false);
    expect(isDismissed(5, 5)).toBe(true);
    expect(isDismissed(5, 6)).toBe(false);
  });
});

describe('manifeste latest.json', () => {
  const ok = { versionCode: 2026101801, versionName: '2026.10.18.1', url: 'https://app.laststream.app/app/android/laststream-2026101801.apk', sha256: SHA, size: 48_000_000, notes: 'Mini-lecteur' };

  it('accepte un manifeste complet', () => {
    expect(parseManifest(ok)).toEqual(ok);
  });

  it('résout une adresse relative sur le serveur Laststream', () => {
    const m = parseManifest({ ...ok, url: '/app/android/a.apk' });
    expect(m?.url).toBe(PUBLIC_BASE + '/app/android/a.apk');
  });

  it('refuse http, empreinte invalide, versionCode invalide', () => {
    expect(parseManifest({ ...ok, url: 'http://x.test/a.apk' })).toBeNull();
    expect(parseManifest({ ...ok, sha256: 'abc' })).toBeNull();
    expect(parseManifest({ ...ok, versionCode: 'x' })).toBeNull();
    expect(parseManifest({ ...ok, versionCode: -3 })).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('texte')).toBeNull();
  });

  it('met l’empreinte en minuscules et remplace un nom absent par le code', () => {
    const m = parseManifest({ ...ok, sha256: SHA.toUpperCase(), versionName: '' });
    expect(m?.sha256).toBe(SHA);
    expect(m?.versionName).toBe('2026101801');
  });

  it('libellés de la bannière', () => {
    const m = parseManifest(ok)!;
    expect(bannerModel(m)).toEqual({ text: 'Mise à jour disponible (v2026.10.18.1)', action: 'Installer' });
    expect(sizeLabel(48_000_000)).toBe('46 Mo');
    expect(sizeLabel(2048)).toBe('2 Ko');
    expect(sizeLabel(undefined)).toBe('');
  });
});

describe('app Android (Tauri)', () => {
  const tauri = join(__dirname, '..', '..', 'tauri');
  const splash = readFileSync(join(tauri, 'splash', 'android.html'), 'utf8');
  const capability = JSON.parse(readFileSync(join(tauri, 'src-tauri', 'capabilities', 'mobile.json'), 'utf8'));

  it('charge l’interface depuis le serveur Laststream (celui de PUBLIC_BASE)', () => {
    expect(splash).toContain(`var SERVER = '${PUBLIC_BASE}/';`);
    expect(JSON.stringify(capability)).toContain(`"${PUBLIC_BASE}/*"`);
  });

  it('page hors ligne du service worker avec bouton Réessayer, tournée vers la même adresse', () => {
    const html = readFileSync(join(__dirname, '..', 'public', 'offline.html'), 'utf8');
    expect(html).toContain('Laststream est hors ligne');
    expect(html).toContain('Réessayer');
    expect(html).toContain(PUBLIC_BASE + '/');
  });
});

describe('bannière de mise à jour', () => {
  beforeEach(() => { document.body.innerHTML = ''; try { localStorage.clear(); } catch { /* ignoré */ } });
  const manifest = parseManifest({ versionCode: 9, versionName: '9', url: 'https://x.test/a.apk', sha256: SHA, size: 5_000_000, notes: 'Notes' })!;

  it('affiche le texte, installe au tap et suit la progression', async () => {
    const { showUpdateBanner } = await import('../src/ui/update-banner.js');
    const install = vi.fn(async (_m: unknown, onProgress: (p: number) => void) => { onProgress(42); return 'started' as const; });
    const root = showUpdateBanner(manifest, { install });
    expect(root.textContent).toContain('Mise à jour disponible (v9)');
    (root.querySelector('.upd-go') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(install).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.upd-sub')!.textContent).toContain('Installation');
  });

  it('guide l’utilisateur quand l’autorisation « sources inconnues » manque', async () => {
    const { showUpdateBanner } = await import('../src/ui/update-banner.js');
    const root = showUpdateBanner(manifest, { install: async () => 'permission' as const });
    (root.querySelector('.upd-go') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.upd-sub')!.textContent).toContain('Autorise l’installation');
    expect((root.querySelector('.upd-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('« × » écarte cette version', async () => {
    const { showUpdateBanner } = await import('../src/ui/update-banner.js');
    const { dismissedCode } = await import('../src/data/appUpdate');
    const root = showUpdateBanner(manifest);
    (root.querySelector('.upd-x') as HTMLButtonElement).click();
    expect(document.querySelector('.upd-banner')).toBeNull();
    expect(dismissedCode()).toBe(9);
  });
});
