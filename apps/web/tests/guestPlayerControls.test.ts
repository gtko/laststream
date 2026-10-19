// Commandes de la page invitée (src/ui/guestplayer.js) : actions transmises au salon, affichage du temps et de la progression,
// raccourcis clavier, plein écran sur le cadre, masquage automatique, panneau « i », attente, extensions (menu, badge, calques).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuestControls, IDLE_MS } from '../src/ui/guestplayer.js';

type Controls = any;

let stages: HTMLElement[] = [];
let controls: Controls[] = [];

/** Cadre vidéo factice (comme celui de la page) avec une fausse fonction plein écran. */
function makeStage(withFullscreen = true): HTMLElement {
  const stage = document.createElement('div');
  if (withFullscreen) (stage as any).requestFullscreen = vi.fn(() => Promise.resolve());
  document.body.appendChild(stage);
  stages.push(stage);
  return stage;
}

function mount(handlers: Record<string, unknown> = {}, withFullscreen = true): { stage: HTMLElement; c: Controls; root: HTMLElement } {
  const stage = makeStage(withFullscreen);
  const c = createGuestControls(stage, handlers as any);
  controls.push(c);
  return { stage, c, root: c.root as HTMLElement };
}

const key = (k: string, target: EventTarget = document.body) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};
const q = (root: HTMLElement, sel: string) => root.querySelector(sel) as HTMLElement & { value?: string };
const spy = () => vi.fn();

beforeEach(() => {
  stages = [];
  controls = [];
});

afterEach(() => {
  for (const c of controls) c.destroy();
  for (const s of stages) s.remove();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('lecture et pause', () => {
  it('bouton et touches K / espace transmettent play ou pause selon l’état, et rien tant que le salon n’est pas prêt', () => {
    const onPlay = spy();
    const onPause = spy();
    const { c, root } = mount({ onPlay, onPause });

    // Pas prêt : le bouton est désactivé et les touches ne font rien.
    q(root, '[data-gp="play"]').click();
    key(' ');
    expect(onPlay).not.toHaveBeenCalled();

    c.setState({ ready: true, duration: 100, position: 10, playing: false });
    expect((q(root, '[data-gp="play"]') as HTMLButtonElement).disabled).toBe(false);
    q(root, '[data-gp="play"]').click();
    expect(onPlay).toHaveBeenCalledTimes(1);
    key('k');
    expect(onPlay).toHaveBeenCalledTimes(2);

    c.setState({ playing: true });
    q(root, '[data-gp="play"]').click();
    expect(onPause).toHaveBeenCalledTimes(1);
    key(' ');
    expect(onPause).toHaveBeenCalledTimes(2);
    expect(onPlay).toHaveBeenCalledTimes(2);
  });

  it('affiche le temps écoulé / la durée (h:mm:ss au-delà d’une heure) et la progression', () => {
    const { c, root } = mount({});
    c.setState({ ready: true, duration: 3725, position: 65, playing: true });
    expect(q(root, '.gp-time, [data-gp="time"]').textContent).toBe('1:05 / 1:02:05');
    expect(parseFloat(q(root, '.lp-played').style.width)).toBeCloseTo((65 / 3725) * 100, 3);
    expect(q(root, '[data-gp="seek"]').getAttribute('aria-valuetext')).toBe('1:05');
  });
});

describe('sauts', () => {
  it('flèches ±5 s bornées à [0, durée] ; boutons -10 s / +10 s', () => {
    const onSeek = spy();
    const { c, root } = mount({ onSeek, onPlay: spy(), onPause: spy() });
    c.setState({ ready: true, duration: 100, position: 3, playing: false });

    key('ArrowLeft');
    expect(onSeek).toHaveBeenLastCalledWith(0);
    // Le saut est affiché tout de suite : l'appui suivant part de 0 (et non de 3) en attendant l'état du salon.
    key('ArrowRight');
    expect(onSeek).toHaveBeenLastCalledWith(5);

    c.setState({ position: 98 });
    key('ArrowRight');
    expect(onSeek).toHaveBeenLastCalledWith(100);

    c.setState({ position: 50 });
    q(root, '[data-gp="back"]').click();
    expect(onSeek).toHaveBeenLastCalledWith(40);
    c.setState({ position: 50 });
    q(root, '[data-gp="fwd"]').click();
    expect(onSeek).toHaveBeenLastCalledWith(60);
  });

  it('barre de progression : glisser puis relâcher saute à la position relevée', () => {
    const onSeek = spy();
    const { c, root } = mount({ onSeek });
    c.setState({ ready: true, duration: 200, position: 0, playing: false });
    const seek = q(root, '[data-gp="seek"]');
    seek.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, right: 200, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    seek.dispatchEvent(new MouseEvent('pointerdown', { clientX: 50, bubbles: true }));
    seek.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, bubbles: true }));
    expect(onSeek).not.toHaveBeenCalled();
    seek.dispatchEvent(new MouseEvent('pointerup', { clientX: 150, bubbles: true }));
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(150);
  });
});

