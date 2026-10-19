import { beforeAll, describe, expect, it } from 'vitest';

// dom.js lit le squelette de l'application à l'import : on le pose avant de charger le module.
let ambientSrc: typeof import('../src/ui/preview.js').ambientSrc;
let paintSound: typeof import('../src/ui/preview.js').paintSound;
let ICON: typeof import('../src/ui/icons.js').ICON;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="toast"></div>'
    + '<div id="modal" hidden><div class="modal"><div id="modal-body"></div><button id="modal-close"></button></div></div>';
  ({ ambientSrc, paintSound } = await import('../src/ui/preview.js'));
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

describe('aperçu muet : sous-titres seulement pour une VO', () => {
  it('bande-annonce VF : pas de sous-titres imposés', () => {
    expect(ambientSrc('abc', false)).toContain('cc_load_policy=0');
    expect(ambientSrc('abc', false)).not.toContain('cc_load_policy=1');
    expect(ambientSrc('abc')).not.toContain('hl=');
  });
  it('bande-annonce VO : sous-titres de la langue principale, hl et cc_lang_pref', () => {
    const src = ambientSrc('abc', true);
    expect(src).toContain('cc_load_policy=1');
    expect(src).not.toContain('cc_load_policy=0');
    expect(src).toContain('hl=fr');
    expect(src).toContain('cc_lang_pref=fr');
  });
});
