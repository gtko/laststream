import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IssuedUrls } from '../src/play/issued.js';
import { ThumbCache } from '../src/lt/thumbs/cache.js';
import { ffmpegFromEnv, ThumbService, type Runner } from '../src/lt/thumbs/service.js';
import { ffmpegArgs, generationOrder, MAX_SLICES, sliceCount, sliceTime } from '../src/lt/thumbs/slices.js';
import { resolveThumbSource } from '../src/lt/thumbs/source.js';
import { fullToken, startApp, type RunningApp } from './lt-harness.js';

const FAKE_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 1)]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lastaddon-thumbs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('miniatures : tranches de 30 s', () => {
  it('nombre de tranches, instants et plafond', () => {
    expect(sliceCount(100)).toBe(4); // 0, 30, 60, 90
    expect(sliceCount(90)).toBe(4);
    expect(sliceCount(undefined)).toBe(MAX_SLICES);
    expect(sliceCount(10 * 3600)).toBe(MAX_SLICES);
    expect(sliceTime(0)).toBe(2);
    expect(sliceTime(3)).toBe(90);
    expect(sliceTime(3, 91)).toBe(90);
    expect(sliceTime(3, 90.5)).toBe(89.5); // jamais au-delà de la fin
  });

  it('ordre de génération : position courante, puis avant/arrière alternés', () => {
    expect(generationOrder(5, 10)).toEqual([5, 6, 4, 7, 3, 8, 2, 9, 1, 0]);
    expect(generationOrder(0, 4)).toEqual([0, 1, 2, 3]);
    expect(generationOrder(99, 4)).toEqual([3, 2, 1, 0]);
    expect(generationOrder(2, 0)).toEqual([]);
  });

  it('commande ffmpeg : tableau d\'arguments, protocoles limités, WebP 160 px, recherche avant -i', () => {
    const args = ffmpegArgs('http://127.0.0.1:1234/media', 60);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('http,https,tcp,tls');
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('scale=160:-2');
    expect(args).toContain('libwebp');
    expect(args.slice(-3)).toEqual(['-f', 'webp', '-']);
  });
});

describe('miniatures : sources autorisées', () => {
  const issued = new IssuedUrls();
  beforeAll(async () => {
    await issued.note('https://cdn.example.com/video.mkv?token=abc');
    await issued.note('https://10.0.0.5/private.mkv');
    await issued.noteResolved('/CFG/play/c/TOK', 'https://dl.debrid.example/f/abc.mkv');
  });

  const ok = (raw: unknown) => resolveThumbSource(raw, issued);

  it('accepte le serveur de streaming local (localhost ramené à 127.0.0.1)', async () => {
    expect((await ok('http://127.0.0.1:11470/abc/0/stream'))?.target.href).toBe('http://127.0.0.1:11470/abc/0/stream');
    expect((await ok('http://localhost:11470/abc/0'))?.target.href).toBe('http://127.0.0.1:11470/abc/0');
  });

  it('accepte une URL émise par lastAddon, et le lien débridé derrière une URL /play résolue', async () => {
    expect(await ok('https://cdn.example.com/video.mkv?token=abc')).not.toBeNull();
    const play = await ok('http://192.168.1.20:7000/CFG/play/c/TOK');
    expect(play?.target.href).toBe('https://dl.debrid.example/f/abc.mkv');
  });

  it('refuse tout le reste', async () => {
    for (const raw of [
      'file:///C:/Windows/win.ini',
      'ftp://example.com/a.mkv',
      'concat:http://127.0.0.1:11470/a|file:///etc/passwd',
      'http://192.168.1.5/a.mkv',
      'http://127.0.0.1:8080/a.mkv',
      'http://localhost:7000/a.mkv',
      'http://127.0.0.1:11471/a',
      'https://10.0.0.5/private.mkv', // émise mais privée
      'https://cdn.example.com/inconnu.mkv', // publique mais jamais émise
      'https://user:pass@cdn.example.com/video.mkv?token=abc',
      'http://192.168.1.20:7000/CFG/play/c/AUTRE', // /play jamais résolu
      '',
      42,
      null,
      undefined,
      `http://127.0.0.1:11470/${'a'.repeat(5000)}`,
    ]) {
      expect(await ok(raw), String(raw).slice(0, 60)).toBeNull();
    }
  });

  it('une origine locale ajoutée par injection n\'ouvre que cette origine', async () => {
    const extra = (u: URL): boolean => u.hostname === '127.0.0.1' && u.port === '45678';
    expect(await resolveThumbSource('http://127.0.0.1:45678/x.mp4', issued, extra)).not.toBeNull();
    expect(await resolveThumbSource('http://127.0.0.1:45679/x.mp4', issued, extra)).toBeNull();
  });

  it('le registre expire ses entrées', async () => {
    let now = 0;
    const reg = new IssuedUrls(() => now, 1000);
    await reg.note('https://cdn.example.com/a.mkv');
    expect(await reg.has('https://cdn.example.com/a.mkv')).toBe(true);
    now = 1001;
    expect(await reg.has('https://cdn.example.com/a.mkv')).toBe(false);
  });
});

