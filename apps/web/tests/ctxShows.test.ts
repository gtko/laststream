// Menu contextuel des émissions et du tactile (ODY-259) : « Plus d’infos » d’une émission, menu natif sur les cartes du guide
// et de l’import Stremio, un seul menu quand l’appui long déclenche aussi le menu natif, watch party d’une série qui attend
// l’état « vu », garde CSS des visuels (avatars et images du chat gardent le glisser natif).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  go: vi.fn(),
  loadWatched: vi.fn((_key: string) => Promise.resolve()),
}));

vi.mock('../src/ui/router.js', async (orig) => ({ ...(await orig<typeof import('../src/ui/router.js')>()), go: spies.go }));
vi.mock('../src/ui/ficheModel.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/ficheModel.js')>()),
  fetchFull: async (type: string, id: string | number) => ({
    key: type + ':' + id, type, id: Number(id), name: 'Sherlock', posterPath: '/p.jpg', releaseFR: '2010-07-25', cinemaSince: null, overview: '', seasons: [],
  }),
}));
// Seul `loadWatched` est remplacé (compté et contrôlable) ; le reste du magasin reste celui de l’application.
vi.mock('../src/data/userStore', async (orig) => {
  const m = await orig<typeof import('../src/data/userStore')>();
  const base = m.userStore as unknown as Record<string | symbol, unknown>;
  return { ...m, userStore: new Proxy({}, { get: (_t, p) => (p === 'loadWatched' ? spies.loadWatched : base[p]) }) };
});

let ctx: typeof import('../src/ui/ctxmenu.js');
let stateMod: typeof import('../src/ui/state.js');
let auth: any;

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '#3b82f6', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [] };

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  window.scrollTo = () => undefined;
  ctx = await import('../src/ui/ctxmenu.js');
  stateMod = await import('../src/ui/state.js');
  // Entrées « Suivre » et « Noter » : leurs modules s’inscrivent au menu à l’import.
  await import('../src/ui/follows.js');
  await import('../src/ui/rate.js');
  ({ auth } = await import('../src/data/auth'));
});

beforeEach(() => {
  auth.status = 'ready';
  auth.profile = ADULT;
  spies.go.mockReset();
  spies.loadWatched.mockReset();
  spies.loadWatched.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  ctx.closeCtx(false);
  vi.useRealTimers();
  document.getElementById('probe')?.remove();
  // Le minuteur de 400 ms de l’appui long part avec les faux minuteurs : on remet l’état à zéro (sinon rows.js bloque les clics suivants).
  (stateMod.state as any).suppressClick = false;
  (stateMod.state as any).model = null;
  (stateMod.state as any).kind = '';
});

/** Monte un fragment dans le corps de page et renvoie son premier élément. */
function mount(html: string): HTMLElement {
  document.getElementById('probe')?.remove();
  const host = document.createElement('div');
  host.id = 'probe';
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

/** Premier élément correspondant à `sel` dans le fragment monté. */
const pick = (sel: string) => document.querySelector('#probe ' + sel) as HTMLElement;
const menu = () => document.querySelector('.ctxmenu') as HTMLElement | null;
const menuCount = () => document.querySelectorAll('.ctxmenu').length;
const labels = () => Array.from(menu()?.querySelectorAll('button') ?? []).map((b) => b.textContent);

/** Clic droit : renvoie l'événement pour lire `defaultPrevented`. */
function rightClick(el: Element, clientX = 40, clientY = 50): MouseEvent {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY });
  el.dispatchEvent(ev);
  return ev;
}

/** Appui tactile (pointerdown d’un doigt) : déclenche le minuteur d’appui long. */
function pressTouch(el: Element, clientX = 40, clientY = 50): void {
  const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(ev, { pointerType: { value: 'touch' }, clientX: { value: clientX }, clientY: { value: clientY } });
  el.dispatchEvent(ev);
}

/** Laisse passer les promesses en attente (chargement de la fiche, du suivi « vu »). */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const TILE = '<button type="button" class="card" data-tile="tv:56" data-open="tv:56">Épisode</button>';

