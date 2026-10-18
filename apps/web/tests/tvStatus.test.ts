// Signal d'état du lecteur TV (« Connexion… », « En direct », « Son seul », « Chaîne indisponible ») et transparence de la
// page pendant la lecture mpv. Logique pure dans src/ui/tvStatus.js ; transparence dans src/ui/tvExternal.js (DOM simulé).
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIO_ONLY_MS, LABELS, reasonOfExternal, reasonOfHls, reduceTvStatus, renderTvStatus, initialStatus, statusView } from '../src/ui/tvStatus.js';
import { externalSample, setTvTransparent, stopExternal } from '../src/ui/tvExternal.js';

const T0 = 1_000_000;
const sample = (state: ReturnType<typeof initialStatus>, now: number, time: number, hasVideo: boolean, paused = false) =>
  reduceTvStatus(state, { type: 'sample', now, time, hasVideo, paused });

describe('état du lecteur TV (fonction pure)', () => {
  it('commence à « Connexion à la chaîne… » et reste sur ce libellé tant que rien n’avance', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'connect' });
    expect(statusView(s)).toEqual({ tone: 'loading', text: 'Connexion à la chaîne…', reason: '' });
    s = sample(s, T0, 0, true);
    s = sample(s, T0 + 1000, 0, true); // position immobile : pas de « En direct »
    expect(statusView(s).text).toBe('Connexion à la chaîne…');
  });

  it('passe à « En direct » quand l’image avance', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'connect' });
    s = sample(s, T0, 10, true);
    s = sample(s, T0 + 1000, 11, true);
    expect(s.phase).toBe('live');
    expect(statusView(s)).toEqual({ tone: 'live', text: 'En direct', reason: '' });
  });

  it('annonce « Son seul — pas d’image » seulement après 5 s de son qui avance sans image', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'connect' });
    s = sample(s, T0, 10, false);
    s = sample(s, T0 + 1000, 11, false); // début : une image peut encore arriver
    expect(s.phase).toBe('connecting');
    s = sample(s, T0 + 1000 + AUDIO_ONLY_MS - 1000, 15, false);
    expect(s.phase).toBe('connecting');
    s = sample(s, T0 + 1000 + AUDIO_ONLY_MS, 16, false);
    expect(s.phase).toBe('audio');
    expect(statusView(s)).toEqual({ tone: 'warn', text: "Son seul — pas d'image", reason: '' });
  });

  it('une image qui arrive après le son repasse en « En direct » et remet le délai à zéro', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'connect' });
    s = sample(s, T0, 1, false);
    s = sample(s, T0 + 1000, 2, false);
    s = sample(s, T0 + 6000, 3, false);
    expect(s.phase).toBe('audio');
    s = sample(s, T0 + 7000, 4, true);
    expect(s.phase).toBe('live');
    s = sample(s, T0 + 8000, 5, false); // le délai repart de cet instant
    expect(s.phase).toBe('connecting');
  });

  it('une lecture en pause ne change pas l’état', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'connect' });
    s = sample(s, T0, 1, true);
    s = sample(s, T0 + 1000, 2, true);
    const paused = sample(s, T0 + 2000, 9, false, true);
    expect(paused).toEqual(s);
  });

  it('un échec affiche « Chaîne indisponible » avec la raison, et reste affiché aux échantillons suivants', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'connect' });
    s = reduceTvStatus(s, { type: 'fail', reason: 'refused' });
    expect(statusView(s)).toEqual({ tone: 'error', text: 'Chaîne indisponible', reason: 'Flux refusé (accès ou CORS)' });
    s = sample(s, T0, 1, true);
    s = sample(s, T0 + 1000, 2, true);
    expect(s.phase).toBe('failed');
  });

  it('une raison inconnue retombe sur « Erreur de lecture »', () => {
    const s = reduceTvStatus(initialStatus(), { type: 'fail', reason: 'n-importe-quoi' });
    expect(statusView(s).reason).toBe('Erreur de lecture');
  });

  it('une nouvelle tentative efface l’échec ; la fermeture remet le signal à vide', () => {
    let s = reduceTvStatus(initialStatus(), { type: 'fail', reason: 'network' });
    s = reduceTvStatus(s, { type: 'connect' });
    expect(s.phase).toBe('connecting');
    s = reduceTvStatus(s, { type: 'stop' });
    expect(statusView(s)).toEqual({ tone: '', text: '', reason: '', hidden: true });
  });

  it('les échantillons arrivant avant toute tentative ne font rien', () => {
    const s = sample(initialStatus(), T0, 5, true);
    expect(s.phase).toBe('idle');
  });
});

describe('libellés', () => {
  it('sont en français, avec les textes attendus', () => {
    expect(LABELS).toEqual({
      connecting: 'Connexion à la chaîne…',
      live: 'En direct',
      audio: "Son seul — pas d'image",
      failed: 'Chaîne indisponible',
    });
  });

  it('raisons d’échec : réseau, flux refusé ou CORS, format, lecture', () => {
    const reason = (r: string) => statusView(reduceTvStatus(initialStatus(), { type: 'fail', reason: r })).reason;
    expect(reason('network')).toBe('Problème réseau');
    expect(reason('refused')).toBe('Flux refusé (accès ou CORS)');
    expect(reason('format')).toBe('Format non pris en charge');
    expect(reason('read')).toBe('Erreur de lecture');
  });

  it('reconnaît la raison d’une erreur mpv ou du plugin natif', () => {
    expect(reasonOfExternal(new Error('mpv:HTTP error 403 Forbidden'))).toBe('refused');
    expect(reasonOfExternal(new Error('mpv:Failed to recognize file format.'))).toBe('format');
    expect(reasonOfExternal(new Error('mpv:loading failed'))).toBe('network');
    expect(reasonOfExternal({ code: 'NETWORK' })).toBe('network');
    expect(reasonOfExternal(undefined)).toBe('read');
  });

  it('reconnaît la raison d’une erreur hls.js (refus HTTP, CORS sur le web, réseau, média)', () => {
    const types = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    expect(reasonOfHls({ type: 'networkError', response: { code: 403 } }, types, true)).toBe('refused');
    expect(reasonOfHls({ type: 'networkError', response: { code: 0 } }, types, true)).toBe('refused');
    expect(reasonOfHls({ type: 'networkError' }, types, false)).toBe('network');
    expect(reasonOfHls({ type: 'networkError', response: { code: 503 } }, types, true)).toBe('network');
    expect(reasonOfHls({ type: 'mediaError' }, types, true)).toBe('format');
  });
});

