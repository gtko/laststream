// Barre du haut de l'accueil : liens, menu Explorer, menu du profil, clavier (flèches, Échap, focus), défilement, profil enfant.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth } from '../src/data/auth';
import { userStore } from '../src/data/userStore';

// Les modules d'interface lisent le gabarit de index.html à l'import : on le charge avant.
let headerA: () => string;
let headerKids: () => string;
let syncTopbar: () => void;
let mainNavHTML: (opts?: { current?: string; idSuffix?: string; social?: boolean }) => string;
beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ({ headerA } = await import('../src/ui/home.js'));
  ({ headerKids } = await import('../src/ui/kids.js'));
  ({ syncTopbar, mainNavHTML } = await import('../src/ui/topnav.js'));
});

const $ =<T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const labels = (sel: string) => $$(sel).map((el) => (el.textContent ?? '').trim());

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true, createdAt: '2026-01-01T00:00:00Z' };
const KID = { id: 'k1', name: 'Léo', avatarColor: '#19c3a6', isKid: true, kidMaxAge: 10, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' };

/** Session serveur simulée : profil actif et indicateur propriétaire. Sans profil : mode local. */
function setAccount(profile: typeof ADULT | typeof KID | null, owner = false): void {
  auth.status = profile ? 'ready' : 'local';
  auth.profile = profile as unknown as typeof auth.profile;
  auth.isOwner = owner;
}

function mount(html: string): void {
  document.body.innerHTML = '<div id="app" class="s-a">' + html + '</div>';
}

const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
const click = (el: Element, detail = 1) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));

beforeEach(() => {
  mount(headerA());
});

