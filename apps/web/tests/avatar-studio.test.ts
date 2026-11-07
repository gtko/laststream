import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushRecentAvatar, resetAvatarCatalog } from '../src/data/avatar-catalog';
import { SETTINGS_STORAGE_KEY, reloadSettings } from '../src/data/config';
import { reloadSession } from '../src/data/session';
import type { Profile } from '../src/data/userStore';
import { closeAvatarStudio, openAvatarStudio } from '../src/ui/avatar-studio.js';

/*
 * Studio d'avatars et éditeur de profil revu : catalogue mocké (fetch), sélection, variante enfant, recherche, collection,
 * erreur réseau, et les points d'entrée depuis l'éditeur (« Changer d'avatar », « Récemment utilisés », avertissement enfant).
 */

const BASE = 'http://srv.test';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const studio = () => document.querySelector('.as-overlay') as HTMLElement;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RAW_CATALOG = {
  version: '2026-10-20',
  families: [
    { id: 'games', label: 'Jeux vidéo' },
    { id: 'heroes', label: 'Super-héros' },
    { id: 'disney', label: 'Disney et films' },
    { id: 'free', label: 'Illustrés' },
  ],
  collections: [
    { id: 'pokemon-officiel', family: 'games', name: 'Pokémon', source: 'PokeAPI', license: 'propriétaire', free: false, kid: true, total: 1025, aliases: ['pokemon'], group: 'pokemon', style: 'Artwork officiel', previews: ['pikachu', 'bulbizarre', 'dracaufeu'] },
    { id: 'pokemon-home', family: 'games', name: 'Pokémon', source: 'HOME', license: 'propriétaire', free: false, kid: true, total: 900, aliases: ['pokemon'], group: 'pokemon', style: 'HOME 3D', previews: ['pikachu', 'dracaufeu'] },
    { id: 'marvel-heros', family: 'heroes', name: 'Marvel', source: 'Marvel', license: 'propriétaire', free: false, kid: false, total: 170, aliases: ['marvel comics'], previews: ['iron-man', 'hulk'] },
    { id: 'disney-classiques', family: 'disney', name: 'Disney', source: 'Disney', license: 'propriétaire', free: false, kid: true, total: 2, aliases: ['disney'], previews: ['mickey', 'donald'] },
    { id: 'mario-amiibo', family: 'games', name: 'Mario', source: 'Nintendo', license: 'propriétaire', free: false, kid: false, total: 2, aliases: ['super mario'], previews: ['mario', 'luigi'] },
  ],
  featured: ['col:pokemon-officiel:pikachu', 'col:marvel-heros:iron-man'],
};

const CHARACTERS: Record<string, { id: string; name: string }[]> = {
  'pokemon-officiel': [{ id: 'pikachu', name: 'Pikachu' }, { id: 'bulbizarre', name: 'Bulbizarre' }, { id: 'dracaufeu', name: 'Dracaufeu' }],
  'pokemon-home': [{ id: 'pikachu', name: 'Pikachu' }, { id: 'dracaufeu', name: 'Dracaufeu' }],
  'marvel-heros': [{ id: 'iron-man', name: 'Iron Man' }, { id: 'hulk', name: 'Hulk' }],
  'disney-classiques': [{ id: 'mickey', name: 'Mickey Mouse' }, { id: 'donald', name: 'Donald Duck' }],
  'mario-amiibo': [{ id: 'mario', name: 'Mario' }, { id: 'luigi', name: 'Luigi' }],
};

/** Serveur simulé : catalogue (ou panne) et fichiers des collections. */
function serve({ down = false } = {}) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = String(url).replace(BASE, '');
    if (u === '/avatars/catalog.json') return down ? new Response('', { status: 503 }) : json(RAW_CATALOG);
    const m = /^\/avatars\/c\/([a-z0-9-]+)\.json$/.exec(u);
    if (m && CHARACTERS[m[1]]) return json({ id: m[1], characters: CHARACTERS[m[1]] });
    return new Response('{}', { status: 404 });
  });
}

const profile = (id: string, extra: Partial<Profile> = {}): Profile =>
  ({ id, name: id, avatarColor: '#ff5a36', isKid: false, kidMaxAge: 12, hasPin: false, allowedCatalogs: [], isMainProfile: false, ...extra }) as Profile;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'X' }));
  reloadSettings();
  reloadSession();
  resetAvatarCatalog();
  document.querySelectorAll('.pin-back, .as-overlay').forEach((n) => n.remove());
});

afterEach(() => {
  closeAvatarStudio();
  vi.unstubAllGlobals();
});