describe('miniatures : cache disque LRU', () => {
  it('supprime les images les moins récemment utilisées au-delà du plafond', async () => {
    let clock = 1_000_000;
    const cache = new ThumbCache(join(dir, 'cache'), 35, () => (clock += 1000));
    const ten = Buffer.alloc(10, 7);
    await cache.put('k', 1, ten);
    await cache.put('k', 2, ten);
    await cache.put('k', 3, ten);
    expect(await cache.get('k', 1)).toBeDefined(); // 1 devient le plus récent
    await cache.put('k', 4, ten); // 40 > 35 : purge jusqu'à 90 % (31) -> la plus ancienne (2) part
    expect(await cache.get('k', 2)).toBeUndefined();
    expect((await cache.indexes('k')).sort()).toEqual([1, 3, 4]);
    expect(cache.totalBytes).toBe(30);
  });

  it('retrouve son contenu au redémarrage (indices et taille)', async () => {
    const a = new ThumbCache(join(dir, 'c2'), 1000);
    await a.put('k', 5, Buffer.alloc(8));
    const b = new ThumbCache(join(dir, 'c2'), 1000);
    expect(await b.indexes('k')).toEqual([5]);
    writeFileSync(join(dir, 'c2', 'k', '9.webp'), Buffer.alloc(4));
    utimesSync(join(dir, 'c2', 'k', '9.webp'), new Date(0), new Date(0));
    expect((await b.indexes('k')).sort()).toEqual([5, 9]);
  });
});

