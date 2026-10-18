import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateTools } from '../src/lt/detect/tools.js';
import { isWebp } from '../src/lt/thumbs/service.js';
import { ffmpegSync, type FileServer, serveDir } from './detect-fixtures.js';
import { fullToken, startApp, type RunningApp } from './lt-harness.js';

/** Intégration : vrai ffmpeg, petit fichier servi par un serveur HTTP de test sur 127.0.0.1 (ajouté par injection). */
const tools = await locateTools();
const run = tools === undefined ? describe.skip : describe;

let dir: string;
let files: FileServer;
let app: RunningApp;

beforeAll(async () => {
  if (tools === undefined) return;
  dir = mkdtempSync(join(tmpdir(), 'lastaddon-thumbs-it-'));
  // 75 s d'image mouvante : tranches 0 (2 s), 1 (30 s) et 2 (60 s).
  ffmpegSync(tools.ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=5:d=75', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(dir, 'film.mp4')]);
  files = await serveDir(dir);
  const port = new URL(files.base).port;
  app = await startApp({
    thumbs: {
      ffmpeg: tools.ffmpeg,
      cacheDir: join(dir, 'cache'),
      concurrency: 2,
      allowLocal: (u) => u.hostname === '127.0.0.1' && u.port === port,
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await files?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

run('miniatures : génération réelle avec ffmpeg', () => {
  it('génère deux miniatures WebP à 30 s d\'intervalle, puis les sert depuis le cache', async () => {
    const token = fullToken();
    const registered = await fetch(`${app.baseUrl}/${token}/lt/thumbs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${files.base}/film.mp4`, duration: 75 }),
    });
    expect(registered.status).toBe(200);
    const { key, interval, count } = (await registered.json()) as { key: string; interval: number; count: number };
    expect(interval).toBe(30);
    expect(count).toBe(3);

    const sizes: number[] = [];
    const bodies: Buffer[] = [];
    for (const index of [1, 2]) {
      const started = Date.now();
      const res = await fetch(`${app.baseUrl}/${token}/lt/thumbs/${key}/${index}.webp`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      const data = Buffer.from(await res.arrayBuffer());
      expect(isWebp(data)).toBe(true);
      expect(Date.now() - started).toBeLessThan(8000);
      sizes.push(data.length);
      bodies.push(data);
    }
    console.info('[miniatures] tailles WebP (octets) :', sizes.join(', '));
    for (const size of sizes) {
      expect(size).toBeGreaterThan(300);
      expect(size).toBeLessThan(12_000);
    }
    expect(bodies[0]!.equals(bodies[1]!)).toBe(false); // deux instants différents

    // Une source refusée (hors liste) ne génère rien.
    const refused = await fetch(`${app.baseUrl}/${token}/lt/thumbs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9/film.mp4' }),
    });
    expect(refused.status).toBe(400);

    // Au-delà de la dernière tranche : introuvable.
    expect((await fetch(`${app.baseUrl}/${token}/lt/thumbs/${key}/3.webp`)).status).toBe(404);
  }, 60_000);
});
