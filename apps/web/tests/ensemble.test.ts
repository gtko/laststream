// Page Ensemble (LAST-196) : route et sous-onglets, redirection de #/parties, barre du bas mobile, coque de la page.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';

let parseRoute: () => any;
let route: () => void;
let tabbar: (current?: string) => string;
let showEnsemble: (tab?: string) => void;
let roomHashOfCode: (raw: string) => string;
let paintSocialBadges: (s?: any) => void;

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [], isAdminProfile: true, createdAt: '2026-01-01T00:00:00Z' };
const KID = { id: 'k1', name: 'Léo', avatarColor: '#19c3a6', isKid: true, kidMaxAge: 10, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' };

/** Session simulée : profil actif ; sans profil, mode local. */
function setAccount(profile: typeof ADULT | typeof KID | null): void {
  auth.status = profile ? 'ready' : 'local';
  auth.profile = profile as unknown as typeof auth.profile;
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const labels = (sel: string) => $$(sel).map((el) => (el.textContent ?? '').trim());
const hash = (h: string) => { location.hash = h; return parseRoute(); };
const detail = () => document.getElementById('detail')!;
/** Fragment hors de #detail (la page Ensemble s'y affiche). */
function scratch(html: string): void {
  document.getElementById('scratch')?.remove();
  document.body.insertAdjacentHTML('beforeend', '<div id="scratch">' + html + '</div>');
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ({ parseRoute, route } = await import('../src/ui/router.js'));
  ({ tabbar } = await import('../src/ui/home.js'));
  ({ showEnsemble, roomHashOfCode } = await import('../src/ui/ensemble.js'));
  ({ paintSocialBadges } = await import('../src/ui/socialButton.js'));
});

beforeEach(() => {
  setAccount(ADULT);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rooms: [], nextCursor: null }), { status: 200 })));
});

afterEach(() => {
  setAccount(null);
  location.hash = '';
  vi.unstubAllGlobals();
});

describe('route #/ensemble', () => {
  it('#/ensemble ouvre « Maintenant » ; un sous-onglet se donne dans l’adresse', () => {
    expect(hash('#/ensemble')).toEqual({ kind: 'ensemble', tab: 'maintenant' });
    expect(hash('#/ensemble/ce-soir')).toEqual({ kind: 'ensemble', tab: 'ce-soir' });
    expect(hash('#/ensemble/a-venir')).toMatchObject({ kind: 'ensemble', tab: 'a-venir' });
    expect(hash('#/ensemble/salons-publics')).toMatchObject({ kind: 'ensemble', tab: 'salons-publics' });
    expect(hash('#/ensemble/passees')).toMatchObject({ kind: 'ensemble', tab: 'passees' });
  });

  it('onglet inconnu : pas une route', () => {
    expect(hash('#/ensemble/inconnu')).toBeNull();
  });

  it('#/parties redirige vers #/ensemble', () => {
    expect(hash('#/parties')).toMatchObject({ kind: 'ensemble', redirect: '#/ensemble' });
    route();
    expect(location.hash).toBe('#/ensemble');
  });

  it('route() sur #/parties : location.replace(#/ensemble), aucune affectation de hash (pas d’entrée d’historique)', () => {
    const assigned: string[] = [];
    const replace = vi.fn();
    vi.stubGlobal('location', {
      pathname: '/',
      search: '',
      replace,
      get hash() { return '#/parties'; },
      set hash(v: string) { assigned.push(v); },
    });
    route();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('#/ensemble');
    expect(assigned).toEqual([]);
  });

  it('#/party/<id> et le lien d’invitation ne changent pas', () => {
    expect(hash('#/party/abc_123')).toEqual({ kind: 'party', id: 'abc_123' });
    expect(hash('#/party/join/room1?t=abcdefghijkl')).toMatchObject({ kind: 'partyjoin', id: 'room1' });
  });

  it('profil enfant : ni #/ensemble ni #/parties (retour à l’accueil)', () => {
    setAccount(KID);
    for (const h of ['#/ensemble', '#/ensemble/ce-soir', '#/parties']) expect(hash(h)).toBeNull();
  });
});