describe('miniatures : service', () => {
  it('désactivé sans ffmpeg : variable absente ou fichier introuvable', async () => {
    expect(ffmpegFromEnv({})).toBeNull();
    expect(ffmpegFromEnv({ LASTADDON_FFMPEG: join(dir, 'absent.exe') })).toBeNull();
    expect(ffmpegFromEnv({ LASTADDON_FFMPEG: process.execPath })).toBe(process.execPath);
    const service = new ThumbService({ ffmpeg: null, cacheDir: join(dir, 'c') });
    expect(service.enabled).toBe(false);
    expect(await service.register('http://127.0.0.1:11470/a')).toBeNull();
    expect((await service.frame('0'.repeat(40), 0)).status).toBe('unknown');
    await service.close();
  });

  it('génère depuis la position courante, puis de part et d\'autre, avec un seul processus', async () => {
    const seeks: number[] = [];
    const run: Runner = async (_cmd, args) => {
      seeks.push(Number(args[args.indexOf('-ss') + 1]));
      return { code: 0, stdout: FAKE_WEBP, stderr: '', killed: false };
    };
    const service = new ThumbService({
      ffmpeg: process.execPath,
      cacheDir: join(dir, 'c'),
      concurrency: 1,
      run,
      allowLocal: (u) => u.hostname === '127.0.0.1' && u.port === '45678',
    });
    const registration = await service.register('http://127.0.0.1:45678/film.mp4', 300, 150);
    expect(registration).toMatchObject({ interval: 30, count: 11 });
    const key = registration?.key as string;
    const frame = await service.frame(key, 5, 5000);
    expect(frame.status).toBe('ok');
    for (let i = 0; i < 100 && seeks.length < 11; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(seeks).toEqual([150, 180, 120, 210, 90, 240, 60, 270, 30, 299, 2]);
    await service.close();
  });

  it('une tranche demandée passe devant la file ; au-delà de la fin : introuvable', async () => {
    const seeks: number[] = [];
    const run: Runner = async (_cmd, args) => {
      const t = Number(args[args.indexOf('-ss') + 1]);
      seeks.push(t);
      return { code: 0, stdout: t > 100 ? Buffer.alloc(0) : FAKE_WEBP, stderr: '', killed: false };
    };
    const service = new ThumbService({
      ffmpeg: process.execPath,
      cacheDir: join(dir, 'c'),
      concurrency: 1,
      run,
      allowLocal: (u) => u.port === '45678',
    });
    const key = (await service.register('http://127.0.0.1:45678/film.mp4'))?.key as string; // durée inconnue
    expect((await service.frame(key, 4, 5000)).status).toBe('missing'); // 120 s : ffmpeg ne produit rien = fin du média
    expect((await service.frame(key, 9, 100)).status).toBe('missing'); // la fin est mémorisée
    expect((await service.frame(key, 1, 5000)).status).toBe('ok');
    await service.close();
  });

  it('abandonne une tranche après deux échecs et libère la source inactive', async () => {
    let now = 0;
    const run: Runner = async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'x', killed: false });
    const service = new ThumbService({
      ffmpeg: process.execPath,
      cacheDir: join(dir, 'c'),
      concurrency: 1,
      run,
      now: () => now,
      idleMs: 120_000,
      allowLocal: (u) => u.port === '45678',
    });
    const key = (await service.register('http://127.0.0.1:45678/film.mp4', 60))?.key as string;
    expect((await service.frame(key, 1, 5000)).status).not.toBe('ok');
    for (let i = 0; i < 100 && (await service.frame(key, 1, 0)).status !== 'missing'; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect((await service.frame(key, 1, 0)).status).toBe('missing');
    now = 121_000;
    await service.sweep();
    expect(service.sourceCount).toBe(0);
    expect((await service.frame(key, 1, 0)).status).toBe('unknown');
    await service.close();
  });
});

describe('miniatures : routes', () => {
  let app: RunningApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('sans ffmpeg : capacité absente, 501 sur les routes', async () => {
    app = await startApp({ thumbs: { ffmpeg: null, cacheDir: join(dir, 'c') } });
    const token = fullToken();
    const health = (await (await fetch(`${app.baseUrl}/${token}/lt/health`)).json()) as { capabilities: { thumbs: boolean } };
    expect(health.capabilities.thumbs).toBe(false);
    const post = await fetch(`${app.baseUrl}/${token}/lt/thumbs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:11470/a' }) });
    expect(post.status).toBe(501);
    expect((await fetch(`${app.baseUrl}/${token}/lt/thumbs/${'a'.repeat(40)}/0.webp`)).status).toBe(501);
  });

  it('avec ffmpeg : configuration exigée, source refusée en 400, clé inconnue en 404', async () => {
    const run: Runner = async () => ({ code: 0, stdout: FAKE_WEBP, stderr: '', killed: false });
    app = await startApp({ thumbs: { ffmpeg: process.execPath, cacheDir: join(dir, 'c'), run } });
    const token = fullToken();
    const post = (body: unknown, cfg = token) =>
      fetch(`${app!.baseUrl}/${cfg}/lt/thumbs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const health = (await (await fetch(`${app.baseUrl}/${token}/lt/health`)).json()) as { capabilities: { thumbs: boolean } };
    expect(health.capabilities.thumbs).toBe(true);
    expect((await post({ url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await post({ url: 'http://192.168.1.2/x.mkv' })).status).toBe(400);
    expect((await post({ url: 'http://127.0.0.1:11470/a' }, 'pas-une-config')).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${app.baseUrl}/${token}/lt/thumbs/${'a'.repeat(40)}/0.webp`)).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/${token}/lt/thumbs/zz/0.webp`)).status).toBe(404);
  });
});
