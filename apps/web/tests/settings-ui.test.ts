// Page Réglages : navigation latérale, interrupteurs, panneau « Accueil et recommandations ».
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

function mockFetch(url: string): Response {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') return json({ services: {}, languages: { preferred: ['fr'], acceptVostfr: true }, sources: [] });
  return json({ error: 'not_found' }, 404);
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const page = () => document.querySelector('#detail .set-page') as HTMLElement;
const click = (el: Element | null) => (el as HTMLElement).click();
const scrolled: string[] = [];

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = function scroll(this: Element) { scrolled.push(this.id); };
  location.hash = '#/settings';
  await import('../src/main.js');
  await settle(900);
});

describe('navigation latérale', () => {
  it('liste les catégories et active la première', () => {
    const items = Array.from(page().querySelectorAll('[data-set-cat]')) as HTMLElement[];
    expect(items.map((i) => i.dataset.setCat)).toEqual(['account', 'appearance', 'region', 'playback', 'audio', 'home', 'server', 'sources']);
    expect(items.filter((i) => i.getAttribute('aria-current') === 'true').map((i) => i.dataset.setCat)).toEqual(['account']);
    expect(page().querySelector('#set-p-sources')).not.toBeNull();
  });

  it('un clic ancre le panneau et met la catégorie active à jour', () => {
    click(page().querySelector('[data-set-cat="playback"]'));
    expect(scrolled).toContain('set-p-playback');
    const cur = Array.from(page().querySelectorAll('[data-set-cat][aria-current="true"]')) as HTMLElement[];
    expect(cur.map((i) => i.dataset.setCat)).toEqual(['playback']);
    click(page().querySelector('[data-set-cat="home"]'));
    expect((page().querySelector('[data-set-cat="home"]') as HTMLElement).getAttribute('aria-current')).toBe('true');
    expect((page().querySelector('[data-set-cat="playback"]') as HTMLElement).getAttribute('aria-current')).toBe('false');
  });
});

describe('interrupteurs', () => {
  it('basculent aria-checked et écrivent la même préférence que l’ancien bouton', async () => {
    const { getAutoplay, getSkipPref } = await import('../src/data/prefs');
    const sw = page().querySelector('[data-set-pref="autoplay"]') as HTMLElement;
    expect(sw.getAttribute('role')).toBe('switch');
    const before = getAutoplay();
    expect(sw.getAttribute('aria-checked')).toBe(String(before));
    click(sw);
    expect(sw.getAttribute('aria-checked')).toBe(String(!before));
    expect(getAutoplay()).toBe(!before);
    click(sw);
    expect(getAutoplay()).toBe(before);

    const intro = page().querySelector('[data-set-pref="skip-intro"]') as HTMLElement;
    const introBefore = getSkipPref('intro');
    click(intro);
    expect(intro.getAttribute('aria-checked')).toBe(String(!introBefore));
    expect(getSkipPref('intro')).toBe(!introBefore);
  });

  it('un clic sur la ligne bascule l’interrupteur, et le formulaire lit aria-checked', () => {
    const row = page().querySelector('[data-sw-row] [data-set-pref="skip-recap"]')!.closest('[data-sw-row]') as HTMLElement;
    const sw = row.querySelector('[role="switch"]') as HTMLElement;
    const before = sw.getAttribute('aria-checked');
    click(row.querySelector('.set-row-t'));
    expect(sw.getAttribute('aria-checked')).toBe(before === 'true' ? 'false' : 'true');
  });
});

