import { describe, expect, it } from 'vitest';
import { bucketOf, bucketTime, clampTooltip, FrameCache, MIN_SEEK_INTERVAL_MS, REST_MS, shouldSeek, thumbsAllowed } from '../src/player/thumbs';

describe('aperçu sur la barre : seaux et cache', () => {
  it('seaux de 10 s et instant demandé (milieu, jamais au-delà de la fin)', () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(9.99)).toBe(0);
    expect(bucketOf(10)).toBe(1);
    expect(bucketOf(-3)).toBe(0);
    expect(bucketTime(3, 3600)).toBe(35);
    expect(bucketTime(359, 3600)).toBe(3595);
    expect(bucketTime(359, 3596)).toBe(3595);
  });

  it('cache LRU : les plus anciens partent, un accès rafraîchit', () => {
    const c = new FrameCache<string>(3);
    c.set(1, 'a');
    c.set(2, 'b');
    c.set(3, 'c');
    expect(c.get(1)).toBe('a'); // 1 devient le plus récent
    c.set(4, 'd'); // 2 est évincé
    expect(c.has(2)).toBe(false);
    expect([1, 3, 4].every((k) => c.has(k))).toBe(true);
    expect(c.size).toBe(3);
  });

  it('image la plus proche en attendant la bonne', () => {
    const c = new FrameCache<string>();
    expect(c.nearest(5)).toBeNull();
    c.set(2, 'x');
    c.set(10, 'y');
    expect(c.nearest(4)).toEqual({ bucket: 2, value: 'x' });
    expect(c.nearest(9)).toEqual({ bucket: 10, value: 'y' });
    c.clear();
    expect(c.nearest(0)).toBeNull();
  });

  it('capacité par défaut : 120 images', () => {
    const c = new FrameCache<number>();
    for (let i = 0; i < 200; i++) c.set(i, i);
    expect(c.size).toBe(120);
    expect(c.has(79)).toBe(false);
    expect(c.has(80)).toBe(true);
  });
});

describe('aperçu sur la barre : cadence', () => {
  const base = { now: 10_000, bucket: 5, lastMoveAt: 9_000, lastSeekAt: 0, pendingBucket: null, cached: false };

  it('demande une image quand le pointeur est au repos et la cadence respectée', () => {
    expect(shouldSeek(base)).toBe(true);
  });

  it('pas de déplacement tant que le pointeur bouge', () => {
    expect(shouldSeek({ ...base, lastMoveAt: base.now - (REST_MS - 1) })).toBe(false);
    expect(shouldSeek({ ...base, lastMoveAt: base.now - REST_MS })).toBe(true);
  });

  it('au plus un déplacement toutes les 150 ms', () => {
    expect(shouldSeek({ ...base, lastSeekAt: base.now - (MIN_SEEK_INTERVAL_MS - 1) })).toBe(false);
    expect(shouldSeek({ ...base, lastSeekAt: base.now - MIN_SEEK_INTERVAL_MS })).toBe(true);
  });

  it('rien à faire si l’image est en cache ou déjà demandée', () => {
    expect(shouldSeek({ ...base, cached: true })).toBe(false);
    expect(shouldSeek({ ...base, pendingBucket: 5 })).toBe(false);
    expect(shouldSeek({ ...base, pendingBucket: 4 })).toBe(true);
  });
});

describe('aperçu sur la barre : conditions', () => {
  const ok = { enabled: true, shell: false, duration: 1400, bandwidthKbps: null as number | null, torrentBuffering: false };

  it('actif par défaut dans le navigateur', () => {
    expect(thumbsAllowed(ok)).toBe(true);
    expect(thumbsAllowed({ ...ok, bandwidthKbps: 50_000 })).toBe(true);
  });

  it('désactivé : réglage, coque mpv, connexion faible, torrent en remplissage, durée inconnue', () => {
    expect(thumbsAllowed({ ...ok, enabled: false })).toBe(false);
    expect(thumbsAllowed({ ...ok, shell: true })).toBe(false);
    expect(thumbsAllowed({ ...ok, bandwidthKbps: 2000 })).toBe(false);
    expect(thumbsAllowed({ ...ok, torrentBuffering: true })).toBe(false);
    expect(thumbsAllowed({ ...ok, duration: 0 })).toBe(false);
  });

  it('cadre centré sur le curseur sans déborder de la barre', () => {
    expect(clampTooltip(500, 1000, 240)).toBe(500);
    expect(clampTooltip(10, 1000, 240)).toBe(120);
    expect(clampTooltip(990, 1000, 240)).toBe(880);
    expect(clampTooltip(50, 100, 240)).toBe(120); // barre plus étroite que le cadre
  });
});