describe('studio d’avatars', () => {
  it('ouvre sur les collections du catalogue, univers réunis par style', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p1', name: 'Greg' }, color: '#ffd9cf', onPick: vi.fn() });
    await tick();
    const names = [...studio().querySelectorAll('.as-card-name')].map((n) => n.textContent);
    expect(names).toEqual(['Pokémon', 'Marvel', 'Disney', 'Mario']);
    expect(studio().querySelector('[data-as-col="pokemon-officiel"]')).not.toBeNull();
    expect(studio().querySelector('[data-as-col="pokemon-home"]')).toBeNull();
  });

  it('sélection puis « Utiliser cet avatar » : onPick reçoit la valeur col: et la couleur, la recherche garde le choix', async () => {
    vi.stubGlobal('fetch', serve());
    const onPick = vi.fn();
    openAvatarStudio({ profile: { id: 'p2', name: 'Greg' }, color: '#ffd9cf', onPick });
    await tick();
    const pikachu = studio().querySelector('[data-as-pick="col:pokemon-officiel:pikachu"]') as HTMLElement;
    pikachu.click();
    expect(pikachu.getAttribute('aria-pressed')).toBe('true');
    await tick();
    expect(studio().querySelector('[data-as-prev-name]')!.textContent).toBe('Pikachu');
    (studio().querySelector('[data-as-bg="#d6e4ff"]') as HTMLElement).click();
    expect(studio().querySelector('[data-as-bg="#d6e4ff"]')!.getAttribute('aria-pressed')).toBe('true');
    (studio().querySelector('[data-as-use]') as HTMLElement).click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('col:pokemon-officiel:pikachu', '#d6e4ff');
    expect(document.querySelector('.as-overlay')).toBeNull();
    expect(JSON.parse(localStorage.getItem('laststream.avatars.recent.p2')!)).toEqual(['col:pokemon-officiel:pikachu']);
  });

  it('variante enfant : seulement les collections « kid », bandeau et bouton « C’est moi ! »', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p3', name: 'Léo' }, kid: true, current: 'col:disney-classiques:mickey', onPick: vi.fn() });
    await tick();
    const text = studio().textContent ?? '';
    expect(studio().querySelector('.as-app.is-kid')).not.toBeNull();
    expect(text).toContain('Profil enfant : seulement les collections pour les enfants');
    expect(text).toContain('Pokémon');
    expect(text).toContain('Disney');
    expect(text).not.toContain('Marvel');
    expect(text).not.toContain('Mario');
    expect(studio().querySelector('[data-as-pick="col:marvel-heros:iron-man"]')).toBeNull();
    expect(studio().querySelector('[data-as-use]')!.textContent).toBe('C\'est moi !');
  });

  it('recherche : à partir de 2 caractères, personnages et collections, retour à l’accueil en effaçant', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p4', name: 'Greg' }, onPick: vi.fn() });
    await tick();
    const input = studio().querySelector('input[name="assearch"]') as HTMLInputElement;
    input.value = 'p';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(320);
    expect(studio().querySelector('.as-cards')).not.toBeNull(); // un caractère : pas de recherche, on reste à l'accueil
    input.value = 'pi';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(320);
    const picks = [...studio().querySelectorAll('[data-as-pick]')].map((b) => (b as HTMLElement).dataset.asPick);
    expect(picks).toContain('col:pokemon-officiel:pikachu');
    expect(picks).not.toContain('col:marvel-heros:iron-man');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(studio().querySelector('.as-cards')).not.toBeNull();
  });

  it('collection : chips de style, recherche dans la collection, « Voir plus » absent si tout tient', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p5', name: 'Greg' }, onPick: vi.fn() });
    await tick();
    (studio().querySelector('[data-as-col="pokemon-officiel"]') as HTMLElement).click();
    await tick();
    const chips = [...studio().querySelectorAll('[data-as-style]')].map((b) => (b as HTMLElement).dataset.asStyle);
    expect(chips).toEqual(['pokemon-officiel', 'pokemon-home']);
    const tilesNow = () => [...studio().querySelectorAll('[data-as-grid] .as-tile-name')].map((n) => n.textContent);
    expect(tilesNow()).toEqual(['Pikachu', 'Bulbizarre', 'Dracaufeu']);
    const input = studio().querySelector('input[name="assearch"]') as HTMLInputElement;
    input.value = 'dra';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(tilesNow()).toEqual(['Dracaufeu']);
    (studio().querySelector('[data-as-style="pokemon-home"]') as HTMLElement).click();
    await tick();
    expect(studio().querySelector('[data-as-style="pokemon-home"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(tilesNow()).toEqual(['Pikachu', 'Dracaufeu']);
    expect((studio().querySelector('[data-as-more]') as HTMLElement).hidden).toBe(true);
  });

  it('Échap et « Annuler » ferment sans choix : onCancel seul', async () => {
    vi.stubGlobal('fetch', serve());
    const onPick = vi.fn();
    const onCancel = vi.fn();
    openAvatarStudio({ profile: { id: 'p6', name: 'Greg' }, onPick, onCancel });
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.as-overlay')).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
    openAvatarStudio({ profile: { id: 'p6', name: 'Greg' }, onPick, onCancel });
    await tick();
    (studio().querySelector('[data-as-cancel]') as HTMLElement).click();
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('catalogue injoignable : message, et accès aux avatars générés (Illustrés > Générés)', async () => {
    vi.stubGlobal('fetch', serve({ down: true }));
    openAvatarStudio({ profile: { id: 'p7', name: 'Greg' }, onPick: vi.fn() });
    await tick();
    expect(studio().querySelector('.as-notice')!.textContent).toBe('Les collections d\'avatars ne sont pas disponibles pour le moment.');
    expect(studio().querySelector('[data-as-sub="gen"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(studio().querySelector('[data-av-tab]')).not.toBeNull();
  });

  it('focus piégé : Tab revient au premier élément depuis le dernier', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p8', name: 'Greg' }, onPick: vi.fn() });
    await tick();
    const all = [...studio().querySelectorAll('button, input')].filter((el) => !el.closest('[hidden]')) as HTMLElement[];
    const last = all[all.length - 1];
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(all[0]);
  });
});

describe('éditeur de profil : entrées vers le studio', () => {
  async function openProfileEditor(p: Profile) {
    const a = await import('../src/data/auth');
    const ui = await import('../src/ui/auth-ui.js');
    a.auth.profiles = [profile('gtko', { isMainProfile: true }), p];
    a.auth.profile = a.auth.profiles[0];
    a.auth.status = 'ready';
    ui.openPicker();
    (document.querySelector('[data-pf-manage]') as HTMLElement).click();
    (document.querySelector(`[data-pf="${p.id}"]`) as HTMLElement).click();
    await tick();
    return document.querySelector('.pf-editor') as HTMLFormElement;
  }

  it('« Changer d’avatar » ouvre le studio sur l’avatar actuel ; « Récemment utilisés » liste les derniers choix', async () => {
    vi.stubGlobal('fetch', serve());
    pushRecentAvatar('ana', 'col:marvel-heros:hulk');
    const form = await openProfileEditor(profile('ana', { name: 'Ana', avatar: 'col:pokemon-officiel:pikachu' }));
    expect(form.querySelector('.pfe-change')!.textContent).toBe('Changer d\'avatar');
    expect((form.querySelector('[data-pfe-recent]') as HTMLElement).hidden).toBe(false);
    expect(form.querySelector('[data-pfe-recent="col:marvel-heros:hulk"]')).not.toBeNull();
    (form.querySelector('.pfe-change') as HTMLElement).click();
    await tick();
    expect(studio()).not.toBeNull();
    expect(studio().querySelector('[data-as-pick="col:pokemon-officiel:pikachu"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('profil enfant : un avatar non autorisé déclenche l’avertissement et propose le studio enfant', async () => {
    vi.stubGlobal('fetch', serve());
    const form = await openProfileEditor(profile('leo', { name: 'Léo', avatar: 'col:marvel-heros:iron-man' }));
    const kid = form.elements.namedItem('kid') as HTMLInputElement;
    kid.checked = true;
    kid.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect((form.querySelector('[data-pfe-kidwarn]') as HTMLElement).hidden).toBe(false);
    (form.querySelector('[data-pfe-kidpick]') as HTMLElement).click();
    await tick();
    expect(studio().querySelector('.as-app.is-kid')).not.toBeNull();
  });

  it('profil enfant : enregistrer avec un avatar non autorisé est bloqué, sans envoi, avec le message et le studio enfant', async () => {
    const f = serve();
    vi.stubGlobal('fetch', f);
    const form = await openProfileEditor(profile('nina', { name: 'Nina', avatar: 'col:marvel-heros:iron-man' }));
    const kid = form.elements.namedItem('kid') as HTMLInputElement;
    kid.checked = true;
    kid.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    expect(f.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    const warn = form.querySelector('[data-pfe-kidwarn]') as HTMLElement;
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toContain('Cet avatar n\'est pas disponible pour un profil enfant : choisis-en un autre.');
    (form.querySelector('[data-pfe-kidpick]') as HTMLElement).click();
    await tick();
    expect(studio().querySelector('.as-app.is-kid')).not.toBeNull();
  });

  it('profil enfant : « Récemment utilisés » ne garde que les avatars autorisés', async () => {
    vi.stubGlobal('fetch', serve());
    pushRecentAvatar('lea', 'col:marvel-heros:hulk');
    pushRecentAvatar('lea', 'col:pokemon-officiel:pikachu');
    const form = await openProfileEditor(profile('lea', { name: 'Léa', avatar: 'col:pokemon-officiel:pikachu' }));
    expect(form.querySelector('[data-pfe-recent="col:marvel-heros:hulk"]')).not.toBeNull();
    const kid = form.elements.namedItem('kid') as HTMLInputElement;
    kid.checked = true;
    kid.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(form.querySelector('[data-pfe-recent="col:marvel-heros:hulk"]')).toBeNull();
    expect(form.querySelector('[data-pfe-recent="col:pokemon-officiel:pikachu"]')).not.toBeNull();
  });

  it('couleur de repli : 8 pastilles, la courante est marquée et un clic la change', async () => {
    vi.stubGlobal('fetch', serve());
    const form = await openProfileEditor(profile('max', { name: 'Max', avatarColor: '#19c3a6' }));
    const btns = [...form.querySelectorAll('[data-pfe-color]')] as HTMLElement[];
    expect(btns.length).toBe(8);
    expect(btns.find((b) => b.dataset.pfeColor === '#19c3a6')!.getAttribute('aria-pressed')).toBe('true');
    btns.find((b) => b.dataset.pfeColor === '#3b82f6')!.click();
    expect(btns.find((b) => b.dataset.pfeColor === '#3b82f6')!.getAttribute('aria-pressed')).toBe('true');
    expect(btns.find((b) => b.dataset.pfeColor === '#19c3a6')!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('studio : corrections de relecture', () => {
  it('« Initiale et couleur » : le rail ne change pas l’avatar ; « Utiliser l’initiale » valide onPick(null, couleur)', async () => {
    vi.stubGlobal('fetch', serve());
    const onPick = vi.fn();
    openAvatarStudio({ profile: { id: 'p9', name: 'Greg' }, current: 'col:pokemon-officiel:pikachu', color: '#d6e4ff', onPick });
    await tick();
    (studio().querySelector('[data-as-fam="initial"]') as HTMLElement).click();
    expect(studio().querySelector('[data-as-prev-name]')!.textContent).toBe('Pikachu');
    (studio().querySelector('[data-as-use-initial]') as HTMLElement).click();
    expect(onPick).toHaveBeenCalledWith(null, '#d6e4ff');
    expect(document.querySelector('.as-overlay')).toBeNull();
  });

  it('pastilles « Fond » : les 6 pastels, plus la couleur courante si elle n’en fait pas partie (sélectionnée)', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p10' }, color: '#7b5bf5', onPick: vi.fn() });
    await tick();
    expect(studio().querySelectorAll('.as-swatch').length).toBe(7);
    expect(studio().querySelector('[data-as-bg="#7b5bf5"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('variante enfant : un avatar non autorisé n’est pas gardé dans l’aperçu', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p11', name: 'Léo' }, kid: true, current: 'col:marvel-heros:iron-man', onPick: vi.fn() });
    await tick();
    expect(studio().querySelector('[data-as-prev-name]')!.textContent).toBe('Initiale');
  });

  it('recherche : une nouvelle frappe vide les résultats précédents ; seul le dernier libellé tapé s’affiche', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p12', name: 'Greg' }, onPick: vi.fn() });
    await tick();
    const input = studio().querySelector('input[name="assearch"]') as HTMLInputElement;
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type('pi');
    await tick(320);
    expect(studio().querySelector('[data-as-pick="col:pokemon-officiel:pikachu"]')).not.toBeNull();
    type('mar');
    expect(studio().textContent).toContain('Recherche…');
    expect(studio().querySelector('[data-as-pick="col:pokemon-officiel:pikachu"]')).toBeNull();
    await tick(320);
    expect(studio().querySelector('[data-as-col="marvel-heros"]')).not.toBeNull();
    expect(studio().querySelector('[data-as-pick="col:pokemon-officiel:pikachu"]')).toBeNull();
    expect(studio().querySelector('[data-as-pick="col:marvel-heros:iron-man"]')).not.toBeNull();
  });

  it('retour depuis une collection ouverte sur une recherche : résultats et libellé revenus', async () => {
    vi.stubGlobal('fetch', serve());
    openAvatarStudio({ profile: { id: 'p13', name: 'Greg' }, onPick: vi.fn() });
    await tick();
    const input = studio().querySelector('input[name="assearch"]') as HTMLInputElement;
    input.value = 'mar';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(320);
    (studio().querySelector('[data-as-col="marvel-heros"]') as HTMLElement).click();
    await tick();
    expect(studio().querySelector('[data-as-grid]')).not.toBeNull();
    (studio().querySelector('[data-as-back]') as HTMLElement).click();
    await tick();
    expect(studio().querySelector('[data-as-col="marvel-heros"]')).not.toBeNull();
    expect(input.value).toBe('mar');
  });
});
