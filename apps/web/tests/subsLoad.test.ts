import { describe, expect, it } from 'vitest';
import { beginSubsLoad, endSubsLoad, isCurrentSubsLoad, resetSubsLoad, type SubsLoadState } from '../src/player/subsLoad';

const fresh = (): SubsLoadState => ({ loading: false, loadedFor: null, loadSeq: 0 });

describe('garde du chargement des sous-titres externes', () => {
  it('un seul chargement à la fois pour une même source', () => {
    const s = fresh();
    const a = beginSubsLoad(s, 0);
    expect(a).not.toBeNull();
    expect(beginSubsLoad(s, 0)).toBeNull();
    expect(endSubsLoad(s, a as number)).toBe(true);
    expect(s.loading).toBe(false);
  });

  it('une vue déjà chargée ne se relance pas, sauf à la demande', () => {
    const s = fresh();
    s.loadedFor = 2;
    expect(beginSubsLoad(s, 2)).toBeNull();
    expect(beginSubsLoad(s, 2, true)).not.toBeNull();
  });

  it('changement de source pendant un chargement : la recherche se relance pour la nouvelle vue', () => {
    const s = fresh();
    const old = beginSubsLoad(s, 0) as number;
    expect(beginSubsLoad(s, 1)).toBeNull(); // avant le correctif : jamais relancée après la fin de l'ancienne
    resetSubsLoad(s);
    expect(isCurrentSubsLoad(s, old)).toBe(false);
    const next = beginSubsLoad(s, 1);
    expect(next).not.toBeNull();
    expect(s.loading).toBe(true);
  });

  it("la fin de l'ancien chargement ne libère pas la garde du nouveau (pas de double chargement)", () => {
    const s = fresh();
    const old = beginSubsLoad(s, 0) as number;
    resetSubsLoad(s);
    const next = beginSubsLoad(s, 1) as number;
    expect(endSubsLoad(s, old)).toBe(false);
    expect(s.loading).toBe(true);
    expect(beginSubsLoad(s, 1)).toBeNull();
    expect(isCurrentSubsLoad(s, next)).toBe(true);
    expect(endSubsLoad(s, next)).toBe(true);
    expect(s.loading).toBe(false);
  });

  it("la source rechargée repart de zéro : l'ancien « chargé pour » est oublié", () => {
    const s = fresh();
    s.loadedFor = 0;
    resetSubsLoad(s);
    expect(beginSubsLoad(s, 0)).not.toBeNull();
  });
});
