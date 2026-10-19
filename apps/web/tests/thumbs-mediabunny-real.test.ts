// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ByteSource, MAX_CHUNK, openMp4, openVideoIndex, type FetchRange } from '../src/thumbs';
import { openMediabunnyIndex } from '../src/thumbs/mediabunny';

/* MP4 fragmenté H.264 généré par ffmpeg local dans un dossier temporaire (rien de binaire commité).
 * Sans ffmpeg sur la machine, la suite est ignorée. mediabunny réel : pas de simulation ici. */

const hasFfmpeg = (): boolean => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Fichier servi par plages, journalise (début, fin incluse). */
function served(file: Uint8Array): { fetchRange: FetchRange; log: [number, number][] } {
  const log: [number, number][] = [];
  const fetchRange: FetchRange = async (start, end) => {
    log.push([start, end]);
    if (start >= file.length) return { data: new Uint8Array(0), total: file.length };
    return { data: file.slice(start, Math.min(end + 1, file.length)), total: file.length };
  };
  return { fetchRange, log };
}

/** Un NAL de type IDR (5) figure-t-il dans l'échantillon (longueurs préfixées sur 4 octets) ? */
function hasIdr(sample: Uint8Array): boolean {
  let p = 0;
  while (p + 4 <= sample.length) {
    const len = ((sample[p] << 24) | (sample[p + 1] << 16) | (sample[p + 2] << 8) | sample[p + 3]) >>> 0;
    if (len === 0 || p + 4 + len > sample.length) return false;
    if ((sample[p + 4] & 31) === 5) return true;
    p += 4 + len;
  }
  return false;
}

describe.skipIf(!hasFfmpeg())('MP4 fragmenté (ffmpeg local) : repli mediabunny', () => {
  let dir = '';
  let frag = new Uint8Array(0);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lst-mediabunny-'));
    const out = join(dir, 'fragmented.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '4', '-an',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-bf', '0',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', out,
    ], { stdio: 'ignore', timeout: 120_000 });
    frag = new Uint8Array(readFileSync(out));
  }, 150_000);

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('le démuxeur maison ne lit aucun échantillon dans ce moov (le repli est nécessaire)', async () => {
    const src = new ByteSource(served(frag).fetchRange);
    await src.open();
    expect(await openMp4(src)).toBeNull();
  });

  it('openVideoIndex : repli sur mediabunny ; info du fichier, aucune image clé indexée d\'avance', async () => {
    const r = await openVideoIndex(served(frag).fetchRange);
    expect(r).not.toBeNull();
    const { index } = r!;
    expect(index.info.container).toBe('mp4');
    expect(index.info.codec).toBe('h264');
    expect(index.info.codecString).toMatch(/^avc1\.[0-9A-F]{6}$/);
    expect(index.info.width).toBe(320);
    expect(index.info.height).toBe(180);
    expect(index.info.duration).toBeCloseTo(4, 1);
    expect(index.keyframeCount).toBe(0);
  });

  it('keyframeAt : image clé la plus proche aux secondes entières ; échantillons IDR de la bonne taille', async () => {
    const { index } = (await openVideoIndex(served(frag).fetchRange))!;
    expect((await index.keyframeAt(-1))!.timestamp).toBeCloseTo(0, 3);
    expect((await index.keyframeAt(1.6))!.timestamp).toBeCloseTo(2, 3);
    expect((await index.keyframeAt(2.3))!.timestamp).toBeCloseTo(2, 3);
    expect((await index.keyframeAt(3.9))!.timestamp).toBeCloseTo(3, 3);
    for (const t of [0, 1, 2, 3]) {
      const ref = (await index.keyframeAt(t))!;
      const sample = (await index.readSample(ref))!;
      expect(sample.length).toBe(ref.size);
      expect(hasIdr(sample)).toBe(true);
    }
  });

  it('plages : toutes ≤ 4 Mo et dans le fichier, même avec un en-tête minuscule', async () => {
    const { fetchRange, log } = served(frag);
    const r = await openVideoIndex(fetchRange, { headBytes: 1024 });
    await r!.index.readSample((await r!.index.keyframeAt(2))!);
    expect(log.length).toBeGreaterThan(1);
    expect(log.every(([s, e]) => e - s + 1 <= MAX_CHUNK && e < frag.length)).toBe(true);
  });

  it('openMediabunnyIndex : même résultat en appel direct', async () => {
    const index = await openMediabunnyIndex(served(frag).fetchRange);
    expect(index.info.codec).toBe('h264');
    const ref = (await index.keyframeAt(1))!;
    expect(hasIdr((await index.readSample(ref))!)).toBe(true);
  });

  it('signal annulé : keyframeAt rejette', async () => {
    const index = await openMediabunnyIndex(served(frag).fetchRange);
    const ctl = new AbortController();
    ctl.abort();
    await expect(index.keyframeAt(1, ctl.signal)).rejects.toThrow();
  });
});
