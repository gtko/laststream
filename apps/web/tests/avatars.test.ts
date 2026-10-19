import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_LICENSES, AVATAR_PATTERN, AVATAR_STYLES, avatarCount, avatarCredits, cleanSeed, formatAvatar, parseAvatar, pickerStyles,
  RETIRED_STYLE_IDS, stylesForTab, tabTiles, usableStyles, type AvatarLicense,
} from '../src/data/avatars';
import { HERO_SEEDS } from '../src/data/avatars';
import { AVATAR_SCALE, avatarAttrs, avatarUri, hydrateAvatars, resetAvatarCache } from '../src/ui/avatar-art.js';
import { SETTINGS_STORAGE_KEY, reloadSettings } from '../src/data/config';
import { reloadSession } from '../src/data/session';
import type { Profile } from '../src/data/userStore';

const DICEBEAR = join(__dirname, '..', 'node_modules', '@dicebear');

/** Licence de l'illustration déclarée dans le LICENSE du paquet @dicebear/<style>. */
function packageLicense(id: string): AvatarLicense | 'autre' {
  const text = readFileSync(join(DICEBEAR, id, 'LICENSE'), 'utf8');
  const line = /License: (.*)/.exec(text)?.[1] ?? '';
  if (/^CC0 1\.0/.test(line)) return 'cc0';
  if (/^CC BY 4\.0/.test(line)) return 'cc-by';
  if (/^Free for personal and commercial use/.test(line)) return 'libre';
  return 'autre';
}

describe('format et validation', () => {
  it('accepte dicebear:<style>:<graine> et rejette le reste', () => {
    expect(AVATAR_PATTERN.test('dicebear:lorelei:Abc_1-x')).toBe(true);
    for (const bad of ['', 'lorelei:abc', 'dicebear:Lorelei:abc', 'dicebear:lorelei:a b', 'dicebear:lorelei:', 'dicebear:lorelei:' + 'a'.repeat(41), 'https://x/y.svg', '<svg>', 'dicebear::abc']) {
      expect(AVATAR_PATTERN.test(bad), bad).toBe(false);
    }
    expect(parseAvatar(formatAvatar('thumbs', 'Mimi'))).toMatchObject({ seed: 'Mimi', style: { id: 'thumbs' } });
    expect(parseAvatar('dicebear:inconnu:abc')).toBeNull();
    expect(parseAvatar(null)).toBeNull();
    expect(parseAvatar(42)).toBeNull();
  });

  it('cleanSeed : sans accents ni espaces, 40 caractères au plus', () => {
    expect(cleanSeed('Élodie Dupont !')).toBe('Elodie-Dupont');
    expect(cleanSeed('a'.repeat(80))).toHaveLength(40);
    expect(cleanSeed('***')).toBe('');
  });
});

describe('licences filtrées', () => {
  it('chaque style proposé déclare la licence réellement indiquée dans son paquet, et elle est autorisée', () => {
    for (const st of AVATAR_STYLES) {
      expect(packageLicense(st.id), st.id).toBe(st.license);
      expect(ALLOWED_LICENSES, st.id).toContain(st.license);
    }
    expect(usableStyles()).toHaveLength(AVATAR_STYLES.length);
  });

  it('aucun style dont la licence n’est pas autorisée n’est proposé', () => {
    const offered = new Set(AVATAR_STYLES.map((s) => s.id));
    for (const dir of readdirSync(DICEBEAR)) {
      if (dir === 'core' || dir === 'collection') continue;
      const kind = (() => { try { return packageLicense(dir); } catch { return 'autre'; } })();
      if (kind === 'autre') expect(offered.has(dir), dir).toBe(false);
    }
    expect(offered.has('initials')).toBe(false);
    expect(offered.has('icons')).toBe(false);
  });

  it('les crédits couvrent chaque style proposé avec illustrateur, licence et page source', () => {
    const credits = avatarCredits();
    const listed = credits.flatMap((c) => c.styles).length;
    expect(listed).toBe(pickerStyles().length);
    expect(credits.some((c) => c.license === 'cc-by' && c.creator === 'Lisa Wischofsky')).toBe(true);
    expect(credits.every((c) => c.creator && c.styles.every((st) => st.label && st.source.startsWith('https://')))).toBe(true);
  });
});

