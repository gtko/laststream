// Boutons d'ouverture (ODY-217) : un second appui referme ce qu'ils ont ouvert, et l'état ouvert est exposé (aria-expanded).
import { describe, expect, it } from 'vitest';
import { setOpenState, toggleOpen } from '../src/ui/disclosure.js';
import { MiniState } from '../src/player/mini';
import { createPlayerUI } from '../src/player/ui.js';

describe('disclosure', () => {
  it('setOpenState : aria-expanded et is-open suivent l’état', () => {
    const b = document.createElement('button');
    setOpenState(b, true);
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(b.classList.contains('is-open')).toBe(true);
    setOpenState(b, false);
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.classList.contains('is-open')).toBe(false);
    expect(() => setOpenState(null, true)).not.toThrow();
  });

  it('toggleOpen : ferme si ouvert, ouvre sinon', () => {
    let open = false;
    const calls: string[] = [];
    const run = () => toggleOpen(() => open, () => { open = true; calls.push('open'); }, () => { open = false; calls.push('close'); });
    expect(run()).toBe(true);
    expect(run()).toBe(false);
    expect(run()).toBe(true);
    expect(calls).toEqual(['open', 'close', 'open']);
  });
});

describe('barre du lecteur', () => {
  function player() {
    const storage = new Map<string, string>();
    const miniState = new MiniState({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } });
    const ui = createPlayerUI({ miniState, action: () => undefined, miniLayout: () => undefined, panelOpened: () => undefined, panelClosed: () => undefined, thumb: () => undefined, thumbCancel: () => undefined });
    const btn = (sel: string) => ui.root.querySelector(sel) as HTMLElement;
    return { ui, btn };
  }

  it('les boutons d’ouverture démarrent fermés', () => {
    const { btn } = player();
    for (const sel of ['[data-act="source"]', '[data-act="panel:tracks"]', '[data-act="panel:episodes"]', '[data-act="react"]', '[data-act="mark-open"]', '[data-act="cinema"]', '[data-act="info"]']) {
      expect(btn(sel).getAttribute('aria-expanded'), sel).toBe('false');
    }
  });

  it('Sources : le bouton reflète le panneau, et se referme avec lui', () => {
    const { ui, btn } = player();
    ui.mountPanel('sources', 'Sources');
    expect(ui.panel).toBe('sources');
    expect(btn('[data-act="source"]').getAttribute('aria-expanded')).toBe('true');
    expect(btn('[data-act="panel:tracks"]').getAttribute('aria-expanded')).toBe('false');
    ui.closePanel();
    expect(ui.panel).toBeNull();
    expect(btn('[data-act="source"]').getAttribute('aria-expanded')).toBe('false');
  });

  it('Réagir ici : isReactOpen suit le popover, le bouton aussi', () => {
    const { ui, btn } = player();
    expect(ui.isReactOpen()).toBe(false);
    ui.openReact(42, {});
    expect(ui.isReactOpen()).toBe(true);
    expect(btn('[data-act="react"]').getAttribute('aria-expanded')).toBe('true');
    ui.closeReact(true);
    expect(ui.isReactOpen()).toBe(false);
    expect(btn('[data-act="react"]').getAttribute('aria-expanded')).toBe('false');
  });

  it('ouvrir un panneau referme le popover et inversement : un seul état ouvert à la fois', () => {
    const { ui, btn } = player();
    ui.openReact(5, {});
    ui.mountPanel('sources', 'Sources');
    ui.openReact(5, {});
    expect(btn('[data-act="react"]').getAttribute('aria-expanded')).toBe('true');
    expect(btn('[data-act="source"]').getAttribute('aria-expanded')).toBe('false');
  });
});
