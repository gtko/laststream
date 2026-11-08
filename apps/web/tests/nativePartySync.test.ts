// Watch party sur le lecteur natif Android (libVLC, NativeEngine) : vitesse non réglable, position interpolée entre deux
// évènements du natif, pause appliquée sans attendre son écho, « prêt » seulement après la première image, et pas de re-seek
// dans la dernière seconde. Le temps ne passe que par `clock.now` (horloge injectée dans le moteur et le contrôleur).
import { describe, expect, it, vi } from 'vitest';
import { NativeEngine } from '../src/player/engines.js';
import { playerOf, type SessionAdapter } from '../src/party/bridge';
import { PartyController, type PlayerLike } from '../src/party/controller';

function fakePlugin() {
  const handlers = new Map<string, (d: unknown) => void>();
  const plugin = {
    addListener: vi.fn(async (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return { remove: async () => {} }; }),
    open: vi.fn(async () => {}), close: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(async () => {}),
    seek: vi.fn(async () => {}), setRate: vi.fn(async () => {}), setAudioTrack: vi.fn(async () => {}), setSubtitleTrack: vi.fn(async () => {}),
    addSubtitles: vi.fn(async () => {}), update: vi.fn(async () => {}),
    minimize: vi.fn(async () => ({ mini: true })), expand: vi.fn(async () => ({ mini: false })),
  };
  return { plugin, fire: (ev: string, d: unknown) => handlers.get(ev)?.(d) };
}

/** Moteur natif ouvert (pas encore d'évènement du natif : aucune image). */
async function nativeAt(now: number) {
  const clock = { now };
  const { plugin, fire } = fakePlugin();
  const engine = new NativeEngine(plugin, () => clock.now);
  await engine.load({ url: 'http://x/a.mkv', startAt: 0, open: {} });
  return { clock, plugin, fire, engine };
}

type Sent = { action: string; pos: number };

/** Invité dont le lecteur natif est branché au contrôleur par le pont (`playerOf`) ; le salon est un état simulé. */
async function guestRig(salon: { playing: boolean; pos: number }, now = 100_000) {
  const n = await nativeAt(now);
  const sent: Sent[] = [];
  const client = {
    state: { playing: salon.playing, pos: salon.pos, at: now, rev: 1 },
    status: 'open',
    isHost: false,
    control: (action: string, pos: number) => { sent.push({ action, pos }); return true; },
    serverNow: () => n.clock.now,
  };
  const ctl = new PartyController(client as never, () => n.clock.now);
  const player = playerOf({ ready: true, engine: n.engine } as unknown as SessionAdapter) as PlayerLike;
  return { ...n, sent, ctl, player };
}

const frame = (over: Record<string, unknown> = {}) => ({ position: 50, duration: 3000, paused: false, buffering: false, rate: 1, ...over });

describe('moteur natif : vitesse non réglable', () => {
  it('playerOf déclare canRate faux pour le natif, vrai pour un moteur à vitesse réglable', async () => {
    const n = await nativeAt(0);
    expect(playerOf({ ready: true, engine: n.engine } as unknown as SessionAdapter)!.canRate).toBe(false);
    const html = { kind: 'html', state: () => ({ time: 0, duration: 100, paused: false, rate: 1 }), play() {}, pause() {}, seek() {}, setRate() {} };
    expect(playerOf({ ready: true, engine: html } as unknown as SessionAdapter)!.canRate).toBe(true);
  });

  it('un écart de 1,5 s : le natif saute à la position du salon, il ne ralentit ni n’accélère jamais', async () => {
    const g = await guestRig({ playing: true, pos: 100 });
    g.fire('state', frame({ position: 98.5 }));
    g.ctl.tick(g.player);
    expect(g.plugin.setRate).not.toHaveBeenCalled();
    expect(g.plugin.seek).toHaveBeenCalledWith({ position: 100 });
  });

  it('un écart de 0,5 s (sous le seuil de saut du natif) ne touche à rien', async () => {
    const g = await guestRig({ playing: true, pos: 100 });
    g.fire('state', frame({ position: 99.5 }));
    g.ctl.tick(g.player);
    expect(g.plugin.setRate).not.toHaveBeenCalled();
    expect(g.plugin.seek).not.toHaveBeenCalled();
  });
});

