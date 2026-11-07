// Modale « Crédits » (ui/credits.js) : accessibilité, focus piégé et rendu, Échap, voile, et mêmes données que la liste d'origine.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { avatarCredits, LICENSE_URL } from '../src/data/avatars';
import { creditsHTML, creditsLinkHTML } from '../src/ui/credits.js';

const dialog = () => document.querySelector('.cr-layer [role="dialog"]') as HTMLElement | null;
const key = (el: Element, k: string, shiftKey = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

function mount() {
  document.body.innerHTML = '<footer><span id="x"></span></footer>';
  document.querySelector('footer')!.insertAdjacentHTML('beforeend', creditsLinkHTML());
  return document.querySelector('[data-credits]') as HTMLButtonElement;
}

afterEach(() => {
  const d = dialog();
  if (d) key(d, 'Escape');
  document.body.className = '';
});

describe('modale Crédits', () => {
  it('le lien ouvre une boîte de dialogue accessible et prend le focus', () => {
    const btn = mount();
    btn.focus();
    btn.click();
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(d.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(d.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('Crédits');
    expect(d.contains(document.activeElement)).toBe(true);
    expect(document.body.classList.contains('modal-open')).toBe(true);
  });

  it('Échap ferme et rend le focus au déclencheur', () => {
    const btn = mount();
    btn.focus();
    btn.click();
    key(dialog()!, 'Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(document.body.classList.contains('modal-open')).toBe(false);
  });

  it('le clic sur le voile et sur le bouton Fermer ferment', () => {
    const btn = mount();
    btn.click();
    (document.querySelector('.cr-scrim') as HTMLElement).click();
    expect(dialog()).toBeNull();
    btn.click();
    (document.querySelector('.cr-x') as HTMLElement).click();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('le focus est piégé (Tab / Maj+Tab bouclent dans la feuille)', () => {
    mount().click();
    const d = dialog()!;
    const items = Array.from(d.querySelectorAll<HTMLElement>('button, a[href]'));
    const first = items[0];
    const last = items[items.length - 1];
    last.focus();
    key(d, 'Tab');
    expect(document.activeElement).toBe(first);
    first.focus();
    key(d, 'Tab', true);
    expect(document.activeElement).toBe(last);
    d.focus();
    key(d, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('liste toutes les entrées avec leurs liens (auteur, œuvre, licence), les mentions finales et target/rel', () => {
    mount().click();
    const body = dialog()!.querySelector('.cr-body')!;
    const credits = avatarCredits();
    const lis = Array.from(body.querySelectorAll('li'));
    expect(lis).toHaveLength(credits.length);
    credits.forEach((c, i) => {
      expect(lis[i].textContent).toContain(c.creator);
      const hrefs = Array.from(lis[i].querySelectorAll('a')).map((a) => a.getAttribute('href'));
      c.styles.forEach((st) => expect(hrefs).toContain(st.source));
      expect(hrefs).toContain(LICENSE_URL[c.license]);
    });
    expect(body.textContent).toContain('Avatars « Héros » : dessins originaux laststream');
    expect(body.querySelector('p.av-credits:last-of-type')!.textContent).toContain('(MIT)');
    body.querySelectorAll('a').forEach((a) => {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    });
  });

  it('même source que le repli du sélecteur d’avatars (une seule fonction de rendu)', () => {
    mount().click();
    expect(dialog()!.querySelector('.cr-body')!.innerHTML).toContain(creditsHTML());
    const picker = fs.readFileSync(path.resolve(__dirname, '../src/ui/avatar-picker.js'), 'utf8');
    expect(picker).toContain("from './credits.js'");
    expect(picker).not.toContain('avatarCredits');
  });
});

describe('retrait de la carte du panneau Profil', () => {
  it('settings.js n’affiche plus « Crédits des avatars » et propose le lien Crédits', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/ui/settings.js'), 'utf8');
    expect(src).not.toContain('Crédits des avatars');
    expect(src).toContain('creditsLinkHTML()');
    const home = fs.readFileSync(path.resolve(__dirname, '../src/ui/home.js'), 'utf8');
    expect(home).toContain('creditsLinkHTML()');
  });
});
