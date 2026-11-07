// Sélecteur de sources : taille à côté de la résolution, filtre 2K, plafond de résolution signalé (ODY-236).
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: () => Promise.resolve(200000) };
});

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { openSourcePicker } = await import('../src/sources/picker.js');
const { toSourceViews } = await import('../src/sources/info');
const { setResolutionCap } = await import('../src/data/prefs');
import type { Stream } from '../src/data/stream';

const mk = (resolution: string, filename: string, sizeBytes: number, score = 50): Stream => ({
  url: 'https://h.example/play/' + filename,
  behaviorHints: { filename },
  laststream: { resolution, height: parseInt(resolution, 10) || 0, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score, estBitrateKbps: 8000, filename, sizeBytes },
});
const list = () => toSourceViews([
  mk('2160p', 'Film.2160p.mkv', 58e9, 95),
  mk('unknown', 'Film.1440p.mkv', 14.2e9, 90),
  mk('1080p', 'Film.1080p.mkv', 8.4e9, 80),
]);

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

describe('sélecteur : résolution maximale', () => {
  it('la taille est à côté de la résolution, la puce 2K filtre les sources 1440p', async () => {
    setResolutionCap('2160p');
    const host = newHost();
    await openSourcePicker({ name: 'Film' }, null, { host, views: list() });
    await vi.waitFor(() => expect(host.querySelector('.is-rec')).not.toBeNull());

    const row = (name: string) => Array.from(host.querySelectorAll('.src2')).find((b) => b.textContent!.includes(name))!;
    expect(row('Film.1440p.mkv').querySelector('.s-l1')!.textContent).toContain('2K');
    expect(row('Film.1440p.mkv').querySelector('.s-l1 .s-size')!.textContent).toBe('14,2 Go');
    expect(row('Film.2160p.mkv').querySelector('.s-l1 .s-size')!.textContent).toBe('58,0 Go');
    expect(host.querySelector('.s-cap')).toBeNull();

    const chip = host.querySelector('[data-chip="res:1440p"]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    chip.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.src2')).toHaveLength(1));
    expect(host.querySelector('.src2')!.textContent).toContain('Film.1440p.mkv');
  });

  it('plafond 1080p : le 1080p est recommandé, les plus lourdes restent choisissables et signalées', async () => {
    setResolutionCap('1080p');
    const host = newHost();
    await openSourcePicker({ name: 'Film' }, null, { host, views: list() });
    await vi.waitFor(() => expect(host.querySelector('.is-rec')).not.toBeNull());

    expect(host.querySelector('.is-rec')!.textContent).toContain('Film.1080p.mkv');
    expect(host.querySelector('.is-rec')!.textContent).toContain('plafond 1080p');
    expect(host.querySelector('.s-cap')!.textContent).toContain('1080p');
    const over = Array.from(host.querySelectorAll('.src2.is-over-cap')) as HTMLButtonElement[];
    expect(over).toHaveLength(2);
    expect(over.every((b) => !b.disabled && b.textContent!.includes('Au-dessus du plafond (1080p)'))).toBe(true);
  });
});