describe('Accueil et recommandations', () => {
  it('état vide sans bouton, puis une seule ligne « Titres masqués — N titres » avec « Gérer »', async () => {
    const home = page().querySelector('#set-p-home') as HTMLElement;
    const empty = home.querySelector('[data-home-hidden]') as HTMLElement;
    expect(empty.classList.contains('is-empty')).toBe(true);
    expect(empty.textContent).toBe('Aucun titre masqué');
    expect(home.querySelector('[data-hidden-nav]')).toBeNull();

    const { hideTitle, unhideTitles } = await import('../src/data/homeFilters');
    hideTitle({ key: 'movie:42', title: 'Le Grand Bleu', poster: '/abc.jpg' });
    hideTitle({ key: 'tv:7', title: 'Sans affiche', poster: '' });
    const { showSettings } = await import('../src/ui/settings.js');
    await showSettings();
    await settle(100);
    const h = page().querySelector('#set-p-home') as HTMLElement;
    expect(h.querySelector('.hm-item')).toBeNull(); // plus de liste dans les réglages
    const line = h.querySelector('[data-home-hidden]') as HTMLElement;
    expect(line.querySelector('.hm-line-t')!.textContent).toBe('Titres masqués — 2 titres');
    expect(h.querySelector('[data-hidden-count]')!.textContent).toBe('2 titres');
    const btn = h.querySelector('[data-hidden-nav]') as HTMLElement;
    expect(btn.textContent).toBe('Gérer');
    expect(btn.getAttribute('aria-label')).toBe('Gérer les titres masqués');

    expect(unhideTitles(['movie:42', 'tv:7'])).toHaveLength(2); // retour à l'état vide pour les tests suivants
    await showSettings();
    await settle(100);
    const again = page().querySelector('#set-p-home [data-home-hidden]') as HTMLElement;
    expect(again.classList.contains('is-empty')).toBe(true);
    expect(again.querySelector('[data-hidden-nav]')).toBeNull();
  });

  it('puces de genres, compteur et réinitialisation', async () => {
    const { bannedGenreIds } = await import('../src/data/homeFilters');
    const h = page().querySelector('#set-p-home') as HTMLElement;
    const chips = Array.from(h.querySelectorAll('[data-ban-genre]')) as HTMLElement[];
    expect(chips.length).toBe(24);
    expect(chips.every((c) => c.getAttribute('role') === 'checkbox' && c.getAttribute('aria-checked') === 'false')).toBe(true);
    const counter = h.querySelector('[data-genre-count]') as HTMLElement;
    const reset = h.querySelector('[data-genres-reset]') as HTMLButtonElement;
    expect(counter.textContent).toBe('Aucun genre exclu');
    expect(reset.disabled).toBe(true);

    click(chips[0]); // Action : deux identifiants TMDB, une seule puce
    click(chips[11]);
    expect(chips[0].getAttribute('aria-checked')).toBe('true');
    expect(bannedGenreIds().has(28) && bannedGenreIds().has(10759)).toBe(true);
    expect(counter.textContent).toBe('2 genres exclus');
    expect(reset.disabled).toBe(false);

    click(chips[11]);
    expect(counter.textContent).toBe('1 genre exclu');

    click(reset);
    expect(bannedGenreIds().size).toBe(0);
    expect(chips.every((c) => c.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(counter.textContent).toBe('Aucun genre exclu');
    expect(reset.disabled).toBe(true);
  });
});

describe('panneau « Audio et sous-titres »', () => {
  const sel = (pref: string) => page().querySelector('#set-p-audio [data-set-pref="' + pref + '"]') as HTMLSelectElement;
  const change = (el: HTMLSelectElement, value: string) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const stored = () => JSON.parse(localStorage.getItem('laststream.langprefs') || 'null');

  it('affiche les valeurs par défaut : français, version originale, sous-titres activés', () => {
    expect(page().querySelector('#set-p-audio')).not.toBeNull();
    expect(sel('lang-audio').value).toBe('fr');
    expect(sel('lang-audio2').value).toBe('vo');
    expect(sel('lang-subtitles').value).toBe('main');
    expect(sel('lang-subtitles').disabled).toBe(false);
    expect(sel('lang-learnlang').disabled).toBe(true);
    expect(Array.from(sel('lang-audio2').options).map((o) => o.textContent)).toEqual(expect.arrayContaining(['Version originale', 'Aucune', 'Anglais', 'Japonais', 'Espagnol', 'Allemand', 'Italien', 'Coréen']));
  });

  it('les listes s’enregistrent dans les réglages du profil', () => {
    change(sel('lang-audio'), 'en');
    change(sel('lang-audio2'), 'none');
    expect(stored()).toMatchObject({ audio: 'en', audio2: 'none' });
    change(sel('lang-audio'), 'fr');
    change(sel('lang-audio2'), 'vo');
  });

  it('l’interrupteur du mode apprentissage active la liste de la langue apprise', () => {
    const sw = page().querySelector('#set-p-audio [data-set-pref="lang-learn"]') as HTMLElement;
    click(sw);
    expect(stored().learn).toBe(true);
    expect(sel('lang-learnlang').disabled).toBe(false);
    change(sel('lang-learnlang'), 'ja');
    expect(stored().learnLang).toBe('ja');
    click(sw);
    expect(stored().learn).toBe(false);
    expect(sel('lang-learnlang').disabled).toBe(true);
  });

  it('l’interrupteur des sous-titres grise leur langue', () => {
    const sw = page().querySelector('#set-p-audio [data-set-pref="lang-subs"]') as HTMLElement;
    click(sw);
    expect(stored().subsOn).toBe(false);
    expect(sel('lang-subtitles').disabled).toBe(true);
    click(sw);
    expect(stored().subsOn).toBe(true);
    expect(sel('lang-subtitles').disabled).toBe(false);
  });
});
