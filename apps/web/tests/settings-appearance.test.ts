// Réglages > Apparence : cartes de thème (radiogroup), panneau « Personnalisé », contraste et correction.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { brightenForText, formatRatio, hexToHsl, hslToHex, textContrast } from '../src/data/color';
import { contrastRatio, onAccent, PRESETS, readTheme } from '../src/data/theme';
import { isServerMode } from '../src/data/auth';

function mockFetch(url: string): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') return json({ services: {}, languages: { preferred: ['fr'], acceptVostfr: true }, sources: [] });
  return json({ error: 'not_found' }, 404);
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const page = () => document.querySelector('#detail .set-page') as HTMLElement;
const radio = (id: string) => page().querySelector('.set-ap-th[data-set-theme="' + id + '"]') as HTMLElement;
const radios = () => Array.from(page().querySelectorAll('.set-ap-th')) as HTMLElement[];
const panel = () => page().querySelector('[data-set-ap-custom]') as HTMLElement;
const hexInput = () => page().querySelector('[data-set-ap-hex]') as HTMLInputElement;
const accentVar = () => document.documentElement.style.getPropertyValue('--accent');
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const typeHex = (v: string, commit = false) => {
  const el = hexInput();
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (commit) el.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  location.hash = '#/settings';
  await import('../src/main.js');
  await settle(900);
});

beforeEach(() => {
  // Point de départ commun : thème Laststream.
  if (radio('laststream').getAttribute('aria-checked') !== 'true') radio('laststream').click();
});

describe('couleurs : calculs', () => {
  it('HSL aller-retour sans dérive visible', () => {
    for (const hex of ['#ff5a36', '#7b5bf5', '#19c3a6', '#f5b700', '#808080', '#000000', '#ffffff']) {
      expect(hslToHex(hexToHsl(hex))).toBe(hex);
    }
  });

  it('contraste du texte réellement posé (onAccent) : toutes les palettes passent AA', () => {
    for (const p of PRESETS) expect(textContrast(p.accent)).toBeGreaterThanOrEqual(4.5);
    // Stremio : le texte sombre échoue (4,35), l'application passe au blanc (4,51).
    expect(contrastRatio('#7B5BF5', '#0c0b11')).toBeLessThan(4.5);
    expect(onAccent('#7B5BF5')).toBe('#ffffff');
    expect(formatRatio(textContrast('#7B5BF5'))).toBe('4,5');
  });

  it('éclaircir garde la teinte et atteint 4,5', () => {
    const base = '#d04a3a'; // ton moyen : ni le sombre (4,41) ni le blanc (4,45) n'atteignent 4,5
    expect(textContrast(base)).toBeLessThan(4.5);
    const fixed = brightenForText(base);
    expect(textContrast(fixed)).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(hexToHsl(fixed).h - hexToHsl(base).h)).toBeLessThan(3);
    expect(hexToHsl(fixed).l).toBeGreaterThan(hexToHsl(base).l);
    expect(brightenForText('#ff5a36')).toBe('#ff5a36');
  });
});

