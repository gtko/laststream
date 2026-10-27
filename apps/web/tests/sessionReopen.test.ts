// LAST-507 : réouverture de la connexion mpv quand un lien débrideur ralentit (éligibilité, paliers, compteur, fin de réouverture).
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { playView } = vi.hoisted(() => ({ playView: vi.fn(async () => undefined) }));
vi.mock('../src/player/sessionPlay.js', () => ({ playView }));

// Les modules de lecture lisent le DOM de l'interface au chargement : on monte le même squelette que les autres tests.
const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = indexHtml.slice(indexHtml.indexOf('<body>') + 6, indexHtml.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
const { reopenEligible, reopenLink, reopenTick } = await import('../src/player/sessionReopen.js');
const { S } = await import('../src/player/sessionState.js');

const MIN = 60_000;
const T0 = Date.parse('2026-10-27T10:00:00Z');
const LINK = 'https://debrid.test/f.mkv';

/** Moteur mpv factice : position figée à `time`, deux pistes audio (la 2 est choisie), appels de chargement et de sélection. */
function fakeMpv(time = 100) {
  return {
    kind: 'mpv',
    state: () => ({ time, paused: false, ended: false, seeking: false, buffering: false, cacheTime: 5 }),
    audioTracks: () => [{ id: '1', selected: false }, { id: '2', selected: true }],
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

  it('le compteur repart à zéro après 10 min sans réouverture', async () => {
    const p = session();
    for (const k of [0, 1, 2]) await reopenLink(p, T0 + k * MIN);
    expect(await reopenLink(p, T0 + 2 * MIN + 10 * MIN + 1000)).toBe(1);
    expect(p.engine.load).toHaveBeenCalledTimes(3);
    expect(playView).toHaveBeenCalledTimes(1);
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
