// LAST-507 : réouverture de la connexion mpv quand un lien débrideur ralentit (éligibilité, paliers, compteur, fin de réouverture).
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { playView } = vi.hoisted(() => ({ playView: vi.fn(async () => undefined) }));
vi.mock('../src/player/sessionPlay.js', () => ({ playView }));

// Les modules de lecture lisent le DOM de l'interface au chargement : on monte le même squelette que les autres tests.
const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { reopenEligible, reopenLink, reopenTick, reopenTracksEvent } = await import('../src/player/sessionReopen.js');
const { S } = await import('../src/player/sessionState.js');

const MIN = 60_000;
const T0 = Date.parse('2026-10-27T10:00:00Z');
const LINK = 'https://debrid.test/f.mkv';

/** Moteur mpv factice : position figée à `time`, deux pistes audio (la 2 est choisie), appels de chargement et de sélection. */
function fakeMpv(time = 100) {
  return {
    kind: 'mpv',
    state: () => ({ time, duration: 3600, paused: false, ended: false, seeking: false, buffering: false, cacheTime: 5 }),
    audioTracks: () => [{ id: '1', selected: false }, { id: '2', selected: true }],
    subtitleTracks: (): Array<{ id: string; selected: boolean }> => [],
    load: vi.fn(async () => undefined),
    setAudioTrack: vi.fn(),
    setSubtitleTrack: vi.fn(),
    supportsSecondary: () => true,
    setSecondarySubtitleTrack: vi.fn(),
  };
}

/** Session factice : les champs lus par sessionReopen.js, surchargés au besoin. */
function session(over: Record<string, unknown> = {}) {
  const base = {
    engine: fakeMpv(),
    mediaUrl: LINK,
    mediaProxied: false,
    view: { index: 0, stream: {} },
    subs: { native: false, native2: false, selectedId: null as string | null, secondaryId: null as string | null, swapped: false },
    watch: { reset: vi.fn() },
    slowLink: { reset: vi.fn(), seeked: vi.fn(), tick: vi.fn(() => 'ok') },
    reopening: false,
  };
  return Object.assign(base, over) as typeof base;
}

/** Relevé du moteur à la position `time`, lecture en cours. */
const tickState = (time: number) => ({ time, paused: false, ended: false, seeking: false, buffering: false, cacheTime: 5 });

beforeEach(() => {
  playView.mockClear();
  Object.assign(S, { ui: { toast: vi.fn() } });
});

describe('éligibilité de la réouverture', () => {
  it('lien HTTPS débridé lu par mpv : éligible', () => {
    expect(reopenEligible(session())).toBe(true);
  });

  it('moteur HTML : non éligible', () => {
    expect(reopenEligible(session({ engine: { kind: 'html' } }))).toBe(false);
  });

  it('serveur local (127.0.0.1, localhost) : non éligible', () => {
    expect(reopenEligible(session({ mediaUrl: 'http://127.0.0.1:11470/hls/x.m3u8' }))).toBe(false);
    expect(reopenEligible(session({ mediaUrl: 'http://localhost:7000/x.mkv' }))).toBe(false);
  });

  it('lien relayé par le serveur (proxied) : non éligible', () => {
    expect(reopenEligible(session({ mediaProxied: true }))).toBe(false);
  });

  it('fichier téléchargé : non éligible', () => {
    expect(reopenEligible(session({ view: { index: 0, stream: {}, local: true } }))).toBe(false);
  });
});