describe('catalogue', () => {
  it('plus de 300 avatars, onglets non vides, graines déterministes', () => {
    expect(avatarCount()).toBeGreaterThanOrEqual(300);
    for (const tab of ['enfants', 'personnages', 'illustres', 'robots', 'fun'] as const) {
      expect(stylesForTab(tab).length, tab).toBeGreaterThan(0);
      expect(tabTiles(tab).map((t) => t.value)).toEqual(tabTiles(tab).map((t) => t.value));
    }
    const tiles = tabTiles('robots', 'Zélie');
    expect(tiles[0].seed).toBe('Zelie');
    expect(new Set(tiles.map((t) => t.value)).size).toBe(tiles.length);
    expect(stylesForTab('enfants').every((s) => s.kid)).toBe(true);
  });

  it('onglet Fun : seulement des figures ; les styles abstraits sont retirés du choix mais restent reconnus', () => {
    expect(stylesForTab('fun').map((s) => s.id).sort()).toEqual(['fun-emoji', 'thumbs']);
    expect([...RETIRED_STYLE_IDS].sort()).toEqual(['glass', 'identicon', 'rings', 'shapes']);
    for (const id of RETIRED_STYLE_IDS) {
      expect(pickerStyles().some((s) => s.id === id), id).toBe(false);
      expect(parseAvatar(formatAvatar(id, 'Mimi')), id).not.toBeNull();
    }
    expect(avatarCount()).toBe(pickerStyles().length * 16 + 4 * HERO_SEEDS.length);
  });
});

