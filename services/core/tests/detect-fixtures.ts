import { spawnSync } from 'node:child_process';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Musique synthétique : notes pentatoniques aléatoires (harmoniques, enveloppe) ; une graine = une mélodie. */
export function melody(seed: number, seconds: number, rate: number): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(Math.round(seconds * rate));
  const scale = [0, 2, 4, 7, 9];
  let at = 0;
  while (at < out.length) {
    const length = Math.round([0.2, 0.25, 0.3, 0.4, 0.5][Math.floor(random() * 5)]! * rate);
    const voices = random() < 0.35 ? 2 : 1;
    for (let v = 0; v < voices; v += 1) {
      const degree = (scale[Math.floor(random() * 5)] ?? 0) + 12 * Math.floor(random() * 3);
      const freq = 220 * Math.pow(2, degree / 12);
      for (let i = 0; i < length && at + i < out.length; i += 1) {
        const t = i / rate;
        const envelope = Math.min(1, i / (0.01 * rate)) * Math.exp(-3 * (i / length));
        const tone = Math.sin(2 * Math.PI * freq * t) + 0.5 * Math.sin(2 * Math.PI * 2 * freq * t) + 0.25 * Math.sin(2 * Math.PI * 3 * freq * t);
        out[at + i] = (out[at + i] ?? 0) + 0.25 * envelope * tone;
      }
    }
    at += length;
  }
  return out;
}

export type Part = { theme: number; seconds: number } | { content: number; seconds: number } | { silence: number };

/** Épisode : suite de parties (thème partagé par graine, contenu propre, silence), bruit léger et gain propre. */
export function episodeAudio(parts: readonly Part[], rate: number, gain = 1, noiseSeed = 99): Float32Array {
  const chunks = parts.map((part) =>
    'silence' in part ? new Float32Array(Math.round(part.silence * rate)) : melody('theme' in part ? part.theme : part.content, part.seconds, rate),
  );
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  const noise = rng(noiseSeed);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  for (let i = 0; i < out.length; i += 1) out[i] = ((out[i] ?? 0) + (noise() - 0.5) * 0.01) * gain;
  return out;
}

export function toPcm16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
}

/** Fichier WAV mono 16 bits. */
export function writeWav(path: string, samples: Float32Array, rate: number): void {
  const pcm = toPcm16(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(pcm.buffer)]));
}

/** Exécute ffmpeg (échoue bruyamment) ; retourne vrai si le binaire est disponible. */
export function ffmpegSync(ffmpeg: string, args: string[]): void {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg a échoué : ${result.stderr}`);
}

export interface ChapterSpec {
  title: string;
  start: number;
  end: number;
}

/** Fichier ffmetadata décrivant des chapitres. */
export function writeChapters(path: string, chapters: readonly ChapterSpec[]): void {
  const lines = [';FFMETADATA1'];
  for (const chapter of chapters) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(chapter.start * 1000)}`, `END=${Math.round(chapter.end * 1000)}`, `title=${chapter.title}`);
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

export interface FileServer {
  base: string;
  /** Octets servis au total (requêtes Range comprises). */
  served: () => number;
  close: () => Promise<void>;
}

/** Serveur HTTP local de fichiers avec Range (sert un dossier de fixtures). */
export async function serveDir(dir: string): Promise<FileServer> {
  let served = 0;
  const server: Server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '');
    if (name.includes('..') || name.includes('/')) {
      res.writeHead(404).end();
      return;
    }
    const path = join(dir, name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range !== null) {
      status = 206;
      if (range[1] === '') {
        start = Math.max(0, size - Number(range[2]));
      } else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
    }
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    const headers: Record<string, string | number> = { 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-type': 'application/octet-stream' };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(path, { start, end });
    stream.on('data', (chunk) => {
      served += chunk.length;
    });
    stream.pipe(res);
    res.on('close', () => stream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    served: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
