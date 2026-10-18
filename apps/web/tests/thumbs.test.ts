import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucketOf, bucketTime, clampTooltip, FrameCache, MIN_SEEK_INTERVAL_MS, REST_MS, shouldSeek, thumbsAllowed, thumbSource, THUMB_HLS_WIDTH } from '../src/player/thumbs';

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
  const ok = { enabled: true, hasSource: true, duration: 1400, bandwidthKbps: null as number | null, torrentBuffering: false };

  it('actif par défaut dans le navigateur', () => {
    expect(thumbsAllowed(ok)).toBe(true);
    expect(thumbsAllowed({ ...ok, bandwidthKbps: 50_000 })).toBe(true);
  });

  it('désactivé : réglage, aucune source d’aperçu, connexion faible, torrent en remplissage, durée inconnue', () => {
    expect(thumbsAllowed({ ...ok, enabled: false })).toBe(false);
    expect(thumbsAllowed({ ...ok, hasSource: false })).toBe(false);
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

describe('aperçu sur la barre : source selon le moteur', () => {
  const base = { hasMedia: true, serverUp: true };

  it('lecture directe : le fichier lui-même', () => {
    expect(thumbSource({ ...base, engine: 'direct', serverUp: false })).toEqual({ mode: 'direct' });
  });

  it('HLS : seconde session basse résolution du serveur', () => {
    expect(thumbSource({ ...base, engine: 'hls' })).toEqual({ mode: 'hls', forceTranscoding: false, maxWidth: THUMB_HLS_WIDTH });
    expect(thumbSource({ ...base, engine: 'hls', forceHls: true })).toMatchObject({ mode: 'hls', forceTranscoding: true });
  });

  it('mpv : session HLS transcodée basse résolution (MKV/HEVC/AV1 illisibles par la WebView)', () => {
    expect(thumbSource({ ...base, engine: 'mpv' })).toEqual({ mode: 'hls', forceTranscoding: true, maxWidth: THUMB_HLS_WIDTH });
  });

  it('aucune source : natif Android, serveur absent, pas de média', () => {
    expect(thumbSource({ ...base, engine: 'native' }).mode).toBe('none');
    expect(thumbSource({ ...base, engine: 'mpv', serverUp: false }).mode).toBe('none');
    expect(thumbSource({ ...base, engine: 'hls', serverUp: false }).mode).toBe('none');
    expect(thumbSource({ ...base, engine: 'mpv', hasMedia: false }).mode).toBe('none');
    expect(thumbSource({ ...base, engine: null }).mode).toBe('none');
  });
});

describe('aperçu sur la barre : URL HLS légère', () => {
  it('maxWidth n’est envoyé que s’il est demandé', async () => {
    const { hlsMasterUrl } = await import('../src/player/server');
    const caps = { videoCodecs: ['h264'], audioCodecs: ['aac'], maxAudioChannels: 2 };
    const u = new URL(hlsMasterUrl('http://127.0.0.1:11470', 'id', 'http://x/a.mkv', caps, true, 320));
    expect(u.searchParams.get('maxWidth')).toBe('320');
    expect(u.searchParams.get('forceTranscoding')).toBe('1');
    expect(new URL(hlsMasterUrl('http://127.0.0.1:11470', 'id', 'http://x/a.mkv', caps)).searchParams.has('maxWidth')).toBe(false);
  });
});

describe('Thumbs : débounce, annulation, masquage', () => {
  async function make(allowed = true) {
    const { Thumbs } = await import('../src/player/thumbview.js');
    const canvas = document.createElement('canvas');
    (canvas as any).getContext = () => ({ drawImage: () => {} });
    canvas.hidden = true;
    const source = vi.fn(async () => ({ url: 'http://x/a.mp4', hls: false }));
    const t = new Thumbs(canvas, { allowed: () => allowed, duration: () => 1400, source });
    return { t, canvas, source };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.querySelectorAll('video').forEach((v) => v.remove()); });

  it('pas de vignette sans image', async () => {
    const { t, canvas } = await make();
    expect(t.request(120)).toBe(false);
    expect(canvas.hidden).toBe(true);
  });

  it('refuse (et masque) quand l’aperçu n’est pas autorisé : aucune source demandée', async () => {
    const { t, canvas, source } = await make(false);
    canvas.hidden = false;
    t.request(120);
    await vi.advanceTimersByTimeAsync(500);
    expect(canvas.hidden).toBe(true);
    expect(source).not.toHaveBeenCalled();
  });

  it('débounce : un seul chargement de source pour des survols rapprochés', async () => {
    const { t, source } = await make();
    for (let i = 0; i < 10; i++) { t.request(100 + i * 20, Date.now()); await vi.advanceTimersByTimeAsync(20); }
    await vi.advanceTimersByTimeAsync(600);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('cancel() abandonne la demande en cours', async () => {
    const { t, source } = await make();
    t.request(100);
    t.cancel();
    await vi.advanceTimersByTimeAsync(600);
    expect(source).not.toHaveBeenCalled();
  });

  it('erreurs de lecture répétées : on abandonne la source et on masque, sans réessayer', async () => {
    const { t, canvas, source } = await make();
    t.request(100);
    await vi.advanceTimersByTimeAsync(600);
    const v = document.querySelector('video') as HTMLVideoElement;
    expect(v).toBeTruthy();
    for (let i = 0; i < 3; i++) v.dispatchEvent(new Event('error'));
    expect(t.dead).toBe(true);
    expect(canvas.hidden).toBe(true);
    expect(document.querySelector('video')).toBeNull();
    t.request(300);
    await vi.advanceTimersByTimeAsync(600);
    expect(source).toHaveBeenCalledTimes(1);
    t.reset();
    expect(t.dead).toBe(false);
  });
});
