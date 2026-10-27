// Chromecast (LAST-347) : lien envoyable au récepteur, position de départ, cadence d'écriture de la progression pendant la diffusion.
import { describe, expect, it, vi } from 'vitest';
import {
  CAST_REFUSED, CAST_RISKY_NOTE, castContentType, castStartPosition, castTarget, castingLabel, createCastProgress, isLoopbackHost,
} from '../src/player/castLogic';

describe('castTarget : sources joignables par le Chromecast', () => {
  it('accepte un lien https public, en mp4 par défaut', () => {
    const t = castTarget({ url: 'https://cdn.exemple.test/dl/abc123?token=x' });
    expect(t).toEqual({ ok: true, url: 'https://cdn.exemple.test/dl/abc123?token=x', contentType: 'video/mp4', warn: '' });
  });

  it('accepte une adresse du réseau local (le Chromecast est sur le même réseau)', () => {
    expect(castTarget({ url: 'http://192.168.1.20:8080/film.mp4' }).ok).toBe(true);
  });

  it('refuse le bouclage : 127.0.0.1, localhost, ::1, 0.0.0.0', () => {
    for (const url of ['http://127.0.0.1:11470/x.mp4', 'http://127.4.5.6/x.mp4', 'http://localhost:8080/x', 'http://app.localhost/x', 'http://[::1]:11470/x', 'http://0.0.0.0/x']) {
      expect(castTarget({ url })).toEqual({ ok: false, reason: CAST_REFUSED.loopback });
    }
  });

  it('refuse les fichiers lus depuis l’appareil (blob:, data:, file:, téléchargement)', () => {
    expect(castTarget({ url: 'blob:https://app.test/1b2c' })).toEqual({ ok: false, reason: CAST_REFUSED.local });
    expect(castTarget({ url: 'data:video/mp4;base64,AAAA' })).toEqual({ ok: false, reason: CAST_REFUSED.local });
    expect(castTarget({ url: 'file:///sdcard/film.mkv' })).toEqual({ ok: false, reason: CAST_REFUSED.local });
    expect(castTarget({ url: 'https://cdn.exemple.test/x.mp4', offline: true })).toEqual({ ok: false, reason: CAST_REFUSED.local });
  });

  it('refuse les autres schémas et les liens invalides', () => {
    expect(castTarget({ url: 'magnet:?xt=urn:btih:abc' })).toEqual({ ok: false, reason: CAST_REFUSED.scheme });
    expect(castTarget({ url: 'ftp://exemple.test/x.mp4' })).toEqual({ ok: false, reason: CAST_REFUSED.scheme });
    expect(castTarget({ url: '' })).toEqual({ ok: false, reason: CAST_REFUSED.scheme });
  });

  it('refuse une source proxifiée par le serveur de streaming, même joignable sur le réseau', () => {
    expect(castTarget({ url: 'https://cdn.exemple.test/x.mp4', proxied: true })).toEqual({ ok: false, reason: CAST_REFUSED.proxied });
    expect(castTarget({ url: 'http://192.168.1.10:11470/proxy/x', serverBase: 'http://192.168.1.10:11470/' })).toEqual({ ok: false, reason: CAST_REFUSED.proxied });
    // Autre port sur la même machine : ce n'est pas le serveur de streaming.
    expect(castTarget({ url: 'http://192.168.1.10:8080/x.mp4', serverBase: 'http://192.168.1.10:11470' }).ok).toBe(true);
  });

  it('accepte un MKV avec un avis (le récepteur par défaut le lit mal)', () => {
    const t = castTarget({ url: 'https://cdn.exemple.test/Film.2024.1080p.MKV' });
    expect(t).toMatchObject({ ok: true, contentType: 'video/x-matroska', warn: CAST_RISKY_NOTE });
  });

  it('les messages de refus sont en français et non vides', () => {
    for (const m of Object.values(CAST_REFUSED)) expect(m).toMatch(/Chromecast|envoyé/);
  });
});