describe('moteur natif : position interpolée entre deux évènements', () => {
  it('avance avec l’horloge pendant la lecture, au rythme de la vitesse', async () => {
    const n = await nativeAt(1000);
    n.fire('state', frame({ position: 50, rate: 2 }));
    n.clock.now += 1500;
    expect(n.engine.state().time).toBeCloseTo(53, 6);
  });

  it('ne bouge pas en pause, pendant un chargement, ni avant la première image', async () => {
    const n = await nativeAt(1000);
    n.fire('state', frame({ position: 50, paused: true }));
    n.clock.now += 5000;
    expect(n.engine.state().time).toBe(50);
    n.fire('state', frame({ position: 50, paused: false, buffering: true }));
    n.clock.now += 5000;
    expect(n.engine.state().time).toBe(50);

    const fresh = await nativeAt(1000);
    fresh.fire('state', frame({ position: 0 })); // position nulle : pas encore d’image
    fresh.clock.now += 5000;
    expect(fresh.engine.state().time).toBe(0);
  });

  it('reste bornée à la durée', async () => {
    const n = await nativeAt(1000);
    n.fire('state', frame({ position: 2990 }));
    n.clock.now += 60_000;
    expect(n.engine.state().time).toBe(3000);
  });

  it('seek remet la base à la position demandée et à maintenant', async () => {
    const n = await nativeAt(1000);
    n.fire('state', frame({ position: 50 }));
    n.clock.now += 1000;
    n.engine.seek(200);
    expect(n.engine.state().time).toBe(200);
    n.clock.now += 500;
    expect(n.engine.state().time).toBeCloseTo(200.5, 6);
  });
});

describe('moteur natif : pause et reprise optimistes', () => {
  it('pause puis play changent l’état tout de suite, et la position interpolée est figée au moment de la pause', async () => {
    const n = await nativeAt(1000);
    n.fire('state', frame({ position: 50 }));
    n.clock.now += 1000;
    n.engine.pause();
    expect(n.engine.state().paused).toBe(true);
    expect(n.engine.state().time).toBeCloseTo(51, 6);
    expect(n.plugin.pause).toHaveBeenCalledTimes(1);
    n.clock.now += 5000;
    expect(n.engine.state().time).toBeCloseTo(51, 6);
    n.engine.play();
    expect(n.engine.state().paused).toBe(false);
    n.clock.now += 1000;
    expect(n.engine.state().time).toBeCloseTo(52, 6);
  });

  it('après une pause du salon, l’écho tardif du natif n’est pas renvoyé comme action locale', async () => {
    const g = await guestRig({ playing: false, pos: 100 });
    g.fire('state', frame({ position: 100 }));
    g.ctl.tick(g.player); // le salon est en pause : le natif se met en pause
    g.clock.now = 100_600; g.ctl.tick(g.player);
    g.clock.now = 102_000; g.ctl.tick(g.player); // fenêtre d’application refermée
    g.fire('state', frame({ position: 100, paused: true })); // écho du natif, après la fenêtre
    g.clock.now = 102_600; g.ctl.tick(g.player);
    expect(g.sent).toEqual([]);
    expect(g.plugin.pause).toHaveBeenCalledTimes(1);
  });
});

describe('moteur natif : prêt seulement après la première image', () => {
  it('playerOf.ready() reste faux avant la première image, puis vrai', async () => {
    const n = await nativeAt(0);
    const player = playerOf({ ready: true, engine: n.engine } as unknown as SessionAdapter)!;
    expect(player.ready()).toBe(false);
    n.fire('state', frame({ position: 10 }));
    expect(player.ready()).toBe(true);
  });

  it('le contrôleur n’agit pas avant la première image, puis applique l’état du salon', async () => {
    const g = await guestRig({ playing: true, pos: 200 });
    g.fire('state', frame({ position: 0, buffering: false })); // le natif annonce la durée mais n’a pas encore d’image
    g.ctl.tick(g.player);
    expect(g.plugin.play).not.toHaveBeenCalled();
    expect(g.plugin.seek).not.toHaveBeenCalled();
    g.fire('state', frame({ position: 5, paused: true }));
    g.clock.now += 600; g.ctl.tick(g.player);
    expect(g.plugin.play).toHaveBeenCalledTimes(1);
  });
});

describe('moteur natif : bornes de fin', () => {
  it('la cible du salon s’arrête à une seconde de la fin', async () => {
    const g = await guestRig({ playing: true, pos: 200 });
    g.fire('state', frame({ position: 50, duration: 100 }));
    g.ctl.tick(g.player);
    expect(g.plugin.seek).toHaveBeenCalledWith({ position: 99 });
  });

  it('pas de re-seek en boucle dans la dernière seconde : local et cible y sont tous deux', async () => {
    const g = await guestRig({ playing: true, pos: 200 });
    g.fire('state', frame({ position: 100, duration: 100 }));
    for (let t = 100_600; t <= 105_000; t += 600) { g.clock.now = t; g.ctl.tick(g.player); }
    expect(g.plugin.seek).not.toHaveBeenCalled();
    expect(g.sent).toEqual([]);
  });
});