describe('barre du bas (mobile)', () => {
  it('compte connecté : Accueil, Rechercher, Ensemble, Ma liste, Téléchargés ; plus d’onglet Amis', () => {
    scratch(tabbar());
    expect(labels('.tabbar .tab-label')).toEqual(['Accueil', 'Rechercher', 'Ensemble', 'Ma liste', 'Téléchargés']);
    expect($('.tabbar [data-soc-open]')).toBeNull();
    expect($('.tabbar a[href="#/ensemble"]')).not.toBeNull();
    expect($('.tab.is-current .tab-label').textContent).toBe('Accueil');
  });

  it('sur la page Ensemble, l’onglet Ensemble est actif', () => {
    scratch(tabbar('ensemble'));
    expect($$('.tab.is-current .tab-label').map((t) => t.textContent)).toEqual(['Ensemble']);
    expect($('.tab.is-current').getAttribute('aria-current')).toBe('page');
  });

  it('la pastille de l’onglet suit le compte du store social (masquée à zéro)', () => {
    scratch(tabbar());
    const badge = $('.tabbar [data-ens-badge]');
    expect(badge.hidden).toBe(true);
    paintSocialBadges({ badge: 3 });
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('3');
    paintSocialBadges({ badge: 120 });
    expect(badge.textContent).toBe('99+');
    paintSocialBadges({ badge: 0 });
    expect(badge.hidden).toBe(true);
  });

  it('sans compte connecté : barre d’origine, sans Ensemble', () => {
    setAccount(null);
    scratch(tabbar());
    expect($('.tabbar a[href="#/ensemble"]')).toBeNull();
  });

  it('onglet Accueil : lien ordinaire (#/) hors de l’accueil, inerte sur l’accueil', () => {
    scratch(tabbar('ensemble'));
    const homeFromEnsemble = $('.tabbar a[href="#/"]');
    expect(homeFromEnsemble.hasAttribute('data-noop')).toBe(false);
    expect(homeFromEnsemble.hasAttribute('data-go')).toBe(true);
    expect(homeFromEnsemble.hasAttribute('aria-current')).toBe(false);
    scratch(tabbar('home'));
    const homeOnHome = $('.tabbar a[href="#/"]');
    expect(homeOnHome.hasAttribute('data-noop')).toBe(true);
    expect(homeOnHome.hasAttribute('data-go')).toBe(false);
    expect(homeOnHome.getAttribute('aria-current')).toBe('page');
  });
});