describe('paliers de réouverture', () => {
  it('palier 1 : recharge le même lien à 2 s avant la position, puis réapplique la piste audio et le sous-titre natif', async () => {
    const p = session({ subs: { native: true, native2: false, selectedId: '5', secondaryId: null, swapped: false } });
    expect(await reopenLink(p, T0)).toBe(1);
    expect(p.engine.load).toHaveBeenCalledTimes(1);
    expect(p.engine.load).toHaveBeenCalledWith({ url: LINK, startAt: 98 });
    expect(p.engine.setAudioTrack).toHaveBeenCalledWith('2');
    expect(p.engine.setSubtitleTrack).toHaveBeenCalledWith('5');
    expect(p.slowLink.reset).toHaveBeenCalledWith(T0);
    expect(playView).not.toHaveBeenCalled();
  });

  it('palier 1 : les sous-titres affichés par la page ne sont pas confiés à mpv', async () => {
    const p = session({ subs: { native: false, native2: false, selectedId: '7', secondaryId: null, swapped: false } });
    await reopenLink(p, T0);
    expect(p.engine.setSubtitleTrack).not.toHaveBeenCalled();
    expect(p.engine.setSecondarySubtitleTrack).not.toHaveBeenCalled();
  });

  it('palier 1 : deux sous-titres natifs inversés sont rétablis dans le même ordre (sid et secondary-sid)', async () => {
    const p = session({ subs: { native: true, native2: true, selectedId: '5', secondaryId: '6', swapped: true } });
    await reopenLink(p, T0);
    expect(p.engine.setSubtitleTrack).toHaveBeenCalledWith('6');
    expect(p.engine.setSecondarySubtitleTrack).toHaveBeenCalledWith('5');
  });

  it('troisième réouverture : relance la source courante avec un lien neuf (palier 2)', async () => {
    const p = session();
    await reopenLink(p, T0);
    await reopenLink(p, T0 + MIN);
    expect(await reopenLink(p, T0 + 2 * MIN)).toBe(2);
    expect(playView).toHaveBeenCalledTimes(1);
    expect(playView).toHaveBeenCalledWith(p.view, 100, { fresh: true });
    expect(p.engine.load).toHaveBeenCalledTimes(2);
  });

  it('au-delà de la troisième réouverture, rien ne se passe (le failover prend le relais)', async () => {
    const p = session();
    for (const k of [0, 1, 2]) await reopenLink(p, T0 + k * MIN);
    expect(await reopenLink(p, T0 + 4 * MIN)).toBe(0);
    expect(p.engine.load).toHaveBeenCalledTimes(2);
    expect(playView).toHaveBeenCalledTimes(1);
  });

  it('le compteur repart à zéro après 10 min sans verdict lent', async () => {
    const p = session();
    for (const k of [0, 1, 2]) await reopenLink(p, T0 + k * MIN);
    expect(await reopenLink(p, T0 + 2 * MIN + 10 * MIN + 1000)).toBe(1);
    expect(p.engine.load).toHaveBeenCalledTimes(3);
    expect(playView).toHaveBeenCalledTimes(1);
  });

  it('verdicts ignorés répétés toutes les 5 min : jamais de nouvelle réouverture, le compteur ne repart pas', async () => {
    const p = session();
    for (const k of [0, 1, 2]) await reopenLink(p, T0 + k * MIN);
    for (let k = 1; k <= 12; k++) expect(await reopenLink(p, T0 + 2 * MIN + k * 5 * MIN)).toBe(0);
    expect(p.engine.load).toHaveBeenCalledTimes(2);
    expect(playView).toHaveBeenCalledTimes(1);
  });

  it('10 min sans aucun verdict après des verdicts ignorés : le compteur repart à zéro', async () => {
    const p = session();
    for (const k of [0, 1, 2]) await reopenLink(p, T0 + k * MIN);
    for (let k = 1; k <= 12; k++) await reopenLink(p, T0 + 2 * MIN + k * 5 * MIN);
    expect(await reopenLink(p, T0 + 62 * MIN + 10 * MIN + 1000)).toBe(1);
    expect(p.engine.load).toHaveBeenCalledTimes(3);
  });
});

describe('réouverture et salon (LAST-507)', () => {
  it('pendant le rechargement, aucun seek n\'est envoyé au salon', async () => {
    const { partyAdapter } = await import('../src/player/sessionSocial.js');
    const { playerOf } = await import('../src/party/bridge');
    const { PartyController } = await import('../src/party/controller');
    const media = { t: 100 };
    const engine = { ...fakeMpv(), state: () => ({ ...tickState(media.t), duration: 3600, rate: 1 }) };
    const p = session({ engine });
    let now = T0;
    const client = { state: { playing: true, pos: 100, at: T0, rev: 1 }, status: 'open', isHost: true, control: vi.fn(() => true), serverNow: () => now };
    const ctl = new PartyController(client as never, () => now);
    const tick = () => ctl.tick(playerOf(partyAdapter(p as never)) as never);
    tick(); // mesure avant la réouverture
    now = T0 + 250;
    await reopenLink(p, now);
    media.t = 0; // mpv repart de zéro au rechargement
    now = T0 + 500;
    tick();
    media.t = 98; // puis reprend deux secondes avant la position
    now = T0 + 750;
    tick();
    expect(client.control).not.toHaveBeenCalled();
  });
});

