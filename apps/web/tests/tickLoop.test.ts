import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SLOW_TICK_MS, UI_TICK_MS, createTickLoop, tickPlan, type TickContext } from '../src/player/tickLoop';

const base: TickContext = { open: true, hidden: false, paused: false, settled: true, kind: 'html', party: false };

describe('cadence de la boucle du lecteur (LAST-142)', () => {
  it('lecture visible : interface (250 ms) et boucle lente (1 s)', () => {
    expect(UI_TICK_MS).toBe(250);
    expect(SLOW_TICK_MS).toBe(1000);
    expect(tickPlan(base)).toMatchObject({ fast: true, slow: true });
  });

  it('en pause : rien ne tourne, sauf la boucle lente dans un salon (l’invité suit l’hôte)', () => {
    expect(tickPlan({ ...base, paused: true })).toMatchObject({ fast: false, slow: false });
    expect(tickPlan({ ...base, paused: true, party: true })).toMatchObject({ fast: false, slow: true });
  });

  it('onglet caché : rien pour un moteur web, la boucle lente pour mpv et le natif (leur progression en dépend)', () => {
    expect(tickPlan({ ...base, hidden: true })).toMatchObject({ fast: false, slow: false });
    expect(tickPlan({ ...base, hidden: true, kind: 'mpv' })).toMatchObject({ fast: false, slow: true });
    expect(tickPlan({ ...base, hidden: true, party: true })).toMatchObject({ fast: false, slow: true });
  });

  it('avant la première image, le démarrage reste surveillé même en pause ou caché', () => {
    expect(tickPlan({ ...base, settled: false, paused: true, hidden: true })).toMatchObject({ fast: true, slow: true });
  });

  it('sans session : rien', () => {
    expect(tickPlan({ ...base, open: false })).toEqual({ fast: false, slow: false, show: false });
  });
});

describe('boucle adaptative : arrêt en pause et onglet caché, reprise au play et au retour', () => {
  let ctx: TickContext;
  let fast: Mock<() => void>;
  let slow: Mock<() => void>;
  let wake: Mock<() => void>;
  let nudge: Mock<() => void>;
  const loop = () => createTickLoop({ plan: () => tickPlan(ctx), fast, slow, wake, nudge });

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = { ...base };
    fast = vi.fn();
    slow = vi.fn();
    wake = vi.fn();
    nudge = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it('tourne à 250 ms et 1 s en lecture', () => {
    const l = loop();
    l.sync();
    fast.mockClear(); slow.mockClear();
    vi.advanceTimersByTime(1000);
    expect(fast).toHaveBeenCalledTimes(4);
    expect(slow).toHaveBeenCalledTimes(1);
    l.stop();
  });

  it('s’arrête en pause après un dernier relevé, puis repart au play avec un relevé immédiat', () => {
    const l = loop();
    l.sync();
    ctx.paused = true;
    fast.mockClear(); slow.mockClear();
    l.sync();
    expect(fast).toHaveBeenCalledTimes(1); // dernier relevé : l’état « pause » est vu
    expect(slow).toHaveBeenCalledTimes(1);
    expect(l.running()).toEqual({ fast: false, slow: false });
    fast.mockClear(); slow.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(fast).not.toHaveBeenCalled();
    expect(slow).not.toHaveBeenCalled();
    ctx.paused = false;
    l.sync();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(1);
    expect(slow).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fast).toHaveBeenCalledTimes(5);
    l.stop();
  });

  it('onglet caché : plus aucun relevé, reprise au retour de l’onglet', () => {
    const l = loop();
    l.sync();
    ctx.hidden = true;
    l.sync();
    fast.mockClear(); slow.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(fast).not.toHaveBeenCalled();
    expect(slow).not.toHaveBeenCalled();
    ctx.hidden = false;
    l.sync();
    expect(l.running()).toEqual({ fast: true, slow: true });
    vi.advanceTimersByTime(1000);
    expect(slow).toHaveBeenCalledTimes(2);
    l.stop();
  });

  it('salon actif en pause : la boucle lente continue, pas celle de l’interface', () => {
    ctx = { ...base, paused: true, party: true };
    const l = loop();
    l.sync();
    fast.mockClear(); slow.mockClear();
    vi.advanceTimersByTime(3000);
    expect(fast).not.toHaveBeenCalled();
    expect(slow).toHaveBeenCalledTimes(3);
    l.stop();
  });

  it('le sous-titre se rafraîchit à la demande pendant le sommeil, pas onglet caché ni pendant que ça tourne', () => {
    const l = loop();
    l.sync();
    l.nudge();
    expect(nudge).not.toHaveBeenCalled(); // la boucle d’interface tourne déjà
    ctx.paused = true;
    l.sync();
    l.nudge();
    expect(nudge).toHaveBeenCalledTimes(1);
    ctx.hidden = true;
    l.nudge();
    expect(nudge).toHaveBeenCalledTimes(1);
    l.stop();
  });

  it('un sync demandé pendant un autre sync n’est pas perdu : second passage sur le plan à jour', () => {
    let l: ReturnType<typeof loop>;
    let reentered = false;
    slow.mockImplementation(() => {
      // le relevé final de la boucle lente découvre un changement de contexte (reprise) et redemande un sync
      if (!reentered && ctx.paused) { reentered = true; ctx.paused = false; l.sync(); }
    });
    l = loop();
    l.sync();
    ctx.paused = true;
    l.sync();
    expect(reentered).toBe(true);
    expect(l.running()).toEqual({ fast: true, slow: true });
    l.stop();
  });

  it('stop : plus aucun relevé', () => {
    const l = loop();
    l.sync();
    l.stop();
    fast.mockClear(); slow.mockClear();
    vi.advanceTimersByTime(5000);
    expect(fast).not.toHaveBeenCalled();
    expect(slow).not.toHaveBeenCalled();
  });
});
