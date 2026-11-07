import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ps from '../src/player/playerState';

vi.mock('../src/sources/load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/load')>()),
  prefetchSources: vi.fn(),
}));
vi.mock('../src/ui/catalog.js', () => ({ getDetail: vi.fn(async () => ({ trailer: 'abc', trailerVO: false })) }));

let startPreview: typeof import('../src/ui/preview.js').startPreview;
let stopPreview: typeof import('../src/ui/preview.js').stopPreview;
let scheduleDwell: typeof import('../src/ui/preview.js').scheduleDwell;
let heroVideoSetup: typeof import('../src/ui/heroVideo.js').heroVideoSetup;
let heroVideoStop: typeof import('../src/ui/heroVideo.js').heroVideoStop;
let initTrailersGate: typeof import('../src/ui/trailersGate.js').initTrailersGate;
let state: { byKey: Map<string, unknown>; inDetail: boolean; preview: unknown; dwell: { timer: unknown } };
beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() { /* sans effet */ } disconnect() { /* sans effet */ } };
  ({ startPreview, stopPreview, scheduleDwell } = await import('../src/ui/preview.js'));
  ({ heroVideoSetup, heroVideoStop } = await import('../src/ui/heroVideo.js'));
  ({ initTrailersGate } = await import('../src/ui/trailersGate.js'));
  ({ state } = await import('../src/ui/state.js') as unknown as { state: typeof state });
});

let off: () => void;
beforeEach(() => {
  state.inDetail = false;
  state.byKey.set('movie:1', { key: 'movie:1', name: 'Film' });
  document.getElementById('app')!.innerHTML = '<div class="hero-bg" data-media="movie:1"></div>';
  off = initTrailersGate();
});
afterEach(() => {
  off();
  vi.useRealTimers();
  stopPreview();
  heroVideoStop();
  ps.set({ open: false, mini: false });
});

describe('bandes-annonces et lecteur (LAST-173)', () => {
  it('plein écran : aucune iframe d’aperçu ne démarre, ni minuterie de survol', async () => {
    ps.set({ open: true, mini: false });
    const media = document.querySelector('[data-media]') as HTMLElement;
    await startPreview(media);
    expect(media.querySelector('iframe')).toBeNull();
    scheduleDwell(media);
    expect(state.dwell.timer).toBeNull();
  });

  it('l’ouverture du lecteur en plein écran arrête l’aperçu en cours', async () => {
    const media = document.querySelector('[data-media]') as HTMLElement;
    await startPreview(media);
    expect(media.querySelector('iframe')).not.toBeNull();
    ps.set({ open: true, mini: false });
    expect(state.preview).toBeNull();
    expect(media.querySelector('iframe')).toBeNull();
  });

  it('miniature : les aperçus peuvent démarrer', async () => {
    ps.set({ open: true, mini: true });
    const media = document.querySelector('[data-media]') as HTMLElement;
    await startPreview(media);
    expect(media.querySelector('iframe')).not.toBeNull();
  });

  it('bande-annonce de la fiche : pause à l’ouverture (même en miniature), lecture à la fermeture', () => {
    vi.useFakeTimers();
    document.getElementById('detail')!.innerHTML = '<div class="f-first"><div class="f-bg"></div></div>';
    heroVideoSetup({ trailer: 'abc', trailerVO: false });
    vi.advanceTimersByTime(60000);
    const iframe = document.querySelector('.f-video iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    const post = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    iframe.dispatchEvent(new Event('load'));
    const funcs = () => post.mock.calls.map((c) => JSON.parse(String(c[0])).func);
    post.mockClear();
    ps.set({ open: true, mini: false });
    expect(funcs()).toEqual(['pauseVideo']);
    post.mockClear();
    ps.set({ mini: true });
    expect(funcs()).toEqual(['pauseVideo']);
    post.mockClear();
    ps.set({ open: false, mini: false });
    expect(funcs()).toEqual(['playVideo']);
  });
});