describe('émission (data-showopen) : cible et menu', () => {
  it('cible de type « show », avec la clé de la série', () => {
    expect(ctx.ctxTarget(mount('<button type="button" data-showopen="123">Émission</button>'))).toMatchObject({ kind: 'show', key: 'tv:123' });
  });

  it('menu : « Plus d’infos », suivre et noter ; jamais « Marquer la série comme vue »', () => {
    rightClick(mount('<button type="button" data-showopen="123">Émission</button>'));
    expect(menu()).not.toBeNull();
    expect(labels()).toContain('Plus d’infos');
    expect(labels().some((l) => l === 'Suivre' || l === 'Ne plus suivre')).toBe(true);
    expect(labels().some((l) => l === 'Noter…' || (l ?? '').startsWith('Modifier ma note'))).toBe(true);
    expect(labels().join('|')).not.toMatch(/Marquer/);
  });

  it('« Plus d’infos » ouvre la page de l’émission', () => {
    rightClick(mount('<button type="button" data-showopen="123">Émission</button>'));
    (menu()!.querySelector('[data-ctx="info"]') as HTMLElement).click();
    expect(spies.go).toHaveBeenCalledWith('#/emission/123', expect.anything());
  });
});

describe('menu natif conservé hors des fiches de l’app', () => {
  it('carte du guide (data-showopen="epg:…") : aucun menu de l’app, menu natif', () => {
    mount('<button type="button" data-showopen="epg:abc"><img src="/a.jpg" alt=""></button>');
    const ev = rightClick(pick('img'));
    expect(ev.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it('carte d’import Stremio (data-open="true") : texte copiable, menu natif', () => {
    mount('<div class="set-card si-card" data-open="true"><p class="si-priv-t">Tes identifiants restent entre toi et ton serveur</p></div>');
    const ev = rightClick(pick('p'));
    expect(ev.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });
});

describe('appui long et clic droit sur une même cible (Android, ODY-259)', () => {
  it('appui long puis menu natif (contextmenu) : un seul menu, le premier', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const el = mount(TILE);
    pressTouch(el);
    vi.advanceTimersByTime(500);
    const first = menu();
    expect(first).not.toBeNull();
    rightClick(el);
    expect(menuCount()).toBe(1);
    expect(menu()).toBe(first);
  });

  it('menu natif (contextmenu) puis appui long : un seul menu, le premier', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const el = mount(TILE);
    rightClick(el);
    const first = menu();
    expect(first).not.toBeNull();
    pressTouch(el);
    vi.advanceTimersByTime(500);
    expect(menuCount()).toBe(1);
    expect(menu()).toBe(first);
  });

  it('au-delà d’une seconde, un nouvel appui rouvre le menu', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const el = mount(TILE);
    rightClick(el);
    const first = menu();
    vi.advanceTimersByTime(1500);
    rightClick(el);
    expect(menuCount()).toBe(1);
    expect(menu()).not.toBe(first);
  });
});

describe('watch party d’une série depuis le menu d’une affiche', () => {
  it('la fenêtre attend le chargement de l’état « vu » de la série', async () => {
    let release = () => {};
    spies.loadWatched.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    rightClick(mount(TILE));
    (menu()!.querySelector('[data-ctx="party"]') as HTMLElement).click();
    await flush();
    expect(spies.loadWatched).toHaveBeenCalledWith('tv:56');
    expect(document.querySelector('.pld-name')).toBeNull();
    release();
    await flush();
    expect(document.querySelector('.pld-name')?.textContent).toBe('Sherlock');
  });
});

describe('visuels et glisser (ODY-259)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/styles.css'), 'utf8');

  it('la règle « img » n’est plus globale : seuls les visuels des cartes, affiches et bannières sont concernés', () => {
    expect(/(^|\n)img\s*\{[^}]*user-drag/.test(css)).toBe(false);
    for (const sel of ['[data-tile] img', '[data-open^="tv:"] img', '[data-showopen] img', '.hero-slide img', '.f-bg img']) {
      expect(css).toContain(sel);
    }
  });

  it('une image dans un parent glissable garde -webkit-user-drag: none', () => {
    expect(css).toMatch(/\[draggable="true"\] img\s*\{[^}]*-webkit-user-drag:\s*none/);
  });
});