describe('cartes de thème', () => {
  it('radiogroup de 5 cartes, une seule cochée et tabulable', () => {
    const group = page().querySelector('.set-ap-grid') as HTMLElement;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(radios().map((r) => r.dataset.setTheme)).toEqual(['laststream', 'stremio', 'teal', 'amber', 'custom']);
    expect(radios().every((r) => r.getAttribute('role') === 'radio' && !r.hasAttribute('aria-pressed'))).toBe(true);
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.dataset.setTheme)).toEqual(['laststream']);
    expect(radios().filter((r) => r.tabIndex === 0).map((r) => r.dataset.setTheme)).toEqual(['laststream']);
    expect(page().querySelector('[data-set-color]')).toBeNull();
    expect(panel().hidden).toBe(true);
    expect(radio('stremio').style.getPropertyValue('--a-on')).toBe('#ffffff');
    expect(radio('teal').style.getPropertyValue('--a-on')).toBe('#0c0b11');
  });

  it('mention de synchronisation selon le mode (compte ou appareil)', () => {
    const d = page().querySelector('.set-ap-head .set-row-d')!.textContent;
    expect(d).toContain(isServerMode() ? 'Ton choix est gardé sur ton compte.' : 'Ton choix est gardé sur cet appareil.');
  });

  it('un clic choisit le thème et l’applique', () => {
    radio('teal').click();
    expect(readTheme()).toEqual({ id: 'teal', accent: '#19C3A6' });
    expect(accentVar()).toBe('#19C3A6');
    expect(radio('teal').getAttribute('aria-checked')).toBe('true');
    expect(radio('teal').tabIndex).toBe(0);
    expect(radio('laststream').tabIndex).toBe(-1);
    expect(panel().hidden).toBe(true);
  });

  it('flèches : droite, gauche en boucle, Début et Fin déplacent le focus et la sélection', () => {
    radio('laststream').focus();
    key(radio('laststream'), 'ArrowRight');
    expect(document.activeElement).toBe(radio('stremio'));
    expect(readTheme().id).toBe('stremio');
    key(radio('stremio'), 'ArrowLeft');
    key(radio('laststream'), 'ArrowLeft');
    expect(document.activeElement).toBe(radio('custom'));
    expect(readTheme().id).toBe('custom');
    expect(panel().hidden).toBe(false);
    key(radio('custom'), 'Home');
    expect(readTheme().id).toBe('laststream');
    key(radio('laststream'), 'End');
    expect(document.activeElement).toBe(radio('custom'));
  });
});

describe('panneau Personnalisé', () => {
  it('part de la couleur affichée et affiche le contraste', () => {
    radio('custom').click();
    (page().querySelector('[data-set-ap-reset]') as HTMLElement).click(); // oublie la couleur personnalisée de la session
    radio('amber').click();
    radio('custom').click();
    expect(readTheme()).toEqual({ id: 'custom', accent: '#f5b700' });
    expect(panel().hidden).toBe(false);
    expect(hexInput().value).toBe('#F5B700');
    expect(radio('custom').classList.contains('is-rainbow')).toBe(false);
    const ok = page().querySelector('[data-set-ap-ok]') as HTMLElement;
    expect(ok.getAttribute('role')).toBe('status');
    expect(ok.textContent).toBe('Texte bien lisible, contraste 10,8 sur 1, AA atteint');
  });

  it('revenir sur Personnalisé retrouve la dernière couleur choisie', () => {
    radio('custom').click();
    typeHex('#123456', true);
    radio('teal').click();
    expect(panel().hidden).toBe(true);
    radio('custom').click();
    expect(readTheme().accent).toBe('#123456');
    expect(hexInput().value).toBe('#123456');
  });

  it('code invalide : bordure d’erreur, rien d’appliqué ; code valide : appliqué', () => {
    radio('custom').click();
    const before = readTheme().accent;
    typeHex('#12zz');
    expect(hexInput().getAttribute('aria-invalid')).toBe('true');
    expect(readTheme().accent).toBe(before);
    typeHex('#12ab', true);
    expect(hexInput().getAttribute('aria-invalid')).toBe('true');
    expect(readTheme().accent).toBe(before);
    typeHex('19c3a6');
    expect(hexInput().getAttribute('aria-invalid')).toBe('false');
    expect(readTheme()).toEqual({ id: 'custom', accent: '#19c3a6' });
    expect(accentVar()).toBe('#19c3a6');
    expect((page().querySelector('[data-set-ap-hue]') as HTMLInputElement).value).toBe(String(Math.round(hexToHsl('#19c3a6').h)));
  });

  it('Stremio en personnalisé : texte blanc dans l’aperçu, contraste annoncé sans alerte', () => {
    radio('custom').click();
    typeHex('#7b5bf5');
    expect(panel().style.getPropertyValue('--a-on')).toBe('#ffffff');
    expect(radio('custom').style.getPropertyValue('--a-on')).toBe('#ffffff');
    expect((page().querySelector('[data-set-ap-ok]') as HTMLElement).textContent).toBe('Texte bien lisible, contraste 4,5 sur 1, AA atteint');
    expect((page().querySelector('[data-set-ap-warn]') as HTMLElement).textContent).toBe('');
  });

  it('couleur trop sombre : alerte non bloquante et bouton Éclaircir qui corrige', () => {
    radio('custom').click();
    typeHex('#d04a3a');
    expect(readTheme().accent).toBe('#d04a3a');
    const warn = page().querySelector('[data-set-ap-warn]') as HTMLElement;
    expect(warn.getAttribute('role')).toBe('alert');
    expect(warn.textContent).toBe('Le texte sera difficile à lire');
    const fix = page().querySelector('[data-set-ap-fix]') as HTMLButtonElement;
    const target = brightenForText('#d04a3a');
    expect(fix.hidden).toBe(false);
    expect(fix.textContent).toBe('Éclaircir (' + target.toUpperCase() + ')');
    fix.click();
    expect(readTheme().accent).toBe(target);
    expect(fix.hidden).toBe(true);
    expect(warn.textContent).toBe('');
    expect((page().querySelector('[data-set-ap-ok]') as HTMLElement).textContent).toMatch(/AA atteint$/);
  });

  it('curseur de luminosité : aperçu en direct', async () => {
    radio('custom').click();
    typeHex('#ff5a36');
    const light = page().querySelector('[data-set-ap-light]') as HTMLInputElement;
    light.value = '80';
    light.dispatchEvent(new Event('input', { bubbles: true }));
    light.dispatchEvent(new Event('change', { bubbles: true }));
    const { l, h } = hexToHsl(readTheme().accent);
    expect(Math.round(l * 100)).toBe(80);
    expect(Math.abs(h - hexToHsl('#ff5a36').h)).toBeLessThan(2);
    expect(hexInput().value).toBe(readTheme().accent.toUpperCase());
  });

  it('Réinitialiser revient au thème Laststream', () => {
    radio('custom').click();
    typeHex('#123456');
    (page().querySelector('[data-set-ap-reset]') as HTMLElement).click();
    expect(readTheme()).toEqual({ id: 'laststream', accent: '#FF5A36' });
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(radio('laststream'));
    expect(radio('custom').classList.contains('is-rainbow')).toBe(true);
    radio('custom').click();
    expect(readTheme().accent).toBe('#ff5a36');
  });
});

