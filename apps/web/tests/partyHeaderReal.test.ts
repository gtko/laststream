// @vitest-environment node
// Lecture d'en-tête réelle (mediabunny) : fichiers générés par ffmpeg local dans un dossier temporaire (rien de binaire commité).
// Sans ffmpeg sur la machine, la suite est ignorée.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeSource } from '../src/party/headerCodecs';
import type { RangeReader } from '../src/relay/player/types';

const hasFfmpeg = (): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Lecteur de plages sur un fichier local : seules les plages demandées sont lues, comme un lien HTTP. */
function rangeReader(bytes: Uint8Array): RangeReader {
  return {
    size: async () => bytes.byteLength,
    read: async (start: number, end: number) => bytes.slice(start, end),
  };
}

describe.skipIf(!hasFfmpeg())('en-tête réel : codecs lus par mediabunny', () => {
  let dir = '';
  let mp4 = new Uint8Array();
  let mkv = new Uint8Array();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'party-header-'));
    const src = ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];
    const mp4Path = join(dir, 'sample.mp4');
    const mkvPath = join(dir, 'sample.mkv');
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4Path]);
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k', mkvPath]);
    mp4 = new Uint8Array(readFileSync(mp4Path));
    mkv = new Uint8Array(readFileSync(mkvPath));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('MP4 H.264 + AAC : vidéo h264, audio aac', async () => {
    expect(await probeSource(rangeReader(mp4))).toEqual({ video: 'h264', audio: 'aac' });
  });

  it('MKV H.264 + AC-3 : vidéo h264, audio ac3', async () => {
    expect(await probeSource(rangeReader(mkv))).toEqual({ video: 'h264', audio: 'ac3' });
  });

  it('un fichier qui n’est pas un média : pas de codec lu (null), la liste reprend le nom', async () => {
    const junk = new Uint8Array(4096).fill(7);
    await expect(probeSource(rangeReader(junk))).rejects.toThrow();
  });
});
