// Fiche titre : « Ne plus proposer sur l'accueil » est rangé derrière le menu « … » (ODY-182).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

let ctx: typeof import('../src/ui/ctxmenu.js');
let stateMod: typeof import('../src/ui/state.js');
let homeFilters: typeof import('../src/data/homeFilters');
let icons: typeof import('../src/ui/icons.js');
let busy: typeof import('../src/ui/busy.js');

const MODEL = { key: 'movie:77', name: 'Alien', posterPath: '/a.jpg' };

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ctx = await import('../src/ui/ctxmenu.js');
  stateMod = await import('../src/ui/state.js');
  homeFilters = await import('../src/data/homeFilters');
  icons = await import('../src/ui/icons.js');
  busy = await import('../src/ui/busy.js');
  await import('../src/ui/events.js');
});

afterEach(() => {
  ctx.closeCtx(false);
  busy.resetBusy(); // le verrou des actions du menu (ODY-257) ne doit pas passer d'un test à l'autre
  document.getElementById('fiche-test')?.remove();
  homeFilters.unhideTitles(['movie:77']);
  (stateMod.state as any).model = null;
});

/** Bouton « … » tel que la fiche le rend : data-fiche-more, replié. */
function moreButton(): HTMLButtonElement {
  document.getElementById('fiche-test')?.remove();
  document.body.insertAdjacentHTML('beforeend', '<div id="fiche-test" class="f-actions"><button type="button" class="btn-round f-more" data-fiche-more aria-haspopup="menu" aria-expanded="false">…</button></div>');
  (stateMod.state as any).model = MODEL;
  return document.querySelector('[data-fiche-more]') as HTMLButtonElement;
}

const menu = () => document.querySelector('.ctxmenu') as HTMLElement | null;
const hideItem = () => menu()?.querySelector('[data-ctx="hide"]') as HTMLButtonElement | null;

describe('fiche : menu « … »', () => {
  it('l’icône « … » existe pour la barre d’actions', () => {
    expect(icons.ICON.dots).toContain('<circle');
  });

  it('le clic ouvre un menu avec « Ne plus proposer sur l’accueil », le bouton reflète l’état', () => {
    const btn = moreButton();
    btn.click();
    expect(menu()).not.toBeNull();
    expect(hideItem()?.textContent).toBe('Ne plus proposer sur l’accueil');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.classList.contains('is-open')).toBe(true);
  });

  it('l’entrée masque le titre et referme le menu', () => {
    const btn = moreButton();
    btn.click();
    hideItem()!.click();
    expect(homeFilters.isHiddenKey('movie:77')).toBe(true);
    expect(menu()).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('titre déjà masqué : l’entrée devient « Proposer à nouveau » et le réaffiche', () => {
    homeFilters.hideTitle({ key: 'movie:77', title: 'Alien', poster: '' });
    const btn = moreButton();
    btn.click();
    expect(hideItem()?.textContent).toBe('Proposer à nouveau sur l’accueil');
    hideItem()!.click();
    expect(homeFilters.isHiddenKey('movie:77')).toBe(false);
  });

  it('second appui sur « … » referme le menu (ODY-217)', () => {
    const btn = moreButton();
    btn.click();
    btn.click();
    expect(menu()).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.classList.contains('is-open')).toBe(false);
  });

  it('Échap referme le menu et rend le focus au bouton « … »', () => {
    const btn = moreButton();
    btn.focus();
    btn.click();
    expect(document.activeElement).toBe(hideItem());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
});
