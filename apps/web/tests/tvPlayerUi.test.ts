// Lecteur TV : panneau « Infos » (bouton, touche I, Échap, croix), badge DIRECT (lecture OK seulement), barre et cartouche
// qui se masquent après 3 s sans activité. Charge le vrai balisage de index.html ; la vidéo est simulée (pas de navigateur).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/data/lt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/lt')>()),
  tvEpg: vi.fn(async () => []),
}));

type PlayerMod = typeof import('../src/ui/player.js');
type TvMod = typeof import('../src/ui/tv.js');
let player: PlayerMod;
let tvMod: TvMod;

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const playerEl = () => $('#player');
const isIdle = () => playerEl().classList.contains('is-idle');
const key = (k: string) => player.playerKey(new KeyboardEvent('keydown', { key: k }));

// État simulé de la balise vidéo : pause et présence d'image (l'heure avance alors avec le temps réel).
const vs = { paused: false, live: false };

const NOW = () => Math.floor(Date.now() / 1000);
const chan = {
  id: 'tf1', name: 'TF1', logo: '', url: 'https://up.example/tf1.mp4', source: 'freetv', epgId: 'tf1', alternatives: [],
  flaky: false, fast: false, cat: 'Généraliste', categories: [], num: 1,
};

function guide() {
  const n = NOW();
  const p = (title: string, start: number, stop: number, desc?: string) => ({ title, start, stop, desc });
  return [
    p('Journal', n - 600, n + 600, 'Les infos du jour'),
    p('Série', n + 600, n + 1800),
    p('Film', n + 1800, n + 7200, 'Un film'),
    p('Météo', n + 7200, n + 7800),
    p('Débat', n + 7800, n + 9000),
    p('Tard', n + 9000, n + 9600),
  ];
}

function stubVideo() {
  const v = $('#player-video') as HTMLVideoElement;
  Object.defineProperty(v, 'paused', { configurable: true, get: () => vs.paused });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => (vs.live ? 1280 : 0) });
  Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => (vs.live ? 720 : 0) });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: () => (vs.live ? Date.now() / 1000 : 0) });
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  for (const name of ['play', 'pause', 'load'] as const) {
    Object.defineProperty(HTMLMediaElement.prototype, name, { configurable: true, value: () => (name === 'play' ? Promise.resolve() : undefined) });
  }
  // player.js d'abord : tv.js importe (par shows.js) player.js ; dans l'autre sens, playerEl n'est pas encore défini.
  player = await import('../src/ui/player.js');
  tvMod = await import('../src/ui/tv.js');
  stubVideo();
});

afterEach(() => {
  player.closePlayer(true);
  vi.useRealTimers();
  vs.paused = false;
  vs.live = false;
});

describe('panneau « Infos »', () => {
  it('le bouton i ouvre la chaîne, le programme, les suivants et les infos techniques ; un second clic ferme', () => {
    tvMod.tv.epg.set('tf1', guide());
    player.openPlayer(chan, [chan], null);
    const info = $('#player-info');
    expect(info.hidden).toBe(true);

    $('[data-pinfo]').click();
    expect(info.hidden).toBe(false);
    expect(info.textContent).toContain('TF1');
    expect(info.textContent).toContain('Chaîne 1');
    expect(info.textContent).toContain('Journal');
    expect(info.textContent).toContain('Les infos du jour');
    ['Série', 'Film', 'Météo', 'Débat'].forEach((t) => expect(info.textContent).toContain(t));
    expect(info.textContent).not.toContain('Tard'); // quatre programmes suivants au plus
    expect(info.textContent).toContain('Source');
    expect($('[data-pinfo]').getAttribute('aria-pressed')).toBe('true');

    $('[data-pinfo]').click();
    expect(info.hidden).toBe(true);
    expect($('[data-pinfo]').getAttribute('aria-pressed')).toBe('false');
    expect(playerEl().hidden).toBe(false);
  });

  it('la touche I ouvre et ferme ; la croix du panneau ferme aussi ; Échap ferme les infos avant le lecteur', () => {
    tvMod.tv.epg.set('tf1', guide());
    player.openPlayer(chan, [chan], null);
    expect(key('i')).toBe(true);
    expect($('#player-info').hidden).toBe(false);
    expect(key('I')).toBe(true);
    expect($('#player-info').hidden).toBe(true);

    key('i');
    $('[data-pinfo-close]').click();
    expect($('#player-info').hidden).toBe(true);

    key('i');
    expect(key('Escape')).toBe(true);
    expect($('#player-info').hidden).toBe(true);
    expect(playerEl().hidden).toBe(false); // le lecteur reste ouvert
    key('Escape');
    expect(playerEl().hidden).toBe(true);
  });

  it('le panneau remplace la liste des chaînes et ne laisse qu’un panneau ouvert', () => {
    player.openPlayer(chan, [chan], null);
    $('[data-plist]').click();
    expect($('#player-panel').hidden).toBe(false);
    expect($('#player-panel').textContent).toContain('TF1');
    $('[data-pinfo]').click();
    expect($('#player-panel').hidden).toBe(true);
    expect($('#player-info').hidden).toBe(false);
  });
});

describe('badge DIRECT et pastille', () => {
  it('le badge DIRECT n’apparaît qu’une fois l’image en train d’avancer ; la pastille « Connexion » disparaît alors', () => {
    vi.useFakeTimers();
    player.openPlayer(chan, [chan], null);
    expect($('#player-live').hidden).toBe(true);
    expect($('#player-status').hidden).toBe(false);
    expect($('#player-status').textContent).toContain('Connexion à la chaîne');

    vs.live = true;
    vi.advanceTimersByTime(3000);
    expect($('#player-live').hidden).toBe(false);
    expect($('#player-live').textContent).toBe('DIRECT');
    expect($('#player-status').hidden).toBe(true);
    expect($('#player-chname').textContent).toBe('TF1');
  });

  it('en pause, le badge DIRECT n’est pas affiché', () => {
    vi.useFakeTimers();
    vs.live = true;
    player.openPlayer(chan, [chan], null);
    vi.advanceTimersByTime(3000);
    expect($('#player-live').hidden).toBe(false);
    vs.paused = true;
    vi.advanceTimersByTime(2000);
    expect($('#player-live').hidden).toBe(true);
  });
});

describe('masquage automatique de la barre et du cartouche', () => {
  it('se masquent 3 s après la dernière activité, reviennent au mouvement, et restent visibles en pause ou panneau ouvert', () => {
    vi.useFakeTimers();
    player.openPlayer(chan, [chan], null);
    expect(isIdle()).toBe(false);
    vi.advanceTimersByTime(2500);
    expect(isIdle()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(isIdle()).toBe(true);

    playerEl().dispatchEvent(new Event('pointermove'));
    expect(isIdle()).toBe(false);

    vs.paused = true;
    playerEl().dispatchEvent(new Event('pointermove'));
    vi.advanceTimersByTime(5000);
    expect(isIdle()).toBe(false);
    vs.paused = false;

    $('[data-pinfo]').click();
    vi.advanceTimersByTime(5000);
    expect(isIdle()).toBe(false);
    $('[data-pinfo]').click();
    vi.advanceTimersByTime(3500);
    expect(isIdle()).toBe(true);
  });
});
