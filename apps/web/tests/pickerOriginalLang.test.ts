// Sélecteur de sources : la langue d'origine du titre est transmise au classement (ODY-147).
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recommend } = vi.hoisted(() => ({ recommend: vi.fn() }));

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: async () => 50_000 };
});
vi.mock('../src/sources/load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/load')>();
  recommend.mockImplementation(actual.recommendFor);
  return { ...actual, recommendFor: recommend };
});

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { openSourcePicker } = await import('../src/sources/picker.js');
const { toSourceViews } = await import('../src/sources/info');
import type { Stream } from '../src/data/stream';

const stream: Stream = {
  name: 'Lumio\n1080p',
  url: 'https://cdn.example/a.mkv',
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['multi'], cached: true, score: 10, estBitrateKbps: 8000, filename: 'Film.mkv' },
};

beforeEach(() => {
  recommend.mockClear();
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
  localStorage.clear();
});

async function open(originalLang?: string): Promise<void> {
  const host = document.createElement('div');
  host.dataset.testHost = '1';
  document.body.appendChild(host);
  await openSourcePicker({ name: 'Film' }, null, { host, views: toSourceViews([stream]), originalLang });
  await vi.waitFor(() => expect(host.querySelector('[data-src]')).not.toBeNull());
}

describe('sélecteur : langue d\'origine', () => {
  it('transmise à chaque recommandation', async () => {
    await open('ko');
    expect(recommend).toHaveBeenCalled();
    for (const call of recommend.mock.calls) expect(call[2]).toBe('ko');
  });

  it('absente : le classement reçoit undefined', async () => {
    await open();
    expect(recommend).toHaveBeenCalled();
    for (const call of recommend.mock.calls) expect(call[2]).toBeUndefined();
  });
});