describe('rendu du signal', () => {
  const el = () => document.createElement('div');

  it('affiche le libellé avec une pastille ou un spinner, et la raison en cas d’échec', () => {
    const e = el();
    renderTvStatus(e, statusView({ phase: 'live', time: 1, since: null, reason: '' } as ReturnType<typeof initialStatus>));
    expect(e.hidden).toBe(false);
    expect(e.dataset.tone).toBe('live');
    expect(e.querySelector('.ps-dot')).not.toBeNull();
    expect(e.querySelector('.ps-text')!.textContent).toBe('En direct');
    renderTvStatus(e, statusView({ phase: 'connecting', time: -1, since: null, reason: '' } as ReturnType<typeof initialStatus>));
    expect(e.querySelector('.ps-spin')).not.toBeNull();
    renderTvStatus(e, statusView({ phase: 'failed', time: -1, since: null, reason: 'format' }));
    expect(e.querySelector('.ps-text')!.textContent).toBe('Chaîne indisponible');
    expect(e.querySelector('.ps-reason')!.textContent).toBe('Format non pris en charge');
  });

  it('se masque à l’arrêt et ne redessine pas un état inchangé (pas de nouvelle annonce aria-live)', () => {
    const e = el();
    renderTvStatus(e, statusView(initialStatus()));
    expect(e.hidden).toBe(true);
    renderTvStatus(e, statusView({ phase: 'live', time: 1, since: null, reason: '' } as ReturnType<typeof initialStatus>));
    const first = e.querySelector('.ps-text');
    renderTvStatus(e, statusView({ phase: 'live', time: 2, since: null, reason: '' } as ReturnType<typeof initialStatus>));
    expect(e.querySelector('.ps-text')).toBe(first);
  });
});

describe('transparence de la page pendant la lecture mpv', () => {
  // Structure proche de index.html : la page (#app), le lecteur TV (#player) avec sa <video> et sa bannière, et un toast.
  let app: HTMLElement;
  let toast: HTMLElement;
  let player: HTMLElement;
  let video: HTMLVideoElement;
  let banner: HTMLElement;

  function build() {
    document.body.innerHTML = '';
    document.body.style.background = 'rgb(1, 2, 3)';
    document.documentElement.style.background = '';
    app = document.createElement('main');
    app.id = 'app';
    app.style.visibility = '';
    toast = document.createElement('div');
    toast.id = 'toast';
    player = document.createElement('div');
    player.id = 'player';
    player.style.background = '#000';
    video = document.createElement('video');
    banner = document.createElement('div');
    banner.id = 'player-banner';
    player.append(video, banner);
    document.body.append(app, player, toast);
  }

  afterEach(() => { setTvTransparent(false); });

  it('applique la transparence au lecteur, à ses ancêtres, à body et html, et masque le reste de la page et la vidéo HTML5', () => {
    build();
    setTvTransparent(true, player);
    expect(player.style.background).toBe('transparent');
    expect(document.body.style.background).toBe('transparent');
    expect(document.documentElement.style.background).toBe('transparent');
    expect(app.style.visibility).toBe('hidden');
    expect(toast.style.visibility).toBe('hidden');
    expect(video.style.visibility).toBe('hidden');
    expect(banner.style.visibility).toBe(''); // la bannière du lecteur reste visible
    expect(player.style.visibility).toBe('');
  });

  it('restaure exactement les styles d’origine à l’arrêt', () => {
    build();
    app.style.visibility = 'collapse'; // un style déjà posé avant la lecture doit revenir tel quel
    setTvTransparent(true, player);
    setTvTransparent(false);
    expect(player.style.background).toBe('rgb(0, 0, 0)'); // jsdom normalise #000
    expect(document.body.style.background).toBe('rgb(1, 2, 3)');
    expect(document.documentElement.style.background).toBe('');
    expect(app.style.visibility).toBe('collapse');
    expect(toast.style.visibility).toBe('');
    expect(video.style.visibility).toBe('');
  });

  it('est idempotente : appliquer deux fois ne fausse pas la restauration', () => {
    build();
    setTvTransparent(true, player);
    setTvTransparent(true, player);
    setTvTransparent(false);
    expect(player.style.background).toBe('rgb(0, 0, 0)'); // jsdom normalise #000
    expect(app.style.visibility).toBe('');
    expect(video.style.visibility).toBe('');
  });

  it('stopExternal restaure la page ; sans lecture externe, rien ne change', () => {
    build();
    setTvTransparent(true, player);
    stopExternal();
    expect(player.style.background).toBe('rgb(0, 0, 0)'); // jsdom normalise #000
    expect(app.style.visibility).toBe('');
    expect(externalSample()).toBeNull();
  });
});
