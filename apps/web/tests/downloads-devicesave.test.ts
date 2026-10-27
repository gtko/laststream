// Web « Sur cet appareil » (LAST-498), côté interface : sans File System Access, l'onglet s'ouvre pendant le clic (avant que le
// lien soit débridé), puis il est dirigé vers le lien ; un échec de résolution referme l'onglet. Aucun réseau.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolve: null as null | (() => Promise<{ url: string; filename?: string }>),
  order: [] as string[],
  toasts: [] as string[],
}));

vi.mock('../src/downloads/service', () => ({
  resolveDeviceLink: () => {
    h.order.push('resolve');
    return h.resolve!();
  },
}));
vi.mock('../src/ui/dom.js', () => ({ toast: (msg: string) => h.toasts.push(msg) }));

import { saveToDevice } from '../src/ui/deviceSave.js';
import { DownloadError } from '../src/downloads/types';

const T = { key: 'movie:1', type: 'movie', id: '1', name: 'Dune' };

function fakeWindow() {
  const replace = vi.fn();
  const close = vi.fn();
  const win = { document: document.implementation.createHTMLDocument(''), location: { replace }, opener: {}, close } as unknown as Window;
  return { win, replace, close };
}

beforeEach(() => {
  h.order = [];
  h.toasts = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveToDevice (navigateur sans choix de dossier)', () => {
  it('ouvre l’onglet avant de débrider, puis le dirige vers le lien', async () => {
    const w = fakeWindow();
    vi.spyOn(window, 'open').mockImplementation(() => {
      h.order.push('open');
      return w.win;
    });
    h.resolve = async () => ({ url: 'https://abc.debrid.it/dl/x/Dune.mkv', filename: 'Dune.mkv' });
    expect(await saveToDevice(T, {}, 'Dune')).toBe(true);
    expect(h.order).toEqual(['open', 'resolve']);
    expect(w.replace).toHaveBeenCalledWith('https://abc.debrid.it/dl/x/Dune.mkv');
    expect(h.toasts.join(' ')).toContain('navigateur');
    expect(h.toasts.join(' ')).not.toContain('debrid.it'); // aucun lien affiché
  });

  it('résolution impossible : l’onglet d’attente est refermé, message traduit', async () => {
    const w = fakeWindow();
    vi.spyOn(window, 'open').mockImplementation(() => w.win);
    h.resolve = async () => {
      throw new DownloadError('account', false);
    };
    expect(await saveToDevice(T, {}, 'Dune')).toBe(false);
    expect(w.close).toHaveBeenCalled();
    expect(w.replace).not.toHaveBeenCalled();
    expect(h.toasts[0]).toMatch(/débrideur/);
  });

  it('onglet bloqué par le navigateur : un bouton propose le téléchargement', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    h.resolve = async () => ({ url: 'https://abc.debrid.it/dl/x/Dune.mkv' });
    expect(await saveToDevice(T, {}, 'Dune')).toBe(true);
    expect(h.toasts.at(-1)).toMatch(/bloqué/);
  });
});