afterEach(() => {
  setAccount(null);
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

describe('barre du haut : liens', () => {
  it('menu principal : Séries, Films, Direct, Émissions TV, Documentaires (le logo ramène à l’accueil)', () => {
    expect(labels('.topbar .nav > a')).toEqual(['Séries', 'Films', 'Direct', 'Émissions TV', 'Documentaires']);
    expect($$('.topbar .nav > a').map((a) => a.getAttribute('href'))).toEqual(['#/series', '#/films', '#/tv-live', '#/emissions', '#/documentaires']);
    expect($('.topbar .nav > a.is-current')).toBeNull(); // accueil : aucune entrée active
    expect($('.brand').getAttribute('href')).toBe('#/');
  });

  it('menu Explorer : Ma liste, Collections, Découvrir, Calendrier ; plus de Services', () => {
    const items = labels('#nav-explore .nav-pop-list:not(.nav-pop-compact) a');
    expect(items).toEqual(['Ma liste', 'Collections', 'Découvrir', 'Calendrier']);
    expect(items).not.toContain('Services');
    expect($$('#nav-explore .nav-pop-list:not(.nav-pop-compact) svg')).toHaveLength(4);
    expect($('#nav-explore [href="#/services"]')).toBeNull();
  });

  it('les cinq entrées principales restent accessibles dans Explorer pour les écrans étroits', () => {
    expect(labels('#nav-explore .nav-pop-compact a')).toEqual(['Séries', 'Films', 'Direct', 'Émissions TV', 'Documentaires']);
    expect($$('.nav-wide')).toHaveLength(5);
  });

  it('la page affichée est marquée (aria-current) dans la barre et dans Explorer', () => {
    mount('<header class="topbar"><nav class="nav">' + mainNavHTML({ current: 'films' }) + '</nav></header>');
    expect(labels('.nav > a.is-current')).toEqual(['Films']);
    expect($('.nav > a.is-current').getAttribute('aria-current')).toBe('page');
    expect(labels('.nav-pop-compact a[aria-current="page"]')).toEqual(['Films']);
  });

  it('Ensemble (point d’accent) seulement pour un compte connecté hors profil enfant, après Documentaires et avant Explorer ; plus de lien Watch parties', () => {
    expect($('.nav-ens')).toBeNull();
    expect($('.nav-party')).toBeNull();
    setAccount(ADULT);
    mount(headerA());
    expect(labels('.topbar .nav > a')).toEqual(['Séries', 'Films', 'Direct', 'Émissions TV', 'Documentaires', 'Ensemble']);
    expect($('.nav-ens').getAttribute('href')).toBe('#/ensemble');
    expect($('.nav-ens .nav-dot')).not.toBeNull();
    expect($('.nav-ens').nextElementSibling!.classList.contains('nav-drop')).toBe(true); // Explorer vient juste après
    expect($('.nav-party')).toBeNull();
    expect($('.top-actions [href="#/parties"]')).toBeNull();
    expect(labels('#nav-explore .nav-pop-compact a')).toContain('Ensemble');
  });

  it('sur la page Ensemble, l’entrée est marquée (aria-current) dans la barre et dans Explorer', () => {
    mount('<header class="topbar"><nav class="nav">' + mainNavHTML({ current: 'ensemble', social: true }) + '</nav></header>');
    expect(labels('.nav > a.is-current')).toEqual(['Ensemble']);
    expect($('.nav-ens').getAttribute('aria-current')).toBe('page');
    expect(labels('.nav-pop-compact a[aria-current="page"]')).toEqual(['Ensemble']);
  });
});

describe('menu Explorer : accessibilité', () => {
  it('le bouton annonce son état (aria-expanded, aria-controls) et s’ouvre au clic', () => {
    const trigger = $('.nav-drop-btn');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe('nav-explore');
    expect($('#nav-explore').hidden).toBe(true);
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect($('#nav-explore').hidden).toBe(false);
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect($('#nav-explore').hidden).toBe(true);
  });

  it('Échap referme le menu et rend le focus au bouton', () => {
    const trigger = $('.nav-drop-btn');
    click(trigger, 0); // ouverture au clavier : le focus entre dans le menu (accès rapide en tête, en écran étroit)
    expect(document.activeElement).toBe($('#nav-explore .nav-pop-compact a'));
    press(document.activeElement!, 'Escape');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect($('#nav-explore').hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('les flèches parcourent les entrées ; flèche bas sur le bouton ouvre le menu', () => {
    const trigger = $('.nav-drop-btn');
    // Ordre affiché (sans CSS en jsdom) : les cinq entrées du menu principal en tête, puis Ma liste, Collections, Découvrir, Calendrier.
    trigger.focus();
    press(trigger, 'ArrowDown');
    expect($('#nav-explore').hidden).toBe(false);
    expect(document.activeElement!.textContent).toContain('Séries');
    press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement!.textContent).toContain('Films');
    press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement!.textContent).toContain('Direct');
    press(document.activeElement!, 'ArrowUp');
    expect(document.activeElement!.textContent).toContain('Films');
    press(document.activeElement!, 'ArrowUp');
    press(document.activeElement!, 'ArrowUp'); // boucle : au-delà de la première entrée, on revient à la dernière
    expect(document.activeElement!.textContent).toContain('Calendrier');
  });

  it('un clic hors du menu le referme ; le focus qui quitte le menu le referme aussi', () => {
    const trigger = $('.nav-drop-btn');
    click(trigger);
    document.body.click();
    expect($('#nav-explore').hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    click(trigger);
    trigger.focus();
    trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: $('.brand') }));
    expect($('#nav-explore').hidden).toBe(true);
  });

  it('ouvrir un menu ferme l’autre', () => {
    setAccount(ADULT);
    mount(headerA());
    click($('.nav-drop-btn'));
    click($('.nav-avatar'));
    expect($('#nav-explore').hidden).toBe(true);
    expect($('#nav-profile').hidden).toBe(false);
  });
});

describe('menu du profil', () => {
  it('compte propriétaire : Administration visible, avec Statistiques et Réglages ; Amis est un bouton de la barre du haut', () => {
    setAccount(ADULT, true);
    mount(headerA());
    const items = labels('#nav-profile a, #nav-profile button');
    expect(items).toEqual(expect.arrayContaining(['Statistiques', 'Réglages', 'Administration', 'Changer de profil', 'Se déconnecter']));
    expect(items).not.toContain('Amis');
    expect($('.top-actions [data-soc-open]')).not.toBeNull();
    expect($('#nav-profile').textContent).toContain(userStore.currentProfile().name);
  });

  it('compte propriétaire mais autre profil adulte (conjoint) : pas d’Administration', () => {
    setAccount({ ...ADULT, id: 'p2', name: 'Jessica', isAdminProfile: false }, true);
    mount(headerA());
    expect(labels('#nav-profile a, #nav-profile button')).not.toContain('Administration');
  });

  it('compte non propriétaire : pas d’Administration', () => {
    setAccount(ADULT, false);
    mount(headerA());
    expect(labels('#nav-profile a, #nav-profile button')).not.toContain('Administration');
  });

  it('mode local : pas de changement de profil ni de déconnexion, pas d’Amis', () => {
    const items = labels('#nav-profile a, #nav-profile button');
    expect(items).toEqual(['Statistiques', 'Réglages']);
    expect(items).not.toContain('Administration');
  });

  it('s’ouvre à l’avatar et porte le nom du profil dans son libellé', () => {
    const avatar = $('.nav-avatar');
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
    click(avatar);
    expect(avatar.getAttribute('aria-expanded')).toBe('true');
    expect($('#nav-profile').hidden).toBe(false);
    expect(avatar.getAttribute('aria-label')).toContain('Profil');
  });
});

describe('profil enfant', () => {
  it('barre enfant : pas d’Amis, d’Ensemble, d’Administration ni de Statistiques ; seulement Changer de profil', () => {
    setAccount(KID, true);
    mount(headerKids());
    expect($('.topbar .nav > a.is-current').textContent).toBe('Accueil');
    expect($('.nav-ens')).toBeNull();
    expect($('.nav-drop-btn')).toBeNull(); // pas de menu Explorer pour un enfant
    expect(labels('#nav-profile a, #nav-profile button')).toEqual(['Changer de profil']);
    expect($('#nav-profile .nav-pop-sub')!.textContent).toBe('Profil enfant');
  });

  it('le profil enfant ne voit pas les liens d’adulte (Collections, Découvrir, Calendrier)', () => {
    setAccount(KID);
    mount(headerKids());
    const text = $('.topbar').textContent ?? '';
    expect(text).not.toContain('Découvrir');
    expect(text).not.toContain('Calendrier');
    expect(text).not.toContain('Collections');
    expect(text).not.toContain('Documentaires');
  });
});

describe('défilement', () => {
  it('la barre devient opaque (is-scrolled) dès qu’on quitte le haut de page', () => {
    const bar = $('.topbar');
    expect(bar.classList.contains('is-scrolled')).toBe(false);
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(bar.classList.contains('is-scrolled')).toBe(true);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    syncTopbar();
    expect(bar.classList.contains('is-scrolled')).toBe(false);
  });
});
