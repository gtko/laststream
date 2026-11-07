import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// dom.js lit le squelette de l'application à l'import : on le pose avant de charger le module.
let ambientSrc: typeof import('../src/ui/preview.js').ambientSrc;
let paintSound: typeof import('../src/ui/preview.js').paintSound;
let setPreviewSound: typeof import('../src/ui/preview.js').setPreviewSound;
let ICON: typeof import('../src/ui/icons.js').ICON;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="toast"></div>'
    + '<div id="modal" hidden><div class="modal"><div id="modal-body"></div><button id="modal-close"></button></div></div>';
  ({ ambientSrc, paintSound, setPreviewSound } = await import('../src/ui/preview.js'));
  ({ ICON } = await import('../src/ui/icons.js'));
});

/** Sérialisation DOM d'une icône (le navigateur écrit `<path></path>` là où le modèle écrit `<path/>`). */
const dom = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.innerHTML;
};

describe('bouton son de l’aperçu : même rendu que sur la fiche', () => {
  it('muet : haut-parleur barré, « Activer le son » ; son actif : haut-parleur, « Couper le son »', () => {
    const btn = document.createElement('button');
    paintSound(btn, true);
    expect(btn.innerHTML).toBe(dom(ICON.mute));
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Activer le son');
    expect(btn.dataset.tip).toBe('Activer le son');
    paintSound(btn, false);
    expect(btn.innerHTML).toBe(dom(ICON.sound));
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Couper le son');
    expect(btn.textContent).not.toContain('Son');
  });
});

describe('aperçu muet : jamais de sous-titres à l’arrivée', () => {
  it('ni VF ni VO : cc_load_policy=0, pas de hl ni de cc_lang_pref', () => {
    for (const src of [ambientSrc('abc'), ambientSrc('abc', false)]) {
      expect(src).toContain('cc_load_policy=0');
      expect(src).not.toContain('cc_load_policy=1');
      expect(src).not.toContain('hl=');
      expect(src).not.toContain('cc_lang_pref');
    }
  });
});

/** Iframe factice : `postMessage` reçoit les commandes IFrame API, décodées ici. */
function fakeFrame() {
  const posted: Array<{ func: string; args: unknown[] }> = [];
  const postMessage = vi.fn((msg: string) => posted.push(JSON.parse(msg)));
  const iframe = document.createElement('iframe');
  Object.defineProperty(iframe, 'contentWindow', { value: { postMessage } });
  return { iframe, posted };
}

describe('son de l’aperçu : sous-titres seulement quand le son est activé', () => {
  beforeEach(() => localStorage.setItem('laststream.langprefs', JSON.stringify({ audio: 'fr' })));

  it('VF : le son ne touche jamais aux sous-titres', () => {
    const { iframe, posted } = fakeFrame();
    setPreviewSound(iframe, true, false);
    setPreviewSound(iframe, false, false);
    expect(posted.map((c) => c.func)).toEqual(['unMute', 'mute']);
  });

  it('VO : son activé → module sous-titres chargé, piste de la langue principale ; son coupé → module retiré', () => {
    const { iframe, posted } = fakeFrame();
    setPreviewSound(iframe, true, true);
    expect(posted).toEqual([
      { event: 'command', func: 'unMute', args: [] },
      { event: 'command', func: 'loadModule', args: ['captions'] },
      { event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'fr' }] },
    ]);
    posted.length = 0;
    setPreviewSound(iframe, false, true);
    expect(posted.map((c) => c.func)).toEqual(['mute', 'unloadModule']);
    expect(posted[1].args).toEqual(['captions']);
  });
});
