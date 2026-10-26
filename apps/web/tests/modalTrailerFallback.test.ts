import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTrailerFailed } from '../src/data/trailerHealth';

let modalMod: typeof import('../src/ui/modal.js');

beforeAll(async () => {
  // Squelette réel : modal.js lit la fenêtre à l'import.
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() { /* sans effet */ } disconnect() { /* sans effet */ } };
  }
  modalMod = await import('../src/ui/modal.js');
});
beforeEach(() => { localStorage.clear(); });

function fail(iframe: HTMLIFrameElement, code: number) {
  const win = { postMessage: vi.fn() };
  Object.defineProperty(iframe, 'contentWindow', { value: win, configurable: true });
  iframe.dispatchEvent(new Event('load'));
  const ev = new MessageEvent('message', { data: JSON.stringify({ event: 'onError', info: code }), origin: 'https://www.youtube-nocookie.com' });
  Object.defineProperty(ev, 'source', { value: win });
  window.dispatchEvent(ev);
}

describe('openVideo : bande-annonce indisponible', () => {
  it('bascule sur la candidate suivante', () => {
    const d = { trailer: 'a', trailerVO: false, trailers: [{ key: 'a', vo: false }, { key: 'b', vo: false }] };
    modalMod.openVideo('a', 'Bande-annonce : Test', null, false, d, 'k1');
    const iframe = document.querySelector('#modal-body iframe') as HTMLIFrameElement;
    fail(iframe, 150);
    expect(iframe.src).toContain('/embed/b');
    expect(isTrailerFailed('a')).toBe(true);
    expect(document.getElementById('modal')!.hidden).toBe(false);
    modalMod.closeModal(true);
  });

  it('plus aucune candidate : ferme, retire les boutons du titre et mémorise l’échec', () => {
    document.body.insertAdjacentHTML('beforeend', '<button data-trailer="k&quot;2">Bande-annonce</button><button data-trailer="autre">Bande-annonce</button>');
    const d = { trailer: 'a', trailerVO: false, trailers: [{ key: 'a', vo: false }] };
    modalMod.openVideo('a', 'Bande-annonce : Test', null, false, d, 'k"2');
    const iframe = document.querySelector('#modal-body iframe') as HTMLIFrameElement;
    fail(iframe, 101);
    expect(document.getElementById('modal')!.hidden).toBe(true);
    expect(document.querySelector('[data-trailer="autre"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-trailer]').length).toBe(1);
    expect(isTrailerFailed('a')).toBe(true);
    expect(d.trailer).toBe('');
  });
});
