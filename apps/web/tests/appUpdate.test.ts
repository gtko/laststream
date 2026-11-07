import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bannerModel, CHECK_INTERVAL_MS, isDismissed, isNewer, parseManifest, shouldCheck, sizeLabel,
} from '../src/data/appUpdate';
import { PUBLIC_BASE } from '../src/data/config';
import { buildManifest, parseArgs, publish, readMeta, sha256File } from '../scripts/publish-android.mjs';

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

describe('configuration Capacitor', () => {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'capacitor.config.json'), 'utf8'));

  it('charge l’interface depuis le serveur Laststream (une seule adresse, celle de PUBLIC_BASE)', () => {
    expect(cfg.server.url).toBe(PUBLIC_BASE);
    expect(cfg.server.androidScheme).toBe('https');
    expect(cfg.server.allowNavigation).toEqual([new URL(PUBLIC_BASE).host]);
  });

  it('page hors ligne embarquée avec bouton Réessayer, tournée vers la même adresse', () => {
    expect(cfg.server.errorPath).toBe('offline.html');
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

describe('script publish-android', () => {
  it('lit les arguments', () => {
    expect(parseArgs(['--apk', 'a.apk', '--notes', 'x y', '--flag'])).toEqual({ apk: 'a.apk', notes: 'x y', flag: true });
  });

  it('lit output-metadata.json', () => {
    expect(readMeta({ elements: [{ versionCode: 2026101803, versionName: '2026.10.18.3' }] })).toEqual({ versionCode: 2026101803, versionName: '2026.10.18.3' });
    expect(() => readMeta({ elements: [] })).toThrow();
  });

  it('SHA-256 d’un fichier', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pub-'));
    writeFileSync(join(d, 'a.bin'), 'abc');
    expect(await sha256File(join(d, 'a.bin'))).toBe(SHA);
  });

  it('manifeste : adresse https nommée par versionCode', () => {
    const m = buildManifest({ versionCode: 7, versionName: '7', sha256: SHA, size: 10, baseUrl: 'https://x.test/app/android/', notes: ' n ' });
    expect(m).toEqual({ versionCode: 7, versionName: '7', url: 'https://x.test/app/android/laststream-7.apk', sha256: SHA, size: 10, notes: 'n' });
    expect(() => buildManifest({ versionCode: 7, versionName: '7', sha256: SHA, size: 1, baseUrl: 'http://x.test' })).toThrow();
    expect(() => buildManifest({ versionCode: 7, versionName: '7', sha256: 'zz', size: 1 })).toThrow();
  });

  it('publish : écrit latest.json et prépare l’APK, et le manifeste est accepté par l’application', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pub-'));
    writeFileSync(join(d, 'app.apk'), 'abc');
    writeFileSync(join(d, 'meta.json'), JSON.stringify({ elements: [{ versionCode: 2026101802, versionName: '2026.10.18.2' }] }));
    const r = await publish({ apk: join(d, 'app.apk'), meta: join(d, 'meta.json'), out: join(d, 'out'), stage: join(d, 'stage'), notes: 'Test' });
    expect(existsSync(join(d, 'stage', 'laststream-2026101802.apk'))).toBe(true);
    const written = JSON.parse(readFileSync(join(d, 'out', 'latest.json'), 'utf8'));
    expect(written).toEqual(r.manifest);
    expect(written.sha256).toBe(SHA);
    expect(parseManifest(written)).toMatchObject({ versionCode: 2026101802, sha256: SHA });
  });
});
