import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { platform, runtimeEnv, setPlatform } from '../src/platform/index.js';
import { createFsUiAssets, createMemoryKvCache, createNodePlatform, nodeScheduler } from '../src/platform/node/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('plateforme Node : variables d\'exécution', () => {
  it('lit process.env à la demande (compatible avec vi.stubEnv)', () => {
    vi.stubEnv('LASTADDON_PLATFORM_TEST', 'a');
    expect(runtimeEnv().get('LASTADDON_PLATFORM_TEST')).toBe('a');
    vi.stubEnv('LASTADDON_PLATFORM_TEST', 'b');
    expect(runtimeEnv().get('LASTADDON_PLATFORM_TEST')).toBe('b');
    vi.unstubAllEnvs();
    expect(runtimeEnv().get('LASTADDON_PLATFORM_TEST')).toBeUndefined();
  });

  it('all() expose le dictionnaire complet et set() écrit une variable', () => {
    vi.stubEnv('LASTADDON_PLATFORM_SET', '');
    runtimeEnv().set?.('LASTADDON_PLATFORM_SET', 'x');
    expect(runtimeEnv().all().LASTADDON_PLATFORM_SET).toBe('x');
  });

  it('setPlatform remplace la plateforme active', () => {
    const original = platform();
    const replacement = { ...createNodePlatform(), capabilities: { thumbs: false, skipDetect: false, tvHls: false, sharedState: false } };
    setPlatform(replacement);
    expect(platform().capabilities.tvHls).toBe(false);
    setPlatform(original);
    expect(platform().capabilities).toEqual({ thumbs: true, skipDetect: true, tvHls: true, sharedState: false });
  });
});

describe('KvCache mémoire', () => {
  it('stocke, expire après le TTL et supprime', async () => {
    let now = 1_000;
    const cache = createMemoryKvCache(() => now);
    await cache.set('k', 'v', 10);
    await cache.set('forever', 'x', 31_536_000);
    expect(await cache.get('k')).toBe('v');
    now += 9_999;
    expect(await cache.get('k')).toBe('v');
    now += 2;
    expect(await cache.get('k')).toBeUndefined();
    now += 10_000_000;
    expect(await cache.get('forever')).toBe('x');
    await cache.delete('forever');
    expect(await cache.get('forever')).toBeUndefined();
  });

  it('createKvCache de la plateforme renvoie des caches indépendants', async () => {
    const a = platform().createKvCache('a');
    const b = platform().createKvCache('b');
    await a.set('k', '1', 3600);
    expect(await b.get('k')).toBeUndefined();
  });
});

describe('Scheduler Node', () => {
  it('after exécute une fois et peut être annulé', async () => {
    vi.useFakeTimers();
    const task = vi.fn();
    nodeScheduler.after(100, task);
    const cancel = nodeScheduler.after(100, task);
    cancel();
    await vi.advanceTimersByTimeAsync(150);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('every répète jusqu\'à l\'annulation', async () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const cancel = nodeScheduler.every(50, task);
    await vi.advanceTimersByTimeAsync(160);
    expect(task).toHaveBeenCalledTimes(3);
    cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('background absorbe une promesse rejetée', async () => {
    expect(() => nodeScheduler.background(Promise.reject(new Error('échec ignoré')))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('UiAssets lues dans un dossier', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lastaddon-assets-'));
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'sub'));
    mkdirSync(join(dir, '.secret'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>racine</title>');
    writeFileSync(join(dir, 'sub', 'index.html'), '<!doctype html><title>sous-dossier</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), '0123456789');
    writeFileSync(join(dir, '.secret', 'k.txt'), 'caché');
    writeFileSync(join(dir, '.env'), 'LASTADDON_SECRET=nope');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response | null> =>
    createFsUiAssets(dir).serve(new Request(`http://localhost${pathname}`, { method, headers }), pathname);

  it('sert un fichier avec son type, sa taille, un ETag et Last-Modified', async () => {
    const res = await get('/assets/app.js');
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res?.headers.get('content-length')).toBe('10');
    expect(res?.headers.get('etag')).toMatch(/^W\/"/);
    expect(res?.headers.get('last-modified')).not.toBeNull();
    expect(res?.headers.get('accept-ranges')).toBe('bytes');
    expect(await res?.text()).toBe('0123456789');
  });

  it('un dossier sert son index.html', async () => {
    expect(await (await get('/sub'))?.text()).toContain('sous-dossier');
    expect(await (await get('/'))?.text()).toContain('racine');
  });

  it('If-None-Match identique : 304 sans corps', async () => {
    const first = await get('/assets/app.js');
    const etag = first?.headers.get('etag') ?? '';
    const again = await get('/assets/app.js', { 'if-none-match': etag });
    expect(again?.status).toBe(304);
    expect(await again?.text()).toBe('');
    const other = await get('/assets/app.js', { 'if-none-match': 'W/"autre"' });
    expect(other?.status).toBe(200);
  });

  it('plages : début-fin, suffixe, et 416 hors fichier', async () => {
    const part = await get('/assets/app.js', { range: 'bytes=2-4' });
    expect(part?.status).toBe(206);
    expect(part?.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await part?.text()).toBe('234');
    const tail = await get('/assets/app.js', { range: 'bytes=-3' });
    expect(await tail?.text()).toBe('789');
    const beyond = await get('/assets/app.js', { range: 'bytes=50-60' });
    expect(beyond?.status).toBe(416);
  });

  it('HEAD : en-têtes sans corps', async () => {
    const res = await get('/assets/app.js', {}, 'HEAD');
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-length')).toBe('10');
    expect(await res?.text()).toBe('');
  });

  it('fichier absent, fichiers cachés, sortie de la racine et méthodes autres que GET : null', async () => {
    expect(await get('/absent.js')).toBeNull();
    expect(await get('/.env')).toBeNull();
    expect(await get('/.secret/k.txt')).toBeNull();
    expect(await get('/../package.json')).toBeNull();
    expect(await get('/%2e%2e/package.json')).toBeNull();
    expect(await get('/assets/app.js%00.png')).toBeNull();
    expect(await get('/assets/app.js', {}, 'POST')).toBeNull();
  });
});