describe('pistes après une réouverture (LAST-507)', () => {
  /** Moteur qui choisit ses pistes par défaut au rechargement : avant, audio 2 et sous-titre 5 (choix de l'utilisateur) ; après, audio 1 et sous-titre 7. */
  const reloaded = () => {
    const engine = fakeMpv();
    let loaded = false;
    engine.load = vi.fn(async () => { loaded = true; });
    engine.audioTracks = () => [{ id: '1', selected: loaded }, { id: '2', selected: !loaded }];
    engine.subtitleTracks = () => [{ id: '5', selected: !loaded }, { id: '7', selected: loaded }];
    return engine;
  };

  it('le premier événement tracks réapplique la piste audio et le sous-titre natif perdus au rechargement', async () => {
    const engine = reloaded();
    const p = session({ engine, subs: { native: true, native2: false, selectedId: '5', secondaryId: null, swapped: false } });
    await reopenLink(p, T0);
    reopenTracksEvent(p, T0 + 100);
    expect(engine.setAudioTrack).toHaveBeenCalledTimes(2);
    expect(engine.setAudioTrack).toHaveBeenLastCalledWith('2');
    expect(engine.setSubtitleTrack).toHaveBeenCalledTimes(2);
    expect(engine.setSubtitleTrack).toHaveBeenLastCalledWith('5');
  });

  it('piste déjà la bonne : rien n\'est réappliqué', async () => {
    const p = session();
    await reopenLink(p, T0);
    reopenTracksEvent(p, T0 + 100);
    expect(p.engine.setAudioTrack).toHaveBeenCalledTimes(1);
  });

  it('une seule fois : les événements suivants ne touchent plus aux pistes', async () => {
    const engine = reloaded();
    const p = session({ engine });
    await reopenLink(p, T0);
    reopenTracksEvent(p, T0 + 100);
    reopenTracksEvent(p, T0 + 200);
    expect(engine.setAudioTrack).toHaveBeenCalledTimes(2);
  });

  it('liste des pistes encore vide : c\'est l\'événement suivant qui applique', async () => {
    const engine = reloaded();
    const p = session({ engine });
    await reopenLink(p, T0);
    const listed = engine.audioTracks;
    engine.audioTracks = () => [];
    reopenTracksEvent(p, T0 + 100);
    expect(engine.setAudioTrack).toHaveBeenCalledTimes(1);
    engine.audioTracks = listed;
    reopenTracksEvent(p, T0 + 200);
    expect(engine.setAudioTrack).toHaveBeenCalledTimes(2);
  });

  it('sous-titre secondaire réappliqué une fois au premier événement', async () => {
    const engine = reloaded();
    const p = session({ engine, subs: { native: true, native2: true, selectedId: '5', secondaryId: '7', swapped: false } });
    await reopenLink(p, T0);
    reopenTracksEvent(p, T0 + 100);
    expect(engine.setSecondarySubtitleTrack).toHaveBeenCalledTimes(2);
    reopenTracksEvent(p, T0 + 200);
    expect(engine.setSecondarySubtitleTrack).toHaveBeenCalledTimes(2);
  });

  it('au-delà de 30 s sans événement, rien n\'est réappliqué (le choix de l\'utilisateur n\'est pas écrasé)', async () => {
    const engine = reloaded();
    const p = session({ engine });
    await reopenLink(p, T0);
    reopenTracksEvent(p, T0 + 31_000);
    expect(engine.setAudioTrack).toHaveBeenCalledTimes(1);
  });
});

describe('saut de position (LAST-507)', () => {
  it('un saut de plus de 3 s entre deux relevés compte comme un seek ; une lecture normale non', () => {
    const slowLink = { reset: vi.fn(), seeked: vi.fn(), tick: vi.fn(() => 'ok') };
    const p = session({ slowLink });
    reopenTick(p, tickState(100), T0);
    reopenTick(p, tickState(101), T0 + 1000);
    expect(slowLink.seeked).not.toHaveBeenCalled();
    reopenTick(p, tickState(160), T0 + 2000);
    expect(slowLink.seeked).toHaveBeenCalledWith(T0 + 2000);
  });
});

describe('suivi de la réouverture', () => {
  it('le drapeau tombe quand la lecture repart après le rechargement, et le StallWatch repart de zéro', async () => {
    const p = session();
    await reopenLink(p, T0);
    reopenTick(p, tickState(100), T0 + 1000);
    expect(p.reopening).toBe(true);
    reopenTick(p, tickState(0), T0 + 2000);
    expect(p.reopening).toBe(true);
    reopenTick(p, tickState(99.5), T0 + 3000);
    expect(p.reopening).toBe(false);
    expect(p.watch.reset).toHaveBeenCalledWith(T0 + 3000);
  });

  it('un verdict « lent » du SlowLinkWatch déclenche la réouverture', async () => {
    const p = session({ slowLink: { reset: vi.fn(), seeked: vi.fn(), tick: vi.fn(() => 'reopen') } });
    await reopenTick(p, tickState(100), T0);
    expect(p.engine.load).toHaveBeenCalledTimes(1);
    expect(p.slowLink.tick).toHaveBeenCalledTimes(1);
  });
});