describe('plein écran', () => {
  it('touche F et bouton appellent requestFullscreen sur le cadre (pas sur la vidéo seule)', () => {
    const { stage, root } = mount({});
    const canvas = document.createElement('canvas');
    stage.prepend(canvas);
    key('f');
    expect((stage as any).requestFullscreen).toHaveBeenCalledTimes(1);
    q(root, '[data-gp="full"]').click();
    expect((stage as any).requestFullscreen).toHaveBeenCalledTimes(2);
  });

  it('double-clic sur la vidéo : plein écran sur le cadre, sans compter le second clic comme une pause', () => {
    const onPlay = spy();
    const onPause = spy();
    const { stage, c } = mount({ onPlay, onPause });
    c.setState({ ready: true, duration: 100, position: 0, playing: false });
    const canvas = document.createElement('canvas');
    stage.prepend(canvas);
    canvas.click();
    canvas.click();
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect((stage as any).requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('sans API plein écran sur le cadre, le bouton est masqué', () => {
    const { root } = mount({}, false);
    expect(q(root, '[data-gp="full"]').hidden).toBe(true);
  });
});

describe('masquage automatique', () => {
  it('se masque après 3 s sans mouvement pendant la lecture, se réaffiche au mouvement, reste visible en pause', () => {
    vi.useFakeTimers();
    const { stage, c } = mount({ onPlay: spy(), onPause: spy() });
    expect(IDLE_MS).toBe(3000);
    c.setState({ ready: true, duration: 100, position: 0, playing: true });
    expect(stage.classList.contains('is-ui')).toBe(true);

    vi.advanceTimersByTime(2999);
    expect(stage.classList.contains('is-ui')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(stage.classList.contains('is-ui')).toBe(false);

    stage.dispatchEvent(new Event('pointermove'));
    expect(stage.classList.contains('is-ui')).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(stage.classList.contains('is-ui')).toBe(false);

    c.setState({ playing: false });
    expect(stage.classList.contains('is-ui')).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(stage.classList.contains('is-ui')).toBe(true);
  });

  it('le panneau « i » ouvert garde les commandes visibles', () => {
    vi.useFakeTimers();
    const { stage, c, root } = mount({});
    c.setState({ ready: true, duration: 100, position: 0, playing: true });
    q(root, '[data-gp="info"]').click();
    vi.advanceTimersByTime(10000);
    expect(stage.classList.contains('is-ui')).toBe(true);
  });
});

describe('volume et sourdine', () => {
  it('sans handler de volume, le réglage n’apparaît pas et M ne fait rien', () => {
    const { root } = mount({ onPlay: spy() });
    expect(q(root, '[data-gp="vol"]').hidden).toBe(true);
    // M sans handler : aucune erreur, le bouton de sourdine reste inactif (rien à régler).
    expect(() => key('m')).not.toThrow();
  });

  it('avec handlers : M bascule la sourdine, le curseur transmet le volume 0..1', () => {
    const onMute = spy();
    const onVolume = spy();
    const { root } = mount({ onMute, onVolume });
    expect(q(root, '[data-gp="vol"]').hidden).toBe(false);
    key('M');
    expect(onMute).toHaveBeenLastCalledWith(true);
    key('m');
    expect(onMute).toHaveBeenLastCalledWith(false);

    const slider = q(root, '[data-gp="volume"]') as HTMLInputElement;
    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    expect(onVolume).toHaveBeenLastCalledWith(0.4);
  });
});

describe('panneau « i »', () => {
  it('affiche débit, octets, codecs et tampon ; « — » pour ce qui manque, et s’ouvre / se ferme', () => {
    const { root, c } = mount({});
    c.setInfo({ rate: 4194304, bytesHost: 2097152, bytesPeers: undefined, videoCodec: 'avc', audioCodec: null, bufferAhead: 12.4 });
    const val = (k: string) => q(root, '[data-gp-info="' + k + '"]').textContent;
    expect(val('rate')).toBe('4,0 Mo/s');
    expect(val('bytesHost')).toBe('2,0 Mo');
    expect(val('bytesPeers')).toBe('—');
    expect(val('videoCodec')).toBe('AVC');
    expect(val('audioCodec')).toBe('—');
    expect(val('bufferAhead')).toBe('12 s');

    const info = q(root, '.gp-info');
    expect(info.hidden).toBe(true);
    q(root, '[data-gp="info"]').click();
    expect(info.hidden).toBe(false);
    expect(q(root, '[data-gp="info"]').getAttribute('aria-expanded')).toBe('true');
    q(root, '[data-gp="info"]').click();
    expect(info.hidden).toBe(true);
  });

  it('Échap ferme le panneau ouvert', () => {
    const { root } = mount({});
    q(root, '[data-gp="info"]').click();
    expect(q(root, '.gp-info').hidden).toBe(false);
    key('Escape');
    expect(q(root, '.gp-info').hidden).toBe(true);
  });
});

describe('attente, tampon et extensions', () => {
  it('bandeau d’attente et spinner de tampon', () => {
    const { root, c } = mount({});
    c.setWait('En attente de l’hôte…');
    expect(q(root, '.gp-wait').hidden).toBe(false);
    expect(q(root, '.gp-wait-t').textContent).toBe('En attente de l’hôte…');
    c.setWait(null);
    expect(q(root, '.gp-wait').hidden).toBe(true);

    expect(q(root, '.gp-spin').hidden).toBe(true);
    c.setBuffering(true);
    expect(q(root, '.gp-spin').hidden).toBe(false);
    c.setBuffering(false);
    expect(q(root, '.gp-spin').hidden).toBe(true);
  });

  it('bouton de menu ajouté, pastille de chat, calques des sous-titres et du tiroir exposés', () => {
    const onClick = spy();
    const { stage, c, root } = mount({});
    const btn = c.addMenuButton({ id: 'chat', icon: '<svg viewBox="0 0 24 24"></svg>', label: 'Chat', onClick });
    expect(btn.getAttribute('aria-label')).toBe('Chat');
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    c.setChatBadge(3);
    expect(btn.querySelector('.gp-badge')?.textContent).toBe('3');
    c.setChatBadge(0);
    expect((btn.querySelector('.gp-badge') as HTMLElement).hidden).toBe(true);

    expect(stage.contains(c.subtitleLayer)).toBe(true);
    expect(stage.contains(c.sideSlot)).toBe(true);
    expect(root.querySelector('.gp-menu')?.contains(btn)).toBe(true);
  });
});

describe('clavier et cycle de vie', () => {
  it('les touches ne pilotent pas la lecture pendant la saisie dans un champ', () => {
    const onPlay = spy();
    const { c } = mount({ onPlay });
    c.setState({ ready: true, duration: 100, position: 0, playing: false });
    const input = document.createElement('input');
    document.body.appendChild(input);
    key(' ', input);
    key('k', input);
    expect(onPlay).not.toHaveBeenCalled();
    input.remove();
  });

  it('destroy retire l’overlay, la classe du cadre et les écouteurs clavier', () => {
    const onPlay = spy();
    const { stage, c } = mount({ onPlay });
    c.setState({ ready: true, duration: 100, position: 0, playing: false });
    c.destroy();
    expect(stage.querySelector('.gp')).toBeNull();
    expect(stage.classList.contains('gp-host')).toBe(false);
    key('k');
    expect(onPlay).not.toHaveBeenCalled();
  });
});