describe('rendu : illustration entière dans la tuile', () => {
  beforeEach(() => resetAvatarCache());
  const decode = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
  const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;

  it.each(AVATAR_STYLES.map((s) => s.id))('%s : viewBox carré, SVG à 100 %, figure mise à l’échelle sans agrandissement', async (id) => {
    const svg = decode(await avatarUri(formatAvatar(id, 'Mimi')));
    const root = parse(svg);
    expect(root.localName).toBe('svg');
    const [minX, minY, w, h] = (root.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    expect(w, 'viewBox carré').toBeGreaterThan(0);
    expect(h).toBe(w);
    expect(minX).toBe(0);
    expect(minY).toBe(0);
    expect(root.getAttribute('width')).toBe('100%');
    expect(root.getAttribute('height')).toBe('100%');
    // Le wrapper de centrage porte l'échelle commune : au plus 100 %, jamais d'agrandissement.
    const wrapper = root.querySelector(`g[transform*="scale(${AVATAR_SCALE / 100})"]`);
    expect(wrapper, 'wrapper de centrage').not.toBeNull();
    const scale = Number(/scale\(([\d.]+)\)/.exec(wrapper!.getAttribute('transform') ?? '')?.[1]);
    expect(scale).toBeLessThanOrEqual(1);
    expect(scale).toBeGreaterThanOrEqual(0.5);
    expect(wrapper!.getAttribute('transform')).toMatch(/^translate\([\d.-]+ [\d.-]+\) scale\(/);
  });

  it('les SVG ne contiennent aucune balise externe ni largeur fixe en pixels', async () => {
    for (const st of AVATAR_STYLES) {
      const svg = decode(await avatarUri(formatAvatar(st.id, 'Luna')));
      expect(svg, st.id).not.toMatch(/<image|(?:href|src)=["']https?:/);
      expect(svg, st.id).not.toMatch(/<svg[^>]*\swidth="\d+"/);
    }
  });
});

describe('génération locale', () => {
  beforeEach(() => resetAvatarCache());

  it('déterministe : même graine, même SVG ; autre graine, autre SVG ; aucune requête réseau', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const a = await avatarUri('dicebear:thumbs:Mimi');
    resetAvatarCache();
    const b = await avatarUri('dicebear:thumbs:Mimi');
    const c = await avatarUri('dicebear:thumbs:Luna');
    vi.unstubAllGlobals();
    expect(a).toMatch(/^data:image\/svg\+xml/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const svg = decodeURIComponent(a.split(',')[1]);
    expect(svg.startsWith('<svg')).toBe(true);
    // Aucune ressource externe (les URL des métadonnées de licence ne sont que du texte).
    expect(svg).not.toMatch(/(?:href|src)=["']https?:/);
    expect(svg).not.toContain('<image');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('chaque famille génère un SVG', async () => {
    for (const st of [AVATAR_STYLES[0], ...AVATAR_STYLES.filter((s) => ['bottts', 'fun-emoji', 'croodles'].includes(s.id))]) {
      expect(await avatarUri(formatAvatar(st.id, 'Test')), st.id).toMatch(/^data:image\/svg\+xml/);
    }
  });

  it('valeur invalide ou style inconnu : rien (repli sur l’initiale)', async () => {
    expect(await avatarUri('dicebear:inconnu:abc')).toBe('');
    expect(await avatarUri('n’importe quoi')).toBe('');
  });
});

describe('rendu de repli', () => {
  beforeEach(() => resetAvatarCache());

  it('sans avatar valide : seulement la couleur, aucun attribut d’illustration', () => {
    expect(avatarAttrs(null, '#ff5a36')).toBe(' style="background:#ff5a36"');
    expect(avatarAttrs('dicebear:inconnu:x', '#ff5a36')).not.toContain('data-avatar');
    expect(avatarAttrs(undefined, '')).toContain('#94a3b8');
  });

  it('avatar valide non chargé : couleur de repli + data-avatar ; hydratation pose l’illustration', async () => {
    document.body.innerHTML = '<span id="x" class="pf-av"' + avatarAttrs('dicebear:thumbs:Mimi', '#7b5bf5') + '>M</span><span id="y"' + avatarAttrs('dicebear:thumbs:Mimi', '#7b5bf5') + '>M</span>';
    const x = document.getElementById('x') as HTMLElement;
    expect(x.dataset.avatar).toBe('dicebear:thumbs:Mimi');
    expect(x.dataset.art).toBeUndefined();
    expect(x.style.background).toContain('rgb(123, 91, 245)');
    await hydrateAvatars(document);
    expect(x.dataset.art).toBe('1');
    expect(x.style.backgroundImage).toContain('data:image/svg+xml');
    // Second rendu : l'illustration est déjà en cache, posée dès le HTML.
    expect(avatarAttrs('dicebear:thumbs:Mimi', '#7b5bf5')).toContain('data-art="1"');
  });
});

describe('éditeur de profil : sélecteur d’avatars (dans le studio)', () => {
  const BASE = 'http://srv.test';
  const bodies: string[] = [];
  const profile = (id: string, extra: Partial<Profile> = {}): Profile =>
    ({ id, name: id, avatarColor: '#ff5a36', isKid: false, kidMaxAge: 12, hasPin: false, allowedCatalogs: [], isMainProfile: false, ...extra }) as Profile;
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: BASE, config: 'X' }));
    reloadSettings();
    reloadSession();
    bodies.length = 0;
    document.querySelectorAll('.pin-back, .as-overlay').forEach((n) => n.remove());
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url).replace(BASE, '');
      if (init?.method === 'POST' && u === '/user/profiles') {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ id: 'new' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (u === '/user/profiles') return new Response(JSON.stringify({ profiles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function openEditor() {
    const a = await import('../src/data/auth');
    const ui = await import('../src/ui/auth-ui.js');
    a.auth.profiles = [profile('gtko', { isMainProfile: true })];
    a.auth.profile = a.auth.profiles[0];
    a.auth.status = 'ready';
    ui.openPicker();
    (document.querySelector('[data-pf-manage]') as HTMLElement).click();
    (document.querySelector('[data-pf-add]') as HTMLElement).click();
    await tick();
    return document.querySelector('.pf-editor') as HTMLFormElement;
  }

  /**
   * Ouvre le studio depuis l'éditeur, puis « Illustrés » > « Générés ». Le catalogue est injoignable dans ce test : le studio
   * tombe alors sur ces avatars générés, seuls disponibles.
   */
  async function openGenerated(kidFirst = false) {
    const form = await openEditor();
    if (kidFirst) {
      const kid = form.elements.namedItem('kid') as HTMLInputElement;
      kid.checked = true;
      kid.dispatchEvent(new Event('change', { bubbles: true }));
    }
    (form.querySelector('[data-pfe-studio]') as HTMLElement).click();
    await tick();
    const studio = document.querySelector('.as-overlay') as HTMLElement;
    (studio.querySelector('[data-as-fam="free"]') as HTMLElement).click();
    (studio.querySelector('[data-as-sub="gen"]') as HTMLElement).click();
    return { form, studio };
  }

  it('onglets par famille, grille paginée ; « Utiliser cet avatar » reporte le choix dans l’éditeur, envoyé avec la couleur de repli', async () => {
    const { form, studio } = await openGenerated();
    expect(studio.querySelector('.as-notice')?.textContent).toContain('Les collections d\'avatars ne sont pas disponibles');
    const tabs = Array.from(studio.querySelectorAll('[data-av-tab]')).map((b) => (b as HTMLElement).dataset.avTab);
    expect(tabs).toEqual(['heroes', 'enfants', 'personnages', 'illustres', 'robots', 'fun']);
    // Premier onglet : Héros, avec ses quatre sous-filtres.
    expect(Array.from(studio.querySelectorAll('[data-av-sub]')).map((b) => (b as HTMLElement).dataset.avSub)).toEqual(['heros', 'vilains', 'scifi', 'fantasy']);
    expect((studio.querySelector('.av-tile') as HTMLElement).dataset.avPick).toMatch(/^hero:heros:/);
    (studio.querySelector('[data-av-sub="vilains"]') as HTMLElement).click();
    expect((studio.querySelector('.av-tile') as HTMLElement).dataset.avPick).toMatch(/^hero:vilains:/);
    // Paginé : 48 tuiles d'abord, « Voir plus » en ajoute.
    expect(studio.querySelectorAll('.av-tile').length).toBe(48);
    (studio.querySelector('[data-av-more]') as HTMLElement).click();
    expect(studio.querySelectorAll('.av-tile').length).toBeGreaterThan(48);
    (studio.querySelector('[data-av-tab="robots"]') as HTMLElement).click();
    const first = studio.querySelector('.av-tile') as HTMLElement;
    expect(first.dataset.avPick).toMatch(/^dicebear:(bottts|bottts-neutral|pixel-art|pixel-art-neutral):/);
    first.click();
    expect((studio.querySelector('.av-tile[aria-pressed="true"]') as HTMLElement).dataset.avPick).toBe(first.dataset.avPick);
    // Recherche : le mot devient la première graine ; « Au hasard » en tire une.
    const search = studio.querySelector('input[name="avsearch"]') as HTMLInputElement;
    search.value = 'Zélie';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect((studio.querySelector('.av-tile') as HTMLElement).dataset.avPick).toMatch(/:Zelie$/);
    (studio.querySelector('[data-av-random]') as HTMLElement).click();
    expect(search.value).toMatch(/^[a-z2-9]{8}$/);
    // Choix, puis « Utiliser cet avatar » : le studio se ferme et l'éditeur garde l'avatar.
    (studio.querySelector('.av-tile') as HTMLElement).click();
    const chosen = (studio.querySelector('.av-tile[aria-pressed="true"]') as HTMLElement).dataset.avPick;
    (studio.querySelector('[data-as-use]') as HTMLElement).click();
    expect(document.querySelector('.as-overlay')).toBeNull();
    (form.elements.namedItem('name') as HTMLInputElement).value = 'Nina';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await tick();
    const sent = JSON.parse(bodies[0]);
    expect(sent.avatar).toBe(chosen);
    expect(sent.avatarColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(sent.name).toBe('Nina');
  });

  it('crédits repliés par défaut dans « Générés », une ligne par auteur, sans « source source »', async () => {
    const { studio } = await openGenerated();
    const details = studio.querySelector('.pf-picker-avatars details.av-credits-more') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Crédits des illustrations');
    expect(details.textContent).toContain('Lisa Wischofsky');
    const ui = await import('../src/ui/auth-ui.js');
    const html = ui.creditsHTML();
    expect(html).not.toContain('>source<');
    expect((html.match(/<li>/g) ?? []).length).toBe(avatarCredits().length);
  });

  it('profil enfant : le studio prend la variante enfant et l’onglet Enfants d’abord', async () => {
    const { studio } = await openGenerated(true);
    expect(studio.querySelector('.as-app.is-kid')).not.toBeNull();
    expect((studio.querySelector('[data-av-tab][aria-pressed="true"]') as HTMLElement).dataset.avTab).toBe('enfants');
  });
});
