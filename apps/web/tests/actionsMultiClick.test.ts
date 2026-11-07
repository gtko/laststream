// Actions rejouables (ODY-237) : un double ou triple clic rapide ne déclenche qu'une seule action.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setFollow = vi.fn();
let following = false;
vi.mock('../src/data/userStore', () => ({
  userStore: {
    isFollowing: () => following,
    setFollow: (...a: unknown[]) => setFollow(...a),
  },
}));
vi.mock('../src/ui/dom.js', () => ({ toast: vi.fn(), detailEl: document.createElement('div') }));
vi.mock('../src/ui/state.js', () => ({ state: { model: null, byKey: new Map() }, registerCtxItems: vi.fn() }));

const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

describe('anti-multi-clic (ODY-237)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    setFollow.mockReset();
    following = false;
    document.body.innerHTML = '<button type="button" data-follow="movie:1">Suivre</button>';
    const { resetBusy } = await import('../src/ui/busy.js');
    resetBusy();
    await import('../src/ui/follows.js');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('suivre : trois clics rapides pendant l’enregistrement ne l’envoient qu’une fois, le bouton est « en cours »', async () => {
    let finish!: (ok: boolean) => void;
    setFollow.mockReturnValue(new Promise<boolean>((r) => { finish = r; }));
    const btn = document.querySelector('[data-follow]')!;
    click(btn); click(btn); click(btn);
    expect(setFollow).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('suivre : un clic juste après la fin est encore ignoré (délai de redéclenchement), puis accepté', async () => {
    setFollow.mockResolvedValue(true);
    const btn = document.querySelector('[data-follow]')!;
    click(btn);
    await vi.advanceTimersByTimeAsync(10);
    click(btn);
    expect(setFollow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    click(btn);
    expect(setFollow).toHaveBeenCalledTimes(2);
  });
});