describe('castContentType', () => {
  it('déduit le type de l’extension du chemin, sans la requête', () => {
    expect(castContentType('https://h.test/a/master.m3u8?x=1')).toBe('application/x-mpegURL');
    expect(castContentType('https://h.test/a/manifest.mpd')).toBe('application/dash+xml');
    expect(castContentType('https://h.test/a/v.webm')).toBe('video/webm');
    expect(castContentType('https://h.test/a/v.mp4')).toBe('video/mp4');
    expect(castContentType('https://h.test/dl/abc?name=x.mkv')).toBe('video/mp4');
  });
});

describe('isLoopbackHost', () => {
  it('distingue le bouclage du réseau local', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('10.0.0.2')).toBe(false);
    expect(isLoopbackHost('127.example.com')).toBe(false);
  });
});

describe('castStartPosition : reprise au même point', () => {
  const saved = { position: 1200, duration: 3000 };

  it('prend la position exacte de la lecture locale', () => {
    expect(castStartPosition(1834.56, saved, 3000)).toBe(1834.56);
  });

  it('sans position locale, reprend la progression enregistrée', () => {
    expect(castStartPosition(0, saved, 0)).toBe(1200);
    expect(castStartPosition(Number.NaN, saved, 3000)).toBe(1200);
  });

  it('sans rien, part du début', () => {
    expect(castStartPosition(0, null, 3000)).toBe(0);
    expect(castStartPosition(0.4, undefined)).toBe(0);
    expect(castStartPosition(0, { position: 0, duration: 3000 }, 3000)).toBe(0);
  });

  it('jamais dans les 5 dernières secondes', () => {
    expect(castStartPosition(2999, null, 3000)).toBe(2995);
    expect(castStartPosition(0, { position: 2999.5, duration: 3000 })).toBe(2995);
  });
});

describe('createCastProgress : écriture de la progression pendant la diffusion', () => {
  const setup = () => {
    let t = 1_000_000;
    const save = vi.fn();
    const pr = createCastProgress(save, () => t);
    return { pr, save, advance: (ms: number) => { t += ms; } };
  };

  it('écrit au premier relevé puis toutes les 10 s, comme le lecteur local', () => {
    const { pr, save, advance } = setup();
    expect(pr.update({ time: 100, duration: 3000, paused: false })).toBe(true);
    advance(1000);
    expect(pr.update({ time: 101, duration: 3000, paused: false })).toBe(false);
    advance(8000);
    expect(pr.update({ time: 109, duration: 3000, paused: false })).toBe(false);
    advance(1000);
    expect(pr.update({ time: 110, duration: 3000, paused: false })).toBe(true);
    expect(save.mock.calls).toEqual([[100, 3000], [110, 3000]]);
  });

  it('la pause sur le téléviseur écrit tout de suite, une seule fois', () => {
    const { pr, save, advance } = setup();
    pr.update({ time: 100, duration: 3000, paused: false });
    advance(2000);
    expect(pr.update({ time: 102, duration: 3000, paused: true })).toBe(true);
    advance(20_000);
    expect(pr.update({ time: 102, duration: 3000, paused: true })).toBe(false);
    expect(save).toHaveBeenLastCalledWith(102, 3000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('rien sans durée connue ni avant 1 s', () => {
    const { pr, save, advance } = setup();
    expect(pr.update({ time: 50, duration: 0, paused: false })).toBe(false);
    advance(11_000);
    expect(pr.update({ time: 0.5, duration: 3000, paused: false })).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('flush écrit le dernier relevé sans attendre (« Reprendre ici », fermeture)', () => {
    const { pr, save, advance } = setup();
    expect(pr.flush()).toBe(false); // aucun relevé encore
    pr.update({ time: 100, duration: 3000, paused: false });
    advance(3000);
    pr.update({ time: 103, duration: 3000, paused: false });
    expect(pr.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith(103, 3000);
    expect(pr.last()).toEqual({ time: 103, duration: 3000, paused: false });
  });
});

describe('castingLabel', () => {
  it('nomme l’appareil, sinon « le Chromecast »', () => {
    expect(castingLabel('Salon TV')).toBe('Lecture sur Salon TV');
    expect(castingLabel('  ')).toBe('Lecture sur le Chromecast');
  });
});