describe('télécommande dans le panneau Personnalisé', () => {
  // jsdom ne calcule pas de mise en page : chaque élément reçoit une boîte pour la navigation spatiale.
  const rects = () => vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function stub(this: Element) {
    return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList;
  });

  it('code et curseurs sont atteignables (data-nav, tabindex 0)', () => {
    radio('custom').click();
    for (const sel of ['[data-set-ap-hex]', '[data-set-ap-hue]', '[data-set-ap-light]']) {
      const el = page().querySelector(sel) as HTMLElement;
      expect(el.getAttribute('tabindex')).toBe('0');
      expect(el.closest('[data-nav]')).not.toBeNull();
    }
    expect(page().querySelector('[data-set-ap-reset]')!.closest('[data-nav]')).toBe(page().querySelector('[data-set-ap-hex]')!.closest('[data-nav]'));
  });

  it('Bas sur un curseur passe à la ligne suivante sans changer sa valeur, Haut sur le code remonte aux cartes', () => {
    const spy = rects();
    try {
      radio('custom').click();
      typeHex('#ff5a36');
      const hue = page().querySelector('[data-set-ap-hue]') as HTMLInputElement;
      const light = page().querySelector('[data-set-ap-light]') as HTMLInputElement;
      const before = hue.value;
      hue.focus();
      const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      hue.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(light);
      expect(hue.value).toBe(before);
      key(light, 'ArrowUp');
      expect(document.activeElement).toBe(hue);
      hexInput().focus();
      key(hexInput(), 'ArrowUp');
      expect(document.activeElement).toBe(radio('custom'));
      // Gauche et Droite restent au champ (rôle natif).
      hue.focus();
      const lr = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      hue.dispatchEvent(lr);
      expect(lr.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(hue);
    } finally {
      spy.mockRestore();
    }
  });
});
