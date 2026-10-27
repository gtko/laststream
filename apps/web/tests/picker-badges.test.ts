// Sélecteur de sources : badges de format, pastille de débit et bouton « Mesurer » (rendu DOM, mesure mockée).
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { measure } = vi.hoisted(() => ({ measure: vi.fn<() => Promise<number | null>>() }));

vi.mock('../src/data/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/sources')>();
  return { ...actual, measureBandwidthKbps: () => measure() };
});

// Le corps de index.html (sans scripts) avant de charger le sélecteur.
const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { openSourcePicker } = await import('../src/sources/picker.js');
const { toSourceViews } = await import('../src/sources/info');
import type { Stream } from '../src/data/stream';

/** Source lastAddon : débit estimé en kb/s, badges (REMUX, DV, HEVC 10-bit, TrueHD Atmos 7.1). */
const stream = (kbps: number): Stream => ({
  name: 'Lumio\n1080p',
  url: 'https://cdn.example/' + kbps + '.mkv',
  laststream: {
    resolution: '1080p', height: 1080, source: 'REMUX', codec: 'HEVC', hdr: ['DV'], languages: ['fr'],
    cached: true, score: 10, estBitrateKbps: kbps, audio: ['TrueHD', 'Atmos'], channels: '7.1',
    filename: 'Film.2024.1080p.REMUX.HEVC.10bit.TrueHD.Atmos.7.1.mkv',
  },
});

const views = () => toSourceViews([stream(8000), stream(40000), stream(48000)]);

function newHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.dataset.testHost = '1';
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  measure.mockReset();
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
  localStorage.clear();
});

describe('sélecteur : pastilles de débit et badges', () => {
  it('débit mesuré : une pastille par niveau, badges de format sur la carte', async () => {
    measure.mockResolvedValue(50000); // 50 Mb/s : 8 → fluide, 40 → juste (80 %), 48 → risque (96 %)
    const host = newHost();
    await openSourcePicker({ name: 'Film' }, null, { host, views: views() });
    await vi.waitFor(() => expect(host.querySelector('.fit-risky')).not.toBeNull());

    expect(host.querySelectorAll('.fit-fluid')).toHaveLength(1);
    expect(host.querySelectorAll('.fit-tight')).toHaveLength(1);
    expect(host.querySelectorAll('.fit-risky')).toHaveLength(1);
    const fluid = host.querySelector('.fit-fluid') as HTMLElement;
    expect(fluid.getAttribute('aria-label')).toBe('8,0 Mb/s sur une connexion de 50,0 Mb/s : fluide');
    expect(host.querySelector('.fit-risky')!.textContent).toContain('Risque de coupures');

    for (const cls of ['bdg-remux', 'bdg-dv', 'bdg-hevc', 'bdg-bit10', 'bdg-truehd', 'bdg-atmos', 'bdg-ch71']) {
      expect(host.querySelector('.' + cls), cls).not.toBeNull();
    }
    // Débit connu : pas de bouton « Mesurer ».
    expect(host.querySelector('[data-chip="bw:measure"]')).toBeNull();
  });

  it('débit inconnu : pastilles neutres, « Mesurer » relance la mesure et rafraîchit', async () => {
    measure.mockResolvedValueOnce(null).mockResolvedValueOnce(178000);
    const host = newHost();
    await openSourcePicker({ name: 'Film' }, null, { host, views: views() });

    expect(host.querySelectorAll('.fit-unknown')).toHaveLength(3);
    expect(host.querySelector('.fit-unknown')!.textContent).toContain('Débit inconnu');
    const btn = host.querySelector('[data-chip="bw:measure"]') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Mesurer ma connexion');

    btn!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-chip="bw:measure"]')).toBeNull());
    expect(measure).toHaveBeenCalledTimes(2);
    // 48 Mb/s sur 178 Mb/s = 27 % : toutes les sources passent.
    expect(host.querySelectorAll('.fit-fluid')).toHaveLength(3);
    expect(host.querySelectorAll('.fit-unknown')).toHaveLength(0);
  });
});
