// @vitest-environment jsdom
/**
 * Édition d'un profil en page plein écran (ODY-142) : ouverture, état modifié et Enregistrer, Échap et confirmation de
 * sortie, création sans nom, code en 4 cases, suppression confirmée par la saisie du nom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_STORAGE_KEY, reloadSettings } from '../src/data/config';
import { reloadSession } from '../src/data/session';
import type { Profile } from '../src/data/userStore';

const BASE = 'http://srv.test';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const profile = (id: string, extra: Partial<Profile> = {}): Profile =>
  ({ id, name: id, avatarColor: '#ff5a36', isKid: false, kidMaxAge: 12, hasPin: false, allowedCatalogs: [], isMainProfile: false, ...extra }) as Profile;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

let calls: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'X' }));
  reloadSettings();
  reloadSession();
  calls = [];
  document.querySelectorAll('.pfe-page, .pin-back, .as-overlay').forEach((n) => n.remove());
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url).replace(BASE, '');
    const method = init?.method || 'GET';
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && u === '/user/profiles') return json({ profiles: [] });
    if (u.endsWith('/unlock')) return json({ token: 'tok', expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (u.startsWith('/user/profiles')) return json({ id: 'x' }, method === 'POST' ? 201 : 200);
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => {
  (await import('../src/ui/auth-ui.js')).hidePad();
  // Ferme la page restée ouverte (confirmations comprises) pour ne pas laisser d'écouteur clavier.
  for (let i = 0; i < 3 && $('.pfe-page'); i++) {
    $<HTMLElement>('[data-pfe-leave]')?.click();
    $<HTMLElement>('[data-pfe-delcancel]')?.click();
    $<HTMLElement>('[data-pfe-cancel]')?.click();
    $<HTMLElement>('[data-pfe-leave]')?.click();
  }
  vi.unstubAllGlobals();
});

async function openEditor(p: Profile | null) {
  const a = await import('../src/data/auth');
  const ui = await import('../src/ui/auth-ui.js');
  const main = profile('gtko', { name: 'Greg', isMainProfile: true });
  a.auth.profiles = [main, ...(p && p.id !== main.id ? [p] : [])];
  a.auth.profile = a.auth.profiles[0];
  a.auth.status = 'ready';
  a.auth.locked = false;
  ui.openPicker();
  $<HTMLElement>('[data-pf-manage]')!.click();
  if (p) $<HTMLElement>(`[data-pf="${p.id}"]`)!.click();
  else $<HTMLElement>('[data-pf-add]')!.click();
  await tick();
  // Profil avec code : le clavier PIN passe d'abord.
  if ($('.pin-keys')) {
    for (const d of '1234') $<HTMLElement>('[data-pin-key="' + d + '"]')!.click();
    await tick();
  }
  return $<HTMLFormElement>('.pf-editor')!;
}

const nameInput = () => $<HTMLInputElement>('input[name="name"]')!;
const saves = () => $$<HTMLButtonElement>('[data-pfe-save]');
const typeName = (v: string) => { nameInput().value = v; nameInput().dispatchEvent(new Event('input', { bubbles: true })); };
const esc = () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const dirtyShown = () => $$('[data-pfe-dirty]').every((d) => !d.hidden);

describe('page d’édition : ouverture', () => {
  it('s’ouvre en page plein écran (plus de modal), titre, focus sur le nom, aperçu en direct', async () => {
    await openEditor(profile('ana', { name: 'Ana', avatarColor: '#19c3a6' }));
    expect($('.pfe-page')).not.toBeNull();
    expect($('.pf-editor')!.getAttribute('role')).toBeNull();
    expect($('#pfe-title')!.textContent).toBe('Modifier le profil');
    expect(document.activeElement).toBe(nameInput());
    expect($('[data-pfe-hero-name]')!.textContent).toBe('Ana');
    expect($('[data-pfe-hero] .pfe-art')!.textContent).toBe('A');
    expect($('[data-pfe-count]')!.textContent).toBe('3/20');
    typeName('Bob');
    expect($('[data-pfe-hero-name]')!.textContent).toBe('Bob');
    expect($('[data-pfe-hero] .pfe-art')!.textContent).toBe('B');
    expect($('[data-pfe-mini-me] .pfe-mini-name')!.textContent).toBe('Bob');
    // Couleur : la coche suit le choix et l'aperçu prend la couleur.
    $<HTMLElement>('[data-pfe-color="#3b82f6"]')!.click();
    expect($('[data-pfe-color="#3b82f6"]')!.getAttribute('aria-pressed')).toBe('true');
    expect($<HTMLElement>('[data-pfe-hero] .pfe-art')!.style.background).toContain('rgb(59, 130, 246)');
    // Zone de danger présente en modification.
    expect($('[data-pfe-delete]')).not.toBeNull();
  });

  it('profil enfant : interrupteur role="switch", pastille « Profil enfant, protégé » et options enfant', async () => {
    await openEditor(profile('leo', { name: 'Léo' }));
    const kid = $<HTMLInputElement>('input[name="kid"]')!;
    expect(kid.getAttribute('role')).toBe('switch');
    expect($('[data-pfe-kidpill]')!.hidden).toBe(true);
    kid.checked = true;
    kid.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('[data-pfe-kidpill]')!.hidden).toBe(false);
    expect($('[data-pfe-kidpill]')!.textContent).toBe('Profil enfant, protégé');
    expect($('[data-kidage]')!.hidden).toBe(false);
  });
});

describe('page d’édition : modifications et Enregistrer', () => {
  it('Enregistrer reste désactivé tant que rien n’a changé ; l’indicateur apparaît puis disparaît si on revient en arrière', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    expect(saves().length).toBe(2);
    expect(saves().every((b) => b.disabled)).toBe(true);
    expect(dirtyShown()).toBe(false);
    typeName('Anaïs');
    expect(saves().every((b) => !b.disabled)).toBe(true);
    expect(dirtyShown()).toBe(true);
    typeName('Ana');
    expect(saves().every((b) => b.disabled)).toBe(true);
    expect(dirtyShown()).toBe(false);
  });

  it('Enregistrer envoie la modification puis revient à « Gérer les profils »', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    typeName('Anaïs');
    $<HTMLFormElement>('.pf-editor')!.requestSubmit(saves()[0]);
    await tick();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('/user/profiles/ana');
    expect((patch?.body as { name: string }).name).toBe('Anaïs');
    expect($('.pfe-page')).toBeNull();
    expect($('.auth-title')!.textContent).toBe('Gérer les profils');
  });

  it('nom vide en modification : Enregistrer désactivé, aide visible', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    typeName('  ');
    expect(saves().every((b) => b.disabled)).toBe(true);
    expect($('[data-pfe-name-help]')!.textContent).toBe('Le nom ne peut pas être vide.');
  });
});

describe('page d’édition : création', () => {
  it('« Créer le profil » désactivé tant que le nom est vide, avec un texte d’aide ; pas de zone de danger', async () => {
    await openEditor(null);
    expect($('#pfe-title')!.textContent).toBe('Nouveau profil');
    expect(saves().every((b) => b.textContent === 'Créer le profil' && b.disabled)).toBe(true);
    expect($('[data-pfe-name-help]')!.textContent).toBe('Donne un nom au profil pour pouvoir le créer.');
    expect($('[data-pfe-delete]')).toBeNull();
    // Un envoi forcé sans nom n'appelle pas le serveur.
    $<HTMLFormElement>('.pf-editor')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect($('#pfe-msg')!.textContent).toBe('Donne un nom au profil.');
    typeName('Nina');
    expect(saves().every((b) => !b.disabled)).toBe(true);
    $<HTMLFormElement>('.pf-editor')!.requestSubmit(saves()[0]);
    await tick();
    const post = calls.find((c) => c.method === 'POST' && c.url === '/user/profiles');
    expect((post?.body as { name: string }).name).toBe('Nina');
  });
});

describe('page d’édition : code PIN en 4 cases', () => {
  it('chaque chiffre passe à la case suivante ; le code complet est envoyé', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    const boxes = $$<HTMLInputElement>('[data-pfe-pin="pin"] [data-pfe-digit]');
    expect(boxes.length).toBe(4);
    boxes[0].focus();
    '1234'.split('').forEach((d, i) => {
      boxes[i].value = d;
      boxes[i].dispatchEvent(new Event('input', { bubbles: true }));
      if (i < 3) expect(document.activeElement).toBe(boxes[i + 1]);
    });
    // Les chiffres restent en mémoire : aucun champ caché ne porte le code.
    expect($('input[name="pin"], input[name="parental"], input[type="hidden"]')).toBeNull();
    expect(dirtyShown()).toBe(true);
    $<HTMLFormElement>('.pf-editor')!.requestSubmit(saves()[0]);
    await tick();
    expect((calls.find((c) => c.method === 'PATCH')?.body as { pin: string }).pin).toBe('1234');
  });

  it('code incomplet : message, rien n’est envoyé', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    const box = $<HTMLInputElement>('[data-pfe-pin="pin"] [data-pfe-digit="0"]')!;
    box.value = '7';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    $<HTMLFormElement>('.pf-editor')!.requestSubmit(saves()[0]);
    await tick();
    expect($('#pfe-msg')!.textContent).toBe('Le code PIN compte 4 chiffres.');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('« Retirer le code » envoie pin: null', async () => {
    await openEditor(profile('ana', { name: 'Ana', hasPin: true }));
    const btn = $<HTMLElement>('[data-pfe-nopin]')!;
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    $<HTMLFormElement>('.pf-editor')!.requestSubmit(saves()[0]);
    await tick();
    expect((calls.find((c) => c.method === 'PATCH')?.body as { pin: null }).pin).toBeNull();
  });
});

describe('page d’édition : Échap et confirmation de sortie', () => {
  it('sans modification, Échap ferme la page aussitôt', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    esc();
    expect($('.pfe-page')).toBeNull();
    expect($('.auth-title')!.textContent).toBe('Gérer les profils');
  });

  it('avec des modifications, Échap demande confirmation ; « Continuer l’édition » (focus par défaut) garde la page', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    typeName('Anaïs');
    esc();
    expect($('.pfe-page')).not.toBeNull();
    expect($('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement).toBe($('[data-pfe-stay]'));
    expect($('.pf-editor')!.hasAttribute('inert')).toBe(true);
    $<HTMLElement>('[data-pfe-stay]')!.click();
    expect($('[role="alertdialog"]')).toBeNull();
    expect($('.pf-editor')!.hasAttribute('inert')).toBe(false);
    expect(nameInput().value).toBe('Anaïs');
    // Échap dans la confirmation la referme seulement.
    esc();
    esc();
    expect($('[role="alertdialog"]')).toBeNull();
    expect($('.pfe-page')).not.toBeNull();
  });

  it('« Quitter sans enregistrer » ferme la page sans rien envoyer ; Annuler suit le même chemin', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    typeName('Anaïs');
    $<HTMLElement>('[data-pfe-cancel]')!.click();
    $<HTMLElement>('[data-pfe-leave]')!.click();
    expect($('.pfe-page')).toBeNull();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('studio d’avatars ouvert : Échap ferme le studio, pas la page', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    $<HTMLElement>('[data-pfe-studio]')!.click();
    await tick();
    expect($('.as-overlay')).not.toBeNull();
    esc();
    expect($('.as-overlay')).toBeNull();
    expect($('.pfe-page')).not.toBeNull();
    expect($('[role="alertdialog"]')).toBeNull();
  });
});

describe('page d’édition : suppression', () => {
  it('confirmation : « Annuler » a le focus ; « Supprimer définitivement » n’est actif qu’avec le nom identique', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    $<HTMLElement>('[data-pfe-delete]')!.click();
    expect($('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement).toBe($('[data-pfe-delcancel]'));
    const ok = $<HTMLButtonElement>('[data-pfe-delok]')!;
    const input = $<HTMLInputElement>('[data-pfe-delname]')!;
    expect(ok.disabled).toBe(true);
    const type = (v: string) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); };
    type('an');
    expect(ok.disabled).toBe(true);
    type('ana');
    expect(ok.disabled).toBe(true);
    type('Ana');
    expect(ok.disabled).toBe(false);
    ok.closest('form')!.requestSubmit(ok);
    await tick();
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/user/profiles/ana');
    expect($('.pfe-page')).toBeNull();
    expect($('.auth-title')!.textContent).toBe('Gérer les profils');
  });

  it('« Annuler » referme la confirmation sans supprimer', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    $<HTMLElement>('[data-pfe-delete]')!.click();
    $<HTMLElement>('[data-pfe-delcancel]')!.click();
    expect($('[role="alertdialog"]')).toBeNull();
    expect($('.pfe-page')).not.toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('relecture : clavier, rôle, enregistrement en cours, code parental, profil principal', () => {
  it('les touches de la page n’atteignent pas le clavier global (Échap, retour arrière)', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    const global = vi.fn();
    document.addEventListener('keydown', global);
    try {
      const box = $<HTMLInputElement>('[data-pfe-pin="pin"] [data-pfe-digit="1"]')!;
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      esc();
      expect($('.pfe-page')).toBeNull();
      expect(global).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', global);
    }
  });

  it('la page est une boîte de dialogue modale nommée par son titre', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    const page = $('.pfe-page')!;
    expect(page.getAttribute('role')).toBe('dialog');
    expect(page.getAttribute('aria-modal')).toBe('true');
    expect(page.getAttribute('aria-labelledby')).toBe('pfe-title');
    expect($('#pfe-title')!.textContent).toBe('Modifier le profil');
  });

  it('pendant l’enregistrement, Annuler et Échap ne quittent pas la page', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    typeName('Anaïs');
    $<HTMLFormElement>('.pf-editor')!.requestSubmit(saves()[0]);
    $<HTMLElement>('[data-pfe-cancel]')!.click();
    esc();
    expect($('[role="alertdialog"]')).toBeNull();
    expect($('.pfe-page')).not.toBeNull();
    await tick();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    expect($('.pfe-page')).toBeNull();
  });

  it('code parental saisi puis profil enfant désactivé : plus aucune modification comptée', async () => {
    await openEditor(profile('ana', { name: 'Ana' }));
    const kid = $<HTMLInputElement>('input[name="kid"]')!;
    kid.checked = true;
    kid.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('[data-parental]')!.hidden).toBe(false);
    const box = $<HTMLInputElement>('[data-pfe-pin="parental"] [data-pfe-digit="0"]')!;
    box.value = '5';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    kid.checked = false;
    kid.dispatchEvent(new Event('change', { bubbles: true }));
    expect(dirtyShown()).toBe(false);
    expect(saves().every((b) => b.disabled)).toBe(true);
  });

  it('profil principal : pas de zone de danger', async () => {
    await openEditor(profile('gtko', { name: 'Greg', isMainProfile: true }));
    expect($('#pfe-title')!.textContent).toBe('Modifier le profil');
    expect($('[data-pfe-delete]')).toBeNull();
    expect($('.pfe-danger')).toBeNull();
  });
});