describe('page Ensemble', () => {
  const mountPage = async (tab?: string) => {
    detail().innerHTML = '';
    showEnsemble(tab);
    await new Promise((r) => setTimeout(r, 30));
  };

  it('en-tête, boutons et cinq onglets pilules ; « Maintenant » est actif par défaut', async () => {
    await mountPage();
    const d = detail();
    expect(d.querySelector('h1')!.textContent).toBe('Ensemble');
    expect(d.querySelector('.ens-sub')!.textContent).toContain('à plusieurs');
    expect(Array.from(d.querySelectorAll('.ens-acts .btn')).map((b) => b.textContent)).toEqual(['Amis', 'Rejoindre avec un code', 'Créer un salon']);
    expect(d.querySelector('.ens-acts a[href="#/friends"]')).not.toBeNull();
    expect(Array.from(d.querySelectorAll('.ens-tabs a')).map((a) => a.textContent)).toEqual(['Maintenant', 'Ce soir', 'À venir', 'Salons publics', 'Passées']);
    expect(Array.from(d.querySelectorAll('.ens-tabs a[aria-current="page"]')).map((a) => a.textContent)).toEqual(['Maintenant']);
    expect(d.querySelector('.ens-tabs a[href="#/ensemble/ce-soir"]')).not.toBeNull();
    expect(d.querySelector('.ens-root .tabbar')).not.toBeNull();
    expect(d.querySelector('.topbar .nav-ens.is-current')).not.toBeNull();
  });

  it('« Maintenant » réutilise la liste des salons ouverts (filtres et liste)', async () => {
    await mountPage('maintenant');
    expect(detail().querySelector('#wp-list')).not.toBeNull();
    expect(detail().querySelector('[data-wp-lang=""]')).not.toBeNull();
  });

  it.each([['ce-soir', 'Ce soir'], ['a-venir', 'À venir'], ['salons-publics', 'Salons publics'], ['passees', 'Passées']])('onglet %s : état vide, aucune donnée inventée', async (id, label) => {
    await mountPage(id);
    const d = detail();
    expect(d.querySelector('.ens-empty')).not.toBeNull();
    expect(d.querySelector('#wp-list')).toBeNull();
    expect(d.querySelector('.ens-tabs a[aria-current="page"]')!.textContent).toBe(label);
  });

  it('« Rejoindre avec un code » ouvre la saisie ; un identifiant reconnu mène à la page du salon', async () => {
    await mountPage();
    const d = detail();
    const form = d.querySelector<HTMLFormElement>('[data-ens-join-form]')!;
    const btn = d.querySelector<HTMLButtonElement>('[data-ens-join]')!;
    expect(form.hidden).toBe(true);
    btn.click();
    expect(form.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const input = form.querySelector('input')!;
    input.value = '???';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(form.querySelector('[data-ens-join-msg]')!.textContent).toContain('non reconnu');
    input.value = 'room_42';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(location.hash).toBe('#/party/room_42');
  });

  it('code non reconnu : champ invalide, décrit par le message, focus rendu ; saisie corrigée, la marque tombe', async () => {
    detail().hidden = false; // zone de détail affichée, comme le fait route() (index.html la masque au départ)
    await mountPage();
    const d = detail();
    const form = d.querySelector<HTMLFormElement>('[data-ens-join-form]')!;
    d.querySelector<HTMLButtonElement>('[data-ens-join]')!.click();
    const input = form.querySelector<HTMLInputElement>('input')!;
    input.value = '???';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const msgId = input.getAttribute('aria-describedby')!;
    expect(msgId).toBeTruthy();
    expect(document.querySelectorAll(`[id="${msgId}"]`)).toHaveLength(1);
    expect(document.getElementById(msgId)!.textContent).toContain('non reconnu');
    expect(document.activeElement).toBe(input);
    input.value = 'room_42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(document.getElementById(msgId)!.textContent).toBe('');
  });

  it('pastille « Amis » de l’en-tête : suit le compte du store, comme celle de l’onglet Ensemble', async () => {
    await mountPage();
    const friendsBadge = detail().querySelector<HTMLElement>('.ens-acts a[href="#/friends"] [data-ens-badge]')!;
    expect(friendsBadge).not.toBeNull();
    expect(friendsBadge.hidden).toBe(true);
    paintSocialBadges({ badge: 2 });
    expect(friendsBadge.hidden).toBe(false);
    expect(friendsBadge.textContent).toBe('2');
    paintSocialBadges({ badge: 0 });
    expect(friendsBadge.hidden).toBe(true);
  });

  it('roomHashOfCode : identifiant, lien d’invitation (avec ou sans jeton), refus du reste', () => {
    expect(roomHashOfCode(' abc-12_X ')).toBe('#/party/abc-12_X');
    expect(roomHashOfCode('https://laststream.app/#/party/abc')).toBe('#/party/abc');
    expect(roomHashOfCode('https://laststream.app/#/party/join/abc?t=abcdefghijkl')).toBe('#/party/join/abc?t=abcdefghijkl');
    expect(roomHashOfCode('https://laststream.app/#/settings')).toBe('');
    expect(roomHashOfCode('a b')).toBe('');
    expect(roomHashOfCode('')).toBe('');
  });

  it('profil enfant : message à la place de la page (le routeur la refuse déjà)', async () => {
    setAccount(KID);
    await mountPage();
    expect(detail().textContent).toContain('pas disponibles sur un profil enfant');
    expect(detail().querySelector('.ens-tabs')).toBeNull();
  });
});
