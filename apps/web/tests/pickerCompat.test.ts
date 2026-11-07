// Sélecteur de sources (navigateur) : sources incompatibles grisées avec leur motif, et message « aucune source compatible » (ODY-189).
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: () => Promise.resolve(50000) };
});

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { openSourcePicker } = await import('../src/sources/picker.js');
const { toSourceViews, withWebPlayback } = await import('../src/sources/info');
import type { Stream } from '../src/data/stream';

const caps = { formats: ['mp4', 'matroska,webm', 'webm'], videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3', 'opus'], maxAudioChannels: 6 };
const mk = (filename: string, over: Record<string, unknown> = {}): Stream => ({
  url: 'https://h.example/play/' + filename,
  behaviorHints: { filename },
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 8000, filename, ...over },
});
const views = (list: Stream[]) => withWebPlayback(toSourceViews(list), caps, { appAudio: true });

function newHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.dataset.testHost = '1';
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
  localStorage.clear();
});

describe('sélecteur : compatibilité navigateur', () => {
  it('une source DTS reste visible, grisée, non sélectionnable, avec son motif ; la compatible est recommandée', async () => {
    const host = newHost();
    await openSourcePicker({ name: 'Film' }, null, { host, views: views([mk('Film.1080p.BluRay.DTS.mkv', { score: 90 }), mk('Film.720p.WEB.AAC.mp4', { resolution: '720p', height: 720 })]) });
    await vi.waitFor(() => expect(host.querySelector('.is-rec')).not.toBeNull());

    const blocked = host.querySelector('.src2.is-incompatible') as HTMLButtonElement;
    expect(blocked).not.toBeNull();
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toContain('Film.1080p.BluRay.DTS.mkv');
    expect(blocked.textContent).toContain('DTS');
    expect(host.querySelector('.is-rec')!.textContent).toContain('Film.720p.WEB.AAC.mp4');
    expect(host.querySelector('.s-nocompat')).toBeNull();
  });

  it('aucune source compatible : message et lien de téléchargement selon l’OS, rien de recommandé', async () => {
    const host = newHost();
    await openSourcePicker({ name: 'Film' }, null, { host, views: views([mk('Film.1080p.BluRay.DTS.mkv'), mk('Film.2160p.WEB.HEVC.AAC.mkv', { codec: 'HEVC', resolution: '2160p', height: 2160 })]) });
    await vi.waitFor(() => expect(host.querySelector('.s-nocompat')).not.toBeNull());

    expect(host.querySelector('.is-rec')).toBeNull();
    expect(host.querySelectorAll('.src2.is-incompatible')).toHaveLength(2);
    expect(host.querySelector('.s-nocompat')!.textContent).toContain('Aucune source');
  });
});
