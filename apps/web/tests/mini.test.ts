// Mini-lecteur : géométrie, aimantation, marges mpv, découpe de la page et cycle réduire → naviguer → agrandir → fermer.
// jsdom uniquement : aucune fenêtre ni navigateur réels.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAR_HEIGHT, CORNER_KEY, MINI_MARGIN, MiniState, ZERO_MARGINS, clampBox, holeClipFor, holeClipPath, isBarLayout, marginProps, miniLayout,
  MINI_ON_EXIT_KEY, exitMode, miniOnExitEnabled, miniWidth, mpvMargins, roundedRectPath, snapCorner,
} from '../src/player/mini';
import { keyToAction } from '../src/player/keys';
import { MpvEngine } from '../src/player/engines.js';
import { createMiniView } from '../src/player/miniview.js';

const WIN = { width: 1920, height: 1080 };

function setWindow(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

describe('géométrie du mini-lecteur', () => {
  it('largeur : 22 vw entre 280 et 480 px', () => {
    expect(miniWidth(1000)).toBe(280); // 220 -> plancher
    expect(miniWidth(1600)).toBe(352);
    expect(miniWidth(1920)).toBe(422);
    expect(miniWidth(3000)).toBe(480); // 660 -> plafond
  });

  it('vignette 16:9 en bas à droite, marge de 24 px', () => {
    const l = miniLayout(WIN, 'br');
    expect(l.bar).toBe(false);
    expect(l.box).toEqual({ left: 1920 - 24 - 422, top: 1080 - 24 - 237, width: 422, height: 237 });
    expect(l.video).toEqual(l.box);
    expect(Math.abs(l.box.width / l.box.height - 16 / 9)).toBeLessThan(0.01);
  });

  it('les quatre coins respectent la marge', () => {
    const w = 422;
    const h = 237;
    expect(miniLayout(WIN, 'tl').box).toMatchObject({ left: MINI_MARGIN, top: MINI_MARGIN });
    expect(miniLayout(WIN, 'tr').box).toMatchObject({ left: 1920 - MINI_MARGIN - w, top: MINI_MARGIN });
    expect(miniLayout(WIN, 'bl').box).toMatchObject({ left: MINI_MARGIN, top: 1080 - MINI_MARGIN - h });
  });

  it('sous 640 px : barre pleine largeur, image 16:9 à gauche', () => {
    expect(isBarLayout(639)).toBe(true);
    expect(isBarLayout(640)).toBe(false);
    const l = miniLayout({ width: 400, height: 800 }, 'tl');
    expect(l.bar).toBe(true);
    expect(l.box).toEqual({ left: 0, top: 800 - BAR_HEIGHT, width: 400, height: BAR_HEIGHT });
    expect(l.video).toEqual({ left: 0, top: 800 - BAR_HEIGHT, width: 128, height: BAR_HEIGHT });
  });
});

describe('aimantation aux coins', () => {
  it('le centre de la vignette désigne le coin le plus proche', () => {
    expect(snapCorner({ x: 100, y: 100 }, WIN)).toBe('tl');
    expect(snapCorner({ x: 1800, y: 100 }, WIN)).toBe('tr');
    expect(snapCorner({ x: 100, y: 1000 }, WIN)).toBe('bl');
    expect(snapCorner({ x: 1800, y: 1000 }, WIN)).toBe('br');
    expect(snapCorner({ x: 960, y: 540 }, WIN)).toBe('br'); // pile au milieu : bas droite
  });

  it('un glissement hors de la fenêtre est ramené dedans', () => {
    const box = { left: -50, top: 2000, width: 422, height: 237 };
    expect(clampBox(box, WIN)).toEqual({ left: 0, top: 1080 - 237, width: 422, height: 237 });
  });
});

describe('marges mpv', () => {
  it('part de fenêtre laissée de chaque côté de la vignette', () => {
    const l = miniLayout(WIN, 'br');
    const m = mpvMargins(l.video, WIN);
    expect(m.left).toBeCloseTo((1920 - 24 - 422) / 1920, 6);
    expect(m.right).toBeCloseTo(24 / 1920, 6);
    expect(m.top).toBeCloseTo((1080 - 24 - 237) / 1080, 6);
    expect(m.bottom).toBeCloseTo(24 / 1080, 6);
    // l'image reste de la taille de la vignette
    expect((1 - m.left - m.right) * 1920).toBeCloseTo(422, 1);
    expect((1 - m.top - m.bottom) * 1080).toBeCloseTo(237, 1);
  });

  it('plein écran : marges nulles ; fenêtre invalide : nulles aussi', () => {
    expect(mpvMargins({ left: 0, top: 0, width: 1920, height: 1080 }, WIN)).toEqual(ZERO_MARGINS);
    expect(mpvMargins({ left: 10, top: 10, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual(ZERO_MARGINS);
  });

  it('bornées entre 0 et 0,99', () => {
    const m = mpvMargins({ left: -50, top: 0, width: 5000, height: 100 }, WIN);
    expect(m.left).toBe(0);
    expect(m.right).toBe(0);
    expect(m.bottom).toBeLessThanOrEqual(0.99);
  });

  it('noms des propriétés mpv', () => {
    expect(marginProps({ left: 0.1, right: 0.2, top: 0.3, bottom: 0.4 })).toEqual([
      ['video-margin-ratio-left', 0.1], ['video-margin-ratio-right', 0.2], ['video-margin-ratio-top', 0.3], ['video-margin-ratio-bottom', 0.4],
    ]);
  });
});

describe('clip-path', () => {
  it('rectangle plein + trou arrondi en evenodd', () => {
    const c = holeClipPath({ width: 1920, height: 1080 }, { left: 1474, top: 819, width: 422, height: 237 }, 12);
    expect(c.startsWith("path(evenodd, 'M0 0H1920V1080H0Z ")).toBe(true);
    expect(c.endsWith("Z')")).toBe(true);
    expect(c).toContain('A12 12 0 0 1'); // coins arrondis
    expect(c.match(/Z/g)).toHaveLength(2); // deux sous-chemins
  });

  it('le trou est exprimé dans le repère de l’élément', () => {
    const c = holeClipFor({ left: 0, top: -300, width: 1920, height: 2000 }, { left: 1474, top: 819, width: 422, height: 237 }, 0);
    // top du trou = 819 - (-300) = 1119
    expect(c).toContain('M1474 1119H1896V1356H1474Z');
  });

  it('le rayon est borné à la moitié du plus petit côté', () => {
    expect(roundedRectPath({ left: 0, top: 0, width: 20, height: 10 }, 99)).toContain('A5 5');
  });
});

describe('touche I', () => {
  it('réduit le plein lecteur (plus le panneau d’infos)', () => {
    const ctx = { panelOpen: false, typing: false, onButton: false };
    expect(keyToAction('i', ctx)).toEqual({ type: 'mini' });
    expect(keyToAction('I', ctx)).toEqual({ type: 'mini' });
    expect(keyToAction('i', { ...ctx, typing: true })).toBeNull();
    expect(keyToAction('i', ctx, { ctrl: true })).toBeNull();
  });
});

describe('retour pendant une lecture (ODY-247)', () => {
  const playing = { canMinimize: true, enabled: true, paused: false, ended: false };

  it('lecture en cours : le retour réduit en miniature sans clic préalable sur « Réduire »', () => {
    expect(exitMode(playing)).toBe('minimize');
  });

  it('en pause, terminée ou sans source réductible : le lecteur se ferme', () => {
    expect(exitMode({ ...playing, paused: true })).toBe('close');
    expect(exitMode({ ...playing, ended: true })).toBe('close');
    expect(exitMode({ ...playing, canMinimize: false })).toBe('close');
  });

  it('réglage désactivé : le retour ferme toujours', () => {
    expect(exitMode({ ...playing, enabled: false })).toBe('close');
  });

  it('réglage « Réduire en miniature en quittant » : activé par défaut, seul « 0 » le coupe', () => {
    expect(MINI_ON_EXIT_KEY).toBe('laststream.player.miniOnExit');
    expect(miniOnExitEnabled(null)).toBe(true);
    expect(miniOnExitEnabled(undefined)).toBe(true);
    expect(miniOnExitEnabled('1')).toBe(true);
    expect(miniOnExitEnabled('0')).toBe(false);
  });
});

describe('état du mini-lecteur', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
  };

  it('coin par défaut en bas à droite, mémorisé puis relu', () => {
    const st = mem();
    const a = new MiniState(st);
    expect(a.corner).toBe('br');
    a.setCorner('tl');
    expect(st.m.get(CORNER_KEY)).toBe('tl');
    expect(new MiniState(st).corner).toBe('tl');
    st.m.set(CORNER_KEY, 'n’importe quoi');
    expect(new MiniState(st).corner).toBe('br');
  });

  it('réduire / agrandir ne signalent que les vrais changements', () => {
    const s = new MiniState();
    const seen: boolean[] = [];
    s.onChange((m) => seen.push(m));
    expect(s.expand()).toBe(false);
    expect(s.minimize()).toBe(true);
    expect(s.minimize()).toBe(false);
    expect(s.expand()).toBe(true);
    expect(seen).toEqual([true, false]);
  });
});

describe('perçage de la page avec mpv', () => {
  beforeEach(() => {
    setWindow(1920, 1080);
    document.body.innerHTML = '<div id="app"></div><div id="detail" hidden></div><div id="toast"></div><div id="lsplayer"></div>';
    const boxes: Record<string, [number, number, number, number]> = { app: [0, 0, 1920, 3000], detail: [0, 0, 1920, 2000], toast: [700, 900, 200, 40], lsplayer: [1474, 819, 422, 237] };
    for (const [id, [l, t, w, h]] of Object.entries(boxes)) {
      const el = document.getElementById(id) as HTMLElement;
      el.getBoundingClientRect = () => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() { return {}; } });
    }
  });
  const engines: MpvEngine[] = [];
  afterEach(() => {
    engines.splice(0).forEach((e) => e.setTransparent(false)); // débranche les écouteurs de la page
    document.body.innerHTML = ''; document.body.removeAttribute('style'); document.documentElement.removeAttribute('style');
  });

  function engine() {
    const sent: Array<[string, unknown[]]> = [];
    const ipc = { send: (n: string, a: unknown) => { sent.push([n, a as unknown[]]); }, on: () => ipc };
    const e = new MpvEngine(ipc, document.getElementById('lsplayer'));
    engines.push(e);
    return { e, sent, margins: () => sent.filter(([n, a]) => n === 'mpv-set-prop' && String(a[0]).startsWith('video-margin')) };
  }
  const mini = { left: 1474, top: 819, width: 422, height: 237 };

  it('plein lecteur : aucune marge, et le moteur ne pose plus visibility (body.lp-covered masque la page en CSS)', () => {
    const { e, margins } = engine();
    e.setTransparent(true);
    expect(document.getElementById('app')!.style.visibility).toBe('');
    expect(document.getElementById('lsplayer')!.style.visibility).toBe('');
    expect(margins()).toHaveLength(0);
  });

  it('mini : la page n’est plus masquée mais percée, mpv reçoit les marges', () => {
    const { e, margins } = engine();
    e.setTransparent(true);
    e.setMini(mini);
    const app = document.getElementById('app')!;
    expect(app.style.visibility).toBe('');
    expect(app.style.clipPath).toContain('evenodd');
    expect(app.style.clipPath).toContain('M0 0H1920V3000H0Z');
    expect(app.style.background).toBe('var(--bg)');
    expect(document.documentElement.style.background).toBe('transparent');
    expect(document.body.style.background).toBe('transparent');
    expect(document.getElementById('detail')!.style.clipPath).toBe(''); // caché : laissé tranquille
    expect(document.getElementById('toast')!.style.clipPath).toBe('');
    expect(document.getElementById('lsplayer')!.style.clipPath).toBe('');
    const m = Object.fromEntries(margins().map(([, a]) => [a[0], a[1]]));
    expect(m['video-margin-ratio-left']).toBeCloseTo(1474 / 1920, 5);
    expect(m['video-margin-ratio-right']).toBeCloseTo(24 / 1920, 5);
    expect(m['video-margin-ratio-top']).toBeCloseTo(819 / 1080, 5);
    expect(m['video-margin-ratio-bottom']).toBeCloseTo(24 / 1080, 5);
  });

  it('un déplacement recalcule marges et découpe ; une position identique n’envoie rien', () => {
    const { e, margins } = engine();
    e.setTransparent(true);
    e.setMini(mini);
    const n = margins().length;
    e.setMini({ ...mini });
    expect(margins()).toHaveLength(n);
    e.setMini({ left: 24, top: 24, width: 422, height: 237 });
    expect(margins().length).toBe(n + 4);
    const got = margins().slice(-4).map(([, a]) => a[1] as number);
    [24 / 1920, 1 - (24 + 422) / 1920, 24 / 1080, 1 - (24 + 237) / 1080].forEach((want, i) => expect(got[i]).toBeCloseTo(want, 5));
    expect(document.getElementById('app')!.style.clipPath).toContain('M36 24'); // coin arrondi : left + rayon
  });

  it('retour au plein lecteur : marges à 0, clip retiré, aucun instantané visibility', () => {
    const { e, margins } = engine();
    e.setTransparent(true);
    e.setMini(mini);
    e.setMini(null);
    const app = document.getElementById('app')!;
    expect(app.style.clipPath).toBe('');
    expect(app.style.background).toBe('');
    expect(app.style.visibility).toBe('');
    expect(margins().slice(-4).map(([, a]) => a[1])).toEqual([0, 0, 0, 0]);
  });

  it('fin de lecture : tout est rendu à la page, marges à 0', () => {
    const { e, margins } = engine();
    e.setTransparent(true);
    e.setMini(mini);
    e.setTransparent(false);
    const app = document.getElementById('app')!;
    expect(app.style.clipPath).toBe('');
    expect(app.style.visibility).toBe('');
    expect(document.body.style.background).toBe('');
    expect(margins().slice(-4).map(([, a]) => a[1])).toEqual([0, 0, 0, 0]);
  });

  it('la découpe suit la page : un conteneur qui apparaît est percé après la navigation', async () => {
    const { e } = engine();
    e.setTransparent(true);
    e.setMini(mini);
    const detail = document.getElementById('detail')!;
    detail.hidden = false;
    window.dispatchEvent(new Event('hashchange'));
    await new Promise((r) => setTimeout(r, 50));
    expect(detail.style.clipPath).toContain('evenodd');
    e.setMini(null);
    expect(detail.style.clipPath).toBe('');
  });
});

describe('cycle réduire → naviguer → agrandir → fermer', () => {
  beforeEach(() => {
    setWindow(1920, 1080);
    document.body.innerHTML = '<div id="app"></div><div id="lsplayer" role="dialog" aria-modal="true" aria-label="Lecteur vidéo"></div>';
    const app = document.getElementById('app')!;
    app.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1920, height: 3000, right: 1920, bottom: 3000, x: 0, y: 0, toJSON() { return {}; } });
    const root = document.getElementById('lsplayer')!;
    // jsdom ne fait pas de mise en page : la boîte du lecteur est celle que miniview a posée en ligne.
    root.getBoundingClientRect = () => {
      const px = (v: string) => parseFloat(v) || 0;
      return { left: px(root.style.left), top: px(root.style.top), width: px(root.style.width), height: px(root.style.height), right: 0, bottom: 0, x: 0, y: 0, toJSON() { return {}; } };
    };
  });
  const engines: MpvEngine[] = [];
  afterEach(() => {
    engines.splice(0).forEach((e) => e.setTransparent(false));
    document.body.innerHTML = ''; document.body.removeAttribute('style'); document.documentElement.removeAttribute('style');
  });

  function setup() {
    const root = document.getElementById('lsplayer') as HTMLElement;
    const state = new MiniState();
    const sent: Array<[string, unknown[]]> = [];
    const ipc = { send: (n: string, a: unknown) => { sent.push([n, a as unknown[]]); }, on: () => ipc };
    const mpv = new MpvEngine(ipc, root);
    engines.push(mpv);
    mpv.p['time-pos'] = 1234; // position de lecture
    mpv.setTransparent(true);
    const actions: string[] = [];
    const view = createMiniView(root, { state, action: (a: string) => actions.push(a), layout: (video: never) => mpv.setMini(video) });
    state.onChange((on) => { if (on) view.enter(); else { view.leave(); } });
    const lastMargins = () => sent.filter(([, a]) => String(a[0]).startsWith('video-margin')).slice(-4).map(([, a]) => a[1] as number);
    const pointer = (type: string, x: number, y: number) => root.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    return { root, state, mpv, view, actions, lastMargins, pointer };
  }

  it('la position de lecture et le coin choisi survivent au cycle ; fermer rend la page', async () => {
    const { root, state, mpv, view, lastMargins, pointer } = setup();
    state.minimize();
    expect(root.classList.contains('is-mini')).toBe(true);
    expect(root.getAttribute('role')).toBe('region');
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('tabindex')).toBe('0');
    expect(root.style.width).toBe('422px');
    expect(lastMargins()[0]).toBeCloseTo((1920 - 24 - 422) / 1920, 5);

    // Glisser vers le coin haut gauche : aimantation à 24 px des bords.
    pointer('pointerdown', 1600, 900);
    pointer('pointermove', 200, 150);
    expect(view.dragging).toBe(true);
    pointer('pointerup', 200, 150);
    expect(state.corner).toBe('tl');
    expect(root.style.left).toBe('24px');
    expect(root.style.top).toBe('24px');
    expect(lastMargins()).toEqual([24 / 1920, 1 - (24 + 422) / 1920, 24 / 1080, 1 - (24 + 237) / 1080].map((v) => Math.round(v * 1e6) / 1e6));

    // Navigation pendant la réduction : la page change, la vignette reste et la lecture n'est pas touchée.
    location.hash = '#/movie/42';
    window.dispatchEvent(new Event('hashchange'));
    await new Promise((r) => setTimeout(r, 30));
    expect(root.classList.contains('is-mini')).toBe(true);
    expect(mpv.p['time-pos']).toBe(1234);
    expect(document.getElementById('app')!.style.clipPath).toContain('evenodd');

    // Agrandir : plein lecteur, marges à 0, boîte rendue au CSS.
    state.expand();
    expect(root.classList.contains('is-mini')).toBe(false);
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.style.left).toBe('');
    expect(lastMargins()).toEqual([0, 0, 0, 0]);
    expect(document.getElementById('app')!.style.visibility).toBe('');
    expect(mpv.p['time-pos']).toBe(1234);

    // Réduire à nouveau : le coin choisi est retrouvé.
    state.minimize();
    expect(state.corner).toBe('tl');
    expect(root.style.left).toBe('24px');
    expect(root.style.top).toBe('24px');

    // Fermer (fin de session) : plein lecteur, puis le moteur rend la page.
    state.reset();
    mpv.destroy();
    expect(root.classList.contains('is-mini')).toBe(false);
    expect(document.getElementById('app')!.style.clipPath).toBe('');
    expect(document.getElementById('app')!.style.visibility).toBe('');
    expect(lastMargins()).toEqual([0, 0, 0, 0]);
    expect(state.corner).toBe('tl'); // le coin reste mémorisé pour la prochaine fois
  });

  it('un simple clic n’est pas un glissement ; un glissement ne déclenche pas « agrandir »', () => {
    const { root, state, view, pointer } = setup();
    state.minimize();
    pointer('pointerdown', 1600, 900);
    pointer('pointerup', 1600, 900);
    expect(view.dragging).toBe(false);
    expect(state.corner).toBe('br');
    pointer('pointerdown', 1600, 900);
    pointer('pointermove', 100, 100);
    pointer('pointerup', 100, 100);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    const spy = vi.fn();
    root.addEventListener('click', spy);
    root.dispatchEvent(click);
    expect(spy).not.toHaveBeenCalled(); // avalé par la garde anti-clic de fin de glissement
  });

  it('fenêtre étroite : barre mobile, pas de glissement', () => {
    setWindow(400, 800);
    const { root, state, pointer } = setup();
    state.minimize();
    expect(root.classList.contains('is-bar')).toBe(true);
    expect(root.style.left).toBe('0px');
    expect(root.style.width).toBe('400px');
    expect(root.style.height).toBe(BAR_HEIGHT + 'px');
    pointer('pointerdown', 300, 780);
    pointer('pointermove', 20, 20);
    pointer('pointerup', 20, 20);
    expect(state.corner).toBe('br');
    expect(root.style.top).toBe(800 - BAR_HEIGHT + 'px');
  });

  it('accessibilité : région nommée avec le titre, boutons en français', () => {
    const { root, state, view } = setup();
    view.setTitle('Dune', 'S1:É2');
    state.minimize();
    expect(root.getAttribute('aria-label')).toBe('Mini-lecteur : Dune');
    const labels = Array.from(root.querySelectorAll('.lp-mini button')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['Agrandir le lecteur (I)', 'Fermer le lecteur', 'Lecture']));
    view.update({ time: 30, duration: 120, paused: false });
    expect(root.querySelector('.lp-mini-play')!.getAttribute('aria-label')).toBe('Pause');
    expect(root.querySelector('.lp-mini-prog')!.getAttribute('aria-valuenow')).toBe('25');
  });

  it('Entrée sur la vignette focalisée l’agrandit', () => {
    const { root, state, actions } = setup();
    state.minimize();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(actions).toContain('expand');
  });
});
